const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = {};
context.window = context;
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'practice.js'), 'utf8'), context);
const { ScoreFollower } = context.PracticeNS;
const score = { events: [
  { startBeat: 0, durBeats: 1, midis: [60] },
  { startBeat: 1, durBeats: 1, midis: [62] },
  { startBeat: 2, durBeats: 2, midis: [64] },
] };

test('free following uses cents tolerance, recovers one missed note, then finishes', () => {
  const f = new ScoreFollower(score);
  assert.equal(f.ingest({ midiF: 60.49, onsetMs: 100 }).kind, 'wrong');
  assert.equal(f.ingest({ midiF: 60.4, onsetMs: 200 }).kind, 'hit');
  const recovered = f.ingest({ midiF: 64, onsetMs: 400 });
  assert.equal(recovered.kind, 'hit');
  assert.equal(recovered.skipped, 1);
  assert.equal(f.skipped, 1);
  assert.equal(f.done, true);
  assert.equal(f.ingest({ midiF: 64, onsetMs: 800 }).kind, 'done');
  assert.equal(f.attempts, 3);
  assert.equal(f.results.get(1).kind, 'skipped');
  assert.equal(f.results.get(2).timing, null);
});

test('tempo mode reports early, late, duration, and late missed events', () => {
  const f = new ScoreFollower(score, { mode: 'tempo', bpm: 120, latencyMs: 100 });
  assert.equal(f.ingest({ midiF: 60, onsetMs: 50 }).kind, 'waiting');
  f.start(1000, 0);
  assert.equal(f.ingest({ midiF: 60, onsetMs: 1000 }).timing, 'early');
  assert.equal(f.release(1100).duration, 'short');
  assert.equal(f.ingest({ midiF: 62, onsetMs: 1800 }).timing, 'late');
  assert.equal(f.tick(3400).kind, 'skipped');
  assert.equal(f.done, true);
});

test('chord needs full pitch classes and cannot verify octave-only voices', () => {
  const f = new ScoreFollower({ events: [{ startBeat: 0, durBeats: 1, midis: [48, 52, 55] }] });
  assert.equal(f.ingest({ midiF: 48, onsetMs: 0 }).kind, 'wrong');
  assert.equal(f.ingest({ chordComplete: true, midis: [48, 52], onsetMs: 50 }).kind, 'wrong');
  assert.equal(f.ingest({ chordComplete: true, midis: [48, 52, 55], onsetMs: 100 }).kind, 'hit');
  const octave = new ScoreFollower({ events: [{ startBeat: 0, durBeats: 1, midis: [40, 52] }] });
  assert.equal(octave.ingest({ chordComplete: true, midis: [40, 52], ambiguous: true, onsetMs: 0 }).kind, 'wrong');
});
