/* Score following is independent of the audio and drawing loops. All times are
 * performance.now() milliseconds; score pitches are sounding MIDI numbers. */
(function (global) {
  'use strict';
  const pc = (m) => ((m % 12) + 12) % 12;
  const names = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  const name = (m) => names[pc(m)] + (Math.floor(m / 12) - 1);

  class ScoreFollower {
    constructor(score, options = {}) {
      this.score = score;
      this.mode = options.mode === 'tempo' ? 'tempo' : 'free';
      this.bpm = options.bpm || score.bpm || 90;
      this.latencyMs = Math.max(0, options.latencyMs || 0);
      this.reset();
    }
    reset() {
      this.cursor = 0;
      this.attempts = 0;
      this.hits = 0;
      this.skipped = 0;
      this.results = new Map();
      this.active = null;
      this.startMs = null;
      this.message = '准备好后弹奏谱面第一个音';
    }
    start(nowMs, countInBeats = 4) {
      this.reset();
      this.startMs = nowMs + countInBeats * 60000 / this.bpm;
      this.message = `倒数 ${countInBeats} 拍后开始`;
      return this.startMs;
    }
    get done() { return this.cursor >= this.score.events.length; }
    get current() { return this.score.events[this.cursor] || null; }
    expectedMs(ev) { return this.startMs + ev.startBeat * 60000 / this.bpm; }
    _matches(ev, note) {
      if (ev.midis.length > 1) {
        if (!note.chordComplete || note.ambiguous) return false;
        const a = new Set(ev.midis.map(pc));
        const b = new Set((note.midis || []).map(pc));
        return a.size > 1 && a.size === b.size && [...a].every((p) => b.has(p));
      }
      return Number.isFinite(note.midiF) &&
        ev.midis.some((m) => Math.abs(note.midiF - m) * 100 <= 45);
    }
    ingest(note) {
      if (this.done) return { kind: 'done', message: '整首已完成' };
      const at = note.onsetMs - this.latencyMs;
      if (this.mode === 'tempo' && (this.startMs == null || at < this.startMs - 150)) {
        return { kind: 'waiting', message: '先点「开始节拍跟弹」，等倒数结束' };
      }
      this.release(note.onsetMs);
      // Only look two events ahead. Repeated motifs cannot jump arbitrarily far.
      let match = -1;
      for (let i = this.cursor; i < Math.min(this.cursor + 3, this.score.events.length); i++) {
        if (this._matches(this.score.events[i], note)) { match = i; break; }
      }
      this.attempts++;
      if (match < 0) {
        const ev = this.current;
        const expected = ev.midis.map(name).join(' + ');
        const played = note.chordComplete ? (note.midis || []).map(name).join(' + ') :
          Number.isFinite(note.midiF) ? name(Math.round(note.midiF)) : '未识别';
        this.message = `弹了 ${played}，谱面需要 ${expected}`;
        this.results.set(this.cursor, { kind: 'wrong' });
        return { kind: 'wrong', index: this.cursor, message: this.message };
      }
      const skippedNow = match - this.cursor;
      for (let i = this.cursor; i < match; i++) {
        this.results.set(i, { kind: 'skipped' });
        this.skipped++;
      }
      const ev = this.score.events[match];
      this.hits++;
      let timing = null;
      let deltaMs = null;
      if (this.mode === 'tempo') {
        deltaMs = Math.round(at - this.expectedMs(ev));
        const allowance = Math.max(80, 0.18 * 60000 / this.bpm);
        timing = deltaMs < -allowance ? 'early' : deltaMs > allowance ? 'late' : 'on-time';
      }
      const cents = Number.isFinite(note.midiF) && ev.midis.length === 1 ?
        Math.round((note.midiF - ev.midis[0]) * 100) : null;
      this.results.set(match, { kind: 'hit', timing, deltaMs, cents, duration: null });
      this.active = { index: match, onsetMs: note.onsetMs };
      this.cursor = match + 1;
      const parts = [skippedNow ? `跳过 ${skippedNow} 个音，已跟上谱面` : '音高正确'];
      if (cents != null && Math.abs(cents) >= 20) parts.push(`音准偏${cents > 0 ? '高' : '低'} ${Math.abs(cents)} 音分`);
      if (timing === 'early') parts.push(`早了 ${Math.abs(deltaMs)} 毫秒`);
      if (timing === 'late') parts.push(`晚了 ${deltaMs} 毫秒`);
      if (this.done) parts.push('整首完成');
      else parts.push(`下一个 ${this.current.midis.map(name).join(' + ')}`);
      this.message = parts.join('；');
      return { kind: 'hit', index: match, skipped: skippedNow, timing, deltaMs, cents, message: this.message };
    }
    release(nowMs) {
      if (!this.active) return null;
      const { index, onsetMs } = this.active;
      this.active = null;
      const result = this.results.get(index);
      if (!result) return null;
      if (this.mode !== 'tempo') return null;
      const expected = this.score.events[index].durBeats * 60000 / this.bpm;
      const actual = Math.max(0, nowMs - onsetMs);
      result.duration = actual < expected * 0.65 ? 'short' : actual > expected * 1.6 ? 'long' : 'ok';
      if (result.duration === 'short') this.message += `；该音太短（约 ${Math.round(actual)} / ${Math.round(expected)} 毫秒）`;
      if (result.duration === 'long') this.message += `；该音偏长（约 ${Math.round(actual)} / ${Math.round(expected)} 毫秒）`;
      return { index, duration: result.duration, message: this.message };
    }
    tick(nowMs) {
      if (this.mode !== 'tempo' || this.startMs == null || this.done) return null;
      const ev = this.current;
      const deadline = this.expectedMs(ev) + Math.max(200, ev.durBeats * 60000 / this.bpm * 0.6);
      if (nowMs - this.latencyMs <= deadline) return null;
      const index = this.cursor++;
      this.results.set(index, { kind: 'skipped' });
      this.skipped++;
      this.message = this.done ? '节拍练习结束' : `第 ${index + 1} 个音漏弹；下一个 ${this.current.midis.map(name).join(' + ')}`;
      return { kind: 'skipped', index, message: this.message };
    }
  }
  global.PracticeNS = { ScoreFollower };
})(window);
