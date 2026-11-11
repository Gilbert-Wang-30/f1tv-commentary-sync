// node extension/sound.test.js
// Sync by sound's match (sound.js) on made-up race audio: F1 TV's sound (engines sweeping, crowd,
// a commentator), and a streamer's stream with that sound passed through quietly under their
// own, louder voice. Where it is, to the sample; how sure; and no confidence where it isn't.
require('./sound.js');
const assert = require('node:assert/strict');
const S = globalThis.FoneSound;
let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok -', name); };

const SR = 8000;
function rng(seed) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) - 0.5; }
// a one-pole low-pass, for colour
function lp(x, a) { const y = new Float32Array(x.length); let s = 0; for (let i = 0; i < x.length; i++) y[i] = s += a * (x[i] - s); return y; }
// race audio: engines (a harmonic stack whose pitch sweeps as cars pass), the crowd (coloured noise)
function race(sec, seed) {
  const r = rng(seed), out = new Float32Array(sec * SR), crowd = lp(Float32Array.from(out, () => r()), 0.2);
  let ph = 0, f = 220, tf = 300;
  for (let i = 0; i < out.length; i++) {
    if (i % (SR / 2) === 0) tf = 120 + 380 * (r() + 0.5);
    f += (tf - f) * 0.0004;
    ph += (2 * Math.PI * f) / SR;
    let e = 0;
    for (let h = 1; h <= 6; h++) e += Math.sin(h * ph) / h;
    out[i] = 0.35 * e * (0.6 + 0.4 * Math.sin(i / SR)) + 0.5 * crowd[i];
  }
  return out;
}
// a voice: band-limited noise in syllables (4-6 Hz), with pauses
function voice(sec, seed) {
  const r = rng(seed), raw = Float32Array.from({ length: sec * SR }, () => r());
  const band = lp(raw, 0.6), low = lp(raw, 0.08), out = new Float32Array(raw.length);
  let env = 0, on = 1;
  for (let i = 0; i < out.length; i++) {
    if (i % (SR / 5) === 0) on = r() > -0.3 ? 1 : 0;
    env += ((on ? Math.abs(Math.sin((i / SR) * Math.PI * 5)) : 0) - env) * 0.01;
    out[i] = (band[i] - low[i]) * env * 2;
  }
  return out;
}
const mix = (...xs) => { const out = new Float32Array(xs[0][1].length); for (const [g, x] of xs) for (let i = 0; i < out.length; i++) out[i] += g * (x[i] || 0); return out; };
const shift = (x, d) => { const out = new Float32Array(x.length); for (let i = 0; i < x.length; i++) out[i] = x[i - d] || 0; return out; };
const db = (v) => 10 ** (v / 20);

// 90 s of race; F1 TV's sound is a 10 s stretch of it, the stream's is 30 s around it
const F1 = race(90, 7), VOICE = voice(90, 11), OTHER = voice(90, 23);
const at = 40 * SR, len = 10 * SR;
const f1 = F1.subarray(at, at + len);

test('the stream passes F1 TV sound through 15 dB under the streamer: found to the sample, sure', () => {
  const D = 2.345; // the copy sits D s later in the stream than where we look from
  const stream = mix([db(-15), shift(F1, Math.round(D * SR))], [1, VOICE]);
  const from = at - 10 * SR;
  const r = S.locate(f1, stream.subarray(from, from + 30 * SR), SR);
  const got = (from + r.lag - at) / SR;
  assert.ok(Math.abs(got - D) < 0.002, `lag ${got} vs ${D}`);
  assert.ok(r.score > 12 && r.score > 2 * r.next, `score ${r.score.toFixed(1)}, next ${r.next.toFixed(1)}`);
});

test('F1 TV on another commentary than the one passed through: the race under both still lines them up', () => {
  const f1Own = mix([1, F1], [0.8, OTHER]).subarray(at, at + len); // F1 TV's own commentator over the race
  const D = -1.2;
  const stream = mix([db(-12), mix([1, shift(F1, Math.round(D * SR))], [0.8, shift(voice(90, 31), Math.round(D * SR))])], [1, VOICE]);
  const from = at - 10 * SR;
  const r = S.locate(f1Own, stream.subarray(from, from + 30 * SR), SR);
  const got = (from + r.lag - at) / SR;
  assert.ok(Math.abs(got - D) < 0.003, `lag ${got} vs ${D}`);
  assert.ok(r.score > 8, `score ${r.score.toFixed(1)}`);
});

test('nothing passed through: no confident peak', () => {
  const stream = mix([1, VOICE], [0.5, race(90, 99)]); // the streamer, and some other race audio
  const from = at - 10 * SR;
  const r = S.locate(f1, stream.subarray(from, from + 30 * SR), SR);
  assert.ok(r.score < 6.5, `score ${r.score.toFixed(1)}`);
});

test('at 4 kHz (the wide search) it still finds it', () => {
  const D = 7.5;
  const stream = mix([db(-15), shift(F1, Math.round(D * SR))], [1, VOICE]);
  const from = at - 25 * SR;
  const x = S.decimate(f1, 2), y = S.decimate(stream.subarray(from, from + 60 * SR), 2);
  const r = S.locate(x, y, SR / 2);
  const got = (from / SR + r.lag / (SR / 2)) - at / SR;
  assert.ok(Math.abs(got - D) < 0.004, `lag ${got} vs ${D}`);
  assert.ok(r.score > 10, `score ${r.score.toFixed(1)}`);
});

test('FFT round trip', () => {
  const re = Float64Array.from({ length: 64 }, (_, i) => Math.sin(i) + i / 10), im = new Float64Array(64), orig = Float64Array.from(re);
  S.fft(re, im);
  S.fft(re, im, true);
  for (let i = 0; i < 64; i++) assert.ok(Math.abs(re[i] - orig[i]) < 1e-9 && Math.abs(im[i]) < 1e-9);
});

console.log(`${n} passed`);
