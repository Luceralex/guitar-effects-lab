/* ============================================================
 * visualizer.js —— 可视化渲染
 * ------------------------------------------------------------
 * 三种视图（都基于自研 DSP 内核，而不是浏览器内置的 FFT）：
 *
 *  1. 频谱   —— 横轴频率(对数)、纵轴幅度(dB)。
 *               叠加：输入信号对比、EQ 频响曲线、峰值保持、
 *               谐波标记(f0/H2/H3...) —— 看"音色的指纹"。
 *  2. 波形   —— 时域示波器（带触发，波形稳定不乱跑）。
 *  3. 频谱图 —— 时间向左滚动，纵轴频率、颜色=能量。
 *               看 Delay 的回声条纹、Chorus 的频率"发胖"最直观。
 * ============================================================ */
(function (global) {
  'use strict';

  const FMIN = 20;
  const FMAX = 20000;
  const DB_MIN = -90;
  const DB_MAX = 6;
  const GRID_FREQS = [30, 50, 100, 200, 300, 500, 1000, 2000, 3000, 5000, 10000, 15000];
  const COLORMAP = (() => {   // 书页式色带：纸白 → 深褐（墨色越浓能量越强）
    const stops = [
      [252, 250, 244], [243, 232, 207], [228, 200, 154], [207, 158, 109],
      [178, 114, 73], [139, 73, 45], [84, 40, 26], [32, 18, 12],
    ];
    const lut = new Uint8Array(256 * 3);
    for (let i = 0; i < 256; i++) {
      const t = (i / 255) * (stops.length - 1);
      const i0 = Math.floor(t), i1 = Math.min(stops.length - 1, i0 + 1);
      const f = t - i0;
      for (let c = 0; c < 3; c++) {
        lut[i * 3 + c] = Math.round(stops[i0][c] + (stops[i1][c] - stops[i0][c]) * f);
      }
    }
    return lut;
  })();

  class Visualizer {
    constructor(canvases, engine) {
      this.engine = engine;
      this.cv = canvases;
      this.tab = 'spectrum';
      this.frameNo = 0;
      this.analysisData = null;   // 后端返回的深度分析结果（静态视图）
      // 每帧拉取的时域数据
      this.preTime = new Float32Array(EngineNS.FFT_SIZE);
      this.postTime = new Float32Array(EngineNS.FFT_SIZE);
      // DSP 复用缓冲
      this.preSpec = null; this.postSpec = null;
      this.smooth = null; this.hold = null;   // 平滑显示 / 峰值保持（按像素）
      this.eqFreqs = null;
      this._resize();
      if (global.ResizeObserver) {
        this._ro = new ResizeObserver(() => this._resize());
        this._ro.observe(this.cv.spectrum.parentElement);
      }
      window.addEventListener('resize', () => this._resize());
    }

    setTab(t) { this.tab = t; }

    _resize() {
      const area = this.cv.spectrum.parentElement;
      if (!area) return;
      const dpr = global.devicePixelRatio || 1;
      // 面板收起/布局未就绪时宽度会塌到 0——此时保留画布现状，等恢复后再算
      if (area.clientWidth < 10) return;
      for (const key of ['spectrum', 'wave']) {
        const c = this.cv[key];
        const w = Math.max(50, Math.round(area.clientWidth * dpr));
        const h = Math.max(50, Math.round(area.clientHeight * dpr));
        if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      }
      const sg = this.cv.spectrogram;
      const sw = Math.max(50, Math.round(area.clientWidth * dpr));
      const sh = Math.max(50, Math.round(area.clientHeight * dpr));
      if (sg.width !== sw || sg.height !== sh) {
        // 保留已积累的频谱内容：先把旧画布拷走，改尺寸后再贴回来
        let keep = null;
        if (sg.width > 0 && sg.height > 0) {
          keep = document.createElement('canvas');
          keep.width = sg.width; keep.height = sg.height;
          keep.getContext('2d').drawImage(sg, 0, 0);
        }
        sg.width = sw; sg.height = sh;
        const g = sg.getContext('2d');
        g.fillStyle = '#ffffff'; g.fillRect(0, 0, sw, sh);
        if (keep) g.drawImage(keep, 0, 0, keep.width, keep.height, 0, 0, sw, sh);
      }
      const an = this.cv.analysis;
      if (an) {
        if (an.width !== sw || an.height !== sh) { an.width = sw; an.height = sh; }
        if (this.analysisData) this.drawAnalysis(this.analysisData);   // 尺寸变化后重画
      }
      this.dpr = dpr;
      this.smooth = null; this.hold = null;   // 尺寸变了，显示缓冲重来
    }

    /* 面板重新可见 / 窗口变化时强制按当前布局重算（画布宽可能塌过 50px 下限） */
    forceResize() {
      const area = this.cv.spectrum && this.cv.spectrum.parentElement;
      if (area && area.clientWidth < 10) return;   // 仍然塌陷，等真正恢复
      this._resize();
    }

    // 对数频率 ↔ 横轴像素（0..W）
    _xForFreq(hz, W) {
      return (Math.log(hz / FMIN) / Math.log(FMAX / FMIN)) * W;
    }
    _freqForX(x, W) {
      return FMIN * Math.pow(FMAX / FMIN, x / W);
    }

    /* ---------- 每帧：取数 + 分析 + 画图 ---------- */
    frame() {
      const eng = this.engine;
      eng.preAnalyser.getFloatTimeDomainData(this.preTime);
      eng.postAnalyser.getFloatTimeDomainData(this.postTime);

      this.pre = DSP.computeSpectrum(this.preTime, eng.sampleRate, this.preSpec);
      this.post = DSP.computeSpectrum(this.postTime, eng.sampleRate, this.postSpec);
      this.preSpec = this.pre; this.postSpec = this.post;

      this.rmsDb = DSP.linToDb(DSP.rms(this.postTime));
      this.f0 = DSP.estimateF0(this.pre.db, this.pre.binHz);
      this.preHarm = this.f0 ? DSP.analyzeHarmonics(this.pre.db, this.pre.binHz, this.f0, 8) : null;
      this.postHarm = this.f0 ? DSP.analyzeHarmonics(this.post.db, this.post.binHz, this.f0, 8) : null;
      this.thd = this.postHarm ? DSP.thdFromHarmonics(this.postHarm) : null;

      if (this.tab === 'spectrum') this._drawSpectrum();
      else if (this.tab === 'wave') this._drawWave();
      else if (this.tab === 'spectrogram') this._drawSpectrogram();
      // analysis 视图是静态结果：只在上传完成后重画，不走逐帧循环

      this.frameNo++;
      if (this.frameNo % 5 === 0) this._updateReadouts();
    }

    _updateReadouts() {
      const $ = (id) => document.getElementById(id);
      $('ro-f0').textContent = this.f0 ? this.f0.toFixed(1) + ' Hz' : '—';
      const note = this.f0 ? DSP.noteName(this.f0) : null;
      $('ro-note').textContent = note ? note.text : '—';
      $('ro-rms').textContent = this.rmsDb > -80 ? this.rmsDb.toFixed(1) + ' dB' : '—';
      $('ro-thd').textContent = this.thd != null ? (this.thd * 100).toFixed(1) + ' %' : '—';
    }

    /* ---------- 视图 1：频谱 ---------- */
    _drawSpectrum() {
      const c = this.cv.spectrum, g = c.getContext('2d');
      const W = c.width, H = c.height;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, W, H);
      const fmax = Math.min(FMAX, this.engine.sampleRate / 2);
      const xF = (hz) => (Math.log(hz / FMIN) / Math.log(fmax / FMIN)) * W;
      const yD = (db) => (1 - (db - DB_MIN) / (DB_MAX - DB_MIN)) * H;

      // 网格
      g.strokeStyle = 'rgba(70,62,48,0.12)';
      g.fillStyle = 'rgba(90,82,66,0.62)';
      g.lineWidth = 1;
      g.font = `${Math.round(11 * this.dpr)}px Georgia, "Songti SC", SimSun, serif`;
      for (const f of GRID_FREQS) {
        if (f > fmax) continue;
        const x = Math.round(xF(f)) + 0.5;
        g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
        g.fillText(f >= 1000 ? f / 1000 + 'k' : '' + f, x + 4 * this.dpr, H - 6 * this.dpr);
      }
      for (let db = -90; db <= 0; db += 15) {
        const y = Math.round(yD(db)) + 0.5;
        g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
        g.fillText(db + ' dB', 6 * this.dpr, y - 4 * this.dpr);
      }

      const N = Math.max(64, Math.floor(W));            // 每像素取一个样
      if (!this.smooth || this.smooth.length !== N) {
        this.smooth = new Float32Array(N).fill(-120);
        this.hold = new Float32Array(N).fill(-120);
      }
      const { db: pdb, binHz } = this.post;
      const idb = this.pre.db;
      const sampleAt = (arr, f) => {
        const b = f / binHz;
        const b0 = Math.floor(b), frac = b - b0;
        if (b0 < 0 || b0 >= arr.length - 1) return -120;
        return arr[b0] * (1 - frac) + arr[b0 + 1] * frac;
      };

      // 输入信号（灰，供对比）
      const showCompare = document.getElementById('chk-compare').checked;
      if (showCompare) {
        g.strokeStyle = 'rgba(140,130,110,0.6)';
        g.lineWidth = 1.2 * this.dpr;
        g.beginPath();
        for (let i = 0; i < N; i++) {
          const v = sampleAt(idb, this._freqForX(i / (N - 1) * W, W));
          const x = (i / (N - 1)) * W, y = yD(Math.max(v, DB_MIN));
          i ? g.lineTo(x, y) : g.moveTo(x, y);
        }
        g.stroke();
      }

      // 输出信号（青色填充 + 快攻慢放的平滑）
      const grad = g.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, 'rgba(191,82,51,0.02)');
      grad.addColorStop(1, 'rgba(191,82,51,0.22)');
      g.beginPath();
      g.moveTo(0, H);
      for (let i = 0; i < N; i++) {
        const v = sampleAt(pdb, this._freqForX(i / (N - 1) * W, W));
        const s = this.smooth[i];
        this.smooth[i] = v > s ? v : s * 0.82 + v * 0.18;   // 快攻慢放
        const x = (i / (N - 1)) * W, y = yD(Math.max(this.smooth[i], DB_MIN));
        g.lineTo(x, y);
      }
      g.lineTo(W, H);
      g.closePath();
      g.fillStyle = grad;
      g.fill();
      g.strokeStyle = '#bf5233';
      g.lineWidth = 1.6 * this.dpr;
      g.stroke();

      // 峰值保持（金色，缓慢下落 → 方便对比效果器开/关前后的差别）
      g.strokeStyle = 'rgba(168,132,44,0.8)';
      g.lineWidth = 1 * this.dpr;
      g.beginPath();
      for (let i = 0; i < N; i++) {
        const v = sampleAt(pdb, this._freqForX(i / (N - 1) * W, W));
        this.hold[i] = Math.max(v, this.hold[i] - 0.25);
        const x = (i / (N - 1)) * W, y = yD(Math.max(this.hold[i], DB_MIN));
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.stroke();

      // EQ 频响曲线（紫虚线，直接叠在频谱上）
      const eq = this.engine.chain.slots.find((s) => s.id === 'eq');
      if (eq) {
        const M = 128;
        if (!this.eqFreqs || this.eqFreqs.length !== M) this.eqFreqs = new Float32Array(M);
        for (let i = 0; i < M; i++) this.eqFreqs[i] = this._freqForX((i / (M - 1)) * W, W);
        const resp = eq.getResponseDb(this.eqFreqs);
        g.strokeStyle = 'rgba(94,125,131,0.9)';
        g.lineWidth = 1.4 * this.dpr;
        g.setLineDash([6 * this.dpr, 5 * this.dpr]);
        g.beginPath();
        for (let i = 0; i < M; i++) {
          const x = (i / (M - 1)) * W, y = yD(Math.max(resp[i], DB_MIN));
          i ? g.lineTo(x, y) : g.moveTo(x, y);
        }
        g.stroke();
        g.setLineDash([]);
      }

      // 谐波标记：f0 与 H2..H8 —— 音色的"指纹"就靠它们读出来
      if (this.preHarm && this.f0) {
        const loudest = Math.max(...this.preHarm.map((h) => h.db));
        g.font = `${Math.round(10 * this.dpr)}px Georgia, "Songti SC", SimSun, serif`;
        g.textAlign = 'center';
        for (const h of this.preHarm) {
          if (h.hz > fmax || h.db < loudest - 42) continue;
          const x = xF(h.hz);
          g.strokeStyle = 'rgba(111,125,92,0.45)';
          g.lineWidth = 1;
          g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
          g.fillStyle = '#6f7d5c';
          // 标签放图版底部（频率刻度上方），避免与右上角图例重叠
          g.fillText(h.k === 1 ? 'f0 ' + Math.round(h.hz) : 'H' + h.k, x, H - 24 * this.dpr);
        }
        const note = DSP.noteName(this.f0);
        if (note) {
          g.fillStyle = '#96421f';
          g.fillText(note.name + note.octave, xF(this.f0), H - 42 * this.dpr);
        }
        g.textAlign = 'start';
      }
    }

    /* ---------- 视图 2：波形（示波器） ---------- */
    _drawWave() {
      const c = this.cv.wave, g = c.getContext('2d');
      const W = c.width, H = c.height;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, W, H);
      // 中线与削波线
      g.strokeStyle = 'rgba(70,62,48,0.18)';
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(0, H / 2); g.lineTo(W, H / 2); g.stroke();
      const yA = (v) => H / 2 - v * (H / 2) * 0.92;
      g.strokeStyle = 'rgba(191,82,51,0.4)';
      g.setLineDash([4 * this.dpr, 6 * this.dpr]);
      g.beginPath(); g.moveTo(0, yA(1)); g.lineTo(W, yA(1)); g.moveTo(0, yA(-1)); g.lineTo(W, yA(-1)); g.stroke();
      g.setLineDash([]);

      // 触发：找上升过零点，让波形"定住"
      const d = this.postTime;
      let start = 0;
      for (let i = 1; i < d.length / 2; i++) {
        if (d[i - 1] <= 0 && d[i] > 0 && d[Math.min(i + 6, d.length - 1)] > d[i]) { start = i; break; }
      }
      const count = d.length - start;
      const drawOne = (data, color, width) => {
        g.strokeStyle = color;
        g.lineWidth = width;
        g.beginPath();
        for (let i = 0; i < count; i++) {
          const x = (i / (count - 1)) * W;
          const y = yA(Math.max(-1.2, Math.min(1.2, data[start + i])));
          i ? g.lineTo(x, y) : g.moveTo(x, y);
        }
        g.stroke();
      };
      const showCompare = document.getElementById('chk-compare').checked;
      if (showCompare) drawOne(this.preTime, 'rgba(140,130,110,0.5)', 1 * this.dpr);
      drawOne(this.postTime, '#bf5233', 1.6 * this.dpr);

      g.fillStyle = 'rgba(90,82,66,0.7)';
      g.font = `${Math.round(11 * this.dpr)}px Georgia, "Songti SC", SimSun, serif`;
      g.fillText('时域波形 · 虚线为削波界限 ±1', 10 * this.dpr, 20 * this.dpr);
    }

    /* ---------- 视图 3：频谱图（时间滚动） ---------- */
    _drawSpectrogram() {
      const c = this.cv.spectrogram, g = c.getContext('2d');
      const W = c.width, H = c.height;
      const colW = Math.max(1, Math.round(this.dpr));
      const { db, binHz } = this.post;
      // 左移一格，最右边画新的一列
      g.drawImage(c, -colW, 0);
      const img = g.createImageData(colW, H);
      const px = img.data;
      for (let y = 0; y < H; y++) {
        const t = 1 - y / H;                       // 顶部 = 高频
        const f = FMIN * Math.pow(FMAX / FMIN, t);
        const b = f / binHz;
        const b0 = Math.floor(b), frac = b - b0;
        let v = -120;
        if (b0 >= 0 && b0 < db.length - 1) v = db[b0] * (1 - frac) + db[b0 + 1] * frac;
        let idx = Math.round(((v - DB_MIN) / (DB_MAX - DB_MIN)) * 255);
        idx = Math.max(0, Math.min(255, idx));
        for (let x = 0; x < colW; x++) {
          const o = (y * colW + x) * 4;
          px[o] = COLORMAP[idx * 3];
          px[o + 1] = COLORMAP[idx * 3 + 1];
          px[o + 2] = COLORMAP[idx * 3 + 2];
          px[o + 3] = 255;
        }
      }
      g.putImageData(img, W - colW, 0);
    }

    /* ---------- 视图 4：深度分析（数据来自 Python 后端） ---------- */
    drawAnalysis(data) {
      this.analysisData = data;
      const c = this.cv.analysis;
      if (!c) return;
      // ResizeObserver 可能在布局未就绪时把画布写成下限宽度——画之前按当前布局重算
      if (c.width < 200) this._resize();
      const g = c.getContext('2d');
      const W = c.width, H = c.height;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, W, H);
      const dpr = this.dpr;
      const { freqs, times, db, dbMin, dbMax } = data.spectrogram;
      const left = 46 * dpr, right = 14 * dpr, top = 30 * dpr, bottom = 30 * dpr;
      const plotW = W - left - right, plotH = H - top - bottom;

      // 热力图：先画到离屏小画布（列×频点），再拉伸铺满图区
      const off = document.createElement('canvas');
      off.width = times.length; off.height = freqs.length;
      const og = off.getContext('2d');
      const img = og.createImageData(times.length, freqs.length);
      const px = img.data;
      for (let y = 0; y < freqs.length; y++) {
        for (let x = 0; x < times.length; x++) {
          let idx = Math.round(((db[y][x] - dbMin) / (dbMax - dbMin)) * 255);
          idx = Math.max(0, Math.min(255, idx));
          const o = (y * times.length + x) * 4;
          px[o] = COLORMAP[idx * 3];
          px[o + 1] = COLORMAP[idx * 3 + 1];
          px[o + 2] = COLORMAP[idx * 3 + 2];
          px[o + 3] = 255;
        }
      }
      og.putImageData(img, 0, 0);
      g.imageSmoothingEnabled = true;
      g.drawImage(off, left, top, plotW, plotH);
      g.strokeStyle = 'rgba(70,62,48,0.35)';
      g.lineWidth = 1;
      g.strokeRect(left + 0.5, top + 0.5, plotW - 1, plotH - 1);

      // 频率刻度（对数轴：第 0 行 = 最高频）
      g.font = `${Math.round(10.5 * dpr)}px Georgia, "Songti SC", SimSun, serif`;
      g.textAlign = 'right';
      const rows = freqs.length;
      for (const f of [10000, 1000, 100, 30]) {
        let best = 0, bd = Infinity;
        for (let i = 0; i < rows; i++) {
          const d = Math.abs(Math.log(freqs[i] / f));
          if (d < bd) { bd = d; best = i; }
        }
        const y = top + ((best + 0.5) / rows) * plotH;
        g.fillStyle = 'rgba(90,82,66,0.75)';
        g.fillText(f >= 1000 ? f / 1000 + 'k' : '' + f, left - 6 * dpr, y + 4 * dpr);
        g.strokeStyle = 'rgba(70,62,48,0.15)';
        g.beginPath();
        g.moveTo(left, Math.round(y) + 0.5);
        g.lineTo(left + plotW, Math.round(y) + 0.5);
        g.stroke();
      }

      // 时间刻度
      const dur = times[times.length - 1] || 0;
      g.textAlign = 'center';
      for (const t of ticksFor(dur)) {
        const x = left + (t / (dur || 1)) * plotW;
        g.fillText(t >= 1 ? t + 's' : Math.round(t * 1000) + 'ms', x, H - 10 * dpr);
      }

      // RMS / 峰值包络（叠加在热力图上）
      const yD = (v) => top + (1 - (Math.max(v, dbMin) - dbMin) / (dbMax - dbMin)) * plotH;
      const drawLine = (arr, color, width) => {
        if (!arr || arr.length < 2) return;
        g.strokeStyle = color;
        g.lineWidth = width;
        g.beginPath();
        for (let i = 0; i < arr.length; i++) {
          const x = left + (i / (arr.length - 1)) * plotW;
          const y = yD(arr[i]);
          i ? g.lineTo(x, y) : g.moveTo(x, y);
        }
        g.stroke();
      };
      drawLine(data.curves.peak, 'rgba(168,132,44,0.85)', 1.2 * dpr);
      drawLine(data.curves.rms, '#211e19', 1.4 * dpr);

      // f0 轨迹（灰绿点）
      g.fillStyle = 'rgba(111,125,92,0.9)';
      const f0s = data.curves.f0;
      for (let i = 0; i < f0s.length; i++) {
        const f = f0s[i];
        if (f == null || f < FMIN || f > FMAX) continue;
        const x = left + (i / (f0s.length - 1)) * plotW;
        const y = top + (1 - Math.log(f / FMIN) / Math.log(FMAX / FMIN)) * plotH;
        g.beginPath();
        g.arc(x, y, 1.6 * dpr, 0, Math.PI * 2);
        g.fill();
      }

      // 统计摘要（Python 后端算出来的）
      const s = data.summary;
      g.textAlign = 'left';
      g.fillStyle = '#211e19';
      g.font = `${Math.round(11.5 * dpr)}px Georgia, "Songti SC", SimSun, serif`;
      const bp = s.bandPercent;
      g.fillText(
        `时长 ${s.duration}s · 峰值 ${s.peakDbfs} dBFS · RMS ${s.rmsDbfs} dBFS · 失真 ${s.thdPercent ?? '—'}% · ` +
        `频段 低 ${bp.low}% / 中 ${bp.mid}% / 高 ${bp.high}%（Python 后端计算）`,
        left, 18 * dpr);
      g.textAlign = 'start';
    }
  }

  // 时间轴刻度：挑一个能让刻度数 ≤8 的整数步长
  function ticksFor(dur) {
    const steps = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
    const step = steps.find((s) => dur / s <= 8) ?? 600;
    const out = [];
    for (let t = 0; t <= dur + 1e-9; t += step) out.push(Math.round(t * 1000) / 1000);
    return out;
  }

  global.Visualizer = Visualizer;
})(window);
