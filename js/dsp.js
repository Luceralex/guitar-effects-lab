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

  /* ---------- 9. 吉他单音检测（指板训练器用） ----------
   * 电吉他弹单音时，频谱上除了主频还有一串泛音，而且第 2、3 次
   * 泛音有时比主频还响（低音弦尤其明显）。所以不能只认"最高的峰"：
   *   1) 电平门限：RMS 低于门限就当静音（手指搭弦、底噪都不算）；
   *   2) 加 Hann 窗做 FFT，在吉他音域 [fmin, fmax] 里找最强峰；
   *   3) 八度纠错：若 f0/2（甚至 f0/3）处也有接近的能量，说明最强峰
   *      其实是泛音，真正的基频在下面 —— 逐级往下修；
   *   4) 对最终基频做抛物线插值细化，并用"峰高出噪底多少 dB"
   *      作为置信度（0~1），给调用方决定信不信这次结果。
   * 返回 { hz, level, conf }；判定为静音返回 null。 */
  function detectPitch(samples, sampleRate, scratch, opts) {
    opts = opts || {};
    const fmin = opts.fmin || 70, fmax = opts.fmax || 1320;
    const gateDb = opts.gateDb == null ? -48 : opts.gateDb;
    const levelDb = linToDb(rms(samples));
    if (levelDb < gateDb) return null;
    const { db, binHz } = computeSpectrum(samples, sampleRate, scratch);
    const p = findPeak(db, binHz, fmin, fmax);
    if (p.db < gateDb + 6) return null;          // 谱峰太弱同样当静音
    let f0 = p.hz;
    for (let i = 0; i < 2; i++) {                // 八度纠错，最多下探两个八度
      const half = f0 / 2;
      if (half < fmin) break;
      if (dbAtFreq(db, binHz, half) > dbAtFreq(db, binHz, f0) - 7) f0 = half; else break;
    }
    const third = f0 / 3;                        // 纯五度下探：低音弦 3 次谐波常偏强
    if (third >= fmin && dbAtFreq(db, binHz, third) > dbAtFreq(db, binHz, f0) - 6) f0 = third;
    const ip = interpPeak(db, Math.round(f0 / binHz));
    const hz = Math.max(fmin, (ip.k + ip.off) * binHz);
    // 置信度：峰相对频谱中位噪底的突出程度（干净单音通常轻松打满）
    const lo = Math.max(1, Math.ceil(60 / binHz));
    const hi = Math.min(db.length - 2, Math.floor(1400 / binHz));
    const seg = [];
    for (let k = lo; k <= hi; k += 2) seg.push(db[k]);
    seg.sort((a, b) => a - b);
    const floor = seg.length ? seg[seg.length >> 1] : -120;
    const conf = Math.max(0, Math.min(1, (ip.db - floor) / 26));
    return { hz, level: levelDb, conf };
  }

  global.DSP = {
    fft, hannWindow, isPowerOfTwo, computeSpectrum,
    findPeak, dbAtFreq, estimateF0, analyzeHarmonics, thdFromHarmonics,
    detectPitch, rms, noteName, linToDb, dbToLin,
  };
})(window);
