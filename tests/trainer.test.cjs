const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML, DOMParser } = require('linkedom');

test('loaded score follows playing and returns to practice start after audition', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const { window, document } = parseHTML(html);
  for (const element of document.querySelectorAll('select,input')) {
    Object.defineProperty(element, 'value', {
      value: element.getAttribute('value') || element.querySelector('option')?.getAttribute('value') || '',
      writable: true, configurable: true,
    });
  }
  const drawing = new Proxy({}, { get: (target, key) => target[key] || (() => {}) });
  const create = document.createElement.bind(document);
  document.createElement = (tag) => {
    const element = create(tag);
    if (tag === 'canvas') element.getContext = () => drawing;
    return element;
  };
  document.getElementById('canvas-fretboard').getContext = () => drawing;
  const context = {
    document, DOMParser, Event: window.Event, performance: { now: () => 1000 },
    setInterval: () => 1, clearInterval: () => {}, setTimeout: () => 1, clearTimeout: () => {},
    EngineNS: { PITCH_FFT_SIZE: 16384 },
    addEventListener: () => {}, devicePixelRatio: 1,
  };
  context.window = context;
  for (const filename of ['dsp.js', 'score.js', 'practice.js', 'fretboard.js']) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'js', filename), 'utf8'), context);
  }
  const ids = {
    canvas: 'canvas-fretboard', root: 'tb-root', scale: 'tb-scale', mode: 'tb-mode',
    labels: 'tb-labels', sens: 'tb-sens', sensVal: 'tb-sens-val', reset: 'tb-reset',
    detected: 'tb-detected', detHz: 'tb-det-hz', target: 'tb-target',
    progress: 'tb-progress', streak: 'tb-streak', acc: 'tb-acc', hint: 'tb-hint',
  };
  const engine = { ctx: { currentTime: 1 }, resume() {}, noteOn() {}, noteOff() {} };
  const trainer = new context.FretboardTrainer.Trainer(engine, ids, () => false);
  trainer._tryLoad(context.ScoreNS.SAMPLE_TWINKLE);
  assert.ok(trainer.score && trainer.follower);
  assert.equal(trainer.mode, 'score');
  const first = trainer.score.events[0].midis[0];
  trainer._onNote({ midi: first, midiF: first, onsetMs: 1000 });
  assert.equal(trainer.scoreCursor, 1);
  trainer.scoreAuto = { t0: 0, beat0: 0, idx: 0 };
  trainer.scoreCursor = trainer.score.events.length;
  trainer._scoreStop(false);
  assert.equal(trainer.scoreCursor, 1);
  trainer._scoreRestart();
  assert.equal(trainer.scoreCursor, 0);
  const flow = document.getElementById('canvas-scoreflow');
  Object.defineProperty(flow, 'clientWidth', { value: 900 });
  Object.defineProperty(flow, 'clientHeight', { value: 150 });
  assert.doesNotThrow(() => trainer._renderFlow(1000));

  trainer._tryLoad('e|0---0---|\nB|1-------|\nG|--------|\nD|--------|\nA|--------|\nE|--------|');
  assert.equal(trainer.score.events[0].midis.length, 2);
  trainer.buf = Float32Array.from({ length: 16384 }, (_, i) =>
    0.25 * Math.sin(2 * Math.PI * 329.6276 * i / 48000) +
    0.25 * Math.sin(2 * Math.PI * 261.6256 * i / 48000));
  engine.sampleRate = 48000;
  trainer._chordStartAt = 900;
  trainer._judgeCooldownUntil = 0;
  trainer._checkChord(1000, -12);
  assert.equal(trainer.scoreCursor, 1);
  trainer._onNote({ midi: 64, midiF: 64, onsetMs: 1000 });
  assert.equal(trainer.scoreCursor, 1, 'chord sustain cannot pass the following single note');
});
