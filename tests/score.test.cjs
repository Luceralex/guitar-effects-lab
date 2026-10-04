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

test('MusicXML keeps key, meter, written spelling, note type, dots, and measure accidentals', () => {
  const xml = `<score-partwise><part id="P1">
    <measure number="1"><attributes><divisions>2</divisions><key><fifths>-2</fifths></key>
      <time><beats>3</beats><beat-type>4</beat-type></time>
      <transpose><chromatic>0</chromatic><octave-change>-1</octave-change></transpose></attributes>
      <note><pitch><step>B</step><alter>-1</alter><octave>4</octave></pitch><duration>3</duration><type>quarter</type><dot/></note>
      <note><pitch><step>B</step><alter>0</alter><octave>4</octave></pitch><duration>1</duration><type>eighth</type></note>
      <note><pitch><step>B</step><alter>0</alter><octave>4</octave></pitch><duration>2</duration><type>quarter</type></note></measure>
    <measure number="2"><note><pitch><step>B</step><alter>-1</alter><octave>4</octave></pitch><duration>6</duration><type>half</type><dot/></note></measure>
  </part></score-partwise>`;
  const result = Score.parseMusicXml(xml, tuning, 15);
  assert.ok(!result.error, result.error);
  assert.deepEqual(Array.from(result.measureStarts), [0, 3]);
  assert.deepEqual(JSON.parse(JSON.stringify(result.measureInfo[0])), { fifths: -2, beats: 3, beatType: 4 });
  assert.deepEqual(Array.from(result.events, (e) => e.durBeats), [1.5, 0.5, 1, 3]);
  assert.equal(result.events[0].notes[0].midi, 58);
  assert.equal(result.events[0].notes[0].step, 'B');
  assert.equal(result.events[0].notes[0].alter, -1);
  assert.equal(result.events[0].notes[0].type, 'quarter');
  assert.equal(result.events[0].notes[0].dots, 1);
  assert.equal(result.events[0].notes[0].displayAccidental, undefined, 'B-flat is supplied by the key signature');
  assert.equal(result.events[1].notes[0].displayAccidental, 'natural');
  assert.equal(result.events[2].notes[0].displayAccidental, undefined, 'natural carries within the measure');
  assert.equal(result.events[3].notes[0].displayAccidental, undefined, 'new measure restores B-flat key signature');
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
