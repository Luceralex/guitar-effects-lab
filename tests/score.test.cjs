const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { DOMParser } = require('linkedom');

const context = { DOMParser };
context.window = context;
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'score.js'), 'utf8'), context);
const Score = context.ScoreNS;
const tuning = [64, 59, 55, 50, 45, 40];
const pitch = (step, octave, duration = 1, extras = '') =>
  `<note>${extras}<pitch><step>${step}</step><octave>${octave}</octave></pitch><duration>${duration}</duration></note>`;

test('MusicXML preserves pickup and polyphonic measure starts and sounding octave', () => {
  const xml = `<score-partwise><work><work-title>Test</work-title></work><part id="P1">
    <measure number="1"><attributes><divisions>1</divisions><transpose><chromatic>0</chromatic><octave-change>-1</octave-change></transpose></attributes>
      <direction><sound tempo="120"/></direction>${pitch('E', 4)}</measure>
    <measure number="2">${pitch('G', 4, 4)}<backup><duration>4</duration></backup>${pitch('C', 4, 1)}
      <forward><duration>1</duration></forward></measure>
    <measure number="3">${pitch('A', 4, 1)}</measure></part></score-partwise>`;
  const result = Score.parseMusicXml(xml, tuning, 15);
  assert.ok(!result.error, result.error);
  assert.deepEqual(Array.from(result.measureStarts), [0, 1, 5]);
  assert.equal(result.bpm, 120);
  assert.equal(result.events[0].midis[0], 52); // E4 written -> E3 sounding
  assert.equal(result.events.at(-1).startBeat, 5);
  assert.ok(result.events.every((e) => e.notes.every((n) => Number.isFinite(n.midi))));
});

test('unplayable imported notes are removed before playback', () => {
  const xml = `<score-partwise><part id="P1"><measure number="1">${pitch('C', 2)}${pitch('E', 4)}</measure></part></score-partwise>`;
  const result = Score.parseMusicXml(xml, tuning, 15);
  assert.ok(!result.error, result.error);
  assert.equal(result.events.length, 1);
  assert.equal(result.stats.skipped, 1);
  assert.equal(result.events[0].notes[0].midi, 64);
});

test('ASCII examples have four-beat measure boundaries and playable notes', () => {
  for (const sample of [Score.SAMPLE_TWINKLE, Score.SAMPLE_MARU_STRUM, Score.SAMPLE_MARU_FINGER]) {
    const result = Score.parseTabText(sample, tuning, 15);
    assert.ok(!result.error, result.error);
    assert.equal(result.measureStarts.length, result.measures);
    assert.ok(result.events.every((e) => e.notes.every((n) => Number.isFinite(n.midi))));
    assert.ok(result.events.every((e) => e.startBeat >= result.measureStarts[e.measure]));
  }
});

test('timewise MusicXML gets an explicit error', () => {
  assert.match(Score.parseMusicXml('<score-timewise/>', tuning, 15).error, /score-timewise/);
});
