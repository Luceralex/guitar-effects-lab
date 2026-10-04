/* ============================================================
 * fretboard.js —— 指板训练器
 * ------------------------------------------------------------
 * 把"弹没弹对"变成看得见的东西：
 *   · 指板上标出所选音阶的全部位置（根音用陶土色实心标出）
 *   · 实时检测你弹的单音：短窗周期估计与置信度门限
 *   · 探索模式：检测环绿色 = 在调内，深红 = 调外
 *   · 闯关模式：指板闪烁提示下一个音，弹对自动前进、弹错连击清零
 *
 * 检测信号取自效果链之前（engine.pitchAnalyser 抽头），所以不管
 * 效果器怎么调，检测到的都是琴本身弹的音；内置音源同样会被检测
 * —— 点指板上的位置试听，就能看到"发声 → 检测 → 判定"全流程。
 * ============================================================ */
(function (global) {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const SERIF = 'Georgia, "Songti SC", SimSun, serif';

  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const SCALES = {
    major:     { name: '自然大调', steps: [0, 2, 4, 5, 7, 9, 11] },
    natMinor:  { name: '自然小调', steps: [0, 2, 3, 5, 7, 8, 10] },
    minorPent: { name: '小调五声', steps: [0, 3, 5, 7, 10] },
    majorPent: { name: '大调五声', steps: [0, 2, 4, 7, 9] },
    blues:     { name: '布鲁斯',   steps: [0, 3, 5, 6, 7, 10] },
  };
  // 标准调弦：自上而下 = 1 弦(高音 e) → 6 弦(低音 E)，值是空弦 MIDI 编号
  const STRINGS = [64, 59, 55, 50, 45, 40];   // E4 B3 G3 D3 A2 E2
  const STRING_LABELS = ['e', 'B', 'G', 'D', 'A', 'E'];
  const MAX_FRET = 15;
  const MIDI_LO = STRINGS[STRINGS.length - 1];        // 40 = E2（指板最低音）
  const MIDI_HI = STRINGS[0] + MAX_FRET;              // 79（15 品高音 e）
  const TOL_CENTS = 45;    // 判"弹对"的容差：±45 音分（半音的一半）
  const CONF_MIN = 0.78;   // 周期性不足的输入不冒充单音
  const SLOT_OPEN_MS = 150;   // 起音名额生效时刻：前 150ms 检测窗里还是旧音
  const SLOT_CLOSE_MS = 600;  // 名额作废时刻：一次拨弦只有一次判定机会

  // 与 style.css 同一套书页配色
  const C = {
    plate: '#ffffff', board: '#f7f7f4', ink: '#191919', ink2: '#60615e',
    ink3: '#858681', line: '#e9e9e5', line2: '#d8d9d3',
    clay: '#bd6447', clayDeep: '#9b4a34', sage: '#6f7d5c',
  };

  const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const nameOf = (m) => NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);

  // 五线谱音位：midi 唱名级数（C=0…B=6）与升号。黑键按升号记（F♯ 等），
  // 谱面位置由"自然音级 + 八度"决定，升号只影响 ♯ 记号
  const STAFF_LETTER = [
    { deg: 0, alter: 0 }, { deg: 0, alter: 1 }, { deg: 1, alter: 0 }, { deg: 1, alter: 1 },
    { deg: 2, alter: 0 }, { deg: 3, alter: 0 }, { deg: 3, alter: 1 }, { deg: 4, alter: 0 },
    { deg: 4, alter: 1 }, { deg: 5, alter: 0 }, { deg: 5, alter: 1 }, { deg: 6, alter: 0 },
  ];

  // 圆角矩形（老浏览器没有 ctx.roundRect 时的兜底）
  function _rr(g, x, y, w, h, r, fill, stroke) {
    g.beginPath();
    if (g.roundRect) g.roundRect(x, y, w, h, r);
    else {
      g.moveTo(x + r, y);
      g.arcTo(x + w, y, x + w, y + h, r);
      g.arcTo(x + w, y + h, x, y + h, r);
      g.arcTo(x, y + h, x, y, r);
      g.arcTo(x, y, x + w, y, r);
      g.closePath();
    }
    if (fill) { g.fillStyle = fill; g.fill(); }
    if (stroke) { g.strokeStyle = stroke; g.lineWidth = 1.2; g.stroke(); }
  }

  class Trainer {
    constructor(engine, ids, isActive) {
      this.engine = engine;
      this.cv = $(ids.canvas);
      this.g = this.cv.getContext('2d');
      this._dpr = global.devicePixelRatio || 1;
      this._isActive = isActive || (() => true);

      /* 练习设置 */
      this.root = 4;               // E —— 吉他手的第一条音阶：E 小调五声
      this.scale = 'minorPent';
      this.mode = 'explore';       // explore | quiz
      this.showLabels = true;
      this.sens = -48;             // 电平门限 dBFS，越小越灵敏

      /* 检测状态 */
      this.buf = new Float32Array(global.EngineNS.PITCH_FFT_SIZE);
      this.scratch = {};           // DSP 单音检测复用缓冲
      this.chordScratch = {};      // 和弦谱证据检测复用 FFT 缓冲
      this.onsets = new global.DSP.OnsetTracker();
      this.det = null;             // 最近一次有效检测 {hz, midiF, midi, cents, conf}
      this.hist = [];              // 最近 3 次检测的连续 midi 值
      this.stableMidi = null;
      this.holdMs = 0;             // 当前音已稳定多久
      this.silMs = 0;              // 已静音多久
      this.firedMidi = null;
      this.firedAt = 0;
      this._lastTick = 0;
      this._detTime = 0;

      /* 练习进度 */
      this.targets = [];           // 闯关序列（从低到高的调内音）
      this.tIdx = 0;
      this.round = 1;
      this.streak = 0;
      this.hits = 0;
      this.attempts = 0;
      this.anim = [];              // 弹对/弹错的扩散圆环动画
      this.hint = '选"麦克风 / 电吉他"连接真琴后弹奏；内置音源模式下点指板可试听';

      /* 乐谱跟弹状态 */
      this.score = null;           // ScoreNS 解析结果（六线谱/MusicXML）
      this.follower = null;
      this.scoreCursor = 0;        // 当前应弹事件下标
      this.bpm = 90;
      this.scoreAuto = null;       // 试听播放状态 {t0, beat0, idx}
      this._autoTimer = null;
      this._autoPending = [];      // 试听已调度的 setTimeout 句柄
      this._judgeCooldownUntil = 0; // 停止试听后的判定冷却（滤掉钢琴余音）
      this._flowBeat = 0;          // 乐谱流当前视口拍（带缓动）
      this._flowHits = new Map();  // 事件下标 → 命中时刻（乐谱流里的绿闪）
      this._pendingFire = false;   // 起音名额：一次拨弦 = 一次判定机会
      this._pendingFireAt = 0;
      this._chordSeen = new Set();
      this._chordStartAt = 0;
      this._chordFired = false;
      this._lastChordCheck = 0;
      this._metronomeTimer = null;
      this._metronomeNext = 0;

      this.ui = {
        detected: $(ids.detected), detHz: $(ids.detHz),
        target: $(ids.target), progress: $(ids.progress),
        streak: $(ids.streak), acc: $(ids.acc), hint: $(ids.hint),
      };
      this._wire(ids);
      this._buildScoreUi();
      this._rebuild();

      // 自驱动循环（~30Hz）：练琴检测不能依赖 rAF —— 窗口被遮挡时
      // rAF 会暂停而音频还在响，定时器仍会以可感知的频率触发。
      // 注意不检查 document.hidden：有些嵌入环境页面明明在显示却上报
      // hidden，守卫会把渲染整个拦死（指板变空白）；真隐藏时浏览器
      // 自动把定时器节流到 ≥1Hz，frame() 的开销可以忽略。
      this._timer = setInterval(() => {
        if (!this._isActive()) return;
        this.frame();
      }, 25);
    }

    /* ---------- 控件 ---------- */
    _wire(ids) {
      const rootSel = $(ids.root);
      rootSel.innerHTML = NOTE_NAMES.map((n, i) => `<option value="${i}">${n}</option>`).join('');
      rootSel.value = String(this.root);
      rootSel.addEventListener('change', () => { this.root = parseInt(rootSel.value, 10); this._rebuild(); });

      const scaleSel = $(ids.scale);
      scaleSel.innerHTML = Object.entries(SCALES).map(([k, s]) => `<option value="${k}">${s.name}</option>`).join('');
      scaleSel.value = this.scale;
      scaleSel.addEventListener('change', () => { this.scale = scaleSel.value; this._rebuild(); });

      $(ids.mode).addEventListener('change', (e) => { this.mode = e.target.value; this._rebuild(); });
      $(ids.labels).addEventListener('change', (e) => { this.showLabels = e.target.checked; });
      const sens = $(ids.sens);
      sens.addEventListener('input', () => {
        this.sens = parseFloat(sens.value);
        $(ids.sensVal).textContent = this.sens + ' dB';
      });
      $(ids.reset).addEventListener('click', () => this._rebuild());

      // 点指板 = 用内置钢琴音色弹那个位置：试听用，也能无琴体验全流程
      this.cv.addEventListener('pointerdown', (e) => {
        const pos = this._hitTest(e);
        if (!pos) return;
        const eng = this.engine;
        eng.resume();
        eng.noteOn('tb-click', midiHz(pos.midi), 'piano');
        const stop = () => eng.noteOff('tb-click');
        this.cv.addEventListener('pointerup', stop, { once: true });
        this.cv.addEventListener('pointerleave', stop, { once: true });
      });
    }

    /* ---------- 音阶 / 闯关序列 ---------- */
    _rebuild() {
      this._resetDetection();
      this.scalePcs = new Set(SCALES[this.scale].steps.map((s) => (this.root + s) % 12));
      let start = MIDI_LO;
      while (start % 12 !== this.root) start++;
      this.targets = [];
      for (let m = start; m <= MIDI_HI; m++) {
        if (this.scalePcs.has(m % 12)) this.targets.push(m);
      }
      this.tIdx = 0;
      this.round = 1;
      this.streak = 0;
      this.hits = 0;
      this.attempts = 0;
      this.anim.length = 0;
      if (this.mode === 'quiz') {
        this.hint = `依序从低到高弹出指板上闪烁的音：${NOTE_NAMES[this.root]} ${SCALES[this.scale].name}，共 ${this.targets.length} 个`;
      } else if (this.mode === 'score') {
        this._scoreStop(false);
        if (this.score) {
          this._scoreRestart();
          this.hint = '跟弹：指板上闪烁的就是下一个音（后两个音以淡环预览），弹对自动前进';
        } else {
          // 还没载入乐谱：弹回探索并打开载入窗
          this.mode = 'explore';
          const sel = $('tb-mode');
          if (sel) sel.value = 'explore';
          this._openScoreModal();
          this.hint = '先载入乐谱（六线谱文本或 MusicXML），再跟弹';
        }
      } else {
        this.hint = '自由弹：检测环绿色 = 在调内，深红 = 调外；根音是陶土色实心圆';
      }
      this._syncFlowVisible();
      this._updateStrip();
    }

    /* 乐谱流只在"跟弹模式 + 已载入乐谱"时显示 */
    _syncFlowVisible() {
      const on = this.mode === 'score' && this.score;
      if (this._flowCv) {
        this._flowCv.classList.toggle('hidden', !on);
      }
      const area = document.getElementById('viz-area');
      if (area) area.classList.toggle('scoring', !!on);   // 双谱带需要更高的图版
    }

    _inScale(midi) { return this.scalePcs.has(((midi % 12) + 12) % 12); }

    _positionsOf(midi) {
      const out = [];
      STRINGS.forEach((open, i) => {
        const f = midi - open;
        if (f >= 0 && f <= MAX_FRET) out.push({ string: i, fret: f, midi });
      });
      return out;
    }

    _resetDetection() {
      this.hist.length = 0;
      this.stableMidi = null;
      this.holdMs = 0;
      this.firedMidi = null;
      this._pendingFire = false;
      this.onsets.reset();
      this._chordSeen.clear();
      this._chordStartAt = 0;
      this._chordFired = false;
    }

    /* ---------- 每帧（仅指板页激活时被 main.js 调用） ---------- */
    frame() {
      const w = this.cv.clientWidth, h = this.cv.clientHeight;
      if (w < 10 || h < 10) return;              // 面板还藏着，等真正显示再画
      const dpr = global.devicePixelRatio || 1;
      const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
      if (this.cv.width !== bw || this.cv.height !== bh || this._dpr !== dpr) {
        this.cv.width = bw;
        this.cv.height = bh;
        this._dpr = dpr;
      }
      const now = performance.now();
      if (now - this._lastTick >= 22) {          // 检测约 40Hz，渲染每帧都跑
        this._lastTick = now;
        this._detect(now);
        if (this.mode === 'score' && !this.scoreAuto && this.follower) {
          const skipped = this.follower.tick(now);
          if (skipped) {
            this.scoreCursor = this.follower.cursor;
            this.hint = skipped.message;
          }
        }
        this._updateStrip();
      }
      this._render(now);
      if (this.mode === 'score' && this.score && !this._flowCv.classList.contains('hidden')) {
        this._renderFlow(now);
      }
    }

    /* 切回指板页时立刻做一次检测（否则要等一个节流间隔） */
    onShow() { this._lastTick = 0; }

    /* ---------- 测音 + 稳定判定 ---------- */
    _detect(now) {
      const eng = this.engine;
      const dt = Math.min(120, now - (this._detTime || now));
      this._detTime = now;
      if (!eng.pitchAnalyser) return;
      eng.pitchAnalyser.getFloatTimeDomainData(this.buf);
      // 尾部约 21ms 的电平用于起音；测音本身使用较长的周期窗。
      const recent = this.buf.subarray(Math.max(0, this.buf.length - 1024));
      const lvlNow = global.DSP.linToDb(global.DSP.rms(recent));
      const attack = this.onsets.update(lvlNow, now, this.sens);
      // 起音瞬间检测窗里新旧音混合，旧的稳定性读数全部作废：
      // 清空历史让新音从头积累 3 次一致检测，判定才跟得上节奏
      if (attack) {
        this.hist.length = 0;
        this.holdMs = 0;
        this.stableMidi = null;
        this._pendingFire = true;    // 发放判定名额
        this._pendingFireAt = now;
        this._chordSeen.clear();
        this._chordStartAt = now;
        this._chordFired = false;
      }
      this._checkChord(now, lvlNow);
      if (lvlNow < this.sens) { this._silence(dt); return; }
      const res = global.DSP.detectPitch(this.buf, eng.sampleRate, this.scratch, { gateDb: this.sens });
      if (!res || res.conf < CONF_MIN) { this._silence(dt); return; }
      const midiF = 69 + 12 * Math.log2(res.hz / 440);
      this.det = {
        hz: res.hz, midiF, midi: Math.round(midiF),
        cents: Math.round((midiF - Math.round(midiF)) * 100), conf: res.conf,
      };
      this.silMs = 0;
      // 稳定判定：最近 3 次检测互相相差 < 40 音分，才算"这个音站稳了"。
      // 起音瞬间的噪声、换音的滑音都过不了这道门。
      this.hist.push(midiF);
      if (this.hist.length > 3) this.hist.shift();
      if (this.hist.length === 3) {
        const xs = [...this.hist].sort((a, b) => a - b);
        if ((xs[2] - xs[0]) * 100 < 40) {
          const midi = Math.round(xs[1]);
          if (midi === this.stableMidi) this.holdMs += dt;
          else { this.stableMidi = midi; this.holdMs = dt; }
          // 判定触发：换音（midi 变化）直接判；同音重弹（小星星的 C C）
          // 消耗"起音名额"——名额在起音 150ms 后生效（之前检测窗里还是
          // 旧音的混合读数）、600ms 后作废，且用掉即关闭：一次拨弦
          // 数学上只可能触发一次判定，按住不放不会连发。
          const slotValid = this._pendingFire &&
            now - this._pendingFireAt >= SLOT_OPEN_MS &&
            now - this._pendingFireAt <= SLOT_CLOSE_MS;
          if (this.holdMs >= 80 && (midi !== this.firedMidi || slotValid)) {
            this._pendingFire = false;
            this.firedMidi = midi;
            this.firedAt = now;
            this._onNote({
              midi, midiF: xs[1], cents: Math.round((xs[1] - midi) * 100),
              onsetMs: slotValid ? this._pendingFireAt : now - 80,
              onsetReliable: slotValid, confirmedMs: now,
            });
          }
        } else {
          this.stableMidi = null;
          this.holdMs = 0;
        }
      }
    }
    _silence(dt) {
      this.silMs += dt;
      if (this.silMs > 160) {
        if (this.follower?.active) {
          const feedback = this.follower.release(performance.now() - this.silMs + 120);
          if (feedback) this.hint = feedback.message;
        }
        this.det = null;
        this.stableMidi = null;
        this.holdMs = 0;
        this.hist.length = 0;
        this.firedMidi = null;   // 松手后允许重新触发同一个音
      }
    }

    _checkChord(now, levelDb) {
      if (this.mode !== 'score' || !this.score || this.scoreAuto ||
          now < this._judgeCooldownUntil || this._chordFired ||
          !this._chordStartAt || now - this._chordStartAt > 750 ||
          now - this._lastChordCheck < 65 || levelDb < this.sens) return;
      const ev = this.follower?.current;
      if (!ev || ev.midis.length < 2) return;
      this._lastChordCheck = now;
      const recent = this.buf.subarray(Math.max(0, this.buf.length - 8192));
      const evidence = global.DSP.detectChord(recent, this.engine.sampleRate, ev.midis,
        this.chordScratch, { gateDb: this.sens });
      if (!evidence) return;
      for (const m of evidence.present) this._chordSeen.add(((m % 12) + 12) % 12);
      const targetPcs = new Set(ev.midis.map((m) => ((m % 12) + 12) % 12));
      const missing = ev.midis.filter((m) => !this._chordSeen.has(((m % 12) + 12) % 12));
      if (evidence.ambiguous || targetPcs.size < 2) {
        this.hint = '这个和弦只有同一音级的八度音，单路音频无法确认全部弦；可点「跳过当前音」继续';
        return;
      }
      if (missing.length) {
        this.hint = `和弦已听到 ${[...this._chordSeen].map((p) => NOTE_NAMES[p]).join('、') || '—'}；还缺 ${[...new Set(missing)].map(nameOf).join('、')}`;
        return;
      }
      this._chordFired = true;
      this._pendingFire = false;
      this._gradeScore({ chordComplete: true, midis: ev.midis, onsetMs: this._chordStartAt,
        onsetReliable: true }, ev.notes);
    }

    _gradeScore(note, positions) {
      if (!this.follower || this.scoreAuto || performance.now() < this._judgeCooldownUntil) return;
      const result = this.follower.ingest(note);
      if (result.kind === 'hit' && !note.chordComplete) {
        this._chordSeen.clear();
        this._chordStartAt = 0; // 下一个和弦必须等自己的新起音
      }
      this.scoreCursor = this.follower.cursor;
      this.hits = this.follower.hits;
      this.attempts = this.follower.attempts;
      this.streak = result.kind === 'hit' ? this.streak + 1 : result.kind === 'wrong' ? 0 : this.streak;
      if (result.kind === 'hit') {
        this._flowHits.set(result.index, performance.now());
        this.anim.push({ positions, t0: performance.now(), kind: 'good' });
      } else if (result.kind === 'wrong') {
        this.anim.push({ positions, t0: performance.now(), kind: 'bad' });
      }
      this.hint = result.message;
    }

    /* ---------- 一次"站稳的音" → 判定 ---------- */
    _onNote(note) {
      const midi = note.midi;
      const positions = this._positionsOf(midi);
      if (this.mode === 'quiz' && this.targets.length) {
        this.attempts++;
        const target = this.targets[this.tIdx];
        if (Math.abs(note.midiF - target) * 100 <= TOL_CENTS) {
          this.hits++;
          this.streak++;
          this.anim.push({ positions, t0: performance.now(), kind: 'good' });
          this.tIdx++;
          if (this.tIdx >= this.targets.length) {
            this.tIdx = 0;
            this.round++;
            this.hint = `第 ${this.round - 1} 轮音阶全部弹对！新一轮开始`;
          } else {
            this.hint = `对了！下一个：${nameOf(this.targets[this.tIdx])}`;
          }
        } else {
          this.streak = 0;
          this.anim.push({ positions, t0: performance.now(), kind: 'bad' });
          this.hint = `弹了 ${nameOf(midi)}，目标是 ${nameOf(target)} —— 弹指板上闪烁的那个音`;
        }
      } else if (this.mode === 'score' && this.score) {
        if (this._chordFired) return; // 和弦余音不能误判为下一个单音
        const ev = this.follower?.current;
        if (!ev) return;
        if (ev.midis.length > 1) return; // 和弦必须走完整音集合证据判定
        this._gradeScore(note, positions);
      } else {
        const inS = this._inScale(midi);
        this.anim.push({ positions, t0: performance.now(), kind: inS ? 'good' : 'bad' });
        this.hint = inS
          ? `${nameOf(midi)} 在 ${NOTE_NAMES[this.root]} ${SCALES[this.scale].name} 内`
          : `${nameOf(midi)} 不在 ${NOTE_NAMES[this.root]} ${SCALES[this.scale].name} 内`;
      }
    }

    /* ---------- 顶部读数条 ---------- */
    _updateStrip() {
      const u = this.ui;
      if (this.det && this.silMs < 160) {
        const n = global.DSP.noteName(this.det.hz);
        u.detected.textContent = n ? n.name + n.octave : nameOf(this.det.midi);
        u.detHz.textContent = this.det.hz.toFixed(1) + ' Hz · ' +
          (this.det.cents >= 0 ? '+' : '') + this.det.cents + '¢';
      } else {
        u.detected.textContent = '—';
        u.detHz.textContent = this.engine.mic ? '等待弹奏…' : '未连接输入';
      }
      if (this.mode === 'quiz' && this.targets.length) {
        u.target.textContent = nameOf(this.targets[this.tIdx]);
        u.progress.textContent = `第 ${this.tIdx + 1}/${this.targets.length} 音 · 第 ${this.round} 轮`;
      } else if (this.mode === 'score' && this.score) {
        const evs = this.score.events;
        const ev = evs[this.scoreCursor];
        const m = ev ? ev.measure : this.score.measures - 1;
        u.target.textContent = ev ? ev.midis.map(nameOf).join('+') : '—';
        u.progress.textContent =
          `第 ${Math.min(m + 1, this.score.measures)}/${this.score.measures} 小节 · ` +
          (ev ? `第 ${this.scoreCursor + 1}/${evs.length} 音` : `已完成 ${evs.length}/${evs.length} 音`);
        // 和弦手型卡随小节切换重画；进度条按拍推进
        if (m !== this._lastChordMeasure) {
          this._lastChordMeasure = m;
          this._drawScoreChords(m);
        }
        const beat = ev ? ev.startBeat : this.score.totalBeats;
        this._scoreEls.bar.style.width =
          Math.min(100, (beat / Math.max(1, this.score.totalBeats)) * 100) + '%';
        if (this.follower?.mode === 'tempo' && this.follower.startMs != null &&
            performance.now() < this.follower.startMs) {
          const left = Math.ceil((this.follower.startMs - performance.now()) * this.bpm / 60000);
          u.progress.textContent += ` · 倒数 ${left} 拍`;
        }
      } else {
        u.target.textContent = '—';
        u.progress.textContent = '探索模式';
      }
      u.streak.textContent = String(this.streak);
      const judged = this.attempts + (this.mode === 'score' ? this.follower?.skipped || 0 : 0);
      u.acc.textContent = judged ? Math.round((this.hits / judged) * 100) + '%' : '—';
      u.hint.textContent = this.hint;
    }

    /* ---------- 指板几何 ---------- */
    _geom() {
      const dpr = this._dpr, W = this.cv.width, H = this.cv.height;
      const x0 = 62 * dpr;                       // 琴枕位置
      const x1 = W - 18 * dpr;
      const padT = 16 * dpr, padB = 30 * dpr;
      // 真实品格间距：第 n 品在 L·(1-2^(-n/12))，高把位越来越密
      const L = (x1 - x0) / (1 - Math.pow(2, -MAX_FRET / 12));
      const xf = (n) => x0 + L * (1 - Math.pow(2, -n / 12));
      const boardH = H - padT - padB;
      const ys = STRINGS.map((_, i) => padT + ((i + 0.5) * boardH) / 6);
      const openX = x0 - 26 * dpr;
      // 半径必须 ≥0：面板被乐谱条/乐谱流挤压时 boardH 可能变成负数，
      // 负半径会让 arc() 抛 IndexSizeError，整个渲染循环每帧崩掉
      const r = Math.max(3 * dpr, Math.min(12 * dpr, (boardH / 6) * 0.4));
      return { W, H, dpr, x0, x1, padT, padB, boardH, xf, ys, openX, r };
    }
    _cx(fret, geo) {
      return fret === 0 ? geo.openX : (geo.xf(fret - 1) + geo.xf(fret)) / 2;
    }

    /* ---------- 渲染 ---------- */
    _render(now) {
      const g = this.g;
      const geo = this._geom();
      const { W, H, dpr } = geo;
      g.clearRect(0, 0, W, H);
      const by = geo.padT, bh = geo.boardH;

      // 高度被挤压到画不下音名时，只给一句提示，别硬画
      if (geo.boardH < 30 * dpr) {
        g.fillStyle = C.ink3;
        g.font = `${Math.round(12 * dpr)}px Georgia, "Songti SC", SimSun, serif`;
        g.textAlign = 'center';
        g.fillText('指板区域太小 —— 收起一排面板或放大窗口', W / 2, H / 2);
        g.textAlign = 'center';
        for (let f = 1; f <= MAX_FRET; f++) {
          g.fillText(String(f), this._cx(f, geo), H - 8 * dpr);
        }
        return;
      }

      // 指板底
      g.fillStyle = C.board;
      g.fillRect(geo.x0, by, geo.x1 - geo.x0, bh);
      g.strokeStyle = C.line2;
      g.lineWidth = 1;
      g.strokeRect(geo.x0 + 0.5, by + 0.5, geo.x1 - geo.x0 - 1, bh - 1);

      // 品记（圆点）：3/5/7/9 单点，12 品双点
      g.fillStyle = C.ink3;
      for (const f of [3, 5, 7, 9, 12]) {
        const cx = (geo.xf(f - 1) + geo.xf(f)) / 2;
        const dots = f === 12 ? [0.3, 0.7] : [0.5];
        for (const t of dots) {
          g.beginPath();
          g.arc(cx, by + bh * t, 4.2 * dpr, 0, Math.PI * 2);
          g.fill();
        }
      }

      // 品丝 + 琴枕
      g.strokeStyle = C.ink3;
      g.lineWidth = 1;
      for (let n = 1; n <= MAX_FRET; n++) {
        const x = Math.round(geo.xf(n)) + 0.5;
        g.beginPath();
        g.moveTo(x, by);
        g.lineTo(x, by + bh);
        g.stroke();
      }
      g.fillStyle = C.ink;
      g.fillRect(geo.x0 - 2.5 * dpr, by, 3 * dpr, bh);

      // 琴弦：1 弦最细在顶、6 弦最粗在底（看谱的习惯）
      STRINGS.forEach((_, i) => {
        g.strokeStyle = 'rgba(33,30,25,0.78)';
        g.lineWidth = (0.8 + i * 0.55) * dpr;
        g.beginPath();
        g.moveTo(geo.x0, geo.ys[i]);
        g.lineTo(geo.x1, geo.ys[i]);
        g.stroke();
      });

      // 弦名 + 调外空弦音的淡字
      g.font = `${Math.round(11 * dpr)}px ${SERIF}`;
      g.textBaseline = 'middle';
      STRINGS.forEach((open, i) => {
        g.fillStyle = C.ink2;
        g.textAlign = 'left';
        g.fillText(STRING_LABELS[i], 10 * dpr, geo.ys[i]);
        if (!this._inScale(open)) {
          g.fillStyle = C.ink3;
          g.textAlign = 'center';
          g.fillText(NOTE_NAMES[open % 12], geo.openX, geo.ys[i]);
        }
      });

      // 调内音标记：根音 = 陶土实心，其余 = 纸底描边
      for (let i = 0; i < STRINGS.length; i++) {
        for (let f = 0; f <= MAX_FRET; f++) {
          const midi = STRINGS[i] + f;
          if (!this._inScale(midi)) continue;
          const cx = this._cx(f, geo), cy = geo.ys[i];
          const isRoot = midi % 12 === this.root;
          g.beginPath();
          g.arc(cx, cy, geo.r, 0, Math.PI * 2);
          g.fillStyle = isRoot ? C.clay : C.plate;
          g.fill();
          g.strokeStyle = isRoot ? C.clayDeep : C.line2;
          g.lineWidth = 1 * dpr;
          g.stroke();
          if (this.showLabels) {
            g.fillStyle = isRoot ? '#fdf9f0' : C.ink;
            g.font = `${Math.round(9.5 * dpr)}px ${SERIF}`;
            g.textAlign = 'center';
            g.fillText(NOTE_NAMES[midi % 12], cx, cy + 0.5 * dpr);
          }
        }
      }

      // 闯关目标：陶土色脉冲环（同音高的所有位置都会闪，弹哪个都行）
      if (this.mode === 'quiz' && this.targets.length) {
        const pulse = 1 + 0.1 * Math.sin(now / 160);
        g.strokeStyle = C.clay;
        g.lineWidth = 2.4 * dpr;
        for (const p of this._positionsOf(this.targets[this.tIdx])) {
          g.beginPath();
          g.arc(this._cx(p.fret, geo), geo.ys[p.string], geo.r * pulse + 2 * dpr, 0, Math.PI * 2);
          g.stroke();
        }
      }

      // 乐谱跟弹：当前要弹的音（脉冲环）+ 后两个事件预览（淡环，越来越淡）
      if (this.mode === 'score' && this.score && this.scoreCursor < this.score.events.length) {
        const evs = this.score.events;
        const cur = evs[this.scoreCursor];
        const pulse = 1 + 0.1 * Math.sin(now / 160);
        g.strokeStyle = C.clay;
        g.lineWidth = 2.4 * dpr;
        for (const n of cur.notes) {
          g.beginPath();
          g.arc(this._cx(n.fret, geo), geo.ys[n.string], geo.r * pulse + 2 * dpr, 0, Math.PI * 2);
          g.stroke();
        }
        for (let k = 1; k <= 2; k++) {
          const up = evs[this.scoreCursor + k];
          if (!up) break;
          g.strokeStyle = C.ink3;
          g.globalAlpha = 0.55 / k;
          g.lineWidth = 1.4 * dpr;
          for (const n of up.notes) {
            g.beginPath();
            g.arc(this._cx(n.fret, geo), geo.ys[n.string], geo.r - 2 * dpr, 0, Math.PI * 2);
            g.stroke();
          }
          g.globalAlpha = 1;
        }
      }

      // 检测环：最近检测到的音在指板上的位置
      if (this.det && this.silMs < 160) {
        const d = this.det;
        const good = this.mode === 'quiz' && this.targets.length
          ? d.midi === this.targets[this.tIdx]
          : this._inScale(d.midi);
        const col = good ? C.sage : C.clayDeep;
        const ps = this._positionsOf(d.midi);
        g.strokeStyle = col;
        g.lineWidth = 2.6 * dpr;
        for (const p of ps) {
          g.beginPath();
          g.arc(this._cx(p.fret, geo), geo.ys[p.string], geo.r + 2.5 * dpr, 0, Math.PI * 2);
          g.stroke();
        }
        if (ps.length) {   // 音名 + 音分标注（顶行弦放下方，其余放上方）
          const cy = geo.ys[ps[0].string];
          const ly = ps[0].string === 0 ? cy + geo.r + 14 * dpr : cy - geo.r - 6 * dpr;
          g.fillStyle = col;
          g.font = `${Math.round(10.5 * dpr)}px ${SERIF}`;
          g.textAlign = 'center';
          g.fillText(nameOf(d.midi) + (d.cents >= 0 ? ' +' : ' ') + d.cents + '¢',
            this._cx(ps[0].fret, geo), ly);
        }
      }

      // 弹对/弹错的扩散圆环
      this.anim = this.anim.filter((a) => now - a.t0 < 650);
      for (const a of this.anim) {
        const k = (now - a.t0) / 650;
        g.strokeStyle = a.kind === 'good' ? C.sage : C.clayDeep;
        g.globalAlpha = 1 - k;
        g.lineWidth = 2.2 * dpr;
        for (const p of a.positions) {
          g.beginPath();
          g.arc(this._cx(p.fret, geo), geo.ys[p.string], geo.r * (1 + 1.7 * k), 0, Math.PI * 2);
          g.stroke();
        }
        g.globalAlpha = 1;
      }

      // 品号
      g.textBaseline = 'alphabetic';
      g.textAlign = 'center';
      for (let f = 1; f <= MAX_FRET; f++) {
        const major = f === 3 || f === 5 || f === 7 || f === 9 || f === 12;
        g.fillStyle = major ? C.ink2 : C.ink3;
        g.font = `${Math.round((major ? 10.5 : 9) * dpr)}px ${SERIF}`;
        g.fillText(String(f), this._cx(f, geo), H - 10 * dpr);
      }
    }

    /* ---------- 点击命中最靠近的品格位置 ---------- */
    _hitTest(e) {
      const rect = this.cv.getBoundingClientRect();
      const x = (e.clientX - rect.left) * (this.cv.width / rect.width);
      const y = (e.clientY - rect.top) * (this.cv.height / rect.height);
      const geo = this._geom();
      let best = null, bd = Infinity;
      for (let i = 0; i < STRINGS.length; i++) {
        for (let f = 0; f <= MAX_FRET; f++) {
          const d = Math.hypot(x - this._cx(f, geo), y - geo.ys[i]);
          if (d < bd) { bd = d; best = { string: i, fret: f, midi: STRINGS[i] + f }; }
        }
      }
      return bd < geo.r * 2 ? best : null;
    }

    /* ============================================================
     * 乐谱跟弹：载入条 / 载入弹窗 / 试听播放 / 和弦手型卡
     * ============================================================ */
    _buildScoreUi() {
      const d = (tag, cls, html) => {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (html != null) e.innerHTML = html;
        return e;
      };
      // "载入乐谱"按钮加入控制行
      const ctrl = $('trainer-ctrl');
      this._btnScore = d('button', 'btn', '载入乐谱');
      this._btnScore.title = '六线谱文本（粘贴）或 MusicXML 五线谱文件';
      ctrl.appendChild(this._btnScore);
      // 乐谱条：插在控制条与画布之间，载入乐谱后才显示
      const wrap = $('fretboard-wrap');
      const strip = d('div', 'hidden');
      strip.id = 'score-strip';
      strip.innerHTML =
        '<div class="ss-transport">' +
        '<button class="btn" data-act="play">从头试听</button>' +
        '<button class="btn" data-act="stop">停止</button>' +
        '<button class="btn" data-act="restart">回开头</button>' +
        '<label>跟弹 <select class="ss-follow"><option value="free">自由跟弹</option><option value="tempo">节拍跟弹</option></select></label>' +
        '<button class="btn" data-act="start">开始节拍跟弹</button>' +
        '<button class="btn" data-act="skip">跳过当前音</button>' +
        '<label>速度 <input class="ss-bpm" type="range" min="30" max="300" step="5" value="90">' +
        '<b class="val">90</b></label>' +
        '<label>输入补偿 <input class="ss-latency" type="range" min="0" max="250" step="5" value="0">' +
        '<b class="ss-latency-val">0 ms</b></label>' +
        '<span class="ss-info"></span>' +
        '</div>' +
        '<div class="ss-body">' +
        '<div class="ss-chords"></div>' +
        '<div class="ss-progress-wrap"><div class="ss-progress"><div></div></div></div>' +
        '</div>';
      const readout = $('trainer-strip');
      wrap.insertBefore(strip, readout);
      // 乐谱流置于实时读数之前，形成「谱面 → 反馈 → 指板」的阅读顺序
      const flow = d('canvas');
      flow.id = 'canvas-scoreflow';
      flow.className = 'hidden';
      wrap.insertBefore(flow, readout);
      this._flowCv = flow;
      this._flowG = flow.getContext('2d');
      this._scoreEls = {
        strip,
        play: strip.querySelector('[data-act=play]'),
        stop: strip.querySelector('[data-act=stop]'),
        restart: strip.querySelector('[data-act=restart]'),
        start: strip.querySelector('[data-act=start]'),
        skip: strip.querySelector('[data-act=skip]'),
        follow: strip.querySelector('.ss-follow'),
        bpm: strip.querySelector('.ss-bpm'),
        bpmVal: strip.querySelector('.ss-transport .val'),
        latency: strip.querySelector('.ss-latency'),
        latencyVal: strip.querySelector('.ss-latency-val'),
        info: strip.querySelector('.ss-info'),
        chords: strip.querySelector('.ss-chords'),
        bar: strip.querySelector('.ss-progress > div'),
      };
      this._scoreEls.play.addEventListener('click', () => this._scorePlay(true));
      this._scoreEls.stop.addEventListener('click', () => this._scoreStop(true));
      this._scoreEls.restart.addEventListener('click', () => { this._scoreRestart(); });
      this._scoreEls.start.addEventListener('click', () => this._startPractice());
      this._scoreEls.skip.addEventListener('click', () => {
        if (!this.follower || this.follower.done || this.scoreAuto) return;
        const i = this.follower.cursor++;
        this.follower.results.set(i, { kind: 'skipped' });
        this.follower.skipped++;
        this.scoreCursor = this.follower.cursor;
        this._resetDetection();
        this.hint = this.follower.done ? '已到曲末' : '已跳过；下一个：' + this.follower.current.midis.map(nameOf).join(' + ');
      });
      this._scoreEls.follow.addEventListener('change', () => {
        if (this.follower) { this.follower.mode = this._scoreEls.follow.value; this._scoreRestart(); }
      });
      this._scoreEls.bpm.addEventListener('input', () => {
        this.bpm = parseFloat(this._scoreEls.bpm.value);
        this._scoreEls.bpmVal.textContent = String(Math.round(this.bpm));
        if (this.follower) this.follower.bpm = this.bpm;
        if (this.follower?.mode === 'tempo' && this.follower.startMs != null) {
          this._scoreRestart();
          this.hint = '速度已更改；请重新点「开始节拍跟弹」';
        }
      });
      this._scoreEls.latency.addEventListener('input', () => {
        const ms = parseFloat(this._scoreEls.latency.value);
        this._scoreEls.latencyVal.textContent = ms + ' ms';
        if (this.follower) this.follower.latencyMs = ms;
      });
      this._btnScore.addEventListener('click', () => this._openScoreModal());
      // 载入弹窗
      const modal = d('div', 'hidden');
      modal.id = 'score-modal';
      modal.innerHTML =
        '<div class="modal-panel">' +
        '<button class="btn close">关闭</button>' +
        '<h2>载入乐谱：六线谱文本 或 五线谱 MusicXML</h2>' +
        '<p><b>六线谱</b>：从 Ultimate Guitar 等直接复制 e|---3---| 形式的文本粘贴到下面，' +
        '和弦名行（如 "Am  F  C  G"）会自动对应到小节。' +
        '<b>五线谱</b>：用 MuseScore / Guitar Pro / Sibelius 导出 <b>MusicXML</b>（.musicxml / .xml），' +
        '自动读音高、时值与和弦记号，程序按"最小手部移动"把音映射到指板。</p>' +
        '<p class="hint">扫描版图片的乐谱识别（OMR）需要专门的模型服务，离线网页做不了——' +
        '可先用 MuseScore 等打开图片对照录入，再导出 MusicXML。</p>' +
        '<input type="file" accept=".musicxml,.xml,.txt" class="hidden">' +
        '<div class="row" style="margin:8px 0">' +
        '<button class="btn" data-act="file">选择 MusicXML / 文本文件</button>' +
        '<button class="btn" data-act="sample">示例：Am 琶音</button>' +
        '<button class="btn" data-act="twinkle">示例：小星星</button>' +
        '<button class="btn" data-act="maru-strum">丸之内 · 弹唱扫弦</button>' +
        '<button class="btn" data-act="maru-finger">丸之内 · 指弹琶音</button>' +
        '<button class="btn primary" data-act="parse">解析并载入</button></div>' +
        '<textarea placeholder="粘贴六线谱文本（e|---3---|）…"></textarea>' +
        '</div>';
      document.body.appendChild(modal);
      this._modalEls = {
        modal,
        close: modal.querySelector('.close'),
        fileInput: modal.querySelector('input[type=file]'),
        fileBtn: modal.querySelector('[data-act=file]'),
        sampleBtn: modal.querySelector('[data-act=sample]'),
        twinkleBtn: modal.querySelector('[data-act=twinkle]'),
        maruStrumBtn: modal.querySelector('[data-act=maru-strum]'),
        maruFingerBtn: modal.querySelector('[data-act=maru-finger]'),
        parseBtn: modal.querySelector('[data-act=parse]'),
        textarea: modal.querySelector('textarea'),
      };
      this._modalEls.close.addEventListener('click', () => modal.classList.add('hidden'));
      modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });
      this._modalEls.fileBtn.addEventListener('click', () => this._modalEls.fileInput.click());
      this._modalEls.fileInput.addEventListener('change', async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        this._modalEls.textarea.value = await f.text();
        this._tryLoad(this._modalEls.textarea.value);
        e.target.value = '';
      });
      this._modalEls.sampleBtn.addEventListener('click', () => {
        this._modalEls.textarea.value = ScoreNS.SAMPLE_TAB;
      });
      this._modalEls.twinkleBtn.addEventListener('click', () => {
        this._modalEls.textarea.value = ScoreNS.SAMPLE_TWINKLE;
        this._tryLoad(ScoreNS.SAMPLE_TWINKLE);
      });
      this._modalEls.maruStrumBtn.addEventListener('click', () => {
        this._modalEls.textarea.value = ScoreNS.SAMPLE_MARU_STRUM;
        this._tryLoad(ScoreNS.SAMPLE_MARU_STRUM);
      });
      this._modalEls.maruFingerBtn.addEventListener('click', () => {
        this._modalEls.textarea.value = ScoreNS.SAMPLE_MARU_FINGER;
        this._tryLoad(ScoreNS.SAMPLE_MARU_FINGER);
      });
      this._modalEls.parseBtn.addEventListener('click', () => this._tryLoad(this._modalEls.textarea.value));
      // 全停 / Esc 顺带停掉试听调度
      $('btn-panic').addEventListener('click', () => this._scoreStop(true));
      global.addEventListener('keydown', (e) => { if (e.key === 'Escape') this._scoreStop(false); });
    }

    _openScoreModal() {
      this._modalEls.modal.classList.remove('hidden');
    }

    /* 解析并载入乐谱：按内容自动判断格式 */
    _tryLoad(text) {
      const snip = (text || '').trim();
      if (!snip) {
        this.hint = '乐谱为空：粘贴六线谱文本，或选择 MusicXML 文件';
        this._updateStrip();
        return;
      }
      const isXml = snip.startsWith('<?xml') || snip.includes('<score-partwise') || snip.includes('<score-timewise');
      const score = isXml
        ? ScoreNS.parseMusicXml(snip, STRINGS, MAX_FRET)
        : ScoreNS.parseTabText(snip, STRINGS, MAX_FRET);
      if (!score || score.error) {
        this.hint = '乐谱解析失败：' + ((score && score.error) || '未知错误');
        this._updateStrip();
        return;
      }
      if (!score.events.length) {
        const skip = score.stats && score.stats.skipped
          ? `（${score.stats.skipped} 个音超出 ${MAX_FRET} 品被跳过）` : '';
        this.hint = '解析到 0 个可弹音符' + skip;
        this._updateStrip();
        return;
      }
      this._scoreStop(false);
      this.score = score;
      this.follower = new global.PracticeNS.ScoreFollower(score, {
        mode: this._scoreEls.follow.value, bpm: this.bpm,
        latencyMs: parseFloat(this._scoreEls.latency.value),
      });
      this._lastChordMeasure = -1;
      this._scoreRestart();
      this._scoreEls.strip.classList.remove('hidden');
      this._syncFlowVisible();
      this._modalEls.modal.classList.add('hidden');
      // 自动切到跟弹模式（_rebuild 会再跑一次 _scoreRestart，无副作用）
      const modeSel = $('tb-mode');
      if (modeSel.value !== 'score') {
        modeSel.value = 'score';
        modeSel.dispatchEvent(new Event('change'));
      }
      const parts = [
        score.title || (score.source === 'xml' ? 'MusicXML 乐谱' : '六线谱'),
        `${score.measures} 小节 · ${score.events.length} 音符`,
        score.chords.length ? '和弦 ' + score.chords.slice(0, 8).join(' ') : '',
        score.bpm ? score.bpm + ' BPM' : '',
        score.stats.skipped ? `跳过 ${score.stats.skipped} 个不可弹音` : '',
      ];
      this._scoreEls.info.textContent = parts.filter(Boolean).join(' · ');
      if (score.bpm) {   // 谱面标题带 BPM → 应用到试听速度
        this.bpm = score.bpm;
        this._scoreEls.bpm.value = String(score.bpm);
        this._scoreEls.bpmVal.textContent = String(score.bpm);
        this.follower.bpm = score.bpm;
      }
      this.hint = '自由跟弹：弹对谱流随你移动；节拍跟弹请点「开始节拍跟弹」';
      this._updateStrip();
    }

    _scoreRestart() {
      this._scoreStop(false);
      this._resetDetection();
      if (this.follower) this.follower.reset();
      this.scoreCursor = 0;
      this._lastChordMeasure = -1;
      this._flowBeat = 0;
      this._flowHits.clear();
      this.streak = 0;
      this.hits = 0;
      this.attempts = 0;
      this.anim.length = 0;
      this._updateStrip();
    }

    async _startPractice() {
      if (!this.follower || !this.score) return;
      this._scoreRestart();
      if (this.follower.mode !== 'tempo') {
        this.hint = '自由跟弹已就绪：按自己的速度弹奏';
        return;
      }
      await this.engine.resume();
      if (this.engine.ctx.state && this.engine.ctx.state !== 'running') {
        this.hint = '音频尚未启动，请再次点击开始';
        return;
      }
      this.follower.bpm = this.bpm;
      const startMs = this.follower.start(performance.now(), 4);
      this._startMetronome(startMs);
      this.hint = '四拍倒数后开始；节拍声和谱面拍位作为早晚判定基准';
    }

    _startMetronome(startMs) {
      this._stopMetronome();
      const ctx = this.engine.ctx;
      const baseCtx = ctx.currentTime + (startMs - performance.now()) / 1000;
      const seconds = 60 / this.bpm;
      this._metronomeNext = -4;
      const schedule = () => {
        if (!this.follower?.startMs || this.mode !== 'score') { this._stopMetronome(); return; }
        while (this._metronomeNext * seconds + baseCtx < ctx.currentTime + 0.4 &&
               this._metronomeNext < Math.ceil(this.score.totalBeats)) {
          const beat = this._metronomeNext++;
          const at = baseCtx + beat * seconds;
          if (at < ctx.currentTime - 0.05) continue;
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.frequency.value = beat % 4 === 0 ? 1100 : 780;
          gain.gain.setValueAtTime(0.0001, at);
          gain.gain.exponentialRampToValueAtTime(0.045, at + 0.003);
          gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.045);
          osc.connect(gain).connect(ctx.destination);
          osc.start(at);
          osc.stop(at + 0.05);
          osc.onended = () => { osc.disconnect(); gain.disconnect(); };
        }
        if (this._metronomeNext >= Math.ceil(this.score.totalBeats)) this._stopMetronome();
      };
      this._metronomeTimer = setInterval(schedule, 100);
      schedule();
    }

    _stopMetronome() {
      if (this._metronomeTimer) clearInterval(this._metronomeTimer);
      this._metronomeTimer = null;
    }

    /* 从当前游标开始自动播放（内置钢琴音色，速度 = 速度滑杆） */
    _scorePlay(fromStart) {
      if (!this.score || !this.score.events.length) return;
      this.engine.resume();
      this._scoreStop(false);
      if (fromStart) this._scoreRestart();
      if (this.follower?.mode === 'tempo') this.follower.startMs = null;
      const evs = this.score.events;
      const startBeat = this.scoreCursor < evs.length ? evs[this.scoreCursor].startBeat : 0;
      this.scoreAuto = { t0: this.engine.ctx.currentTime + 0.25, beat0: startBeat, idx: this.scoreCursor };
      this._autoTimer = setInterval(() => this._autoTick(), 80);
      this._autoTick();
      this.hint = '试听中：程序自动播放，游标随播放前进；点"停止"后轮到你跟弹';
      this._updateStrip();
    }

    _autoTick() {
      const a = this.scoreAuto;
      if (!a || !this.score) return;
      const ctx = this.engine.ctx;
      const evs = this.score.events;
      const beatNow = (ctx.currentTime - a.t0) * this.bpm / 60 + a.beat0;
      // 把 lookahead（0.5 拍）内的音符按准确时刻调度出去
      while (a.idx < evs.length && evs[a.idx].startBeat <= beatNow + 0.5) {
        const ev = evs[a.idx];
        const delayMs = Math.max(0, (a.t0 + (ev.startBeat - a.beat0) * 60 / this.bpm - ctx.currentTime) * 1000);
        const key = 'auto-' + a.idx;
        const id = setTimeout(() => {
          if (!this.scoreAuto) return;
          for (const n of ev.notes) this.engine.noteOn(key + '-' + n.string, midiHz(n.midi), 'piano');
          const offId = setTimeout(() => {
            for (const n of ev.notes) this.engine.noteOff(key + '-' + n.string);
          }, Math.max(250, ev.durBeats * 60000 / this.bpm));
          this._autoPending.push({ key, offId });
        }, delayMs);
        this._autoPending.push({ id });
        a.idx++;
      }
      // 显示游标随播放推进
      let c = 0;
      while (c < evs.length && evs[c].startBeat <= beatNow) c++;
      this.scoreCursor = Math.min(c, evs.length);
      const last = evs[evs.length - 1];
      if (beatNow > last.startBeat + last.durBeats + 1) {
        this._scoreStop(true);
        this.hint = '试听结束 —— 现在轮到你跟弹了';
      }
      this._updateStrip();
    }

    _scoreStop(showHint) {
      const wasPlaying = !!this.scoreAuto || this._autoTimer != null;
      this._stopMetronome();
      if (this._autoTimer) { clearInterval(this._autoTimer); this._autoTimer = null; }
      this.scoreAuto = null;
      if (wasPlaying && this.follower) this.scoreCursor = this.follower.cursor;
      // 余音冷却：停止后琴声还要衰减约 0.6s + 检测窗 0.34s，
      // 这段时间里的"稳定音"是程序的余音而不是用户弹的，不判定。
      // 只在真的停掉过播放时才设——手动"回开头"没有余音，别挡用户弹。
      if (wasPlaying) this._judgeCooldownUntil = performance.now() + 1000;
      for (const p of this._autoPending) {
        if (p.id) clearTimeout(p.id);
        if (p.offId) clearTimeout(p.offId);
        if (p.key) this.engine.noteOff(p.key);
      }
      this._autoPending.length = 0;
      if (showHint && this.mode === 'score' && this.score) {
        if (this.follower?.mode === 'tempo') this.follower.startMs = null;
        this.hint = wasPlaying ? '已停止试听 —— 指板上闪烁的音就是你要弹的' :
          '节拍练习已停止；点「开始节拍跟弹」重新开始';
        this._updateStrip();
      }
    }

    /* ---------- 乐谱流：横向滚动的时间轴 ----------
     * 音符块按拍定位，随播放/跟弹游标从右向左流动；
     * 陶土块 = 当前要弹的音，绿闪 = 刚弹对的音，灰块 = 已经过去的音。 */
    /* ---------- 乐谱流：横向滚动的时间轴（五线谱 + 六线谱双谱带） ----------
     * 音符块按拍定位，随播放/跟弹游标从右向左流动；
     * 陶土块 = 当前要弹的音，绿闪 = 刚弹对的音，灰块 = 已经过去的音。
     * 上谱带 = 五线谱（吉他记谱：记谱音高比实际高八度），实心/空心
     * 音符头表示时值，加线与升号按乐理画；下谱带 = 六线谱（品号）。 */
    _renderFlow(now) {
      const cv = this._flowCv;
      const w = cv.clientWidth, h = cv.clientHeight;
      if (w < 10 || h < 10) return;
      const dpr = global.devicePixelRatio || 1;
      const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
      if (cv.width !== bw || cv.height !== bh) { cv.width = bw; cv.height = bh; }
      const g = this._flowG;
      g.clearRect(0, 0, bw, bh);
      const evs = this.score.events;
      if (!evs.length) return;

      // 视口拍：试听 = 实时播放拍；跟弹 = 当前事件起始拍（缓动跟随）
      let target;
      if (this.scoreAuto) {
        const a = this.scoreAuto;
        target = (this.engine.ctx.currentTime - a.t0) * this.bpm / 60 + a.beat0;
      } else {
        const ev = evs[this.scoreCursor];
        target = ev ? ev.startBeat : this.score.totalBeats;
      }
      if (this._flowBeat == null || Math.abs(this._flowBeat - target) > 8) this._flowBeat = target;
      else this._flowBeat += (target - this._flowBeat) * 0.15;
      const view = this._flowBeat;

      const gutter = 36 * dpr;
      const headX = Math.round(bw * 0.3);
      const ppb = (bw - headX - 16 * dpr) / 16;   // 播放头右侧可见 16 拍
      const xOf = (beat) => headX + (beat - view) * ppb;

      // 版面几何：上 = 五线谱，下 = 六线谱 TAB
      const staffTop = 16 * dpr;
      const sp = 8 * dpr;
      const staffBot = staffTop + 4 * sp;
      const tabTop = staffBot + 24 * dpr;
      const rh = 10 * dpr;
      const tabBot = tabTop + 5 * rh;
      // 音高 → 五线谱 y。吉他记谱比实际音高高八度（m = midi + 12），
      // 高音谱表底线 = 记谱 E4（dn 基准 37），每个音级走半个线距
      const yHead = (midi) => {
        const m = midi + 12;
        const oct = Math.floor(m / 12) - 1;
        const pc = ((m % 12) + 12) % 12;
        const L = STAFF_LETTER[pc];
        return { y: staffBot - ((oct + 1) * 7 + L.deg - 37) * (sp / 2), alter: L.alter };
      };

      // 五线谱 5 条线
      for (let i = 0; i < 5; i++) {
        const y = Math.round(staffTop + i * sp) + 0.5;
        g.strokeStyle = 'rgba(33,30,25,0.5)';
        g.lineWidth = 1;
        g.beginPath(); g.moveTo(gutter, y); g.lineTo(bw, y); g.stroke();
      }
      // 六线谱 6 条弦线（上细下粗）+ 弦名
      STRINGS.forEach((_, i) => {
        const y = Math.round(tabTop + (i + 0.5) * rh) + 0.5;
        g.strokeStyle = 'rgba(33,30,25,0.25)';
        g.lineWidth = (0.6 + (5 - i) * 0.16) * dpr;
        g.beginPath(); g.moveTo(gutter, y); g.lineTo(bw, y); g.stroke();
      });
      g.fillStyle = C.ink3;
      g.font = `${Math.round(9 * dpr)}px Georgia, serif`;
      g.textAlign = 'left';
      STRING_LABELS.forEach((lb, i) => {
        g.fillText(lb, 6 * dpr, tabTop + (i + 0.5) * rh + 3 * dpr);
      });
      g.fillText('谱', 13 * dpr, staffTop + 2 * sp + 3 * dpr);

      // 小节线（贯穿双谱带）+ 小节号
      g.textAlign = 'center';
      for (const [mi, b] of this.score.measureStarts.entries()) {
        if (xOf(b) >= bw + 20) break;
        if (xOf(b) < -10) continue;
        const x = Math.round(xOf(b)) + 0.5;
        g.strokeStyle = 'rgba(70,62,48,0.2)';
        g.lineWidth = 1;
        g.beginPath(); g.moveTo(x, staffTop - 4 * dpr); g.lineTo(x, tabBot + 4 * dpr); g.stroke();
        g.fillStyle = C.ink3;
        g.font = `${Math.round(9 * dpr)}px Georgia, serif`;
        g.fillText(String(mi + 1), x, tabBot + 13 * dpr);
      }

      // 音符：TAB 块 + 品号，五线谱音符头 / 符干 / 加线 / 升号
      const headRx = 4.4 * dpr, headRy = 3.1 * dpr;
      for (let i = 0; i < evs.length; i++) {
        const ev = evs[i];
        const x0 = xOf(ev.startBeat);
        const x1 = xOf(ev.startBeat + ev.durBeats);
        if (x1 < gutter || x0 > bw) continue;
        const isCur = i === this.scoreCursor && !this.scoreAuto;
        const outcome = this.follower?.results.get(i);
        const sounding = this.scoreAuto && view >= ev.startBeat && view < ev.startBeat + ev.durBeats;
        const hitT = this._flowHits.get(i);
        const hitK = hitT != null ? Math.max(0, 1 - (now - hitT) / 600) : 0;
        const hot = hitK > 0 || isCur || sounding;
        const hotCol = hitK > 0 ? C.sage : C.clay;

        // ---- TAB 块 + 品号 ----
        for (const n of ev.notes) {
          const y = tabTop + (n.string + 0.5) * rh;
          let fill = '#f2f2ef', text = C.ink2;
          if (outcome?.kind === 'hit' || hitK > 0) { fill = C.sage; text = '#fdf9f0'; }
          else if (outcome?.kind === 'skipped') { fill = '#b8907f'; text = '#fff'; }
          else if (outcome?.kind === 'wrong') { fill = '#a85646'; text = '#fff'; }
          else if (isCur || sounding) { fill = C.clay; text = '#fdf9f0'; }
          else if (ev.startBeat + ev.durBeats <= view) { fill = '#ededeb'; text = C.ink3; }
          _rr(g, x0 + 1 * dpr, y - 3.6 * dpr, Math.max(4 * dpr, x1 - x0 - 2 * dpr), 7.2 * dpr, 2.5 * dpr, fill,
            isCur || sounding ? C.clayDeep : null);
          if (x1 - x0 > 16 * dpr) {
            g.fillStyle = text;
            g.font = `${Math.round(8.5 * dpr)}px Georgia, serif`;
            g.textAlign = 'center';
            g.fillText(String(n.fret), (x0 + x1) / 2, y + 3 * dpr);
          }
        }

        // ---- 五线谱音符 ----
        const xc = x0 + 7 * dpr;
        const whole = ev.durBeats >= 3.75, half = ev.durBeats >= 1.75;
        for (const n of ev.notes) {
          const pos = yHead(n.midi);
          const x = xc;
          if (x < gutter - 8 * dpr) continue;
          const fillHead = outcome?.kind === 'hit' ? C.sage :
            outcome?.kind === 'skipped' ? '#a86955' : outcome?.kind === 'wrong' ? '#a85646' : hot ? hotCol :
            (ev.startBeat + ev.durBeats <= view ? 'rgba(33,30,25,0.35)' : C.ink);
          // 加线（超出五线谱的音按线位补短横线）
          g.strokeStyle = 'rgba(33,30,25,0.55)';
          g.lineWidth = 1;
          if (pos.y > staffBot + 0.5) {
            for (let ly = staffBot + sp; ly <= pos.y + 0.6; ly += sp) {
              g.beginPath(); g.moveTo(x - 7 * dpr, Math.round(ly) + 0.5); g.lineTo(x + 7 * dpr, Math.round(ly) + 0.5); g.stroke();
            }
          } else if (pos.y < staffTop - 0.5) {
            for (let ly = staffTop - sp; ly >= pos.y - 0.6; ly -= sp) {
              g.beginPath(); g.moveTo(x - 7 * dpr, Math.round(ly) + 0.5); g.lineTo(x + 7 * dpr, Math.round(ly) + 0.5); g.stroke();
            }
          }
          // 升号（黑键音在谱面上标 ♯）
          if (pos.alter) {
            g.fillStyle = hot ? hotCol : C.ink2;
            g.font = `${Math.round(10 * dpr)}px Georgia, "Segoe UI Symbol", sans-serif`;
            g.textAlign = 'center';
            g.fillText('♯', x - 8.5 * dpr, pos.y + 3.5 * dpr);
          }
          // 音符头（二分/全音符空心）+ 符干
          g.beginPath();
          g.ellipse(x, pos.y, headRx, headRy, -0.35, 0, Math.PI * 2);
          if (whole || half) {
            g.fillStyle = '#fdfaf1';
            g.fill();
            g.strokeStyle = fillHead;
            g.lineWidth = 1.4 * dpr;
            g.stroke();
          } else {
            g.fillStyle = fillHead;
            g.fill();
          }
          if (!whole) {
            const stemUp = pos.y > staffTop + 2 * sp;
            g.strokeStyle = fillHead;
            g.lineWidth = 1.1 * dpr;
            g.beginPath();
            if (stemUp) { g.moveTo(x + headRx - 0.5, pos.y - 0.5); g.lineTo(x + headRx - 0.5, pos.y - 21 * dpr); }
            else { g.moveTo(x - headRx + 0.5, pos.y + 0.5); g.lineTo(x - headRx + 0.5, pos.y + 21 * dpr); }
            g.stroke();
          }
        }
      }

      // 播放头（贯穿双谱带）
      g.strokeStyle = C.clay;
      g.lineWidth = 2 * dpr;
      g.beginPath();
      g.moveTo(headX + 0.5, staffTop - 6 * dpr);
      g.lineTo(headX + 0.5, tabBot + 6 * dpr);
      g.stroke();
      // 清理过期绿闪
      if (this._flowHits.size > 64) {
        for (const [k, t0] of this._flowHits) if (now - t0 > 800) this._flowHits.delete(k);
      }
    }

    /* ---------- 和弦手型卡：当前小节起最多 3 张 ---------- */
    _drawScoreChords(m) {
      const holder = this._scoreEls.chords;
      holder.innerHTML = '';
      const picked = [];
      for (let k = m; k < this.score.measures && picked.length < 3; k++) {
        const c = this.score.chordForMeasure[k];
        if (c && (!picked.length || picked[picked.length - 1].chord.name !== c.name)) {
          picked.push({ chord: c, measure: k });
        }
      }
      if (!picked.length) {
        holder.appendChild(Object.assign(document.createElement('span'), {
          className: 'ss-info', textContent: '本小节没有可识别的和弦',
        }));
        return;
      }
      for (const { chord, measure } of picked) {
        const card = document.createElement('div');
        card.className = 'chord-card';
        const cv = document.createElement('canvas');
        cv.width = 112; cv.height = 132;
        card.appendChild(cv);
        const b = document.createElement('b');
        b.textContent = chord.name;
        card.appendChild(b);
        const cap = document.createElement('span');
        cap.className = 'cap';
        cap.textContent = measure === m ? '本小节' : '第 ' + (measure + 1) + ' 小节';
        card.appendChild(cap);
        holder.appendChild(card);
        this._drawChordCard(cv, chord);
      }
    }

    /* 迷你和弦图：6 弦 × 5 品网格，陶土点 = 按的位置 */
    _drawChordCard(cv, chord) {
      const g = cv.getContext('2d');
      const dpr = this._dpr;
      const W = cv.width, H = cv.height;
      g.clearRect(0, 0, W, H);
      const shape = chord.shape;
      if (!shape) {
        g.fillStyle = C.ink2;
        g.font = `${11 * dpr}px Georgia, serif`;
        g.textAlign = 'center';
        g.fillText(chord.name, W / 2, H / 2);
        return;
      }
      const frets = shape.frets;   // 低→高（6 弦 → 1 弦）
      const left = 16 * dpr, top = 22 * dpr;
      const gw = W - left - 10 * dpr, gh = H - top - 10 * dpr;
      const rows = 5;
      const used = frets.filter((f) => f > 0);
      const base = used.length ? Math.max(1, Math.min(...used)) : 1;
      // 琴弦（竖线，从左到右 = 6 弦 → 1 弦）与品丝
      for (let i = 0; i < 6; i++) {
        const x = Math.round(left + (i / 5) * gw) + 0.5;
        g.strokeStyle = C.ink3;
        g.lineWidth = 1;
        g.beginPath(); g.moveTo(x, top); g.lineTo(x, top + gh); g.stroke();
      }
      for (let r = 0; r <= rows; r++) {
        const y = Math.round(top + (r / rows) * gh) + 0.5;
        const nut = r === 0 && base === 1;
        g.strokeStyle = nut ? C.ink : C.line2;
        g.lineWidth = nut ? 3 * dpr : 1;
        g.beginPath(); g.moveTo(left, y); g.lineTo(left + gw, y); g.stroke();
      }
      if (base > 1) {
        g.fillStyle = C.ink2;
        g.font = `${9 * dpr}px Georgia, serif`;
        g.textAlign = 'left';
        g.fillText(base + 'fr', 2 * dpr, top + 8 * dpr);
      }
      // 按法标记
      g.textAlign = 'center';
      for (let i = 0; i < 6; i++) {
        const f = frets[i];
        const x = left + (i / 5) * gw;
        if (f < 0) {
          g.fillStyle = C.ink3;
          g.font = `${8 * dpr}px Georgia, serif`;
          g.fillText('×', x, top - 6 * dpr);
          continue;
        }
        if (f === 0) {
          g.strokeStyle = C.ink2;
          g.lineWidth = 1.2 * dpr;
          g.beginPath();
          g.arc(x, top - 10 * dpr, 3.2 * dpr, 0, Math.PI * 2);
          g.stroke();
          continue;
        }
        const row = f - base;
        if (row > rows - 1) continue;
        g.fillStyle = C.clay;
        g.beginPath();
        g.arc(x, top + ((row + 0.5) / rows) * gh, 5.2 * dpr, 0, Math.PI * 2);
        g.fill();
      }
    }

    /* 控制台/自动化测试用的状态快照 */
    debug() {
      return {
        det: this.det, silMs: this.silMs, stableMidi: this.stableMidi,
        mode: this.mode, tIdx: this.tIdx, target: this.targets[this.tIdx],
        targetsLen: this.targets.length, streak: this.streak,
        hits: this.hits, attempts: this.attempts, round: this.round, hint: this.hint,
      };
    }
  }

  global.FretboardTrainer = { Trainer, SCALES, STRINGS, NOTE_NAMES };
})(window);
