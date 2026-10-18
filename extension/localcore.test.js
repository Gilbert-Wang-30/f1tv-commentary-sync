// node extension/localcore.test.js
require('./demux.js');
require('./localcore.js');
const assert = require('node:assert/strict');
const D = globalThis.FoneDemux;
const L = globalThis.FoneLocal;
let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok -', name); };

const RATE = 48000, FD = 1024 / RATE; // one frame: 21.33 ms
const FMT = { profile: 1, sri: 3, ch: 2 };
// a frame whose payload says which one it is (k), so tests can tell what was kept
const frame = (t, k) => {
  const raw = Uint8Array.of(0xaa, (k >> 16) & 0xff, (k >> 8) & 0xff, k & 0xff);
  return { t, data: D.concat(D.adtsHeader(FMT, raw.length), raw), rate: RATE, ch: 2, samples: 1024 };
};
const isSilent = (f) => f.length === 16; // ADTS header + the 9-byte stereo silent frame
// frames k0..k0+count-1 of a stream whose frame k has source timestamp t0 + k·FD
const run = (k0, count, t0 = 100) => Array.from({ length: count }, (_, i) => frame(t0 == null ? null : t0 + (k0 + i) * FD, k0 + i));
// all frames in the buffer, in order: their k (or 's' for silence)
function contents(B) {
  const out = [];
  for (const c of B.chunks) {
    for (const { at, len } of D.adtsFrames(c.data).frames) {
      const f = c.data.subarray(at, at + len);
      out.push(isSilent(f) ? 's' : (f[8] << 16) | (f[9] << 8) | f[10]);
    }
  }
  return out;
}
// feed a stream in real time: `count` frames from k0, in batches of `per`, arriving `lag` s after
// they were made (frame k made at made0 + k·FD)
function feed(B, { k0 = 0, count, per = 5, conn = 1, made0 = 1000, lag = 2, t0 = 100, tl = 'own' }) {
  for (let i = 0; i < count; i += per) {
    const fs = run(k0 + i, Math.min(per, count - i), t0);
    L.push(B, fs, { conn, at: made0 + (k0 + i + fs.length) * FD + lag, tl });
  }
}

test('a stream in one go: contiguous chunks of ~0.5 s, from m = 0', () => {
  const B = L.newBuffer(600);
  feed(B, { count: 470 }); // ~10 s
  assert.equal(B.chunks[0].m, 0);
  for (let i = 1; i < B.chunks.length; i++) assert.ok(Math.abs(B.chunks[i].m - (B.chunks[i - 1].m + B.chunks[i - 1].d)) < 1e-9);
  assert.ok(B.chunks.every((c, i) => i === B.chunks.length - 1 || Math.abs(c.d - 24 * FD) < 1e-9)); // 24 frames ≥ 0.5 s
  assert.deepEqual(contents(B), Array.from({ length: 456 }, (_, k) => k)); // 19 whole chunks; the rest still filling
  assert.ok(Math.abs(L.playableEnd(B) - 456 * FD) < 1e-9);
});

test('the live edge: the m arriving now, judged by the freshest arrivals', () => {
  const B = L.newBuffer(600);
  feed(B, { count: 470, lag: 2 });
  // frame k made at 1000 + k·FD arrives 2 s later: at time T the edge is the m made at T - 2
  const T = 1000 + 470 * FD + 2 + 0.3;
  assert.ok(Math.abs(L.liveEdge(B, T) - (470 * FD + 0.3)) < 1e-6);
  // a late batch (network hiccup) doesn't move it
  L.push(B, run(470, 5), { conn: 1, at: 1000 + 475 * FD + 4 });
  assert.ok(Math.abs(L.liveEdge(B, T + 1) - (470 * FD + 1.3)) < 1e-6);
});

test('a burst at connect (the CDN\'s cached seconds) doesn\'t make the edge look fresher', () => {
  const B = L.newBuffer(600);
  // 3 s of audio at once, then real time 2 s behind
  L.push(B, run(0, 141), { conn: 1, at: 1000 + 141 * FD + 2 + 0.1 });
  feed(B, { k0: 141, count: 141, lag: 2 });
  const T = 1000 + 282 * FD + 2;
  assert.ok(Math.abs(L.liveEdge(B, T) - 282 * FD) < 1e-6);
});

test('reconnect, timestamps continuing: the repeated burst is dropped, the missing part is silence', () => {
  const B = L.newBuffer(600);
  feed(B, { count: 200 });
  // reconnect: the new connection's burst starts 1 s (47 frames) back, after 1 s away with
  // 2 s (94 frames) missed before it, i.e. it resumes at frame 200 - 47 = 153... no: it resumes
  // at frame 153 and we already have up to 199: 47 repeats
  L.push(B, run(153, 100), { conn: 2, at: 1000 + 253 * FD + 2, tl: 'own' });
  feed(B, { k0: 253, count: 50, conn: 2 });
  const got = contents(B);
  assert.deepEqual(got.slice(0, 288), Array.from({ length: 288 }, (_, k) => k));
  assert.equal(B.dropped, 47);
  assert.equal(B.filled, 0);
  // and a hole: the next connection resumes 2 s after where it left
  const B2 = L.newBuffer(600);
  feed(B2, { count: 200 });
  L.push(B2, run(294, 100), { conn: 2, at: 1000 + 394 * FD + 2, tl: 'own' });
  const g2 = contents(B2);
  assert.deepEqual(g2.slice(0, 200), Array.from({ length: 200 }, (_, k) => k));
  assert.deepEqual(g2.slice(200, 294), Array(94).fill('s'));
  assert.equal(g2[294], 294);
  assert.ok(Math.abs(B2.filled - 94 * FD) < 1e-9);
});

test('a reconnect whose timestamps restarted is placed by arrival, as fresh as the old one was', () => {
  const B = L.newBuffer(600);
  feed(B, { count: 300, lag: 2 }); // frames 0..299, edge offset: arrives 2 s after made
  // the stream comes back with timestamps from 0: frame k of it (true frame 400 + k) made at
  // 1000 + (400 + k)·FD; 1 s burst first
  const made0 = 1000 + 400 * FD;
  L.push(B, run(400, 47, 0 - 400 * FD), { conn: 2, at: made0 + 47 * FD + 2 + 0.05, tl: null });
  for (let i = 47; i < 47 * 4; i += 5) L.push(B, run(400 + i, 5, 0 - 400 * FD), { conn: 2, at: made0 + (i + 5) * FD + 2, tl: null });
  assert.equal(B.pend, null, 'settled');
  const got = contents(B);
  const at400 = got.indexOf(400);
  assert.ok(Math.abs(at400 - 400) <= 1, `frame 400 at m ${at400}·FD (true place 400)`);
  assert.ok(got.slice(300, at400).every((x) => x === 's'), 'the gap is silence');
});

test('a reconnect overlapping what we have, placed by arrival: the overlap goes', () => {
  const B = L.newBuffer(600);
  feed(B, { count: 300, lag: 2, t0: null }); // a bare ADTS stream (no timestamps)
  // back with frame 250 (50 repeats), real time
  for (let i = 0; i < 200; i += 5) L.push(B, run(250 + i, 5, null), { conn: 2, at: 1000 + (255 + i) * FD + 2 });
  const got = contents(B);
  const k = got.indexOf(300);
  assert.ok(Math.abs(k - 300) <= 1, `frame 300 at ${k}`);
});

test('a reconnect that carries on where it left off (HLS resumed by sequence number) lands to the sample', () => {
  // 10 s away, then the recorder resumes with the next segment (235 frames each, 5 s): what was
  // missed comes in late but goes exactly where its timestamps say, no repeat, no silence
  const B = L.newBuffer(900);
  feed(B, { count: 47 * 120, per: 235 });
  for (let k = 47 * 120; k < 47 * 130; k += 235) L.push(B, run(k, 235), { conn: 2, at: 1000 + 47 * 130 * FD + 2, tl: 'own' });
  const got = contents(B);
  assert.deepEqual(got, Array.from({ length: got.length }, (_, k) => k), 'every frame at its own place, none twice');
  assert.equal(B.filled, 0);
  assert.equal(B.dropped, 0);
});

test('the streamer starting a new stream (same room, timestamps from 0 again) goes by arrival', () => {
  // Douyin/Huya FLV runs on the stream's own timeline: a new stream 75 s later starts it again;
  // its timestamps sit minutes behind the old ones, so they say nothing: placed by arrival
  const B = L.newBuffer(900);
  feed(B, { count: 47 * 300, t0: 12, tl: 'room|flv' }); // 5 min of a stream whose first frame was t = 12
  const k0 = 47 * 375; // the new stream, 75 s later, first frame t = 22
  for (let i = 0; i < 47 * 6; i += 5) L.push(B, run(k0 + i, 5, 22 - k0 * FD), { conn: 2, at: 1000 + (k0 + i + 5) * FD + 2, tl: 'room|flv' });
  L.liveEdge(B, 1000 + (k0 + 47 * 6) * FD + 2 + 2);
  const got = contents(B);
  assert.equal(B.dropped, 0, 'nothing of the new stream dropped as a repeat');
  assert.ok(Math.abs(got.indexOf(k0 + 47) - (k0 + 47)) <= 1, `the new stream at its time (${got.indexOf(k0 + 47)} vs ${k0 + 47})`);
});

test('FLV that starts each connection at 0: after a short connection, the next goes by arrival', () => {
  // (Bilibili's FLV): a long connection, one of 8 s, then another 3 s later; their timestamps
  // say nothing about each other (tl null), so nothing new is dropped as a 'repeat'
  const B = L.newBuffer(900);
  feed(B, { count: 47 * 60, tl: null, t0: 0 });
  const c2 = 47 * 62;
  for (let i = 0; i < 47 * 8; i += 5) L.push(B, run(c2 + i, 5, -c2 * FD), { conn: 2, at: 1000 + (c2 + i + 5) * FD + 2, tl: null });
  const c3 = c2 + 47 * 11;
  for (let i = 0; i < 47 * 6; i += 5) L.push(B, run(c3 + i, 5, -c3 * FD), { conn: 3, at: 1000 + (c3 + i + 5) * FD + 2, tl: null });
  L.liveEdge(B, 1000 + (c3 + 47 * 6) * FD + 2 + 2);
  const got = contents(B);
  for (const k of [c2, c2 + 100, c3, c3 + 100]) assert.ok(Math.abs(got.indexOf(k) - k) <= 1, `frame ${k} at ${got.indexOf(k)}`);
  assert.equal(B.dropped, 0);
});

test('a new rendition (another timeline) goes by arrival even when its timestamps look close', () => {
  const B = L.newBuffer(900);
  feed(B, { count: 300, tl: 'hls|0' });
  // another rendition whose timestamps happen to sit 3 s behind: placed by arrival, not as repeats
  for (let i = 0; i < 47 * 4; i += 5) L.push(B, run(330 + i, 5, 100 - 3), { conn: 2, at: 1000 + (330 + i + 5) * FD + 2, tl: 'hls|1' });
  const got = contents(B);
  assert.ok(Math.abs(got.indexOf(330) - 330) <= 1, `frame 330 at ${got.indexOf(330)}`);
  assert.equal(B.dropped, 0);
});

test('the bytes kept are counted again after the buffer starts over', () => {
  const B = L.newBuffer(10);
  feed(B, { count: 300 });
  L.push(B, run(300 + 47 * 60, 100), { conn: 2, at: 1000 + (400 + 47 * 60) * FD + 2, tl: 'own' });
  assert.equal(B.bytes, B.chunks.reduce((a, c) => a + c.data.length, 0));
});

test('only the last `keep` seconds are kept; chunkAt finds a moment', () => {
  const B = L.newBuffer(10);
  feed(B, { count: 47 * 30 }); // 30 s
  const end = L.playableEnd(B);
  assert.ok(B.chunks[0].m >= end - 10.6 && B.chunks[0].m <= end - 9.4, `kept from ${B.chunks[0].m} to ${end}`);
  const k = L.chunkAt(B, end - 3);
  assert.ok(B.chunks[k].m <= end - 3 && end - 3 < B.chunks[k].m + B.chunks[k].d);
  assert.equal(L.chunkAt(B, 1), -1);
  assert.equal(L.chunkAt(B, end + 1), B.chunks.length);
});

test('a gap longer than the buffer starts it over there', () => {
  const B = L.newBuffer(10);
  feed(B, { count: 300 });
  L.push(B, run(300 + 47 * 60, 100), { conn: 2, at: 1000 + (400 + 47 * 60) * FD + 2, tl: 'own' });
  assert.ok(B.chunks[0].m > 60, 'nothing old kept');
  assert.equal(B.filled, 0);
  assert.equal(contents(B)[0], 300 + 47 * 60);
});

test('a new audio format starts the player over (gen)', () => {
  const B = L.newBuffer(600);
  feed(B, { count: 100 });
  const f = { ...frame(100 + 100 * FD, 100) };
  const raw = Uint8Array.of(1, 2, 3, 4);
  f.data = D.concat(D.adtsHeader({ profile: 1, sri: 4, ch: 2 }, raw.length), raw);
  f.rate = 44100;
  const gen = B.gen;
  L.push(B, [f], { conn: 1, at: 1000 + 101 * FD + 2 });
  assert.equal(B.gen, gen + 1);
  assert.equal(B.chunks.length, 0);
  assert.equal(B.fmt.rate, 44100);
});

test('the engine\'s timeline: one piece over what is kept, live', () => {
  const B = L.newBuffer(600);
  assert.deepEqual(L.timeline(B, 1000).pieces, []);
  feed(B, { count: 470, lag: 2 });
  const tl = L.timeline(B, 1012);
  assert.equal(tl.live, true);
  assert.equal(tl.pieces.length, 1);
  assert.equal(tl.pieces[0].m, 0);
  assert.ok(Math.abs(tl.pieces[0].d - L.playableEnd(B)) < 1e-9);
  assert.ok(Math.abs(tl.pieces[0].w - (1000 + 2)) < 1e-6, 'w: when it arrived');
});

console.log(`${n} tests passed`);
