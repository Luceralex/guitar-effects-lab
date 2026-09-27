/* ============================================================
 * audio-engine.js —— 音频引擎：信号源 + 效果链 + 分析抽头
 * ------------------------------------------------------------
 * 信号流向（Web Audio 节点图）：
 *
 *   [音源: 乐器合成 / 文件 / 麦克风 / 噪声]
 *        └─> sourceBus ─┬─> preAnalyser  (输入侧分析抽头，不发声)
 *                       └─> [效果链 Gate→Wah→Comp→Drive→EQ→调制→Delay→Reverb]
 *                              └─> postAnalyser ─> 音量 ─> 扬声器
 *
 * preAnalyser 挂了零增益"假负载"，保证节点被音频线程拉活。
 * 可视化始终独立于监听音量（analyser 在音量节点之前）。
 * ============================================================ */
(function (global) {
  'use strict';

  const FFT_SIZE = 4096;

  class AudioEngine {
    constructor() {
      const AC = window.AudioContext || window.webkitAudioContext;
      // 请求低延迟输出；浏览器和声卡最终选择的缓冲长度以实际报告值为准。
      this.ctx = new AC({ latencyHint: 0.005 }); // 创建时可能是 suspended，首次交互后 resume
      this.sampleRate = this.ctx.sampleRate;
      this.instrument = 'violin';
      this.sourceMode = 'synth';
      this.voices = new Map();                // key → 音符句柄
      this._voiceSeq = 0;
      this.file = { buffer: null, node: null, playing: false, offset: 0, startedAt: 0, loop: true, onended: null };
      this.mic = null;
      this.noise = null;
      this._buildGraph();
    }

    _buildGraph() {
      const ctx = this.ctx;
      this.sourceBus = ctx.createGain();

      // 输入侧分析抽头
      this.preAnalyser = ctx.createAnalyser();
      this.preAnalyser.fftSize = FFT_SIZE;
      this.preAnalyser.smoothingTimeConstant = 0;
      this.sink = ctx.createGain();
      this.sink.gain.value = 0;               // 静音假负载：只为让节点图被拉活

      // 效果链
      this.chain = new Effects.EffectChain(ctx);

      // 输出侧：postAnalyser 串在音量之前 → 可视化与音量无关
      this.postAnalyser = ctx.createAnalyser();
      this.postAnalyser.fftSize = FFT_SIZE;
      this.postAnalyser.smoothingTimeConstant = 0;
      // 后级录制抽头：把"经过效果链之后"的信号录下来做深度分析
      this.postDest = ctx.createMediaStreamDestination();
      this.postAnalyser.connect(this.postDest);
      this.master = ctx.createGain();
      this.master.gain.value = 0.8;

      // 布线
      this.sourceBus.connect(this.chain.input);
      this.sourceBus.connect(this.preAnalyser);
      this.preAnalyser.connect(this.sink);
      this.sink.connect(ctx.destination);
      this.chain.output.connect(this.postAnalyser);
      this.postAnalyser.connect(this.master);
      this.master.connect(ctx.destination);
    }

    async resume() {
      if (this.ctx.state !== 'running') {
        try { await this.ctx.resume(); } catch (e) { /* 需要用户手势 */ }
      }
    }

    setMasterVolume(v) {
      this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
    }

    /* ================= 内置乐器合成 =================
     * 音色 = 泛音结构。下面全部用"加法合成"：一个音符 = 一堆
     * 正弦振荡器（每个管一次谐波），幅度/衰减/失谐各自设定 ——
     * 正好把"音色由泛音决定"这件事写进代码里。
     * ================================================ */
    _makeVibrato(freq) {   // 揉弦：5.2Hz 正弦 → detune(音分) 参数
      const ctx = this.ctx;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 5.2;
      const depth = ctx.createGain();
      depth.gain.value = 0;
      lfo.connect(depth);
      lfo.start();
      // 弓子拉响之后揉弦才慢慢起来（前 0.25s 淡入）
      depth.gain.setTargetAtTime(14, ctx.currentTime + 0.15, 0.15);
      return { lfo, depth, targets: [] };
    }

    _buildVoice(freq, inst) {
      const ctx = this.ctx;
      const t = ctx.currentTime;
      const env = ctx.createGain();          // 包络（音量随时间变化）
      env.gain.value = 0;
      env.connect(this.sourceBus);
      const oscs = [];
      let stopped = false;
      let self = null;   // 指向返回的音符句柄，供自然结束时自动清理 voices 表

      const addPartial = (hz, amp, opts) => {
        const osc = ctx.createOscillator();
        osc.type = opts.type || 'sine';
        osc.frequency.value = hz;
        if (opts.detune) osc.detune.value = opts.detune;
        const g = ctx.createGain();
        g.gain.value = amp;
        osc.connect(g).connect(env);
        if (opts.vibrato) opts.vibrato.depth.connect(osc.detune);
        osc.start(t);
        oscs.push(osc);
        return { osc, g };
      };
      const stopAll = (when) => {
        if (stopped) return;
        stopped = true;
        oscs.forEach((o, i) => {
          try {
            if (i === 0) {
              o.onended = () => {   // 自然衰减结束 → 从 voices 表摘掉自己（ piano 等）
                if (self && self.key && this.voices.get(self.key) === self) {
                  this.voices.delete(self.key);
                }
              };
            }
            o.stop(when);
          } catch (e) {}
        });
      };

      if (inst === 'violin') {
        /* 小提琴：弓弦稳态 → 谐波按 ~1/k 递减（接近锯齿波的谱），
         * 持续不衰减 + 揉弦。 */
        const vib = this._makeVibrato(freq);
        for (let k = 1; k <= 10; k++) {
          addPartial(freq * k, (1 / k) * 0.22, { detune: (Math.random() - 0.5) * 6, vibrato: vib });
        }
        env.gain.setValueAtTime(0, t);
        env.gain.linearRampToValueAtTime(1, t + 0.12);          // 起弓
        env.gain.setTargetAtTime(0.85, t + 0.12, 0.3);          // 微回落到持续
        return self = {
          stop: (now) => {
            env.gain.cancelScheduledValues(now);
            env.gain.setTargetAtTime(0, now, 0.07);             // 收弓
            vib.depth.gain.setTargetAtTime(0, now, 0.05);
            stopAll(now + 0.4);
            try { vib.lfo.stop(now + 0.5); } catch (e) {}       // 揉弦 LFO 也要停，避免泄漏
          },
        };
      }

      if (inst === 'piano') {
        /* 钢琴：敲弦 → 攻击很硬，整体指数衰减，高次谐波衰减更快；
         * 琴弦刚度带来"非谐性"：第 k 次谐波比 k·f0 略偏高
         * f_k = k·f0·√(1+B·k²)，这让钢琴音色更"亮/金属"。 */
        const B = 0.0004;
        for (let k = 1; k <= 12; k++) {
          const hz = freq * k * Math.sqrt(1 + B * k * k);
          const tau = Math.max(0.9 / (1 + 0.45 * (k - 1)), 0.12);   // 该次谐波的衰减时间常数
          const p = addPartial(hz, (1 / Math.pow(k, 1.35)) * 0.3, {});
          p.g.gain.setValueAtTime(p.g.gain.value, t);
          p.g.gain.setTargetAtTime(0.0001, t + 0.005, tau);
        }
        env.gain.setValueAtTime(0, t);
        env.gain.linearRampToValueAtTime(1, t + 0.004);             // 锤击
        stopAll(t + 4.0);                                           // 自然衰减到底
        return self = {
          stop: (now) => {                                          // 提前松键：止音
            env.gain.cancelScheduledValues(now);
            env.gain.setTargetAtTime(0, now, 0.08);
            stopAll(now + 0.5);
          },
        };
      }

      /* 振荡器音色（持续音，按住发声松手停）：
       *   正弦   → 只有基频，"没有泛音 = 没有音色"
       *   锯齿波 → 全部谐波按 1/k（和小提琴的谱形一样，但没有揉弦与弓噪）
       *   方波   → 只有奇次谐波，按 1/k —— 傅里叶级数的经典结论
       *   三角波 → 只有奇次谐波，按 1/k²，听感更圆润 */
      const types = { sine: 'sine', saw: 'sawtooth', square: 'square', triangle: 'triangle' };
      const osc = ctx.createOscillator();
      osc.type = types[inst] || 'sine';
      osc.frequency.value = freq;
      osc.connect(env);
      osc.start(t);
      oscs.push(osc);
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(0.6, t + 0.02);
      return self = {
        stop: (now) => {
          env.gain.cancelScheduledValues(now);
          env.gain.setTargetAtTime(0, now, 0.05);
          stopAll(now + 0.3);
        },
      };
    }

    noteOn(key, freq, inst) {
      // 同一键重复触发：先快速收掉旧音，防止旧句柄丢失变成"关不掉"的长音
      const old = this.voices.get(key);
      if (old) old.stop(this.ctx.currentTime);
      const handle = this._buildVoice(freq, inst || this.instrument);
      handle.key = key;
      this.voices.set(key, handle);
    }
    noteOff(key) {
      const v = this.voices.get(key);
      if (v) { v.stop(this.ctx.currentTime); this.voices.delete(key); }
    }
    allNotesOff() {
      const keys = [...this.voices.keys()];
      keys.forEach((k) => this.noteOff(k));
    }

    /* 紧急停音：停止所有软件音源（Esc / 全停按钮调用）。
     * 注意：Jam Buddy 本机直通不受浏览器控制，效果器尾音会自然衰减。 */
    panic() {
      if (this._demoTimers) {
        this._demoTimers.forEach(clearTimeout);
        this._demoTimers = null;
      }
      this.allNotesOff();
      this.setNoise(false);
      this.stopFile();
      this.disableMic();
    }

    /* 白噪声（测 EQ/压缩用） */
    setNoise(on) {
      const ctx = this.ctx;
      if (on && !this.noise) {
        const len = 2 * ctx.sampleRate;
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        const src = ctx.createBufferSource();
        src.buffer = buf; src.loop = true;
        const g = ctx.createGain(); g.gain.value = 0.25;
        src.connect(g).connect(this.sourceBus);
        src.start();
        this.noise = { src, g };
      } else if (!on && this.noise) {
        try { this.noise.src.stop(); } catch (e) {}
        this.noise = null;
      }
    }

    /* ================= 音频文件 ================= */
    async loadFile(file) {
      const buf = await file.arrayBuffer();
      const decoded = await this.ctx.decodeAudioData(buf);
      this.stopFile();
      this.file.buffer = decoded;
      this.file.offset = 0;
      return decoded;
    }
    playFile() {
      if (!this.file.buffer || this.file.playing) return;
      const ctx = this.ctx;
      const node = ctx.createBufferSource();
      node.buffer = this.file.buffer;
      node.loop = this.file.loop;
      node.connect(this.sourceBus);
      const off = this.file.offset % this.file.buffer.duration;
      node.start(0, off);
      this.file.startedAt = ctx.currentTime;
      this.file.node = node;
      this.file.playing = true;
      node.onended = () => {           // 非循环播完自然结束
        if (this.file.node === node) {
          this.file.playing = false;
          this.file.offset = 0;
          this.file.node = null;
          if (this.file.onended) this.file.onended();
        }
      };
    }
    stopFile() {
      const f = this.file;
      if (!f.playing) return;
      const elapsed = this.ctx.currentTime - f.startedAt;
      f.offset = f.loop
        ? (f.offset + elapsed) % f.buffer.duration
        : Math.min(f.offset + elapsed, f.buffer.duration);
      f.playing = false;
      try { f.node.stop(); } catch (e) {}
      f.node = null;
    }

    /* ================= 麦克风 / 电吉他（USB 声卡） =================
     * USB 吉他声卡（如 JOYO Jam Buddy II，免驱 OTG 声卡）插上电脑后
     * 就是系统的一个普通录音设备 —— 浏览器用标准 getUserMedia 即可采集，
     * 无需任何专用驱动。关键约束：必须关掉浏览器为"人声通话"准备的
     * 回声消除/降噪/自动增益，否则吉他音色会被毁掉。 */
    async listInputDevices() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
      const devs = await navigator.mediaDevices.enumerateDevices();
      return devs.filter((d) => d.kind === 'audioinput');
    }
    async enableMic(deviceId) {
      if (this.mic) return this.mic;
      const audio = {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        latency: { ideal: 0 }, // 请求尽可能短的采集缓冲；不支持时浏览器会忽略
      };
      if (deviceId) audio.deviceId = { exact: deviceId };
      const stream = await navigator.mediaDevices.getUserMedia({ audio });
      const src = this.ctx.createMediaStreamSource(stream);
      const g = this.ctx.createGain(); g.gain.value = 0.9;
      src.connect(g).connect(this.sourceBus);
      this.mic = { stream, src, g };
      return this.mic;
    }
    disableMic() {
      if (!this.mic) return;
      this.mic.stream.getTracks().forEach((t) => t.stop());
      try { this.mic.src.disconnect(); } catch (e) {}
      this.mic = null;
    }
    // 监听输出切换（Chrome/Edge 110+）：可把处理后的琴声送到 Jam Buddy 耳机口
    async setSink(deviceId) {
      if (typeof this.ctx.setSinkId !== 'function') {
        throw new Error('当前浏览器不支持切换输出设备（需要 Chrome / Edge 110+）');
      }
      await this.ctx.setSinkId(deviceId || '');
    }

    /* 录制"经过效果链之后"的琴声（postAnalyser 抽头），供深度分析。
     * 注意这不是 mic.stream（那是效果链之前的原始输入）。 */
    async recordProcessed(seconds = 4) {
      if (!this.postDest) throw new Error('后级录制节点未初始化');
      if (typeof MediaRecorder === 'undefined') throw new Error('浏览器不支持 MediaRecorder');
      const rec = new MediaRecorder(this.postDest.stream);
      const chunks = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      const stopped = new Promise((res) => { rec.onstop = res; });
      rec.start();
      await new Promise((r) => setTimeout(r, seconds * 1000));
      rec.stop();
      await stopped;
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
      return this.ctx.decodeAudioData(await blob.arrayBuffer());
    }

    /* 切换信号源模式时，把不相关的声源都停掉 */
    setSourceMode(mode) {
      if (mode !== 'synth' && this._demoTimers) {
        this._demoTimers.forEach(clearTimeout);
        this._demoTimers = null;
      }
      if (mode !== 'synth') { this.allNotesOff(); this.setNoise(false); }
      if (mode !== 'file') this.stopFile();
      if (mode !== 'mic') this.disableMic();
      this.sourceMode = mode;
    }

    /* 一键对比演示：小提琴 A4 (2.2s) → 钢琴 A4。
     * 重复点击时先清掉上一轮的定时器和余音，防止旧音符句柄丢失。 */
    demoCompare() {
      this.resume();
      if (this._demoTimers) this._demoTimers.forEach(clearTimeout);
      this.noteOff('demo');
      this.noteOn('demo', 440, 'violin');
      this._demoTimers = [
        setTimeout(() => { if (this.sourceMode === 'synth') this.noteOff('demo'); }, 2200),
        setTimeout(() => { if (this.sourceMode === 'synth') this.noteOn('demo', 440, 'piano'); }, 2600),
      ];
    }
  }

  global.EngineNS = { AudioEngine, FFT_SIZE };
})(window);
