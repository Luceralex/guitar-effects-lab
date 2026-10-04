/* ============================================================
 * score.js —— 乐谱解析：文本六线谱 / MusicXML 五线谱 → 指板事件
 * ------------------------------------------------------------
 * 三步流水线，全部离线完成：
 *   1) 解析：tab 文本（Ultimate Guitar 式 ASCII）或 MusicXML
 *      （MuseScore / Guitar Pro / Sibelius 都能导出）→ 时间轴事件
 *      { startBeat, durBeats, notes:[{string,fret}] 或 midis:[..] }
 *   2) 指板映射：只有音高的事件（五线谱）按"最小手部移动"贪心
 *      分配到琴弦/品格；六线谱自带指位，直接沿用
 *   3) 和弦手型：优先用谱面和弦记号（tab 的和弦行 / XML 的
 *      <harmony>），没有就按小节音级集合推断，再配一个标准手型
 *      （常见开放和弦 → E 型 / A 型横按），供手型提示卡绘制
 * ============================================================ */
(function (global) {
  'use strict';

  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const STEP_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const SHARP_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
  const FLAT_ORDER = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];
  const MAX_FRET_PARSE = 24;   // tab 里出现的品号上限（超过的当误识别丢掉）
  const MEASURE_BEATS = 4;     // tab 文本按 4/4 估：一个小节 4 拍

  const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const nameOf = (m) => NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
  function keyAlter(step, fifths) {
    if (fifths > 0) return SHARP_ORDER.slice(0, Math.min(7, fifths)).includes(step) ? 1 : 0;
    if (fifths < 0) return FLAT_ORDER.slice(0, Math.min(7, -fifths)).includes(step) ? -1 : 0;
    return 0;
  }
  // ASCII TAB 无音值记号，只有列宽；选最接近的常见音值用于显示。
  function estimatedRhythm(beats) {
    const values = [
      [0.25, '16th', 0], [0.375, '16th', 1], [0.5, 'eighth', 0],
      [0.75, 'eighth', 1], [1, 'quarter', 0], [1.5, 'quarter', 1],
      [2, 'half', 0], [3, 'half', 1], [4, 'whole', 0],
    ];
    const nearest = values.reduce((best, item) => Math.abs(item[0] - beats) < Math.abs(best[0] - beats) ? item : best);
    return { type: nearest[1], dots: nearest[2], estimated: true };
  }

  /* ================= 和弦识别 ================= */
  const CHORD_TEMPLATES = [
    ['maj', [0, 4, 7], ''],
    ['m', [0, 3, 7], 'm'],
    ['7', [0, 4, 7, 10], '7'],
    ['m7', [0, 3, 7, 10], 'm7'],
    ['maj7', [0, 4, 7, 11], 'maj7'],
    ['sus4', [0, 5, 7], 'sus4'],
    ['dim', [0, 3, 6], 'dim'],
    ['5', [0, 7], '5'],
    ['6', [0, 4, 7, 9], '6'],
    ['m6', [0, 3, 7, 9], 'm6'],
    ['aug', [0, 4, 8], 'aug'],
  ];
  // 从音级集合（+低音）猜和弦：模板匹配，允许多 1 个和弦外音
  function detectChord(pcs, bassPc) {
    const set = new Set(pcs);
    if (!set.size) return null;
    let best = null;
    for (const [q, steps, suffix] of CHORD_TEMPLATES) {
      for (let root = 0; root < 12; root++) {
        if (!set.has(root)) continue;
        const tpl = steps.map((s) => (root + s) % 12);
        let matched = 0;
        for (const p of tpl) if (set.has(p)) matched++;
        const extra = set.size - matched;
        const missing = tpl.length - matched;      // 模板要求但谱里没有的音
        if (extra > 1 || missing > 0) continue;    // 模板音必须全部出现，否则 C 会被认成 C7
        let score = matched - extra * 0.6 + tpl.length * 0.1;
        if (bassPc === root) score += 0.8;   // 低音是根音 → 明显加权
        if (!best || score > best.score) {
          best = { root, quality: q, name: NOTE_NAMES[root] + suffix, pcs: tpl, score };
        }
      }
    }
    return best;
  }

  /* ================= 和弦记号 → 音级 ================= */
  const QUALITY_MAP = {
    '': 'maj', maj: 'maj', M: 'maj', major: 'maj', min: 'm', m: 'm', '-': 'm',
    minor: 'm', dominant: '7', '7': '7', m7: 'm7', min7: 'm7', maj7: 'maj7',
    M7: 'maj7', 'maj9': 'maj7', 'half-diminished': 'm7b5',
    'diminished': 'dim', 'augmented': 'aug', 'suspended-fourth': 'sus4',
    'suspended-second': 'sus2', 'major-ninth': 'maj7', 'minor-ninth': 'm7',
    sus: 'sus4', sus4: 'sus4', sus2: 'sus2', dim: 'dim', aug: 'aug',
    add9: 'add9', '5': '5', '6': '6', m6: 'm6', '9': '9', m7b5: 'm7b5',
  };
  const QUALITY_INTERVALS = {
    maj: [0, 4, 7], m: [0, 3, 7], 7: [0, 4, 7, 10], m7: [0, 3, 7, 10],
    maj7: [0, 4, 7, 11], sus4: [0, 5, 7], sus2: [0, 2, 7], dim: [0, 3, 6],
    aug: [0, 4, 8], add9: [0, 4, 7, 2], '5': [0, 7], '6': [0, 4, 7, 9],
    m6: [0, 3, 7, 9], '9': [0, 4, 7, 10, 2], m7b5: [0, 3, 6, 10],
  };
  const QUALITY_SUFFIX = { maj: '', m: 'm', '7': '7', m7: 'm7', maj7: 'maj7', sus4: 'sus4', sus2: 'sus2', dim: 'dim', aug: 'aug', add9: 'add9', '5': '5', '6': '6', m6: 'm6', '9': '9', m7b5: 'm7b5' };

  function chordTokenToInfo(token) {
    const m = /^([A-G])([#b]?)(.*)$/.exec(token.trim());
    if (!m) return null;
    let root = STEP_PC[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
    root = ((root % 12) + 12) % 12;
    const q = QUALITY_MAP[m[3]] || 'maj';
    const ivs = QUALITY_INTERVALS[q] || [0, 4, 7];
    return { root, quality: q, name: NOTE_NAMES[root] + (QUALITY_SUFFIX[q] || ''), pcs: ivs.map((v) => (root + v) % 12) };
  }

  /* ================= 标准手型库 =================
   * frets 一律"低→高"（6 弦 E → 1 弦 e），-1 = 闷音不按，0 = 空弦。
   * 不在库里的和弦退到 E 型 / A 型横按 —— 练琴时"大概按哪"够用了。 */
  const OPEN_SHAPES = {
    'C:maj': [-1, 3, 2, 0, 1, 0], 'C:maj7': [-1, 3, 2, 0, 0, 0], 'C:7': [-1, 3, 2, 3, 1, 0],
    'A:maj': [-1, 0, 2, 2, 2, 0], 'A:7': [-1, 0, 2, 0, 2, 0], 'A:m': [-1, 0, 2, 2, 1, 0],
    'A:m7': [-1, 0, 2, 0, 1, 0], 'A:sus4': [-1, 0, 2, 2, 3, 0], 'A:5': [-1, 0, 2, -1, -1, -1],
    'G:maj': [3, 2, 0, 0, 0, 3], 'G:7': [3, 2, 0, 0, 0, 1], 'G:maj7': [3, -1, 0, 0, 0, 2],
    'E:maj': [0, 2, 2, 1, 0, 0], 'E:7': [0, 2, 0, 1, 0, 0], 'E:m': [0, 2, 2, 0, 0, 0],
    'E:m7': [0, 2, 0, 0, 0, 0], 'E:sus4': [0, 2, 2, 2, 0, 0], 'E:5': [0, 2, -1, -1, -1, -1],
    'D:maj': [-1, -1, 0, 2, 3, 2], 'D:7': [-1, -1, 0, 2, 1, 2], 'D:m': [-1, -1, 0, 2, 3, 1],
    'D:m7': [-1, -1, 0, 2, 1, 1], 'D:maj7': [-1, -1, 0, 2, 2, 2], 'D:sus4': [-1, -1, 0, 2, 3, 3],
    'B:7': [-1, 2, 1, 2, 0, 2],
    'F:maj7': [-1, -1, 3, 2, 1, 0],
  };
  // 横按形状 = 横按品 n + 每根弦的相对偏移
  const BARRE_E = {   // 根音在 6 弦第 n 品（E 型）
    maj: [0, 2, 2, 1, 0, 0], m: [0, 2, 2, 0, 0, 0], 7: [0, 2, 0, 1, 0, 0],
    m7: [0, 2, 0, 0, 0, 0], maj7: [0, 2, 1, 1, 0, 0], sus4: [0, 2, 2, 3, 0, 0],
    '5': [0, 2, 2, -1, -1, -1],
  };
  const BARRE_A = {   // 根音在 5 弦第 n 品（A 型，6 弦闷掉），偏移对应 A/D/G/B/e 五根弦
    maj: [0, 2, 2, 2, 0], m: [0, 2, 2, 1, 0], 7: [0, 2, 0, 2, 0],
    m7: [0, 2, 0, 1, 0], maj7: [0, 2, 1, 2, 0], sus4: [0, 2, 2, 3, 0],
    '5': [0, 2, -1, -1, -1],
  };
  // 不好横按的形状退化为近似手型（"大概按哪"级别）
  const FALLBACK_QUALITY = { dim: 'm', m6: 'm', aug: 'maj', add9: 'maj', '9': '7', sus2: 'sus4', m7b5: 'm7' };

  function chordShape(rootPc, quality) {
    let q = quality;
    let key = NOTE_NAMES[rootPc] + ':' + q;
    let frets = OPEN_SHAPES[key];
    if (!frets && FALLBACK_QUALITY[q]) {
      q = FALLBACK_QUALITY[q];
      frets = OPEN_SHAPES[NOTE_NAMES[rootPc] + ':' + q];
    }
    if (frets) return { frets: frets.slice(), quality: q };
    const nE = ((rootPc - 4) % 12 + 12) % 12 || 12;
    const nA = ((rootPc - 9) % 12 + 12) % 12 || 12;
    if (BARRE_E[q] && (nE <= nA || !BARRE_A[q])) {
      return { frets: BARRE_E[q].map((o) => (o < 0 ? -1 : nE + o)), quality: q };
    }
    if (BARRE_A[q]) {
      return { frets: [-1, ...BARRE_A[q].map((o) => (o < 0 ? -1 : nA + o))], quality: q };
    }
    return null;
  }

  /* ================= 文本六线谱解析 =================
   * 识别形如 e|---3--3--| 的行；连续 ≥4 行凑成一个 block；
   * 和弦行（整行只有和弦记号）分配给紧随其后的 block 逐小节。 */
  function parseTabText(text, tuning, maxFret) {
    const labelIdx = { e: 0, b: 1, B: 1, g: 2, G: 2, d: 3, D: 3, a: 4, A: 4, E: 5 };
    const STRING_RE = /^\s*([eEaAdDgGbB])\s*\|(.*)$/;
    const CHORD_TOKEN_RE = /^[A-G][#b]?(m|maj|min|dim|aug|sus|add|M)?[0-9]*(sus[24]|add[0-9]+|b5|#5)?(\/[A-G][#b]?)?$/;
    const lines = String(text || '').replace(/\r/g, '').split('\n');
    const evs = [];                       // {colGroup 跨段累计不必要，直接顺序排}
    const chordTok = [];
    const warnings = [];
    let title = null;
    let bpmOut = null;
    let measureBase = 0;
    let pendingChords = null;
    let block = [];

    const flushBlock = () => {
      if (block.length < 4) { block = []; return; }
      const rows = block.map((m) => {
        const segs = m.content.split('|');
        if (segs.length && segs[segs.length - 1] === '') segs.pop();   // 末尾 | 的 split 伪影
        return { si: labelIdx[m.label], segs };
      });
      const nSegs = Math.max(...rows.map((r) => r.segs.length));
      for (let s = 0; s < nSegs; s++, measureBase++) {
        const segs = rows.map((r) => r.segs[s] || '');
        const width = Math.max(1, ...segs.map((x) => x.length));
        const byCol = new Map();
        for (const [rowIdx, r] of rows.entries()) {
          const seg = segs[rowIdx];
          for (let i = 0; i < seg.length; i++) {
            if (seg[i] >= '0' && seg[i] <= '9') {
              let j = i;
              while (j < seg.length && seg[j] >= '0' && seg[j] <= '9') j++;
              const fret = parseInt(seg.slice(i, j), 10);
              if (fret <= maxFret) {
                if (!byCol.has(i)) byCol.set(i, []);
                byCol.get(i).push({ string: r.si, fret });
              }
              i = j - 1;
            }
          }
        }
        const cols = [...byCol.keys()].sort((a, b) => a - b);
        for (let k = 0; k < cols.length; k++) {
          const col = cols[k];
          evs.push({ col, width, measure: measureBase, notes: byCol.get(col) });
        }
      }
      // 和弦行挂到本 block 的小节
      if (pendingChords) {
        pendingChords.forEach((tok, i) => chordTok.push({ measure: measureBase - nSegs + i, token: tok }));
        pendingChords = null;
      }
      block = [];
    };

    for (const line0 of lines) {
      const line = line0.replace(/\t/g, '  ');
      const tm = STRING_RE.exec(line);
      if (tm) { block.push({ label: tm[1], content: tm[2] }); continue; }
      // 非谱行 → 结束当前 block
      flushBlock();
      const trimmed = line.trim();
      if (!trimmed) continue;
      const tokens = trimmed.split(/\s+/);
      const allChords = tokens.every((t) => CHORD_TOKEN_RE.test(t) || /^[|]+$/.test(t)) &&
        tokens.some((t) => CHORD_TOKEN_RE.test(t));
      if (allChords) {
        pendingChords = tokens.filter((t) => CHORD_TOKEN_RE.test(t));
      } else if (!title) {
        title = trimmed.slice(0, 60);
        const bm = /BPM\s*(\d{2,3})/i.exec(trimmed);   // 标题里带 BPM100 之类 → 设定试听速度
        if (bm) bpmOut = parseInt(bm[1], 10);
      }
    }
    flushBlock();

    // ASCII 谱没有正式时值。每根竖线之间暂按四拍等宽网格估计；
    // 同小节下一列或小节末尾决定当前音的估计时长。
    const events = evs.map((e, i) => {
      const startBeat = e.measure * MEASURE_BEATS + e.col / e.width * MEASURE_BEATS;
      const next = evs[i + 1];
      const endBeat = next && next.measure === e.measure
        ? e.measure * MEASURE_BEATS + next.col / next.width * MEASURE_BEATS
        : (e.measure + 1) * MEASURE_BEATS;
      return { startBeat, durBeats: Math.max(0.25, endBeat - startBeat), measure: e.measure, notes: e.notes };
    });
    if (!events.length) return { error: '没有解析到任何音符 —— 检查粘贴的是不是 e|---3---| 形式的六线谱' };
    return buildScore({
      source: 'tab', title, events, measures: measureBase,
      chordTokens: chordTok, tuning, maxFret, warnings, bpm: bpmOut,
    });
  }

  /* ================= MusicXML（五线谱）解析 =================
   * 只取第一个 part；读 divisions/backup/forward 处理多声部，
   * <chord/> 并入同拍事件，<harmony> 当作和弦记号，
   * <transpose> 的半音数（变调夹/移调）直接加到所有音上。 */
  function parseMusicXml(text, tuning, maxFret) {
    let doc;
    try { doc = new DOMParser().parseFromString(text, 'text/xml'); }
    catch (e) { return { error: 'XML 解析失败：' + e.message }; }
    if (doc.querySelector('parsererror')) return { error: '不是有效的 MusicXML 文件' };
    if (doc.documentElement?.tagName === 'score-timewise') {
      return { error: '暂不支持 score-timewise MusicXML，请导出 score-partwise 格式' };
    }
    const part = doc.querySelector('score-partwise > part');
    if (!part) return { error: 'MusicXML 里没有乐谱声部（<part>）' };
    const events = [];
    const chordMarks = [];
    const warnings = [];
    let divisions = 1;
    let transpose = 0;
    let cursor = 0;
    let prevStart = 0;
    let measureEnd = 0;
    const measureStarts = [];
    const measureInfo = [];
    let bpm = null;
    let measures = 0;
    let fifths = 0, beats = 4, beatType = 4;

    for (const measure of part.children) {
      if (measure.tagName !== 'measure') continue;
      const measureStart = measureEnd;
      measureStarts.push(measureStart);
      measureInfo.push({ fifths, beats, beatType });
      cursor = measureStart;
      prevStart = measureStart;
      measures++;
      for (const node of measure.children) {
        if (node.tagName === 'attributes') {
          const dv = node.querySelector('divisions');
          if (dv) divisions = parseFloat(dv.textContent) || divisions;
          const key = node.querySelector('key > fifths');
          if (key) fifths = Math.max(-7, Math.min(7, parseInt(key.textContent, 10) || 0));
          const time = node.querySelector('time');
          if (time) {
            beats = parseInt(time.querySelector('beats')?.textContent || '', 10) || beats;
            beatType = parseInt(time.querySelector('beat-type')?.textContent || '', 10) || beatType;
          }
          measureInfo[measures - 1] = { fifths, beats, beatType };
          const tr = node.querySelector('transpose');
          if (tr) transpose = (parseInt(tr.querySelector('chromatic')?.textContent || '0', 10) || 0) +
            12 * (parseInt(tr.querySelector('octave-change')?.textContent || '0', 10) || 0);
        } else if (node.tagName === 'harmony') {
          // 注意：MusicXML 里是 <root-step>/<root-alter> 这种带连字符的
          // 单个标签，不能写 'root step' 后代选择器（那样永远匹配不到）
          const step = node.querySelector('root-step')?.textContent;
          const alter = parseInt(node.querySelector('root-alter')?.textContent || '0', 10) || 0;
          const kind = node.querySelector('kind')?.textContent || 'major';
          if (step) {
            const root = ((STEP_PC[step] + alter + transpose) % 12 + 12) % 12;
            const q = QUALITY_MAP[kind === 'major' ? '' : kind] || 'maj';
            const ivs = QUALITY_INTERVALS[q] || [0, 4, 7];
            chordMarks.push({
              measure: measures - 1, root, quality: q,
              name: NOTE_NAMES[root] + (QUALITY_SUFFIX[q] || ''),
              pcs: ivs.map((v) => (root + v) % 12),
            });
          }
        } else if (node.tagName === 'backup' || node.tagName === 'forward') {
          const d = parseFloat(node.querySelector('duration')?.textContent || '0') / divisions;
          cursor = Math.max(measureStart, cursor + (node.tagName === 'backup' ? -d : d));
          measureEnd = Math.max(measureEnd, cursor);
        } else if ((node.tagName === 'sound' || node.tagName === 'direction') && node.querySelector('sound[tempo]')) {
          bpm = parseFloat(node.querySelector('sound[tempo]').getAttribute('tempo')) || bpm;
        } else if (node.tagName === 'sound' && node.getAttribute('tempo')) {
          bpm = parseFloat(node.getAttribute('tempo')) || bpm;
        } else if (node.tagName === 'note') {
          if (node.querySelector('grace')) continue;               // 装饰音不计拍
          if (node.querySelector('unpitched')) continue;           // 打击乐声部
          const dur = Math.max(0, parseFloat(node.querySelector('duration')?.textContent || '0') / divisions);
          if (node.querySelector('rest')) {
            if (!node.querySelector('chord')) cursor += dur;
            measureEnd = Math.max(measureEnd, cursor);
            continue;
          }
          const step = node.querySelector('pitch step')?.textContent;
          if (!step) continue;
          const alter = parseFloat(node.querySelector('pitch alter')?.textContent || '0') || 0;
          const octave = parseInt(node.querySelector('pitch octave')?.textContent || '4', 10);
          const midi = (octave + 1) * 12 + STEP_PC[step] + alter + transpose;
          const pitchInfo = {
            midi, step, alter, octave,
            accidental: node.querySelector('accidental')?.textContent?.trim() || null,
            type: node.querySelector('type')?.textContent?.trim() || null,
            dots: node.querySelectorAll('dot').length,
          };
          const isChord = !!node.querySelector('chord');
          const start = isChord ? prevStart : cursor;
          if (!isChord) { prevStart = start; cursor += dur; }
          measureEnd = Math.max(measureEnd, start + dur, cursor);
          const last = events[events.length - 1];
          if (isChord && last && last.startBeat === start) {
            last.midis.push(midi);
            last.pitches.push(pitchInfo);
            last.durBeats = Math.max(last.durBeats, dur);
          } else {
            events.push({ startBeat: start, durBeats: Math.max(0.25, dur), midis: [midi], pitches: [pitchInfo], measure: measures - 1 });
          }
        }
      }
    }
    if (!events.length) return { error: 'MusicXML 里没有解析到音符' };
    events.sort((a, b) => a.startBeat - b.startBeat);
    const joined = [];
    for (const ev of events) {
      const prev = joined[joined.length - 1];
      if (prev && prev.startBeat === ev.startBeat && prev.measure === ev.measure) {
        prev.midis.push(...ev.midis);
        prev.pitches.push(...ev.pitches);
        prev.durBeats = Math.max(prev.durBeats, ev.durBeats);
      } else joined.push(ev);
    }
    // 临时记号按小节、音名和八度持续；明确写在 XML 中的记号始终显示。
    let lastMeasure = -1;
    let accidentals = new Map();
    for (const ev of joined) {
      if (ev.measure !== lastMeasure) { accidentals = new Map(); lastMeasure = ev.measure; }
      for (const p of ev.pitches) {
        const id = `${p.step}${p.octave}`;
        const expected = accidentals.has(id) ? accidentals.get(id) : keyAlter(p.step, measureInfo[ev.measure].fifths);
        if (p.accidental) p.displayAccidental = p.accidental;
        else if (p.alter !== expected) p.displayAccidental = p.alter === 1 ? 'sharp' : p.alter === -1 ? 'flat' : p.alter === 0 ? 'natural' : null;
        accidentals.set(id, p.alter);
      }
    }
    return buildScore({
      source: 'xml', title: doc.querySelector('work-title, movement-title')?.textContent?.trim() || null,
      events: joined, measures, measureStarts, measureInfo, totalBeats: measureEnd,
      chordMarks, tuning, maxFret, warnings,
      bpm: bpm && bpm > 20 && bpm < 300 ? Math.round(bpm) : null,
    });
  }

  /* ================= 指板映射 =================
   * 单音：候选指位按 |Δ品|·1.3 + |Δ弦|·0.7 + 品位·0.1（偏爱低位）
   *       + 空弦奖励 打分；和弦：在每音的候选指位里做带剪枝的
   *       组合搜索，要求把位跨度 ≤4（空弦除外），尽量贴近上一个手型。 */
  function mapToFretboard(score, tuning, maxFret) {
    const positionsOf = (midi) => {
      const out = [];
      tuning.forEach((open, si) => {
        const f = midi - open;
        if (f >= 0 && f <= maxFret) out.push({ string: si, fret: f });
      });
      return out;
    };
    let prevF = 3, prevS = 3;
    let skipped = 0;
    for (const ev of score.events) {
      const pitches = (ev.pitches || (ev.midis || []).map((midi) => ({ midi })))
        .slice().sort((a, b) => a.midi - b.midi).slice(0, 6);
      const midis = pitches.map((p) => p.midi);
      const notes = [];
      if (midis.length === 1) {
        const cands = positionsOf(midis[0]);
        if (!cands.length) { skipped += 1; continue; }
        let best = cands[0], bestCost = Infinity;
        for (const c of cands) {
          const cost = Math.abs(c.fret - prevF) * 1.3 + Math.abs(c.string - prevS) * 0.7 +
            c.fret * 0.1 + (c.fret === 0 ? -0.6 : 0);
          if (cost < bestCost) { bestCost = cost; best = c; }
        }
        notes.push({ ...best, ...pitches[0] });
      } else if (midis.length > 1) {
        const candLists = midis.map(positionsOf);
        if (candLists.some((l) => !l.length)) { skipped += midis.length; continue; }
        let best = null, bestCost = Infinity;
        const dfs = (i, picked, fretsUsed) => {
          if (best && bestCost < 0) return;
          if (i === candLists.length) {
            const real = fretsUsed.filter((f) => f > 0);
            const span = real.length ? Math.max(...real) - Math.min(...real) : 0;
            if (span > 4) return;
            let cost = span * 1.5;
            for (const p of picked) {
              cost += p.fret * 0.1 + (p.fret === 0 ? -0.5 : 0) +
                Math.abs(p.fret - prevF) * 0.9 + Math.abs(p.string - prevS) * 0.4;
            }
            // 同一根弦双音不可能——picked 的 string 必须互异
            const strs = new Set(picked.map((p) => p.string));
            if (strs.size !== picked.length) return;
            if (cost < bestCost) { bestCost = cost; best = picked.slice(); }
            return;
          }
          for (const c of candLists[i]) {
            picked.push(c);
            fretsUsed.push(c.fret);
            dfs(i + 1, picked, fretsUsed);
            picked.pop();
            fretsUsed.pop();
          }
        };
        dfs(0, [], []);
        if (!best) { skipped += midis.length; continue; }
        notes.push(...best.map((p, i) => ({ ...p, ...pitches[i] })));
      }
      ev.notes = notes;
      ev.midis = notes.map((n) => tuning[n.string] + n.fret);
      const low = notes.reduce((a, b) => (b.fret < a.fret ? b : a), notes[0]);
      prevF = low.fret; prevS = low.string;
    }
    score.events = score.events.filter((e) => e.notes && e.notes.length);
    score.stats = { skipped };
    return score;
  }

  /* ================= 组装：拍号统计 + 每小节和弦 ================= */
  function buildScore(base) {
    let { events } = base;
    const { tuning, maxFret } = base;
    // tab 事件已有指位 → 补 midi；xml 事件只有 midi → 映射指位
    if (base.source === 'tab') {
      let lastMeasure = -1;
      let accidentals = new Map();
      for (const ev of events) {
        if (ev.measure !== lastMeasure) { accidentals = new Map(); lastMeasure = ev.measure; }
        for (const n of ev.notes) {
          n.midi = tuning[n.string] + n.fret;
          const written = n.midi + 12;
          const name = NOTE_NAMES[((written % 12) + 12) % 12];
          n.step = name[0];
          n.alter = name.length > 1 ? 1 : 0;
          n.octave = (written - STEP_PC[n.step] - n.alter) / 12 - 1;
          const id = `${n.step}${n.octave}`;
          const expected = accidentals.get(id) || 0;
          if (n.alter !== expected) n.displayAccidental = n.alter ? 'sharp' : 'natural';
          accidentals.set(id, n.alter);
        }
        ev.midis = ev.notes.map((n) => n.midi);
        ev.rhythm = estimatedRhythm(ev.durBeats);
      }
    } else {
      const mapped = mapToFretboard({ events }, tuning, maxFret);
      events = mapped.events;
      base.stats = mapped.stats;
    }
    if (!events.length) return { error: '谱面里的音符超出当前 15 品标准调弦的可弹范围' };
    const totalBeats = Math.max(base.totalBeats || 0,
      events.reduce((mx, e) => Math.max(mx, e.startBeat + e.durBeats), 0));
    const measures = Math.max(1, base.measures);
    // 每小节和弦：谱面记号优先，没有就按该小节音级集合推断
    const chordForMeasure = new Array(measures).fill(null);
    const marks = base.source === 'tab'
      ? base.chordTokens.map((t) => ({ measure: t.measure, ...chordTokenToInfo(t.token) })).filter((c) => c.root != null && c.measure >= 0)
      : (base.chordMarks || []);
    for (const c of marks) {
      if (c.measure < measures && !chordForMeasure[c.measure]) {
        chordForMeasure[c.measure] = { ...c, shape: chordShape(c.root, c.quality) };
      }
    }
    for (let m = 0; m < measures; m++) {
      if (chordForMeasure[m]) continue;
      const pcs = [];
      let bass = null;
      for (const ev of events) {
        if (ev.measure !== m) continue;
        for (const mi of ev.midis) { pcs.push(mi % 12); if (bass === null || mi < bass) bass = mi; }
      }
      if (!pcs.length) continue;
      const det = detectChord(pcs, bass % 12);
      if (det) chordForMeasure[m] = { ...det, shape: chordShape(det.root, det.quality), inferred: true };
    }
    const playable = events.reduce((n, e) => n + e.midis.length, 0);
    return {
      source: base.source, title: base.title,
      events, measures, totalBeats,
      measureStarts: base.measureStarts || Array.from({ length: measures }, (_, m) => m * MEASURE_BEATS),
      measureInfo: base.measureInfo || Array.from({ length: measures }, () => ({ fifths: 0, beats: 4, beatType: 4 })),
      chordForMeasure,
      chords: [...new Set(chordForMeasure.filter(Boolean).map((c) => c.name))],
      bpm: base.bpm || null,
      stats: { playable, skipped: (base.stats && base.stats.skipped) || 0 },
      warnings: base.warnings || [],
    };
  }

  /* 示例谱 1：Am-F-C-G 琶音，每小节 8 个均分音，用于快速体验 */
  const SAMPLE_TAB = [
    'Am          F           C           G',
    'e|----0---|-----1--|----0---|-----3--|',
    'B|---1-1--|----1-1-|---1-1--|----0-0-|',
    'G|--2---2-|---2---2|--0---0-|---0--0-|',
    'D|-2-----2|--3-----|-2-----2|--0----0|',
    'A|0-------|-3------|3-------|-2------|',
    'E|--------|1-------|--------|3-------|',
  ].join('\n');

  /* 示例谱 2：小星星（C 大调开放把位，12 小节），由音符表程序化生成
   * 六线谱文本，保证弦/品/时值不写错。二分音符靠"到下一个音的列距"
   * 自动推断（列距是中位数 2 倍 → 2 拍）。 */
  function buildTwinkleTab() {
    const M = { C4: [4, 3], D4: [3, 0], E4: [3, 2], F4: [3, 3], G4: [2, 0], A4: [2, 2] };
    const bars = [
      [['C4', 1], ['C4', 1], ['G4', 1], ['G4', 1]],
      [['A4', 1], ['A4', 1], ['G4', 2]],
      [['F4', 1], ['F4', 1], ['E4', 1], ['E4', 1]],
      [['D4', 1], ['D4', 1], ['C4', 2]],
      [['G4', 1], ['G4', 1], ['F4', 1], ['F4', 1]],
      [['E4', 1], ['E4', 1], ['D4', 2]],
      [['G4', 1], ['G4', 1], ['F4', 1], ['F4', 1]],
      [['E4', 1], ['E4', 1], ['D4', 2]],
      [['C4', 1], ['C4', 1], ['G4', 1], ['G4', 1]],
      [['A4', 1], ['A4', 1], ['G4', 2]],
      [['F4', 1], ['F4', 1], ['E4', 1], ['E4', 1]],
      [['D4', 1], ['D4', 1], ['C4', 2]],
    ];
    const chords = ['C', 'C', 'F', 'C', 'C', 'C', 'F', 'C', 'C', 'C', 'F', 'C'];
    const CPB = 2;                     // 每拍 2 列
    const w = 4 * CPB;                 // 每小节 8 列
    const out = Array.from({ length: 6 }, () => '');
    bars.forEach((bar) => {
      const grid = Array.from({ length: 6 }, () => new Array(w).fill('-'));
      let col = 0;
      for (const [name, beats] of bar) {
        if (name) {
          const [si, fret] = M[name];
          const s = String(fret);
          for (let k = 0; k < s.length; k++) grid[si][col + k] = s[k];
        }
        col += beats * CPB;
      }
      for (let i = 0; i < 6; i++) out[i] += grid[i].join('') + '|';
    });
    const labels = ['e', 'B', 'G', 'D', 'A', 'E'];
    const lines = out.map((row, i) => labels[i] + '|' + row);
    return ['小星星（C 大调 · 开放把位）', '', chords.join('  '), ...lines].join('\n');
  }
  const SAMPLE_TWINKLE = buildTwinkleTab();

  /* 示例谱 3/4：丸之内进行（椎名林檎《丸の内サディスティック》的和声骨架）
   * BPM100 · 4/4 · G 调弹 Cmaj7 → B7 → Em7 → G7（即"丸サ進行"
   * IVmaj7-III7-VIm7-I7 的 G 调版本，原曲为 A♭ 调夹 1 品）。
   * 和弦进行是公开的和声事实；指弹版为风格化琶音改编，非原曲 riff 转录。 */
  function buildMarunouchiTabs() {
    const CH = [
      { name: 'Cmaj7', root: [4, 3], pad: [[3, 2], [2, 0], [1, 0], [0, 0]] },
      { name: 'B7',    root: [4, 2], pad: [[3, 1], [2, 2], [1, 0], [0, 2]] },
      { name: 'Em7',   root: [5, 0], pad: [[3, 0], [2, 0], [1, 3], [0, 0]] },
      { name: 'G7',    root: [5, 3], pad: [[3, 0], [2, 0], [1, 0], [0, 1]] },
    ];
    const CPB = 2, LOOPS = 2;
    const render = (fillBar) => {
      const out = Array.from({ length: 6 }, () => '');
      const names = [];
      for (let loop = 0; loop < LOOPS; loop++) {
        for (const ch of CH) {
          names.push(ch.name);
          // 每小节 16 列：8 个扫弦位各占 1 列 + 1 列横线隔开。
          // 相邻列的数字会连成一个多位数（"2000000"），必须隔开——
          // 这也是手写 ASCII 谱的通用规范。
          const grid = Array.from({ length: 6 }, () => new Array(16).fill('-'));
          fillBar(grid, ch);
          for (let i = 0; i < 6; i++) out[i] += grid[i].join('') + '|';
        }
      }
      const labels = ['e', 'B', 'G', 'D', 'A', 'E'];
      return { names, lines: out.map((row, i) => labels[i] + '|' + row) };
    };
    const put = (grid, si, fret, col) => {
      const s = String(fret);
      for (let k = 0; k < s.length; k++) grid[si][col + k] = s[k];
    };
    // 弹唱扫弦：每小节第 1 列根音，随后 7 个八分音符（偶数列）交替扫 4/3 根弦
    const strum = render((grid, ch) => {
      put(grid, ch.root[0], ch.root[1], 0);
      for (let c = 1; c < 8; c++) {
        const col = c * 2;
        const voices = c % 2 === 1 ? ch.pad : ch.pad.slice(1);
        for (const [si, fret] of voices) put(grid, si, fret, col);
      }
    });
    // 指弹琶音：根-3-5-7-高-7-5-3 上行回落（偶数列，留横线隔开相邻数字）
    const finger = render((grid, ch) => {
      const seq = [ch.root, ...ch.pad, ch.pad[2], ch.pad[1], ch.pad[0]];
      seq.forEach(([si, fret], c) => put(grid, si, fret, c * 2));
    });
    // 每小节 16 列 = 4 拍，速度 100 BPM。
    const head = (sub) => [`丸サ進行 · ${sub}（BPM100）`, ''];
    return {
      strumText: [...head('弹唱扫弦'), strum.names.join('  '), ...strum.lines].join('\n'),
      fingerText: [...head('指弹琶音'), finger.names.join('  '), ...finger.lines].join('\n'),
    };
  }
  const MARU = buildMarunouchiTabs();

  global.ScoreNS = {
    parseTabText, parseMusicXml, detectChord, chordShape,
    chordTokenToInfo, nameOf, midiHz,
    SAMPLE_TAB, SAMPLE_TWINKLE, SAMPLE_MARU_STRUM: MARU.strumText, SAMPLE_MARU_FINGER: MARU.fingerText,
  };
})(window);
