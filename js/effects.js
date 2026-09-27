/* ============================================================
 * effects.js —— 效果器插槽与信号链
 * ------------------------------------------------------------
 * 每个效果器是一个 EffectSlot（插槽）：
 *
 *   input ──┬──> [效果器内部处理链] ──> wetOut ──┬──> output
 *           └──> bypassGain(干路) ──────────────┘
 *
 * 旁路开关用 30ms 左右的平滑增益切换，不会"啪"一声。
 * 链路顺序（模拟真实吉他效果链）：
 *   Gate → Wah → Compressor → Drive → EQ → 调制 → Delay → Reverb
 * ============================================================ */
(function (global) {
  'use strict';

  const fmtPct = (v) => Math.round(v * 100) + '%';

  /* ---------- 通用插槽 ---------- */
  class EffectSlot {
    constructor(ctx) {
      const meta = this.constructor.meta || {};
      this.ctx = ctx;
      this.id = meta.id;
      this.label = meta.label;
      this.color = meta.color;
      this.bypassed = false;
      this.input = ctx.createGain();
      this.output = ctx.createGain();
      this.wetOut = ctx.createGain();   // 内部处理链的出口
      this.bypassGain = ctx.createGain(); // 干路（旁路时走这里）
      this.bypassGain.gain.value = 0;
      this.wetOut.gain.value = 1;       // 默认启用：处理链直通输出
      this.input.connect(this.bypassGain).connect(this.output);
      this.input.connect(this.wetIn = ctx.createGain());
      this.params = {};
      for (const d of this.paramDefs()) this.params[d.key] = d.value; // 先建参数表，build() 里会用到
      this.build();                      // 子类：把 wetIn 连到处理链，最终接到 wetOut
      this.wetOut.connect(this.output);
      for (const d of this.paramDefs()) this.setParam(d.key, this.params[d.key]); // 让节点状态与参数一致
    }
    build() {}
    paramDefs() { return []; }
    setParam(key, value) { this.params[key] = value; }
    setBypassed(b) {
      this.bypassed = b;
      const t = this.ctx.currentTime;
      // setTargetAtTime = 指数逼近，约 3×tc 后到位，避免爆音
      this.bypassGain.gain.setTargetAtTime(b ? 1 : 0, t, 0.012);
      this.wetOut.gain.setTargetAtTime(b ? 0 : 1, t, 0.012);
    }
  }

  /* ---------- 0. 降噪门 Noise Gate ----------
   * 电吉他 USB 采集的三层底噪（拾音器电源哼声 / 声卡嘶声 / 线路干扰）
   * 的标准解法：低切 + 电源哼声陷波 + 噪声门（GitHub 上 Faust/AudioWorklet
   * 吉他效果器与电子管音箱模拟项目的共识做法）。
   * 门逻辑：滤波后的信号电平低于门限 → 压低 atten dB；高于门限+迟滞 → 开。
   * ---------------------------------------------------------- */
  class NoiseGateEffect extends EffectSlot {
    static meta = { id: 'gate', label: '降噪门 Gate', color: '#7a8a99' };
    build() {
      const ctx = this.ctx;
      this.hp = ctx.createBiquadFilter();          // 低切：吉他有效频段从 ~80Hz 起
      this.hp.type = 'highpass';
      this.hp.frequency.value = 80;
      this.hp.Q.value = 0.71;
      // 电源哼声陷波（50Hz 基频 + 2/3 次谐波）；关断时 Q→0.01 近似直通
      this.notches = [50, 100, 150].map((f) => {
        const n = ctx.createBiquadFilter();
        n.type = 'notch';
        n.frequency.value = f;
        n.Q.value = 0.01;                           // 默认直通
        return n;
      });
      this.gate = ctx.createGain();                 // 门的执行器
      this.gate.gain.value = 1;
      this.analyser = ctx.createAnalyser();         // 串在链里测滤波后电平（passthrough）
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0;
      this._buf = new Float32Array(this.analyser.fftSize);
      this._open = false;
      this._levelDb = -100;
      // 链：wetIn → hp → notch×3 → analyser → gate → wetOut
      this.wetIn.connect(this.hp);
      let node = this.hp;
      for (const n of this.notches) { node.connect(n); node = n; }
      node.connect(this.analyser).connect(this.gate).connect(this.wetOut);
    }
    paramDefs() {
      return [
        { key: 'threshold', label: '门限',     min: -80, max: -20, step: 1,  value: -55, fmt: (v) => v.toFixed(0) + ' dB' },
        { key: 'release',   label: '释放时间', min: 50,  max: 500, step: 10, value: 150, fmt: (v) => v.toFixed(0) + ' ms' },
        { key: 'atten',     label: '压噪深度', min: -60, max: 0,   step: 1,  value: -48, fmt: (v) => v.toFixed(0) + ' dB' },
        { key: 'hpf',       label: '低切频率', min: 40,  max: 200, step: 5,  value: 80,  fmt: (v) => v.toFixed(0) + ' Hz' },
        { key: 'hum',       label: '哼声滤除', min: 0,   max: 1,   step: 1,  value: 1,   fmt: (v) => (v >= 0.5 ? '开' : '关') },
      ];
    }
    setParam(key, value) {
      this.params[key] = value;
      const t = this.ctx.currentTime;
      if (key === 'hpf') this.hp.frequency.setTargetAtTime(value, t, 0.02);
      if (key === 'hum') this.notches.forEach((n) => n.Q.setTargetAtTime(value >= 0.5 ? 10 : 0.01, t, 0.02));
    }
    /* 每帧调用：读滤波后电平 → 开/关门（带 3dB 迟滞，防抖） */
    tick() {
      if (!this.analyser) return;
      this.analyser.getFloatTimeDomainData(this._buf);
      let peak = 0;
      for (let i = 0; i < this._buf.length; i++) {
        const a = Math.abs(this._buf[i]);
        if (a > peak) peak = a;
      }
      this._levelDb = DSP.linToDb(peak);
      const thr = this.params.threshold;
      const now = this.ctx.currentTime;
      const target = this._open ? 1 : DSP.dbToLin(this.params.atten);
      if (!this._open && this._levelDb > thr) {            // 开门：快
        this._open = true;
        this.gate.gain.setTargetAtTime(1, now, 0.002);
      } else if (this._open && this._levelDb < thr - 3) {  // 关门：按释放时间缓降
        this._open = false;
        this.gate.gain.setTargetAtTime(DSP.dbToLin(this.params.atten), now, this.params.release / 3000);
      } else {
        this.gate.gain.setTargetAtTime(target, now, 0.05); // 参数变化时平滑跟随
      }
    }
    getLevelDb() { return this._levelDb; }
    isOpen() { return this._open; }
  }

  /* ---------- 1. 过载 / 增益 Drive ----------
   * WaveShaper 对波形做非线性映射（这里是 tanh 软削波）。
   * 削波越狠波形越"方"，傅里叶级数告诉我们：方波 = 无穷多奇次
   * 谐波之和 → 频谱上冒出一排新峰，这就是失真音色的来源。
   * ---------------------------------------------------------- */
  class DriveEffect extends EffectSlot {
    static meta = { id: 'drive', label: '过载 Drive', color: '#bf5233' };
    build() {
      const ctx = this.ctx;
      this.pre = ctx.createGain();       // 前级：决定削波深度
      this.shaper = ctx.createWaveShaper();
      this.shaper.oversample = '4x';     // 过采样抑制混叠
      this.dryG = ctx.createGain();      // 干湿并联混合
      this.wetG = ctx.createGain();
      this.post = ctx.createGain();      // 输出电平
      this.wetIn.connect(this.pre).connect(this.shaper).connect(this.post).connect(this.wetG).connect(this.wetOut);
      this.wetIn.connect(this.dryG).connect(this.wetOut);
      this._k = 1;
      this._updateCurve();
    }
    paramDefs() {
      return [
        { key: 'drive', label: '削波强度', min: 0, max: 1, step: 0.01, value: 0.15, fmt: fmtPct },
        { key: 'mix',   label: '干湿混合', min: 0, max: 1, step: 0.01, value: 1,    fmt: fmtPct },
        { key: 'level', label: '输出电平', min: 0, max: 1, step: 0.01, value: 0.7,  fmt: fmtPct },
      ];
    }
    _updateCurve() {
      // 指数映射：0→线性(k=1)，0.5→中度(k≈7)，1→重削波(k≈49)
      const k = Math.exp(this.params.drive * 3.9);
      this._k = k;
      const n = 1024, curve = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1;
        curve[i] = Math.tanh(k * x) / Math.tanh(k);  // 软削波：k 小→线性，k 大→削顶
      }
      this.shaper.curve = curve;
    }
    setParam(key, value) {
      this.params[key] = value;
      const t = this.ctx.currentTime;
      if (key === 'drive') this._updateCurve();
      if (key === 'mix') {
        this.dryG.gain.setTargetAtTime(1 - value, t, 0.01);
        this.wetG.gain.setTargetAtTime(value, t, 0.01);
      }
      if (key === 'level') this.post.gain.setTargetAtTime(value * 1.2, t, 0.01);
    }
    // 供可视化：削波传输曲线的采样点
    curvePoints(n) {
      n = n || 65;
      const pts = [];
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1;
        pts.push({ x, y: Math.tanh(this._k * x) / Math.tanh(this._k) });
      }
      return pts;
    }
  }

  /* ---------- 2. 均衡器 EQ ----------
   * 三个 BiquadFilter：低频架式(250Hz) / 峰式(1kHz) / 高频架式(4kHz)。
   * getFrequencyResponse() 可以拿到滤波器在任意频率点的响应，
   * 乘起来就是整条 EQ 的频响曲线 → 直接叠加画在频谱上。
   * ---------------------------------------------------------- */
  class EQEffect extends EffectSlot {
    static meta = { id: 'eq', label: '均衡 EQ', color: '#6f7d5c' };
    build() {
      const ctx = this.ctx;
      this.low = ctx.createBiquadFilter();
      this.low.type = 'lowshelf'; this.low.frequency.value = 250;
      this.mid = ctx.createBiquadFilter();
      this.mid.type = 'peaking'; this.mid.frequency.value = 1000; this.mid.Q.value = 1.1;
      this.high = ctx.createBiquadFilter();
      this.high.type = 'highshelf'; this.high.frequency.value = 4000;
      this.wetIn.connect(this.low).connect(this.mid).connect(this.high).connect(this.wetOut);
      this._mag = null;
    }
    paramDefs() {
      const db = (v) => (v > 0 ? '+' : '') + v.toFixed(1) + ' dB';
      return [
        { key: 'low',  label: '低频 250Hz', min: -15, max: 15, step: 0.5, value: 0, fmt: db },
        { key: 'mid',  label: '中频 1kHz',  min: -15, max: 15, step: 0.5, value: 0, fmt: db },
        { key: 'high', label: '高频 4kHz',  min: -15, max: 15, step: 0.5, value: 0, fmt: db },
      ];
    }
    setParam(key, value) {
      this.params[key] = value;
      const t = this.ctx.currentTime;
      this[key].gain.setTargetAtTime(value, t, 0.01);
    }
    // 返回整条 EQ 在 freqs(Hz) 各点的响应(dB)
    getResponseDb(freqs) {
      const n = freqs.length;
      if (!this._mag || this._mag.length !== n) {
        this._mag = new Float32Array(n);
        this._m1 = new Float32Array(n);
        this._ph = new Float32Array(n);
      }
      const mag = this._mag, m1 = this._m1, ph = this._ph;
      mag.fill(1);
      for (const f of [this.low, this.mid, this.high]) {
        f.getFrequencyResponse(freqs, m1, ph);
        for (let i = 0; i < n; i++) mag[i] *= m1[i];
      }
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = DSP.linToDb(Math.max(mag[i], 1e-6));
      return out;
    }
  }

  /* ---------- 3. 合唱 Chorus ----------
   * 把信号复制成两份，各自经过一个被慢速 LFO 调制的 ~20ms 延时。
   * 延时在变 = 副本在"变速播放" = 频率微微漂移 → 与原信号产生
   * 拍频，听感变"厚"。两个声部左右声道分开 + LFO 速率/相位不同。
   * ---------------------------------------------------------- */
  class ChorusEffect extends EffectSlot {
    static meta = { id: 'chorus', label: '合唱 Chorus', color: '#8a6b8f' };
    build() {
      const ctx = this.ctx;
      this.dryG = ctx.createGain();
      this.wetG = ctx.createGain();
      this.wetIn.connect(this.dryG).connect(this.wetOut);
      this.voices = [];
      // 两个合唱声部：基延时不完全相同，LFO 速率/相位错开
      const mk = (baseSec, rateMul, invert, pan) => {
        const delay = ctx.createDelay(0.1);
        delay.delayTime.value = baseSec;
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 0.8 * rateMul;
        const depth = ctx.createGain();
        depth.gain.value = 0.0025;
        if (invert) {                       // 反相 LFO：两个声部反着漂
          const inv = ctx.createGain(); inv.gain.value = -1;
          lfo.connect(inv).connect(depth);
        } else {
          lfo.connect(depth);
        }
        depth.connect(delay.delayTime);
        const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain();
        if (panner.pan) panner.pan.value = pan;
        this.wetIn.connect(delay).connect(panner).connect(this.wetG);
        this.wetG.connect(this.wetOut);
        lfo.start();
        return { delay, lfo, depth };
      };
      this.voices.push(mk(0.021, 1, false, -0.55));
      this.voices.push(mk(0.027, 1.31, true, 0.55));
      this.wetG.gain.value = 0.5;
    }
    paramDefs() {
      return [
        { key: 'rate',  label: '速率',     min: 0.05, max: 5, step: 0.01, value: 0.8, fmt: (v) => v.toFixed(2) + ' Hz' },
        { key: 'depth', label: '深度',     min: 0, max: 1, step: 0.01, value: 0.5, fmt: fmtPct },
        { key: 'mix',   label: '湿声比例', min: 0, max: 1, step: 0.01, value: 0.5, fmt: fmtPct },
      ];
    }
    setParam(key, value) {
      this.params[key] = value;
      const t = this.ctx.currentTime;
      if (key === 'rate') this.voices.forEach((v, i) => v.lfo.frequency.setTargetAtTime(value * (i ? 1.31 : 1), t, 0.02));
      if (key === 'depth') this.voices.forEach((v) => v.depth.gain.setTargetAtTime(Math.max(value * 0.005, 1e-4), t, 0.02));
      if (key === 'mix') this.wetG.gain.setTargetAtTime(value, t, 0.01);
    }
  }

  /* ---------- 4. 延迟 Delay ----------
   * 输入 + 延迟副本；副本再经"阻尼低通 + 反馈增益"送回延迟线，
   * 形成一串越来越轻、越来越闷的回声（磁带回声的感觉）。
   * 频谱图上表现为一组组平行的"回声条纹"。
   * ---------------------------------------------------------- */
  class DelayEffect extends EffectSlot {
    static meta = { id: 'delay', label: '延迟 Delay', color: '#a8842c' };
    build() {
      const ctx = this.ctx;
      this.dryG = ctx.createGain();
      this.wetG = ctx.createGain();
      this.delay = ctx.createDelay(2.0);
      this.delay.delayTime.value = 0.28;
      this.tone = ctx.createBiquadFilter();   // 回声阻尼：每绕一圈更闷一点
      this.tone.type = 'lowpass';
      this.tone.frequency.value = 3500;
      this.tone.Q.value = 0.5;
      this.fb = ctx.createGain();             // 反馈量
      this.fb.gain.value = 0.4;
      this.wetIn.connect(this.dryG).connect(this.wetOut);
      this.wetIn.connect(this.delay).connect(this.tone).connect(this.wetG).connect(this.wetOut);
      this.tone.connect(this.fb).connect(this.delay);  // 反馈环（DelayNode 打破环路）
      this.wetG.gain.value = 0.35;
    }
    paramDefs() {
      const ms = (v) => (v < 1 ? Math.round(v * 1000) + ' ms' : v.toFixed(2) + ' s');
      return [
        { key: 'time',     label: '延迟时间', min: 0.02, max: 1,    step: 0.01, value: 0.28,  fmt: ms },
        { key: 'feedback', label: '反馈',     min: 0,    max: 0.85, step: 0.01, value: 0.4,   fmt: fmtPct },
        { key: 'damp',     label: '回声阻尼', min: 500,  max: 12000, step: 50,  value: 3500,  fmt: (v) => Math.round(v) + ' Hz' },
        { key: 'mix',      label: '湿声比例', min: 0,    max: 1,    step: 0.01, value: 0.35,  fmt: fmtPct },
      ];
    }
    setParam(key, value) {
      this.params[key] = value;
      const t = this.ctx.currentTime;
      if (key === 'time') this.delay.delayTime.setTargetAtTime(value, t, 0.05);
      if (key === 'feedback') this.fb.gain.setTargetAtTime(value, t, 0.02);
      if (key === 'damp') this.tone.frequency.setTargetAtTime(value, t, 0.02);
      if (key === 'mix') this.wetG.gain.setTargetAtTime(value, t, 0.01);
    }
  }

  /* ---------- 5. 压缩器 Compressor ----------
   * 自动音量控制：信号超过阈值的部分按 ratio 压下来。
   * "更响的压得多" → 动态范围变小 → 听感更密实。
   * comp.reduction 实时告诉你当前压了多少 dB（画成 GR 表）。
   * ---------------------------------------------------------- */
  class CompressorEffect extends EffectSlot {
    static meta = { id: 'comp', label: '压缩 Compressor', color: '#5e7d83' };
    build() {
      const ctx = this.ctx;
      this.comp = ctx.createDynamicsCompressor();
      this.comp.threshold.value = -24;
      this.comp.knee.value = 12;
      this.comp.ratio.value = 4;
      this.comp.attack.value = 0.01;
      this.comp.release.value = 0.15;
      this.makeup = ctx.createGain();
      this.wetIn.connect(this.comp).connect(this.makeup).connect(this.wetOut);
    }
    paramDefs() {
      return [
        { key: 'threshold', label: '阈值',     min: -60, max: 0,    step: 1,    value: -24,  fmt: (v) => v.toFixed(0) + ' dB' },
        { key: 'ratio',     label: '比率',     min: 1,   max: 20,   step: 0.1,  value: 4,    fmt: (v) => v.toFixed(1) + ' : 1' },
        { key: 'attack',    label: '启动时间', min: 0.001, max: 0.2, step: 0.001, value: 0.01, fmt: (v) => Math.round(v * 1000) + ' ms' },
        { key: 'release',   label: '释放时间', min: 0.02,  max: 0.6, step: 0.01,  value: 0.15, fmt: (v) => Math.round(v * 1000) + ' ms' },
        { key: 'makeup',    label: '补偿增益', min: 0,   max: 24,   step: 0.5,  value: 0,    fmt: (v) => '+' + v.toFixed(1) + ' dB' },
      ];
    }
    setParam(key, value) {
      this.params[key] = value;
      const t = this.ctx.currentTime;
      if (key === 'makeup') this.makeup.gain.setTargetAtTime(DSP.dbToLin(value), t, 0.02);
      else this.comp[key].setTargetAtTime(value, t, 0.02);
    }
    // 当前增益衰减量(dB，负值) —— 不同浏览器 reduction 可能是 number 或 AudioParam
    getReduction() {
      const r = this.comp.reduction;
      return typeof r === 'number' ? r : r.value;
    }
    // 静态输入/输出曲线(dB 域)，供可视化
    staticCurve(n) {
      n = n || 65;
      const thr = this.params.threshold, ratio = this.params.ratio;
      const pts = [];
      for (let i = 0; i < n; i++) {
        const x = -60 + (i / (n - 1)) * 60;           // 输入 -60..0 dB
        const y = x <= thr ? x : thr + (x - thr) / ratio;
        pts.push({ x, y });
      }
      return pts;
    }
  }

  /* ---------- 6. 自动哇 Auto Wah（包络滤波） ----------
   * 带通滤波器的中心频率跟随演奏力度扫动——放克经典。
   * 包络跟随：快攻（0.4 系数）慢放（0.08），每帧由主循环驱动。 */
  class AutoWahEffect extends EffectSlot {
    static meta = { id: 'wah', label: '自动哇 Wah', color: '#c2a24b' };
    build() {
      const ctx = this.ctx;
      this.analyser = ctx.createAnalyser();        // 串在链里（passthrough）测包络
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0;
      this.bp = ctx.createBiquadFilter();
      this.bp.type = 'bandpass';
      this.bp.frequency.value = 450;
      this.bp.Q.value = 3.5;
      this.makeup = ctx.createGain();              // 带通有电平损失，补一点
      this.makeup.gain.value = 1.6;
      this._buf = new Float32Array(this.analyser.fftSize);
      this._env = 0;
      this.wetIn.connect(this.analyser).connect(this.bp).connect(this.makeup).connect(this.wetOut);
    }
    paramDefs() {
      return [
        { key: 'sens',  label: '灵敏度',   min: 0,   max: 1,    step: 0.01, value: 0.6,  fmt: fmtPct },
        { key: 'base',  label: '中心频率', min: 150, max: 900,  step: 10,   value: 450,  fmt: (v) => v.toFixed(0) + ' Hz' },
        { key: 'range', label: '扫频范围', min: 200, max: 2000, step: 50,   value: 1200, fmt: (v) => v.toFixed(0) + ' Hz' },
        { key: 'q',     label: '共振',     min: 1,   max: 8,    step: 0.1,  value: 3.5,  fmt: (v) => v.toFixed(1) },
      ];
    }
    setParam(key, value) {
      this.params[key] = value;
      if (key === 'q') this.bp.Q.setTargetAtTime(value, this.ctx.currentTime, 0.02);
    }
    tick() {
      if (!this.analyser) return;
      this.analyser.getFloatTimeDomainData(this._buf);
      let peak = 0;
      for (let i = 0; i < this._buf.length; i++) {
        const a = Math.abs(this._buf[i]);
        if (a > peak) peak = a;
      }
      const target = Math.min(1, peak * 2.5);
      this._env += (target - this._env) * (target > this._env ? 0.4 : 0.08);  // 快攻慢放
      const freq = Math.min(2400, this.params.base + this._env * this.params.range * this.params.sens);
      this.bp.frequency.setTargetAtTime(freq, this.ctx.currentTime, 0.012);
    }
  }

  /* ---------- 7. 镶边 Flanger ----------
   * 合唱的近亲：超短延时（~4ms）+ 反馈环 → 梳状陷波随 LFO 扫动，
   * 喷气机"嗖嗖"声。反馈环必须经过 DelayNode（Web Audio 允许）。 */
  class FlangerEffect extends EffectSlot {
    static meta = { id: 'flanger', label: '镶边 Flanger', color: '#d98e4a' };
    build() {
      const ctx = this.ctx;
      this.dryG = ctx.createGain(); this.dryG.gain.value = 1;
      this.wetG = ctx.createGain(); this.wetG.gain.value = 0.5;
      this.delay = ctx.createDelay(0.02);
      this.delay.delayTime.value = 0.004;
      this.lfo = ctx.createOscillator();
      this.lfo.frequency.value = 0.25;
      this.depth = ctx.createGain(); this.depth.gain.value = 0.0015;
      this.fb = ctx.createGain(); this.fb.gain.value = 0.6;
      this.lfo.connect(this.depth).connect(this.delay.delayTime);
      this.lfo.start();
      this.wetIn.connect(this.dryG).connect(this.wetOut);
      this.wetIn.connect(this.delay);
      this.delay.connect(this.fb).connect(this.delay);     // 反馈环（Delay 打破环路）
      this.delay.connect(this.wetG).connect(this.wetOut);
    }
    paramDefs() {
      return [
        { key: 'rate', label: '速率',   min: 0.05, max: 2,   step: 0.01, value: 0.25, fmt: (v) => v.toFixed(2) + ' Hz' },
        { key: 'depth', label: '深度',  min: 0,    max: 1,   step: 0.01, value: 0.5,  fmt: fmtPct },
        { key: 'fb', label: '反馈',     min: 0,    max: 0.9, step: 0.01, value: 0.6,  fmt: fmtPct },
        { key: 'mix', label: '湿声比例', min: 0,    max: 1,   step: 0.01, value: 0.5,  fmt: fmtPct },
      ];
    }
    setParam(key, value) {
      this.params[key] = value;
      const t = this.ctx.currentTime;
      if (key === 'rate') this.lfo.frequency.setTargetAtTime(value, t, 0.02);
      if (key === 'depth') this.depth.gain.setTargetAtTime(Math.max(value * 0.003, 1e-4), t, 0.02);
      if (key === 'fb') this.fb.gain.setTargetAtTime(value, t, 0.02);
      if (key === 'mix') this.wetG.gain.setTargetAtTime(value, t, 0.01);
    }
  }

  /* ---------- 8. 移相 Phaser ----------
   * 4 级全通滤波器随 LFO 扫频，与干信号叠加产生移动的陷波——
   * MXR Phase 90 的经典结构。 */
  class PhaserEffect extends EffectSlot {
    static meta = { id: 'phaser', label: '移相 Phaser', color: '#b58fd8' };
    build() {
      const ctx = this.ctx;
      this.dryG = ctx.createGain(); this.dryG.gain.value = 1;
      this.wetG = ctx.createGain(); this.wetG.gain.value = 0.6;
      this.stages = [];
      for (let i = 0; i < 4; i++) {
        const ap = ctx.createBiquadFilter();
        ap.type = 'allpass';
        ap.frequency.value = 700;
        ap.Q.value = 0.6;
        this.stages.push(ap);
      }
      this.lfo = ctx.createOscillator();
      this.lfo.frequency.value = 0.35;
      this.depth = ctx.createGain(); this.depth.gain.value = 400;
      this.lfo.connect(this.depth);
      for (const ap of this.stages) this.depth.connect(ap.frequency);
      this.lfo.start();
      let node = this.wetIn;
      for (const ap of this.stages) { node.connect(ap); node = ap; }
      node.connect(this.wetG).connect(this.wetOut);
      this.wetIn.connect(this.dryG).connect(this.wetOut);
    }
    paramDefs() {
      return [
        { key: 'rate', label: '速率',   min: 0.05, max: 4,  step: 0.01, value: 0.35, fmt: (v) => v.toFixed(2) + ' Hz' },
        { key: 'depth', label: '深度',  min: 0,    max: 1,  step: 0.01, value: 0.6,  fmt: fmtPct },
        { key: 'mix', label: '湿声比例', min: 0,   max: 1,  step: 0.01, value: 0.6,  fmt: fmtPct },
      ];
    }
    setParam(key, value) {
      this.params[key] = value;
      const t = this.ctx.currentTime;
      if (key === 'rate') this.lfo.frequency.setTargetAtTime(value, t, 0.02);
      if (key === 'depth') this.depth.gain.setTargetAtTime(value * 650, t, 0.02);
      if (key === 'mix') this.wetG.gain.setTargetAtTime(value, t, 0.01);
    }
  }

  /* ---------- 9. 颤音 Tremolo ----------
   * 幅度调制：LFO 直接推动 VCA 的增益（冲浪音乐的心脏）。 */
  class TremoloEffect extends EffectSlot {
    static meta = { id: 'trem', label: '颤音 Tremolo', color: '#e0b34a' };
    build() {
      const ctx = this.ctx;
      this.vca = ctx.createGain();
      this.lfo = ctx.createOscillator();
      this.lfo.type = 'sine';
      this.lfo.frequency.value = 4.5;
      this.depth = ctx.createGain();
      this.lfo.connect(this.depth).connect(this.vca.gain);
      this.lfo.start();
      this.wetIn.connect(this.vca).connect(this.wetOut);
      this._applyDepth();
    }
    _applyDepth() {
      const d = this.params.depth;
      const t = this.ctx.currentTime;
      this.vca.gain.setTargetAtTime(1 - d / 2, t, 0.02);      // 基准
      this.depth.gain.setTargetAtTime(d / 2, t, 0.02);        // LFO 摆幅
    }
    paramDefs() {
      return [
        { key: 'rate', label: '速率', min: 0.5, max: 12, step: 0.1, value: 4.5, fmt: (v) => v.toFixed(1) + ' Hz' },
        { key: 'depth', label: '深度', min: 0, max: 1, step: 0.01, value: 0.7, fmt: fmtPct },
        { key: 'shape', label: '波形', min: 0, max: 1, step: 1, value: 0, fmt: (v) => (v >= 0.5 ? '三角' : '正弦') },
      ];
    }
    setParam(key, value) {
      this.params[key] = value;
      const t = this.ctx.currentTime;
      if (key === 'rate') this.lfo.frequency.setTargetAtTime(value, t, 0.02);
      if (key === 'shape') this.lfo.type = value >= 0.5 ? 'triangle' : 'sine';
      if (key === 'depth') this._applyDepth();
    }
  }

  /* ---------- 10. 混响 Reverb ----------
   * ConvolverNode + 程序生成的脉冲响应（房间/大厅/板式/弹簧）。
   * 专业信号链里混响永远在最后。 */
  class ReverbEffect extends EffectSlot {
    static meta = { id: 'reverb', label: '混响 Reverb', color: '#7fa8a0' };
    static IR_TYPES = ['房间', '大厅', '板式', '弹簧'];
    build() {
      const ctx = this.ctx;
      this.preDelay = ctx.createDelay(0.2);
      this.preDelay.delayTime.value = 0.02;
      this.tone = ctx.createBiquadFilter();
      this.tone.type = 'lowpass';
      this.tone.frequency.value = 6500;
      this.conv = ctx.createConvolver();
      this.dryG = ctx.createGain(); this.dryG.gain.value = 1;
      this.wetG = ctx.createGain(); this.wetG.gain.value = 0.3;
      this.wetIn.connect(this.dryG).connect(this.wetOut);
      this.wetIn.connect(this.preDelay).connect(this.tone).connect(this.conv).connect(this.wetG).connect(this.wetOut);
      this._generateIR(this.params.type | 0);
    }
    /* 程序生成 IR：指数衰减噪声；板式用差分提亮；弹簧加稀疏早期反射 */
    _generateIR(type) {
      const spec = [
        { seconds: 0.9, decay: 5.0, bright: false, taps: 0 },   // 房间
        { seconds: 2.8, decay: 2.6, bright: false, taps: 0 },   // 大厅
        { seconds: 2.0, decay: 3.2, bright: true,  taps: 0 },   // 板式（亮、密）
        { seconds: 1.3, decay: 4.5, bright: false, taps: 7 },   // 弹簧（叮当感）
      ][type] || { seconds: 1.5, decay: 3, bright: false, taps: 0 };
      const sr = this.ctx.sampleRate;
      const len = Math.max(1, Math.floor(sr * spec.seconds));
      const ir = this.ctx.createBuffer(2, len, sr);
      for (let ch = 0; ch < 2; ch++) {
        const d = ir.getChannelData(ch);
        let prev = 0;
        for (let i = 0; i < len; i++) {
          const env = Math.pow(1 - i / len, spec.decay);
          let v = (Math.random() * 2 - 1) * env;
          if (spec.bright) { const dv = v - prev; prev = v; v = dv * 1.4; }  // 差分 ≈ 提亮
          d[i] = v;
        }
        for (let k = 0; k < spec.taps; k++) {                    // 弹簧的离散早期反射
          const pos = Math.floor((0.006 + k * 0.005 + Math.random() * 0.003) * sr);
          if (pos < len) d[pos] += (Math.random() - 0.5) * 1.5;
        }
      }
      this.conv.buffer = ir;
    }
    paramDefs() {
      return [
        { key: 'type', label: '空间类型', min: 0, max: 3, step: 1, value: 1, fmt: (v) => ReverbEffect.IR_TYPES[v | 0] },
        { key: 'wet', label: '湿度', min: 0, max: 1, step: 0.01, value: 0.3, fmt: fmtPct },
        { key: 'pre', label: '预延迟', min: 0, max: 0.15, step: 0.005, value: 0.02, fmt: (v) => Math.round(v * 1000) + ' ms' },
      ];
    }
    setParam(key, value) {
      this.params[key] = value;
      const t = this.ctx.currentTime;
      if (key === 'type') this._generateIR(value | 0);
      if (key === 'wet') this.wetG.gain.setTargetAtTime(value, t, 0.02);
      if (key === 'pre') this.preDelay.delayTime.setTargetAtTime(value, t, 0.02);
    }
  }

  /* ---------- 信号链（专业综合效果器标准顺序，参照 Boss GT-1000 /
   * Line 6 Helix 文档：滤 → 压 → 失真 → EQ → 调制 → 延迟 → 混响最后） ---------- */
  const CHAIN_ORDER = ['gate', 'wah', 'comp', 'drive', 'eq', 'chorus', 'flanger', 'phaser', 'trem', 'delay', 'reverb'];
  class EffectChain {
    constructor(ctx) {
      const make = {
        gate: NoiseGateEffect, wah: AutoWahEffect, comp: CompressorEffect, drive: DriveEffect,
        eq: EQEffect, chorus: ChorusEffect, flanger: FlangerEffect, phaser: PhaserEffect,
        trem: TremoloEffect, delay: DelayEffect, reverb: ReverbEffect,
      };
      this.slots = CHAIN_ORDER.map((id) => new make[id](ctx));
      this.input = ctx.createGain();
      this.output = this.slots[this.slots.length - 1].output;
      let node = this.input;
      for (const s of this.slots) { node.connect(s.input); node = s.output; }
    }
    // A/B 全局旁路：记住各插槽原来的开关状态
    setAllBypassed(b) {
      if (b) {
        this._saved = this.slots.map((s) => s.bypassed);
        this.slots.forEach((s) => s.setBypassed(true));
      } else {
        this.slots.forEach((s, i) => s.setBypassed(this._saved ? this._saved[i] : false));
      }
    }
  }

  global.Effects = { EffectSlot, DriveEffect, EQEffect, ChorusEffect, DelayEffect, CompressorEffect, EffectChain, CHAIN_ORDER };
})(window);
