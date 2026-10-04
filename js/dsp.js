/* ============================================================
 * dsp.js —— 信号处理内核（Signal Processing Kernel）
 * ------------------------------------------------------------
 * 这个文件是整个项目的"数学引擎"，不依赖 Web Audio、不依赖 UI。
 * 你在页面上看到的每一根频谱，都是这里算出来的：
 *
 *   时域采样 x[n] → 加 Hann 窗 → 基-2 FFT → 单边幅度谱(dB)
 *                                        → 峰值 / 谐波 / f0 / THD
 *
 * 关键概念（对照你"小提琴 vs 钢琴"的问题）：
 *   - 任何周期信号都能分解成一串正弦波的叠加（傅里叶级数）；
 *   - 440Hz 的音，频谱上除了 440Hz 的峰（基频 f0），
 *     还有 880、1320、1760... Hz 的峰（第 2、3、4... 次谐波）；
 *   - 两件乐器音色不同 = 这些谐波的"幅度分布 / 随时间的衰减"不同。
 * ============================================================ */
(function (global) {
  'use strict';

  /* ---------- 1. 基-2 快速傅里叶变换（Cooley–Tukey，原地、迭代版） ----------
   * 直接算 DFT 是 O(n²)，FFT 通过"分治 + 蝶形运算"降到 O(n·log n)。
   * re/im 为长度 n（2 的整数次幂）的实部/虚部数组，结果写回原数组。
   * -------------------------------------------------------------------- */
  function fft(re, im) {
    const n = re.length;
    if (n <= 1 || (n & (n - 1)) !== 0) {
      throw new Error('FFT 长度必须是 2 的整数次幂，收到 ' + n);
    }
    // 第一步：位反转置换（bit-reversal permutation）
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    // 第二步：自底向上做蝶形运算，len 是当前子 DFT 的长度
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (-2 * Math.PI) / len;   // e^(i·ang) 是本级的旋转因子
      const wRe = Math.cos(ang), wIm = Math.sin(ang);
      const half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let curRe = 1, curIm = 0;         // w^0, w^1, w^2, ...
        for (let k = 0; k < half; k++) {
          const aRe = re[i + k], aIm = im[i + k];
          const bRe = re[i + k + half] * curRe - im[i + k + half] * curIm;
          const bIm = re[i + k + half] * curIm + im[i + k + half] * curRe;
          re[i + k] = aRe + bRe;           im[i + k] = aIm + bIm;
          re[i + k + half] = aRe - bRe;    im[i + k + half] = aIm - bIm;
          const nRe = curRe * wRe - curIm * wIm;
          curIm = curRe * wIm + curIm * wRe;
          curRe = nRe;
        }
      }
    }
  }

  /* ---------- 2. Hann 窗 ----------
   * 截取一段有限长的信号 = 原信号 × 矩形窗，会让频谱"漏"到旁边
   * （频谱泄漏）。Hann 窗把两头压到 0，能显著抑制泄漏，
   * 代价是主瓣稍宽。分析频谱几乎总是要加窗。
   * -------------------------------------------------------------------- */
  function hannWindow(n) {
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
    }
    return w;
  }

  function isPowerOfTwo(n) { return n > 0 && (n & (n - 1)) === 0; }

  const linToDb = (x) => (x > 1e-9 ? 20 * Math.log10(x) : -180);
  const dbToLin = (db) => Math.pow(10, db / 20);

  /* ---------- 3. 频谱计算：加窗 → FFT → 单边幅度谱（dB） ----------
   * scratch 是复用缓冲（避免每帧分配内存）：
   *   { re, im, win, db, binHz }
   * 首次调用会自动按 samples.length 建好。
   * 幅度归一化：×2/(n·0.5)，其中 0.5 是 Hann 窗的相干增益，
   * 这样一个满幅正弦波在谱上正好读到 0 dB。
   * -------------------------------------------------------------------- */
  function computeSpectrum(samples, sampleRate, scratch) {
    const n = samples.length;
    if (!isPowerOfTwo(n)) throw new Error('采样点数必须是 2 的整数次幂');
    if (!scratch || !scratch.re || scratch.re.length !== n) {
      scratch = {
        re: new Float32Array(n),
        im: new Float32Array(n),
        win: hannWindow(n),
        db: new Float32Array(n >> 1),
        binHz: 0,
      };
    }
    const { re, im, win, db } = scratch;
    for (let i = 0; i < n; i++) { re[i] = samples[i] * win[i]; im[i] = 0; }
    fft(re, im);
    const half = n >> 1;
    const scale = 2 / (0.5 * n);
    for (let k = 0; k < half; k++) {
      const mag = Math.hypot(re[k], im[k]) * scale;
      db[k] = linToDb(mag);
    }
    scratch.binHz = sampleRate / n;
    return { db, binHz: scratch.binHz };
  }

  /* ---------- 4. 峰值搜索（含抛物线插值） ----------
   * FFT 的 bin 是离散的，真峰往往落在两个 bin 之间。
   * 对峰顶及左右邻居做抛物线插值（在对数域），可以把频率估计
   * 精度从 ±binHz/2 提高到远高于 bin 分辨率。
   * -------------------------------------------------------------------- */
  function interpPeak(db, k) {
    if (k <= 0 || k >= db.length - 1) return { k, off: 0, db: db[k] };
    const a = db[k - 1], b = db[k], c = db[k + 1];
    const denom = a - 2 * b + c;
    const off = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
    return { k, off, db: b - 0.25 * (a - c) * off };
  }

  function findPeak(db, binHz, fmin, fmax) {
    const lo = Math.max(1, Math.ceil(fmin / binHz));
    const hi = Math.min(db.length - 2, Math.floor(fmax / binHz));
    let best = lo;
    for (let k = lo; k <= hi; k++) if (db[k] > db[best]) best = k;
    const p = interpPeak(db, best);
    return { hz: (p.k + p.off) * binHz, db: p.db, bin: best };
  }

  // 读取某个频率附近的谱值（±1 bin 内取最大，用于查谐波幅度）
  function dbAtFreq(db, binHz, hz) {
    const b = Math.round(hz / binHz);
    let v = -180;
    for (let k = Math.max(0, b - 1); k <= Math.min(db.length - 1, b + 1); k++) {
      if (db[k] > v) v = db[k];
    }
    return v;
  }

  /* ---------- 5. 基频（f0）估计 ----------
   * 取 [60, 1600] Hz 里最强的峰；再做一个八度纠错：
   * 若 f0/2 处也有差不多强的能量（差 6dB 以内），说明真正的
   * 基频在低八度（第二谐波常比基频更响，尤其钢琴高音区）。
   * -------------------------------------------------------------------- */
  function estimateF0(db, binHz) {
    const p = findPeak(db, binHz, 60, 1600);
    if (p.db < -75) return null;          // 基本是静音/底噪
    let f0 = p.hz;
    for (let i = 0; i < 2; i++) {         // 最多往下纠两个八度
      const half = f0 / 2;
      if (half < 55) break;
      const sub = dbAtFreq(db, binHz, half);
      if (sub > dbAtFreq(db, binHz, f0) - 6) f0 = half; else break;
    }
    return f0;
  }

  /* ---------- 6. 谐波分析 ----------
   * 以 f0 为基准，读出第 1..maxH 次谐波各自的频率与幅度(dB)。
   * 返回 [{k, hz, db}] —— 这就是"音色的指纹"：
   *   小提琴: 1/k 左右递减、持续；
   *   钢琴:   高次更亮但衰减快、略非谐。
   * -------------------------------------------------------------------- */
  function analyzeHarmonics(db, binHz, f0, maxH) {
    maxH = maxH || 8;
    const out = [];
    for (let k = 1; k <= maxH; k++) {
      const hz = f0 * k;
      if (hz >= binHz * db.length) break;
      out.push({ k, hz, db: dbAtFreq(db, binHz, hz) });
    }
    return out;
  }

  /* ---------- 7. 总谐波失真 THD ----------
   * THD = sqrt(A2² + A3² + ... + A8²) / A1，用线性幅度算。
   * 纯正弦 ≈ 0%；开 Drive 削波后飙升 —— 这就是"失真音色"
   * 在数学上的样子（波形被削 → 新增高次谐波）。
   * -------------------------------------------------------------------- */
  function thdFromHarmonics(harm) {
    if (!harm || !harm.length) return null;
    const a = harm.map((h) => dbToLin(h.db));
    const a1 = a[0];
    if (a1 < 1e-6) return null;
    let sum = 0;
    for (let i = 1; i < a.length; i++) sum += a[i] * a[i];
    return Math.sqrt(sum) / a1;
  }

  /* ---------- 8. 其它小工具 ---------- */
  function rms(samples) {
    let s = 0;
    for (let i = 0; i < samples.length; i++) s += samples[i] * samples[i];
    return Math.sqrt(s / samples.length);
  }

  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  // 频率 → 音名（A4=440Hz，MIDI 音高 69）
  function noteName(hz) {
    if (!hz || hz <= 0) return null;
    const n = 69 + 12 * Math.log2(hz / 440);
    const midi = Math.round(n);
    const cents = Math.round((n - midi) * 100);
    const name = NOTE_NAMES[((midi % 12) + 12) % 12];
    const octave = Math.floor(midi / 12) - 1;
    return {
      name, octave, cents,
      text: name + octave + (cents >= 0 ? ' +' : ' ') + cents + '¢',
    };
  }

  /* ---------- 9. 吉他单音检测（短窗 YIN 周期估计） ----------
   * 最强频谱峰可能是第二泛音，因而不能用它当基频。比较波形与
   * 各个延迟后的波形：真正的周期会让差值接近 0。CMNDF 归一化
   * 消除短延迟偏置；取全局最好周期附近最早的谷值，避免倍周期。
   * 只用最新约 170ms，缩短换音后的旧音残留；先平均降采样，避免
   * 高频谐波混叠。谱面和弦不强行当作高置信单音。
   * scratch 由调用者复用，减少每 30ms 一次的 GC 分配。 */
  function detectPitch(samples, sampleRate, scratch, opts) {
    opts = opts || {};
    const fmin = opts.fmin || 70, fmax = opts.fmax || 1320;
    const gateDb = opts.gateDb == null ? -48 : opts.gateDb;
    const decimation = Math.max(1, Math.round(sampleRate / 12000));
    const count = Math.floor(Math.min(samples.length, 8192) / decimation);
    if (count < 256) return null;
    const start = samples.length - count * decimation;
    let levelSum = 0;
    for (let i = start; i < samples.length; i++) levelSum += samples[i] * samples[i];
    const levelDb = linToDb(Math.sqrt(levelSum / (samples.length - start)));
    if (levelDb < gateDb) return null;
    scratch = scratch || {};
    if (!scratch.yin || scratch.yin.length !== count) scratch.yin = new Float32Array(count);
    const x = scratch.yin;
    for (let i = 0; i < count; i++) {
      let sum = 0;
      const j = start + i * decimation;
      for (let k = 0; k < decimation; k++) sum += samples[j + k];
      x[i] = sum / decimation;
    }
    const rate = sampleRate / decimation;
    const minTau = Math.max(2, Math.floor(rate / fmax));
    const maxTau = Math.min(count >> 1, Math.ceil(rate / fmin));
    if (!scratch.diff || scratch.diff.length <= maxTau) scratch.diff = new Float32Array(maxTau + 1);
    const diff = scratch.diff;
    const compareCount = count - maxTau;
    let running = 0, bestTau = 0, bestVal = Infinity;
    for (let tau = 1; tau <= maxTau; tau++) {
      let sum = 0;
      for (let i = 0; i < compareCount; i++) {
        const delta = x[i] - x[i + tau];
        sum += delta * delta;
      }
      running += sum;
      const value = running > 1e-12 ? (sum * tau) / running : 1;
      diff[tau] = value;
      if (tau >= minTau && value < bestVal) { bestVal = value; bestTau = tau; }
    }
    // 噪声或多音没有清晰的共同周期；宁可显示“不确定”也不误判。
    if (bestVal > 0.22 || !bestTau) return null;
    const nearBest = Math.max(0.045, bestVal * 1.35);
    for (let tau = minTau + 1; tau < bestTau; tau++) {
      if (diff[tau] <= nearBest && diff[tau] <= diff[tau - 1] && diff[tau] <= diff[tau + 1]) {
        bestTau = tau;
        break;
      }
    }
    const a = diff[bestTau - 1], b = diff[bestTau], c = diff[bestTau + 1];
    const denom = a - 2 * b + c;
    const offset = denom > 1e-9 ? Math.max(-1, Math.min(1, 0.5 * (a - c) / denom)) : 0;
    const hz = rate / (bestTau + offset);
    if (hz < fmin || hz > fmax) return null;
    const conf = Math.max(0, Math.min(1, 1 - b));
    return { hz, level: levelDb, conf };
  }

  /* ---------- 10. 已知目标和弦的保守证据检测 ----------
   * 只检查谱面要求的音级：每个目标基频必须明显高于邻近频谱底噪。
   * 同音级的八度叠音无法从一个吉他通道可靠拆开，故按音级合并；
   * 只含一个音级的八度和弦标为 ambiguous，不声称已验证指法。
   * 返回的 present / missing 是每个音级的最低目标 MIDI。 */
  function detectChord(samples, sampleRate, targetMidis, scratch, opts) {
    opts = opts || {};
    const gateDb = opts.gateDb == null ? -48 : opts.gateDb;
    if (!targetMidis || !targetMidis.length || linToDb(rms(samples)) < gateDb) return null;
    scratch = scratch || {};
    if (!scratch.re || scratch.re.length !== samples.length) {
      scratch.re = new Float32Array(samples.length);
      scratch.im = new Float32Array(samples.length);
      scratch.win = hannWindow(samples.length);
      scratch.db = new Float32Array(samples.length >> 1);
    }
    const { db, binHz } = computeSpectrum(samples, sampleRate, scratch);
    const representatives = new Map();
    for (const midi of targetMidis) {
      if (!Number.isFinite(midi)) continue;
      const pc = ((midi % 12) + 12) % 12;
      if (!representatives.has(pc) || midi < representatives.get(pc)) representatives.set(pc, midi);
    }
    const evidence = [...representatives.values()].map((midi) => {
      const hz = 440 * Math.pow(2, (midi - 69) / 12);
      const bin = Math.round(hz / binHz);
      const peak = dbAtFreq(db, binHz, hz);
      const neighbors = [];
      for (let k = Math.max(1, bin - 14); k <= Math.min(db.length - 1, bin + 14); k++) {
        if (Math.abs(k - bin) > 2) neighbors.push(db[k]);
      }
      neighbors.sort((a, b) => a - b);
      const floor = neighbors.length ? neighbors[neighbors.length >> 1] : -180;
      return { midi, peak, prominence: peak - floor };
    });
    const strongest = Math.max(...evidence.map((e) => e.peak));
    const present = [], missing = [];
    for (const e of evidence) {
      const found = e.peak >= Math.max(gateDb + 7, strongest - 23) && e.prominence >= 9;
      (found ? present : missing).push(e.midi);
    }
    return {
      present, missing,
      complete: missing.length === 0 && representatives.size > 1,
      ambiguous: representatives.size <= 1 && targetMidis.length > 1,
    };
  }

  class OnsetTracker {
    constructor(riseDb = 5, minGapMs = 90) {
      this.riseDb = riseDb;
      this.minGapMs = minGapMs;
      this.lastDb = null;
      this.lastOnsetMs = -Infinity;
    }

    update(levelDb, nowMs, gateDb = -48) {
      const previous = this.lastDb;
      this.lastDb = levelDb;
      const active = levelDb > gateDb + 3;
      const rose = previous == null ? active : levelDb - previous >= this.riseDb;
      if (active && rose && nowMs - this.lastOnsetMs >= this.minGapMs) {
        this.lastOnsetMs = nowMs;
        return true;
      }
      return false;
    }

    reset() { this.lastDb = null; this.lastOnsetMs = -Infinity; }
  }

  global.DSP = {
    fft, hannWindow, isPowerOfTwo, computeSpectrum,
    findPeak, dbAtFreq, estimateF0, analyzeHarmonics, thdFromHarmonics,
    detectPitch, detectChord, OnsetTracker, rms, noteName, linToDb, dbToLin,
  };
})(window);
