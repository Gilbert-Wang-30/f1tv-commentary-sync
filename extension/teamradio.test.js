// Team-radio sting detection on synthetic F1 TV sound (node teamradio.test.js).
'use strict';
require('./teamradio.js');
const assert = require('node:assert/strict');
const R = globalThis.FoneRadio;
let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok -', name); };

const SR = 8000;
const lcg = (seed) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
// engine-ish noise: a low rumble with a few wandering harmonics, plus broadband hiss
function noise(sec, seed, level = 0.05) {
  const r = lcg(seed), x = new Float32Array(Math.round(sec * SR));
  let b = 0;
  for (let i = 0; i < x.length; i++) {
    b = 0.98 * b + 0.02 * r();
    const f0 = 180 + 40 * Math.sin(i / SR * 0.7);
    x[i] = level * (6 * b + 0.3 * Math.sin(2 * Math.PI * f0 * i / SR) + 0.15 * Math.sin(2 * Math.PI * 2 * f0 * i / SR) + 0.2 * r());
  }
  return x;
}
// a voice: a fundamental near 196 Hz with harmonics (on all three tones: G5:B5:D6 = 4:5:6)
function voice(x, at, sec, level = 0.1) {
  for (let i = Math.round(at * SR); i < Math.min(x.length, Math.round((at + sec) * SR)); i++) {
    const t = i / SR, f0 = 196 * (1 + 0.03 * Math.sin(t * 3));
    let v = 0;
    for (let h = 1; h <= 12; h++) v += Math.sin(2 * Math.PI * h * f0 * t) / h;
    x[i] += level * v * (0.6 + 0.4 * Math.sin(t * 9));
  }
}
function sting(x, at, level = 0.05) {
  R.TONES.forEach((f, k) => {
    const s = Math.round((at + R.ON[k]) * SR), len = Math.round(0.05 * SR), ramp = Math.round(0.01 * SR);
    for (let i = 0; i < len && s + i < x.length; i++) {
      const env = Math.min(1, i / ramp, (len - i) / ramp);
      x[s + i] += level * env * Math.sin(2 * Math.PI * f * i / SR);
    }
  });
}

test('a sting in engine noise is found, within 10 ms of its first note', () => {
  const x = noise(20, 7);
  sting(x, 8.4);
  const s = R.stings(x);
  assert.equal(s.length, 1, JSON.stringify(s));
  assert.ok(Math.abs(s[0].t - 8.4) < 0.01, JSON.stringify(s));
});

test('stings under a voice, and several in a row, are each found once', () => {
  const x = noise(40, 11);
  voice(x, 5, 10, 0.06);
  for (const at of [6.2, 18.0, 31.5]) sting(x, at, 0.05);
  const s = R.stings(x).map((v) => Math.round(v.t * 100) / 100);
  assert.deepEqual(s.length, 3, JSON.stringify(s));
});

test('no false stings in 5 minutes of engine noise and voices', () => {
  const x = noise(300, 3);
  for (let at = 2; at < 290; at += 23) voice(x, at, 9, 0.08);
  assert.deepEqual(R.stings(x), []);
});

test('the same tones in another order, or one long tone, are not a sting', () => {
  const x = noise(20, 5);
  // B5 D6 G5 (reversed)
  [987.6, 1174.7, 783.8].forEach((f, k) => { const s = Math.round((4 + R.ON[k]) * SR); for (let i = 0; i < 400; i++) x[s + i] += 0.05 * Math.sin(2 * Math.PI * f * i / SR); });
  // a held G5 for a second
  for (let i = 0; i < SR; i++) x[12 * SR + i] += 0.05 * Math.sin(2 * Math.PI * 783.8 * i / SR);
  assert.deepEqual(R.stings(x), []);
});

test('a message file name is its recording time, in UTC by the session offset', () => {
  // NOR_1_20261108_132915.mp3 at São Paulo (-03:00): 16:29:15 UTC
  assert.equal(R.fileTime('https://x/TeamRadio/NOR_1_20261108_132915.mp3', '-03:00:00'), Date.UTC(2026, 10, 8, 16, 29, 15) / 1000);
  assert.equal(R.fileTime('HAM_44_20261101_142204.mp3', '-06:00:00'), Date.UTC(2026, 10, 1, 20, 22, 4) / 1000);
  assert.equal(R.fileTime('nothing.mp3', '0'), null);
});

test('speech onset: after the quiet opening; none in an opening alone', () => {
  const y = new Float32Array(SR * 6);
  const r = lcg(9);
  for (let i = 0; i < y.length; i++) y[i] = 0.008 * r(); // (-42 dBFS: the opening's level)
  for (let i = Math.round(2.5 * SR); i < y.length; i++) y[i] += 0.2 * Math.sin(2 * Math.PI * 220 * i / SR);
  const t = R.speechOnset(y, SR);
  assert.ok(t != null && Math.abs(t - 2.5) < 0.06, String(t));
  assert.equal(R.speechOnset(y.subarray(0, 2 * SR), SR), null);
});

console.log(`${n} passed`);
