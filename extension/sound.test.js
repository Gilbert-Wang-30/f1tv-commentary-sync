// node extension/sound.test.js
// Sync by sound's match (sound.js) on made-up race audio: F1 TV's sound (engines sweeping, crowd,
// a commentator), and a streamer's stream with that sound passed through quietly under their
// own, louder voice. Where it is, to the sample; how sure; and no confidence where it isn't.
require('./sound.js');
const assert = require('node:assert/strict');
const S = globalThis.FoneSound;
let n = 0, chain = Promise.resolve();
const test = (name, fn) => { chain = chain.then(fn).then(() => { n++; console.log('ok -', name); }); };

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

// a ±240 s look (an F1 Academy/F2/F3 video's start only guessed): a stretch at a time, the page let run between
test('a long look a stretch at a time: the same place as one FFT over all of it, the rest of the page run between', async () => {
  const sr = SR / 2, D = 211.3; // (where F1 TV's sound is in the stream, s)
  const LONG = race(300, 41), x = S.decimate(LONG.subarray(100 * SR, 115 * SR), 2);
  const stream = S.decimate(mix([db(-15), shift(LONG, Math.round((D - 100) * SR))], [1, voice(300, 43)]), 2);
  const y = stream.subarray(0, 270 * sr), lags = y.length - x.length, k = Math.ceil(lags / (50 * sr)); // (255 s of lags: 6 stretches)
  let pauses = 0;
  const all = S.locate(x, y, sr), long = await S.locateLong(x, y, sr, { span: 50, pause: async () => { pauses++; } });
  assert.ok(Math.abs(all.lag / sr - D) < 0.002 && Math.abs(long.lag - all.lag) < 0.01, `${all.lag / sr} ${long.lag / sr}`);
  assert.ok(long.score > 8 && long.score > 1.6 * long.next && !long.edge, JSON.stringify(long));
  assert.equal(pauses, k);
  // at the end of one stretch (the start of the next's own lags, 2 s on): found whole there, not an edge
  const at = Math.ceil(lags / k) + 2 * sr, yj = Float32Array.from(y);
  for (let i = 0; i < x.length; i++) yj[at + i] += 3 * x[i];
  const j = await S.locateLong(x, yj, sr, { span: 50 });
  assert.ok(Math.abs(j.lag - at) < 1 && !j.edge, JSON.stringify(j));
  // the runner-up from another stretch: a fainter copy (a lap shown again) far away
  const y2 = Float32Array.from(y);
  for (let i = 0; i < x.length; i++) y2[Math.round(30 * sr) + i] += 0.1 * x[i];
  const two = await S.locateLong(x, y2, sr, { span: 50 });
  assert.ok(Math.abs(two.lag / sr - D) < 0.002 && two.next > long.next + 1, `${JSON.stringify(two)} vs ${long.next}`);
  // short: locate itself
  const ys = y.subarray(Math.round(190 * sr), Math.round(250 * sr));
  assert.deepEqual(await S.locateLong(x, ys, sr, { span: 50 }), S.locate(x, ys, sr));
});

// ---- sync by sound's rules, with the engine's numbers (offscreen.js SND) ----------------------
const P = { SCORE: 8, NEXT: 1.6, AGREE: 0.08, JUMP: 1.5, JUMP_LATER: 3, NEAR: 4, WIDE: 25, FAR: 240, REWIDE: 300, MISSES: 2 };

test('how far a look reaches: widely till locked, now and then, after misses; ±240 s for a start only guessed', () => {
  const R = (o) => { const r = S.lookRange({ locked: true, sinceWide: 15, misses: 0, guess: false, ...o }, P); return `${r.wide} ${r.R}`; };
  assert.equal(R({ locked: false }), 'true 25');
  assert.equal(R({}), 'false 4');
  assert.equal(R({ sinceWide: 301 }), 'true 25');
  assert.equal(R({ misses: 2 }), 'true 25');
  assert.equal(R({ locked: false, guess: true }), 'true 240');
  // F1 TV's F1 Academy, F2, F3 videos: the pre-roll's clock borrowed, no session key
  const g = { live: false, vod: false, clock: 'preroll', sessionKey: null, locked: false };
  assert.equal(S.guessed(g), true);
  for (const o of [{ live: true }, { vod: true }, { clock: 'multiviewer' }, { sessionKey: 9947 }, { locked: true }]) assert.equal(S.guessed({ ...g, ...o }), false, JSON.stringify(o));
});

test("a look's verdict: sure, and a second that agrees locks it, at their median", () => {
  const st = { target: null, bias: 0, est: [], quick: null };
  const look = (val, score, next, edge = false) => ({ val, score, next, edge });
  let J = S.judge(st, look(50.02, 7.9, 3), 100, P);
  assert.ok(!J.sure && J.why === 'not sure' && J.o === null);
  assert.equal(S.judge(st, look(50.02, 12, 7.6), 100, P).sure, false); // (under 1.6× the runner-up)
  assert.equal(S.judge(st, look(50.02, 12, 7.5, true), 100, P).sure, false); // (at the edge of where it looked)
  assert.equal(S.judge(st, look(null, 20, 4), 100, P).sure, false); // (not recorded there)
  J = S.judge(st, look(50.02, 12, 7.5), 100, P);
  assert.ok(J.sure && J.o === null && J.why === 'waiting for a second match' && J.est.length === 1);
  st.est = J.est;
  J = S.judge(st, look(50.2, 13, 5), 115, P); // (0.18 s from it: not the same place)
  assert.equal(J.o, null);
  st.est = J.est;
  J = S.judge(st, look(50.06, 14, 5), 130, P); // (agrees with 50.02, not 50.2)
  assert.ok(J.o === 50.06 && J.why === 'matched' && J.est.length === 3);
  // the last few minutes, four at most
  st.est = [{ at: 0, val: 50 }, { at: 100, val: 50 }, { at: 110, val: 50 }, { at: 120, val: 50 }, { at: 130, val: 50 }];
  assert.deepEqual(S.judge(st, look(50, 12, 5), 181, P).est.map((e) => e.at), [110, 120, 130, 181]);
  // a resync asked for: the first sure one will do
  assert.ok(S.judge({ target: 50, bias: 0, est: [], quick: 1 }, look(51.3, 9, 5), 200, P).o === 51.3);
  // how far off it's jumped rather than eased
  assert.equal(S.jumpOver({ quick: true, fresh: false }, P), 0.05);
  assert.equal(S.jumpOver({ quick: false, fresh: true }, P), 1.5);
  assert.equal(S.jumpOver({ quick: false, fresh: false }, P), 3);
});

test("the streamer's latency stepped 4.4 s (2026-11-01, over one race): found far, again soon, jumped there", () => {
  // locked at 50.00 with a nudge of +0.3 on top (target 50.3); then the stream's sound is 4.4 s later
  const st = { target: 50.3, bias: 0.3, est: [{ at: 0, val: 50 }, { at: 15, val: 50.01 }], quick: null };
  let J = S.judge(st, look2(50.03), 30, P);
  assert.ok(!J.far && J.o === 50.01, JSON.stringify(J)); // (where it is: no news)
  st.est = J.est;
  J = S.judge(st, look2(54.4), 45, P);
  assert.ok(J.far && J.o === null, JSON.stringify(J)); // (far: looked at again soon, widely)
  st.est = J.est;
  J = S.judge(st, look2(54.41), 50, P);
  assert.ok(J.o === 54.41 && J.why === 'matched');
  const err = J.o + st.bias - 50.3; // (from where it plays: the target)
  assert.ok(Math.abs(err) > S.jumpOver({ quick: false, fresh: false }, P), 'too big to ease: jumped');
  function look2(val) { return { val, score: 14, next: 5, edge: false }; }
});

chain.then(() => console.log(`${n} passed`), (e) => { console.error(e); process.exit(1); });
