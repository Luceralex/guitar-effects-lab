const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const context = {};
context.window = context;
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'dsp.js'), 'utf8'), context);
const { DSP } = context;
const RATE = 48000;
const SIZE = 16384;

function signal(voices, noise = 0) {
  let seed = 123456;
  return Float32Array.from({ length: SIZE }, (_, i) => {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    const hiss = noise * (seed / 4294967296 * 2 - 1);
    return voices.reduce((sum, [hz, amp]) => sum + amp * Math.sin(2 * Math.PI * hz * i / RATE), hiss);
  });
}

test('single notes distinguish adjacent low guitar semitones', () => {
  for (const hz of [82.4069, 87.3071, 110, 164.8138, 440]) {
    const result = DSP.detectPitch(signal([[hz, 0.35]]), RATE, {}, {});
    assert.ok(result && result.conf > 0.8, `missing ${hz} Hz`);
    assert.ok(Math.abs(result.hz - hz) < 0.5, `${hz} Hz became ${result.hz}`);
  }
});

test('strong second and third harmonics retain the real E2 and A2', () => {
  for (const fundamental of [82.4069, 110]) {
    const result = DSP.detectPitch(signal([
      [fundamental, 0.1], [fundamental * 2, 0.6], [fundamental * 3, 0.3],
    ]), RATE, {}, {});
    assert.ok(result);
    assert.ok(Math.abs(result.hz - fundamental) < 0.6, `${fundamental} Hz became ${result.hz}`);
  }
});

test('silence, seeded noise, and a triad are not reported as confident single notes', () => {
  assert.equal(DSP.detectPitch(new Float32Array(SIZE), RATE, {}, {}), null);
  assert.equal(DSP.detectPitch(signal([], 0.4), RATE, {}, {}), null);
  assert.equal(DSP.detectPitch(signal([[130.81, 0.2], [164.81, 0.3], [196, 0.35]]), RATE, {}, {}), null);
});

test('scratch buffers are reused between analysis frames', () => {
  const scratch = {};
  const pcm = signal([[110, 0.3]]);
  DSP.detectPitch(pcm, RATE, scratch, {});
  const yin = scratch.yin;
  const diff = scratch.diff;
  DSP.detectPitch(pcm, RATE, scratch, {});
  assert.equal(scratch.yin, yin);
  assert.equal(scratch.diff, diff);
});

test('target chord needs every distinct pitch class', () => {
  const target = [48, 52, 55]; // C3 E3 G3
  const full = signal([[130.8128, 0.2], [164.8138, 0.18], [195.9977, 0.21]]);
  const onlyC = signal([[130.8128, 0.3], [261.6256, 0.12], [392.4384, 0.08]]);
  const found = DSP.detectChord(full, RATE, target, {}, {});
  const partial = DSP.detectChord(onlyC, RATE, target, {}, {});
  assert.equal(found.complete, true);
  assert.deepEqual(Array.from(found.missing), []);
  assert.equal(partial.complete, false);
  assert.ok(partial.missing.includes(52));
  assert.ok(partial.missing.includes(55));
});

test('octave-only voicing is explicitly ambiguous from one audio channel', () => {
  const result = DSP.detectChord(signal([[82.4069, 0.3], [164.8138, 0.2]]), RATE, [40, 52], {}, {});
  assert.equal(result.ambiguous, true);
  assert.equal(result.complete, false);
});

test('onset tracker counts two attacks of the same held pitch but not sustain', () => {
  const tracker = new DSP.OnsetTracker();
  const frames = [
    [0, -70], [25, -14], [50, -12], [75, -12], [100, -17],
    [125, -23], [150, -12], [175, -11], [200, -11],
  ];
  const onsets = frames.filter(([time, level]) => tracker.update(level, time, -48)).map(([time]) => time);
  assert.deepEqual(onsets, [25, 150]);
});
