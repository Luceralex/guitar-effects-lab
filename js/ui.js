/* ============================================================
 * ui.js —— 界面交互与效果器机架
 * ============================================================ */
(function (global) {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  };
  const KEY_NOTES = {   // 键盘钢琴：白键 + 黑键，H = A4·440Hz
    a: 261.63, w: 277.18, s: 293.66, e: 311.13, d: 329.63,
    f: 349.23, t: 369.99, g: 392.0, y: 415.30, h: 440.0,
    u: 466.16, j: 493.88, k: 523.25,
  };

  /* 经典音色组合——大牌机架的公认配置（乐手社区常识），
   * 每条是全 11 槽的完整状态快照，未提到的参数回落到该槽默认值。 */
  const PRESETS = [
    {
      name: '实时练琴 · 基础音色',
      desc: '保留轻过载和 EQ，关闭降噪门、调制、延迟和混响；用于比较效果链的额外延迟',
      settings: {
        gate: { bypassed: true }, wah: { bypassed: true }, comp: { bypassed: true },
        drive: { params: { drive: 0.25, mix: 1, level: 0.8 } },
        eq: { params: { low: 0, mid: 0, high: 0 } },
        chorus: { bypassed: true }, flanger: { bypassed: true },
        phaser: { bypassed: true }, trem: { bypassed: true },
        delay: { bypassed: true }, reverb: { bypassed: true },
      },
    },
    {
      name: '都市清音 · Jazz Chorus',
      desc: 'JC-120 式玻璃清音：轻合唱 + 短延迟 + 房间混响',
      settings: {
        gate: { bypassed: true }, wah: { bypassed: true },
        comp: { bypassed: true }, drive: { bypassed: true },
        eq: { params: { low: 1, mid: 0, high: 2 } },
        chorus: { params: { rate: 0.6, depth: 0.4, mix: 0.45 } },
        flanger: { bypassed: true }, phaser: { bypassed: true }, trem: { bypassed: true },
        delay: { params: { time: 0.32, feedback: 0.25, mix: 0.2 } },
        reverb: { params: { type: 0, wet: 0.3 } },
      },
    },
    {
      name: '德州蓝调 · Tube Screamer',
      desc: 'TS 式中频推挤过载 + slap 短延迟 + 弹簧混响',
      settings: {
        wah: { bypassed: true },
        comp: { params: { threshold: -30, ratio: 3 } },
        drive: { params: { drive: 0.35, mix: 1, level: 0.75 } },
        eq: { params: { low: 0, mid: 4, high: 1 } },
        chorus: { bypassed: true }, flanger: { bypassed: true },
        phaser: { bypassed: true }, trem: { bypassed: true },
        delay: { params: { time: 0.09, feedback: 0.2, mix: 0.14 } },
        reverb: { params: { type: 3, wet: 0.22 } },
      },
    },
    {
      name: '英伦堆积 · Plexi',
      desc: 'Plexi 式堆积过载 + 板式混响，无调制',
      settings: {
        wah: { bypassed: true }, comp: { bypassed: true },
        drive: { params: { drive: 0.5, mix: 1, level: 0.72 } },
        eq: { params: { low: -2, mid: 0, high: 2 } },
        chorus: { bypassed: true }, flanger: { bypassed: true },
        phaser: { bypassed: true }, trem: { bypassed: true },
        delay: { bypassed: true },
        reverb: { params: { type: 2, wet: 0.16 } },
      },
    },
    {
      name: '高增益金属 · 5150',
      desc: '紧门限 + 高增益削波 + V 型 EQ + 大厅长尾',
      settings: {
        gate: { params: { threshold: -40, atten: -60, release: 80 } },
        wah: { bypassed: true },
        comp: { bypassed: true },
        drive: { params: { drive: 0.8, mix: 1, level: 0.65 } },
        eq: { params: { low: -4, mid: -6, high: 4 } },
        chorus: { bypassed: true }, flanger: { bypassed: true },
        phaser: { bypassed: true }, trem: { bypassed: true },
        delay: { bypassed: true },
        reverb: { params: { type: 1, wet: 0.12 } },
      },
    },
    {
      name: '冲浪远征 · Surf',
      desc: 'Dick Dale 式：5Hz 颤音泵动 + 大湿度弹簧混响',
      settings: {
        wah: { bypassed: true }, comp: { bypassed: true },
        drive: { params: { drive: 0.15 } },
        eq: { params: { low: 2, mid: -2, high: 3 } },
        chorus: { bypassed: true }, flanger: { bypassed: true },
        phaser: { bypassed: true },
        trem: { bypassed: false, params: { rate: 5.2, depth: 0.8 } },
        delay: { bypassed: true },
        reverb: { params: { type: 3, wet: 0.5 } },
      },
    },
    {
      name: '太空氛围 · Ambient',
      desc: '深合唱 + 600ms 长延迟高反馈 + 大厅高湿度——后摇引擎',
      settings: {
        wah: { bypassed: true }, comp: { bypassed: true },
        drive: { bypassed: true },
        eq: { params: { low: 2, mid: -2, high: 2 } },
        chorus: { params: { rate: 0.4, depth: 0.7, mix: 0.6 } },
        flanger: { bypassed: true }, phaser: { bypassed: true }, trem: { bypassed: true },
        delay: { params: { time: 0.6, feedback: 0.55, mix: 0.42 } },
        reverb: { params: { type: 1, wet: 0.55 } },
      },
    },
    {
      name: '放克律动 · Auto Wah',
      desc: '包络跟随的"自动哇"——弹得越狠哇得越高',
      settings: {
        wah: { bypassed: false, params: { sens: 0.75, base: 380, range: 1400, q: 4.5 } },
        comp: { params: { threshold: -30, ratio: 3 } },
        drive: { bypassed: true },
        eq: { params: { low: 2, mid: 2, high: 2 } },
        chorus: { bypassed: true }, flanger: { bypassed: true },
        phaser: { bypassed: true }, trem: { bypassed: true },
        delay: { bypassed: true },
        reverb: { params: { type: 0, wet: 0.15 } },
      },
    },
    {
      name: '迷幻漩涡 · Phase 90',
      desc: 'MXR 式四段移相 + 轻过载 + 弹簧混响',
      group: 'rack',
      settings: {
        wah: { bypassed: true }, comp: { bypassed: true },
        drive: { params: { drive: 0.28 } },
        eq: { params: { low: 1, mid: 1, high: 1 } },
        chorus: { bypassed: true }, flanger: { bypassed: true },
        phaser: { bypassed: false, params: { rate: 0.8, depth: 0.7, mix: 0.7 } },
        trem: { bypassed: true },
        delay: { bypassed: true },
        reverb: { params: { type: 3, wet: 0.25 } },
      },
    },
    /* ===== 经典名曲音色（歌迷社区的公开复刻常识） ===== */
    {
      name: '名曲 · Hotel California 前奏',
      group: 'song',
      desc: '老鹰乐队 12 弦琶音：压缩匀化 + 微合唱 + 200ms 瀑布回声 + 大厅',
      settings: {
        gate: { bypassed: true }, wah: { bypassed: true },
        flanger: { bypassed: true }, phaser: { bypassed: true }, trem: { bypassed: true },
        comp: { params: { threshold: -32, ratio: 2.5, attack: 0.01, release: 0.2, makeup: 2 } },
        drive: { bypassed: true },
        eq: { params: { low: 0, mid: -1, high: 3 } },
        chorus: { params: { rate: 0.5, depth: 0.3, mix: 0.25 } },
        delay: { params: { time: 0.2, feedback: 0.35, damp: 5000, mix: 0.3 } },
        reverb: { params: { type: 1, wet: 0.35, pre: 0.03 } },
      },
    },
    {
      name: '名曲 · Hotel California 尾奏独奏',
      group: 'song',
      desc: 'Felder/Walsh 双琴和声：轻过载歌唱 + 八分音符回声（74BPM = 405ms）+ 板式',
      settings: {
        gate: { params: { threshold: -65, atten: -30, release: 400 } },  // 门放宽，保住长音尾
        wah: { bypassed: true }, flanger: { bypassed: true },
        phaser: { bypassed: true }, trem: { bypassed: true },
        comp: { params: { threshold: -35, ratio: 2.5, release: 0.25, makeup: 2 } },
        drive: { params: { drive: 0.28, mix: 1, level: 0.7 } },
        eq: { params: { low: 1, mid: 2, high: 1 } },
        chorus: { bypassed: true },
        delay: { params: { time: 0.405, feedback: 0.3, damp: 4500, mix: 0.26 } },
        reverb: { params: { type: 2, wet: 0.28, pre: 0.03 } },
      },
    },
    {
      name: '名曲 · Sultans of Swing',
      group: 'song',
      desc: 'Knopfler 亮清音：轻压 + 高频提亮 + slap 短延迟（不用拨片更像）',
      settings: {
        gate: { params: { threshold: -60, atten: -40, release: 250 } },
        wah: { bypassed: true }, flanger: { bypassed: true },
        phaser: { bypassed: true }, trem: { bypassed: true },
        comp: { params: { threshold: -34, ratio: 2.2, release: 0.2, makeup: 2 } },
        drive: { bypassed: true },
        eq: { params: { low: 0, mid: -1, high: 3 } },
        chorus: { bypassed: true },
        delay: { params: { time: 0.09, feedback: 0.18, damp: 6000, mix: 0.15 } },
        reverb: { params: { type: 0, wet: 0.22 } },
      },
    },
    {
      name: '名曲 · Comfortably Numb 独奏',
      group: 'song',
      desc: 'Gilmour：Big Muff 式绵绵失真 + 长延迟 + 大厅——Pink Floyd 式咏叹',
      settings: {
        gate: { params: { threshold: -60, atten: -35, release: 350 } },
        wah: { bypassed: true }, flanger: { bypassed: true },
        phaser: { bypassed: true }, trem: { bypassed: true },
        comp: { params: { threshold: -36, ratio: 3, release: 0.3, makeup: 2 } },
        drive: { params: { drive: 0.55, mix: 0.85, level: 0.7 } },
        eq: { params: { low: 1, mid: -1, high: 2 } },
        chorus: { bypassed: true },
        delay: { params: { time: 0.38, feedback: 0.35, damp: 4200, mix: 0.3 } },
        reverb: { params: { type: 1, wet: 0.35, pre: 0.04 } },
      },
    },
    {
      name: '名曲 · Sweet Child 前奏',
      group: 'song',
      desc: 'Slash 的亮清音 + slap 回声——练音阶琶音的好模板',
      settings: {
        gate: { params: { threshold: -60, atten: -45, release: 200 } },
        wah: { bypassed: true }, flanger: { bypassed: true },
        phaser: { bypassed: true }, trem: { bypassed: true },
        comp: { params: { threshold: -32, ratio: 2.5, release: 0.18, makeup: 2 } },
        drive: { bypassed: true },
        eq: { params: { low: 0, mid: 1, high: 3 } },
        chorus: { bypassed: true },
        delay: { params: { time: 0.1, feedback: 0.22, damp: 6500, mix: 0.18 } },
        reverb: { params: { type: 0, wet: 0.2 } },
      },
    },
    {
      name: '名曲 · Nothing Else Matters 前奏',
      group: 'song',
      desc: 'Metallica 清音琶音：合唱微湿 + 长厅混响',
      settings: {
        gate: { bypassed: true }, wah: { bypassed: true },
        flanger: { bypassed: true }, phaser: { bypassed: true }, trem: { bypassed: true },
        comp: { params: { threshold: -30, ratio: 2.2, release: 0.22, makeup: 1.5 } },
        drive: { bypassed: true },
        eq: { params: { low: 1, mid: 0, high: 2 } },
        chorus: { params: { rate: 0.45, depth: 0.3, mix: 0.2 } },
        delay: { bypassed: true },
        reverb: { params: { type: 1, wet: 0.4, pre: 0.04 } },
      },
    },
  ];

  const UI = {
    app: null,
    bypassSwitches: [],
    redrawers: {},       // slotId → [重画函数]

    init(app) {
      this.app = app;
      const eng = app.engine;

      /* ---- 信号源切换 ---- */
      $('source-select').addEventListener('change', (e) => {
        const mode = e.target.value;
        eng.setSourceMode(mode);
        for (const m of ['synth', 'file', 'mic']) {
          $(m + '-panel').classList.toggle('hidden', m !== mode);
        }
        if (mode === 'file') this._refreshFileBtn();
      });

      /* ---- 乐器选择 ---- */
      $('instrument-row').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-inst]');
        if (!btn) return;
        eng.resume();
        eng.instrument = btn.dataset.inst;
        for (const b of document.querySelectorAll('#instrument-row .chip[data-inst]')) {
          b.classList.toggle('active', b === btn);
        }
        this.setStatus('当前音色：' + btn.textContent.trim() + ' —— 按住下方音符按钮或键盘 A–K 试听');
      });

      /* ---- 白噪声开关 ---- */
      $('btn-noise').addEventListener('click', (e) => {
        eng.resume();
        eng.setNoise(!eng.noise);
        e.currentTarget.classList.toggle('on', !!eng.noise);
      });

      /* ---- 音符按钮：按住发声、松手停 ---- */
      for (const btn of document.querySelectorAll('.btn.note')) {
        const freq = parseFloat(btn.dataset.note);
        const down = (ev) => {
          ev.preventDefault();
          eng.resume();
          eng.noteOn('btn-' + btn.dataset.note, freq);
          btn.classList.add('holding');
        };
        const up = () => {
          eng.noteOff('btn-' + btn.dataset.note);
          btn.classList.remove('holding');
        };
        btn.addEventListener('pointerdown', down);
        btn.addEventListener('pointerup', up);
        btn.addEventListener('pointerleave', up);
      }

      /* ---- 电脑键盘弹奏 ---- */
      global.addEventListener('keydown', (e) => {
        if (e.repeat || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
        const f = KEY_NOTES[e.key.toLowerCase()];
        if (!f || eng.sourceMode !== 'synth') return;
        eng.resume();
        eng.noteOn('kb-' + e.key, f);
      });
      global.addEventListener('keyup', (e) => {
        const f = KEY_NOTES[e.key.toLowerCase()];
        if (f) eng.noteOff('kb-' + e.key);
      });

      /* ---- 全局释放保险网 ----
       * 按住发声的交互在几种边界下会漏掉"松手"事件（在按钮外松开、
       * 切换窗口、触屏 pointercancel、连点覆盖句柄），这里统一兜底：
       * 任何松手 / 窗口失焦 / 切到后台，都立刻停掉所有按住的音。 */
      const releaseHeld = () => {
        for (const key of [...eng.voices.keys()]) {
          if (key.startsWith('btn-') || key.startsWith('kb-')) eng.noteOff(key);
        }
        document.querySelectorAll('.btn.holding').forEach((b) => b.classList.remove('holding'));
      };
      global.addEventListener('pointerup', releaseHeld);
      global.addEventListener('pointercancel', releaseHeld);
      global.addEventListener('blur', () => { eng.allNotesOff(); releaseHeld(); });
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) { eng.allNotesOff(); releaseHeld(); }
        else app.viz.forceResize();   // 面板重新可见：画布尺寸按当前布局重算
      });
      const stopSoftwareAudio = () => {
        eng.panic();
        releaseHeld();
        $('btn-noise').classList.remove('on');
        $('btn-mic').textContent = '连接';
        $('btn-mic').classList.remove('on');
        this._refreshFileBtn();
        refreshDevices();
      };
      // Esc = 停止全部软件音源
      global.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        stopSoftwareAudio();
        this.setStatus('已停止软件音源；输入设备的直通监听仍可能发声，效果器尾音会自然衰减');
      });
      // 显式"全停"按钮：给"关不掉"一个一目了然的出口
      $('btn-panic').addEventListener('click', () => {
        stopSoftwareAudio();
        this.setStatus('已停止软件音源；输入设备的直通监听仍可能发声，效果器尾音会自然衰减');
      });

      /* ---- 小提琴 vs 钢琴 一键对比 ---- */
      $('btn-compare').addEventListener('click', () => {
        eng.setSourceMode('synth');
        eng.resume();
        eng.demoCompare();
        this.setStatus('对比中：小提琴 2.2s → 钢琴。峰值保持线会留下两者的频谱轮廓');
      });

      /* ---- 文件播放 ---- */
      $('btn-file').addEventListener('click', () => $('file-input').click());
      $('file-input').addEventListener('change', async (e) => {
        const f = e.target.files[0];
        if (f) await this.loadFile(f);
      });
      $('btn-file-play').addEventListener('click', () => {
        eng.resume();
        if (eng.file.playing) eng.stopFile(); else eng.playFile();
        this._refreshFileBtn();
      });
      $('file-loop').addEventListener('change', (e) => { eng.file.loop = e.target.checked; });
      eng.file.onended = () => this._refreshFileBtn();

      // 拖放音频文件到可视化区域
      const area = $('viz-area');
      area.addEventListener('dragover', (e) => { e.preventDefault(); $('drop-hint').classList.remove('hidden'); });
      area.addEventListener('dragleave', () => $('drop-hint').classList.add('hidden'));
      area.addEventListener('drop', async (e) => {
        e.preventDefault();
        $('drop-hint').classList.add('hidden');
        const f = e.dataTransfer.files && e.dataTransfer.files[0];
        if (f && f.type.startsWith('audio')) {
          $('source-select').value = 'file';
          $('source-select').dispatchEvent(new Event('change'));
          await this.loadFile(f);
        }
      });

      /* ---- 麦克风 / 电吉他 ----
       * 吉他插电脑线路输入时优先采集该输入。
       * 若没有线路输入，再尝试匹配吉他声卡。 */
      const inSel = $('mic-input-select');
      const outSel = $('mic-output-select');
      const LINE_IN_RE = /线路输入|line[\s-]*in/i;
      const GUITAR_RE = /jam|buddy|guitar|instrument|声卡|吉他/i;
      const JAM_BUDDY_RE = /jam\s*buddy/i;
      let inputTouched = false;
      let outputTouched = false;
      let activeOutputId = '';

      const updateLatencyInfo = () => {
        const track = eng.mic?.stream.getAudioTracks()[0];
        if (!track) { $('latency-info').textContent = ''; return; }
        const ms = (seconds) => Number.isFinite(seconds) ? Math.round(seconds * 1000) + ' ms' : null;
        const parts = [
          ['采集', ms(track.getSettings().latency)],
          ['浏览器处理', ms(eng.ctx.baseLatency)],
          ['输出', ms(eng.ctx.outputLatency)],
        ].filter(([, value]) => value !== null).map(([name, value]) => name + ' ' + value);
        $('latency-info').textContent = parts.length
          ? '浏览器报告的部分延迟：' + parts.join(' + ') + '；实际往返延迟可能更高'
          : '浏览器未提供延迟读数；以实际弹奏感觉为准';
      };

      const refreshDevices = async () => {
        try {
          const inputs = await eng.listInputDevices();
          const prevIn = inSel.value;
          inSel.innerHTML = '<option value="">自动（系统默认输入）</option>';
          for (const d of inputs) {
            inSel.appendChild(new Option(d.label || '输入设备 ' + d.deviceId.slice(0, 6), d.deviceId));
          }
          const lineInput = inputs.find((d) => LINE_IN_RE.test(d.label));
          const preferredInput = lineInput || inputs.find((d) => JAM_BUDDY_RE.test(d.label)) ||
            inputs.find((d) => GUITAR_RE.test(d.label));
          const connectedId = eng.mic?.stream.getAudioTracks()[0]?.getSettings().deviceId;
          const preferredIn = connectedId || (inputTouched ? prevIn : (preferredInput?.deviceId || prevIn));
          inSel.value = inputs.some((d) => d.deviceId === preferredIn) ? preferredIn : '';
          const outs = (await navigator.mediaDevices.enumerateDevices()).filter((x) => x.kind === 'audiooutput');
          outSel.innerHTML = '<option value="">自动（系统默认输出）</option>';
          for (const d of outs) {
            outSel.appendChild(new Option(d.label || '输出设备 ' + d.deviceId.slice(0, 6), d.deviceId));
          }
          outSel.value = outs.some((d) => d.deviceId === activeOutputId) ? activeOutputId : '';
          const named = inputs.some((d) => d.label);
          const activeInputLabel = eng.mic?.stream.getAudioTracks()[0]?.label || '';
          $('mic-hint').textContent = eng.mic
            ? (LINE_IN_RE.test(activeInputLabel)
              ? '电脑线路输入已连接；弹琴时看输入频谱是否跳动，才能确认收到吉他信号'
              : JAM_BUDDY_RE.test(activeInputLabel)
              ? '此 Jam Buddy 实测：GUITAR.VOL / CH.VOL 归零也会切断 USB 吉他输入；软件回放会叠在本机声上'
              : '页面音量只控制软件回放；输入设备自身的直通监听可能仍会发声')
            : named
            ? (lineInput ? '已识别电脑线路输入；点“连接”，弹琴时检查频谱'
              : preferredInput ? '已识别吉他声卡，点“连接”开始弹'
              : '没看到输入设备？检查 Windows 声音设置里的录音设备')
            : '点击"连接"并在浏览器弹窗授权后，这里会显示设备名称';
          updateLatencyInfo();
          return {
            preferredInputId: preferredInput?.deviceId || '',
            jamOutputId: outs.find((d) => JAM_BUDDY_RE.test(d.label))?.deviceId || '',
          };
        } catch (e) { return { preferredInputId: '', jamOutputId: '' }; }
      };
      refreshDevices();
      if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
        navigator.mediaDevices.addEventListener('devicechange', refreshDevices);
      }

      const connectMic = async () => {
        try {
          await eng.resume();
          await eng.enableMic(inSel.value || undefined);
          let devices = await refreshDevices(); // 授权后设备标签才可能出现
          if (!inputTouched && devices.preferredInputId) {
            const track = eng.mic.stream.getAudioTracks()[0];
            if (track.getSettings().deviceId !== devices.preferredInputId) {
              eng.disableMic();
              await eng.enableMic(devices.preferredInputId);
              devices = await refreshDevices();
            }
          }
          let outputWarning = '';
          if (!outputTouched && devices.jamOutputId) {
            try {
              await eng.setSink(devices.jamOutputId);
              activeOutputId = devices.jamOutputId;
              outSel.value = activeOutputId;
            } catch (err) {
              outputWarning = '；自动切换 Jam Buddy 输出失败：' + err.message;
            }
          }
          updateLatencyInfo();
          $('btn-mic').textContent = '断开';
          $('btn-mic').classList.add('on');
          const track = eng.mic.stream.getAudioTracks()[0];
          const outputName = activeOutputId
            ? (outSel.selectedOptions[0]?.textContent || '所选输出') : '系统默认输出';
          this.setStatus('输入已连接：' + (track.label || '系统默认输入') +
            '；软件监听：' + outputName + outputWarning +
            (LINE_IN_RE.test(track.label)
              ? '。请弹琴确认输入频谱跳动；电脑线路输入不是专用 Hi-Z 吉他接口。'
              : JAM_BUDDY_RE.test(track.label)
              ? '。Jam Buddy 本机声会与软件处理声叠加；本机音量归零也会切断 USB 输入。'
              : '。输入设备的直通监听可能与软件处理声同时播放。'));
        } catch (err) {
          this.setStatus('连接失败：' + err.message + '（需通过 localhost/https 打开，并在浏览器弹窗里允许麦克风）', true);
        }
      };
      $('btn-mic').addEventListener('click', async () => {
        if (eng.mic) {
          eng.disableMic();
          updateLatencyInfo();
          $('btn-mic').textContent = '连接';
          $('btn-mic').classList.remove('on');
          this.setStatus('输入已断开');
        } else {
          await connectMic();
        }
      });
      inSel.addEventListener('change', async () => {
        inputTouched = true;
        if (!eng.mic) return;           // 未连接时只记录选择
        eng.disableMic();
        $('btn-mic').textContent = '连接';
        $('btn-mic').classList.remove('on');
        await connectMic();
      });
      outSel.addEventListener('change', async () => {
        try {
          await eng.setSink(outSel.value || undefined);
          outputTouched = true;
          activeOutputId = outSel.value;
          updateLatencyInfo();
          this.setStatus(outSel.value ? '监听输出已切换：处理后的琴声从所选设备出声' : '监听输出已恢复系统默认');
        } catch (err) {
          outSel.value = activeOutputId;
          this.setStatus('切换输出失败：' + err.message, true);
        }
      });

      /* ---- 音量 / A/B / 帮助 ---- */
      eng.setMasterVolume(parseFloat($('master-volume').value));
      $('master-volume').addEventListener('input', (e) => eng.setMasterVolume(parseFloat(e.target.value)));
      $('btn-ab').addEventListener('click', () => {
        eng.resume();
        const on = !$('btn-ab').classList.contains('on');
        $('btn-ab').classList.toggle('on', on);
        eng.chain.setAllBypassed(on);
        this.syncBypassUi();
        this.setStatus(on ? 'A/B 旁路：现在听到的是未经处理的原始信号' : '已恢复各效果器原来的开关状态');
      });
      $('btn-help').addEventListener('click', () => $('modal').classList.remove('hidden'));
      $('btn-close-modal').addEventListener('click', () => $('modal').classList.add('hidden'));
      $('modal').addEventListener('click', (e) => { if (e.target === $('modal')) $('modal').classList.add('hidden'); });

      /* ---- 可视化标签页 ---- */
      $('viz-tabs').addEventListener('click', (e) => {
        const btn = e.target.closest('.tab');
        if (!btn) return;
        for (const t of document.querySelectorAll('#viz-tabs .tab')) t.classList.toggle('active', t === btn);
        const tab = btn.dataset.tab;
        app.viz.setTab(tab);
        const panes = {
          spectrum: 'canvas-spectrum',
          wave: 'canvas-wave',
          spectrogram: 'spec-wrap',
          analysis: 'canvas-analysis',
        };
        for (const [name, id] of Object.entries(panes)) {
          $(id).classList.toggle('active', name === tab);
        }
        $('spectrum-legend').classList.toggle('hidden', tab !== 'spectrum');
        app.viz.forceResize();   // 隐藏期间画布可能塌到下限宽，切回来强制按当前布局重算
      });

      /* ---- 深度分析：前端解码/重采样 → Python 后端计算 → 前端渲染 ---- */
      const hasLocalBackend = location.origin === 'http://127.0.0.1:8765' ||
        location.origin === 'http://localhost:8765';
      if (!hasLocalBackend) {
        $('btn-analyze').classList.add('hidden');
        document.querySelector('#viz-tabs .tab[data-tab="analysis"]').classList.add('hidden');
      }
      const ANALYSIS_SR = 22050;
      // 没加载文件时，用 OfflineAudioContext 渲染内置小提琴 A4 当演示素材
      const renderDemoPcm = async () => {
        const ctx = new OfflineAudioContext(1, ANALYSIS_SR * 3, ANALYSIS_SR);
        const t = ctx.currentTime;
        const env = ctx.createGain();
        env.gain.setValueAtTime(0, t);
        env.gain.linearRampToValueAtTime(1, t + 0.12);
        env.connect(ctx.destination);
        for (let k = 1; k <= 10; k++) {
          const o = ctx.createOscillator();
          o.frequency.value = 440 * k;
          const gn = ctx.createGain();
          gn.gain.value = (1 / k) * 0.22;
          o.connect(gn).connect(env);
          o.start(t);
          o.stop(t + 3);
        }
        return ctx.startRendering();
      };
      $('btn-analyze').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        try {
          btn.disabled = true;
          eng.resume();
          // 1) 取单声道 AudioBuffer：文件优先 → 麦克风连着就录 4s 真琴（经效果链）→ 否则内置演示
          let buf, label;
          if (eng.file.buffer) {
            buf = eng.file.buffer;
            label = $('file-name').textContent || '当前文件';
          } else if (eng.mic) {
            label = '你的琴声（经效果链 · 实时录制 4s）';
            this.setStatus('正在录制你的琴声 4 秒 —— 现在弹！（信号取自效果链之后，A/B 旁路可对照）');
            buf = await eng.recordProcessed(4);
          } else {
            label = '内置音源演示（小提琴 A4）';
            buf = await renderDemoPcm();
          }
          this.setStatus('前端解码 / 重采样中…（浏览器解出 PCM，重活交给 Python）');
          // 2) 重采样到 22050Hz 单声道（抗混叠由浏览器完成）
          const target = new OfflineAudioContext(1, Math.max(4096, Math.ceil(buf.duration * ANALYSIS_SR)), ANALYSIS_SR);
          const srcn = target.createBufferSource();
          srcn.buffer = buf;
          srcn.connect(target.destination);
          srcn.start();
          const rendered = await target.startRendering();
          const pcm = rendered.getChannelData(0);
          // 3) 打包 Int16 PCM → POST 给后端
          const i16 = new Int16Array(pcm.length);
          for (let i = 0; i < pcm.length; i++) {
            i16[i] = Math.max(-32768, Math.min(32767, Math.round(pcm[i] * 32767)));
          }
          this.setStatus(`已把「${label}」的 PCM（${(i16.length / ANALYSIS_SR).toFixed(1)}s）发给 Python 后端计算…`);
          const resp = await fetch('/api/analyze?sample_rate=' + ANALYSIS_SR, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: i16.buffer,
          });
          const data = await resp.json();
          if (data.error) {
            this.setStatus('后端返回错误：' + data.error, true);
            return;
          }
          // 4) 切到分析视图，前端只负责把结果画出来
          //    （同步调用：rAF 在页面切到后台时不会执行，分析结果会丢）
          document.querySelector('#viz-tabs .tab[data-tab="analysis"]').click();
          this.app.viz.drawAnalysis(data);
          const s = data.summary;
          this.setStatus(`后端分析完成（${s.frames} 帧 STFT）：峰值 ${s.peakDbfs} dBFS · RMS ${s.rmsDbfs} dBFS · ` +
            `失真 ${s.thdPercent ?? '—'}% · 频段 低 ${s.bandPercent.low}% / 中 ${s.bandPercent.mid}% / 高 ${s.bandPercent.high}%`);
        } catch (err) {
          this.setStatus('深度分析失败：' + err.message + '（确认后端已用 python server.py 启动）', true);
        } finally {
          btn.disabled = false;
        }
      });

      /* ---- 效果器机架：恢复上次状态 → 构建 → 音色组合 ---- */
      const restored = this.restoreState();
      this.buildRack();

      // 音色组合（大牌机架的经典配置 + 经典名曲音色，分组显示）
      const presetSel = $('preset-select');
      presetSel.appendChild(new Option('选择音色组合', '', true, true));
      const presetGroups = [
        { label: '经典机架组合', list: PRESETS.filter((p) => p.group !== 'song') },
        { label: '经典名曲音色', list: PRESETS.filter((p) => p.group === 'song') },
      ];
      for (const g of presetGroups) {
        const og = document.createElement('optgroup');
        og.label = g.label;
        for (const p of g.list) og.appendChild(new Option(p.name, p.name));
        presetSel.appendChild(og);
      }
      presetSel.addEventListener('change', () => {
        const p = PRESETS.find((x) => x.name === presetSel.value);
        if (p) this.applyPreset(p);
      });
      $('btn-preset-reset').addEventListener('click', () => {
        this.exitAB();
        try { localStorage.removeItem('xgq-state'); } catch (e) { /* 隐私模式 */ }
        for (const slot of eng.chain.slots) {
          for (const def of slot.paramDefs()) slot.setParam(def.key, def.value);
          slot.setBypassed(false);
        }
        this.buildRack();
        this.setStatus('已恢复全部默认设置，并清除了状态记忆');
      });

      $('ro-sr').textContent = (eng.sampleRate / 1000).toFixed(1) + ' kHz';
      this.setStatus(restored
        ? '已恢复上次的机架状态 —— 连接输入即可回到你上次的音色'
        : '按住发声，松手即停；Esc 或"全停"随时静音。松手后的余音是 Delay 回声在自然衰减');
    },

    exitAB() {
      const btn = $('btn-ab');
      if (!btn.classList.contains('on')) return;
      btn.classList.remove('on');
      this.app.engine.chain.setAllBypassed(false);
      this.syncBypassUi();
    },
    syncBypassUi() {
      for (const { input, card } of this.bypassSwitches) {
        const slot = this.app.engine.chain.slots.find((s) => s.id === input.dataset.slot);
        input.checked = !slot.bypassed;
        card.classList.toggle('bypassed', slot.bypassed);
      }
    },

    /* ---------- 效果器机架构建 ---------- */
    buildRack() {
      const rack = $('effects-rack');
      rack.innerHTML = '';
      this.bypassSwitches = [];
      this.redrawers = {};
      for (const slot of this.app.engine.chain.slots) {
        this.redrawers[slot.id] = [];
        const card = el('div', 'fx-card');
        card.dataset.slot = slot.id;

        // 标题行：色点 + 名称 + 旁路开关
        const head = el('div', 'fx-head');
        head.appendChild(el('span', 'fx-dot'));
        head.querySelector('.fx-dot').style.background = slot.color;
        head.appendChild(el('h3', null, slot.label));
        const sw = el('label', 'fx-switch',
          `<input type="checkbox" data-slot="${slot.id}" checked><span class="knob"></span>开启`);
        head.appendChild(sw);
        card.appendChild(head);
        sw.querySelector('input').checked = !slot.bypassed;
        card.classList.toggle('bypassed', slot.bypassed);
        this.bypassSwitches.push({ input: sw.querySelector('input'), card });
        sw.querySelector('input').addEventListener('change', (e) => {
          this.app.engine.resume();
          const enabled = e.target.checked;
          this.exitAB();
          slot.setBypassed(!enabled);
          this.syncBypassUi();
          this.saveState();
        });

        // 参数滑杆（由各效果器的 paramDefs 自动生成）
        for (const def of slot.paramDefs()) {
          const row = el('div', 'prm');
          const val = slot.params[def.key];
          row.innerHTML =
            `<label>${def.label}</label>
             <input type="range" min="${def.min}" max="${def.max}" step="${def.step}" value="${val}">
             <b class="val">${def.fmt(val)}</b>`;
          const input = row.querySelector('input');
          input.addEventListener('input', () => {
            const v = parseFloat(input.value);
            slot.setParam(def.key, v);
            row.querySelector('.val').textContent = def.fmt(v);
            this.redrawers[slot.id].forEach((fn) => fn());
            this.saveState();
          });
          card.appendChild(row);
        }

        // 附加可视化（传输曲线 / 频响 / GR 表）
        const extra = this._buildExtra(slot);
        if (extra) { extra.classList.add('fx-extra'); card.appendChild(extra); }

        rack.appendChild(card);
      }
      this.redrawers.drive.forEach((fn) => fn());
      this.redrawers.eq.forEach((fn) => fn());
      this.redrawers.comp.forEach((fn) => fn());
    },

    /* ---------- 每个效果器的附加图 ---------- */
    _curveCanvas(slot, caption) {
      const wrap = el('div');
      const cv = el('canvas');
      cv.width = 260; cv.height = 86;
      wrap.appendChild(cv);
      wrap.appendChild(el('div', 'cap', caption));
      return { wrap, cv };
    },
    _drawCurve(cv, pts, mapX, mapY, color) {
      const g = cv.getContext('2d');
      const W = cv.width, H = cv.height;
      g.clearRect(0, 0, W, H);
      g.strokeStyle = 'rgba(70,62,48,0.15)';
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(0, H / 2 + 0.5); g.lineTo(W, H / 2 + 0.5); g.stroke();
      g.strokeStyle = color;
      g.lineWidth = 1.6;
      g.beginPath();
      pts.forEach((p, i) => {
        const x = mapX(p, W), y = mapY(p, H);
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      });
      g.stroke();
    },

    _buildExtra(slot) {
      if (slot.id === 'drive') {
        const { wrap, cv } = this._curveCanvas(slot, '削波传输特性');
        const draw = () => {
          this._drawCurve(cv, slot.curvePoints(80),
            (p, W) => ((p.x + 1) / 2) * W,
            (p, H) => (1 - (p.y + 1) / 2) * (H - 8) - 4, slot.color);
        };
        this.redrawers.drive.push(draw);
        return wrap;
      }
      if (slot.id === 'eq') {
        const { wrap, cv } = this._curveCanvas(slot, 'EQ 频响曲线（主频谱中的蓝虚线）');
        const draw = () => {
          const N = 100, freqs = new Float32Array(N);
          for (let i = 0; i < N; i++) freqs[i] = 20 * Math.pow(1000, i / (N - 1));
          const resp = slot.getResponseDb(freqs);
          const g = cv.getContext('2d'), W = cv.width, H = cv.height;
          g.clearRect(0, 0, W, H);
          g.strokeStyle = 'rgba(70,62,48,0.15)';
          g.beginPath(); g.moveTo(0, H / 2 + 0.5); g.lineTo(W, H / 2 + 0.5); g.stroke();
          g.strokeStyle = slot.color; g.lineWidth = 1.6;
          g.beginPath();
          for (let i = 0; i < N; i++) {
            const x = (i / (N - 1)) * W;
            const y = H / 2 - (resp[i] / 15) * (H / 2 - 6);
            i ? g.lineTo(x, y) : g.moveTo(x, y);
          }
          g.stroke();
        };
        this.redrawers.eq.push(draw);
        return wrap;
      }
      if (slot.id === 'comp') {
        const { wrap, cv } = this._curveCanvas(slot, '压缩曲线（dB）');
        const meter = el('div', 'gr-meter',
          '<span style="font-size:11px;color:var(--dim)">GR</span>' +
          '<div class="gr-bar"><div class="gr-fill"></div></div><span class="gr-val">0.0 dB</span>');
        wrap.appendChild(meter);
        this.compMeter = { fill: meter.querySelector('.gr-fill'), val: meter.querySelector('.gr-val') };
        const draw = () => {
          this._drawCurve(cv, slot.staticCurve(80),
            (p, W) => ((p.x + 60) / 60) * W,
            (p, H) => (1 - (p.y + 60) / 60) * (H - 8) - 4, slot.color);
        };
        this.redrawers.comp.push(draw);
        return wrap;
      }
      if (slot.id === 'gate') {
        // 实时电平表：条到门限线以上 = 门开（绿），静默 = 关（灰），底噪被压掉
        const wrap = el('div');
        const meter = el('div', 'gr-meter',
          '<span style="font-size:11px;color:var(--dim)">电平</span>' +
          '<div class="gr-bar"><div class="gr-fill"></div>' +
          '<div style="position:absolute;left:' + ((slot.params.threshold + 60) / 60) * 100 + '%;top:0;bottom:0;width:2px;background:var(--clay)"></div></div>' +
          '<span class="gr-val">—</span>');
        meter.querySelector('.gr-bar').style.position = 'relative';
        wrap.appendChild(meter);
        this.gateMeter = { fill: meter.querySelector('.gr-fill'), state: meter.querySelector('.gr-val') };
        wrap.appendChild(el('div', 'cap', '绿 = 门开（琴声通过）· 灰 = 门关（底噪压掉）· 红线 = 门限'));
        return wrap;
      }
      return null;
    },

    /* ---------- 每帧更新（降噪门电平/开合 + 自动哇包络 + 压缩器 GR） ---------- */
    updateMeters() {
      const slots = this.app.engine.chain.slots;
      const gate = slots.find((s) => s.id === 'gate');
      if (gate) {
        gate.tick();
        if (this.gateMeter) {
          const db = Math.max(-60, Math.min(0, gate.getLevelDb()));
          this.gateMeter.fill.style.width = ((db + 60) / 60) * 100 + '%';
          this.gateMeter.fill.style.background = gate.isOpen() ? 'var(--green)' : 'var(--ink-3)';
          this.gateMeter.state.textContent = gate.isOpen() ? '开' : '关';
        }
      }
      const wah = slots.find((s) => s.id === 'wah');
      if (wah) wah.tick();
      if (!this.compMeter) return;
      const comp = slots.find((s) => s.id === 'comp');
      const gr = Math.abs(comp.getReduction());
      this.compMeter.fill.style.width = Math.min(100, (gr / 24) * 100) + '%';
      this.compMeter.val.textContent = '-' + gr.toFixed(1) + ' dB';
    },

    /* ---------- 音色组合应用 + 状态记忆（localStorage） ---------- */
    applyPreset(p) {
      this.exitAB();
      for (const slot of this.app.engine.chain.slots) {
        const cfg = (p.settings || {})[slot.id];
        for (const def of slot.paramDefs()) {
          slot.setParam(def.key, cfg?.params?.[def.key] ?? def.value);
        }
        slot.setBypassed(!!cfg?.bypassed);
      }
      this.buildRack();          // 重建卡片 = 滑杆/开关与状态同步
      this.saveState();
      this.setStatus(`已应用音色组合「${p.name}」：${p.desc}`);
    },
    saveState() {
      try {
        const state = this.app.engine.chain.slots.map((s) => ({
          id: s.id, bypassed: s.bypassed, params: { ...s.params },
        }));
        localStorage.setItem('xgq-state', JSON.stringify(state));
      } catch (e) { /* 隐私模式下静默 */ }
    },
    restoreState() {
      try {
        const raw = localStorage.getItem('xgq-state');
        if (!raw) return false;
        for (const st of JSON.parse(raw)) {
          const slot = this.app.engine.chain.slots.find((s) => s.id === st.id);
          if (!slot) continue;
          for (const [k, v] of Object.entries(st.params || {})) slot.setParam(k, v);
          slot.setBypassed(!!st.bypassed);
        }
        return true;
      } catch (e) { return false; }
    },

    /* ---------- 杂项 ---------- */
    async loadFile(f) {
      const eng = this.app.engine;
      try {
        eng.resume();
        await eng.loadFile(f);
        $('file-name').textContent = f.name;
        $('btn-file-play').disabled = false;
        eng.playFile();
        this._refreshFileBtn();
        this.setStatus('已加载：' + f.name + '（' + eng.file.buffer.duration.toFixed(1) + 's）');
      } catch (err) {
        this.setStatus('音频解码失败：' + err.message, true);
      }
    },
    _refreshFileBtn() {
      const eng = this.app.engine;
      $('btn-file-play').textContent = eng.file.playing ? '暂停' : '播放';
    },
    setStatus(text, isErr) {
      const s = $('status-text');
      s.textContent = text;
      s.style.color = isErr ? 'var(--red)' : '';
    },
  };

  global.UI = UI;
})(window);
