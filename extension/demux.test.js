// node extension/demux.test.js
// testdata/: 3 s of a 440 Hz tone (AAC 48 kHz stereo) with a tiny video, as ffmpeg muxes it
// to FLV and MPEG-TS (timestamps offset to 100 s), and 2 s as bare ADTS (44.1 kHz mono).
require('./demux.js');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const D = globalThis.FoneDemux;
let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok -', name); };
const data = (f) => new Uint8Array(fs.readFileSync(path.join(__dirname, 'testdata', f)));

// every frame a whole, valid ADTS frame of the expected format, timestamps one frame apart
function checkFrames(frames, rate, ch) {
  for (const f of frames) {
    const h = D.adtsAt(f.data, 0);
    assert.ok(h, 'an ADTS frame');
    assert.equal(h.len, f.data.length);
    assert.equal(h.rate, rate);
    assert.equal(h.ch, ch);
    assert.equal(f.rate, rate);
  }
  for (let i = 1; i < frames.length; i++) {
    if (frames[i].t == null) continue;
    assert.ok(Math.abs(frames[i].t - frames[i - 1].t - 1024 / rate) < 0.0015, `frame ${i} follows on (${frames[i].t - frames[i - 1].t})`);
  }
}

test('FLV: the AAC frames, timed by the tags, however the bytes arrive', () => {
  const b = data('sine.flv');
  const whole = D.flvReader().push(b);
  assert.ok(whole.length >= 138 && whole.length <= 145, `${whole.length} frames in 3 s`);
  checkFrames(whole, 48000, 2);
  assert.ok(Math.abs(whole[0].t - 100) < 0.05, `starts at its timestamp (${whole[0].t})`);
  // the same frames from the stream cut at odd places
  const r = D.flvReader();
  const parts = [];
  for (let i = 0, k = 1; i < b.length; i += k, k = (k * 7 + 3) % 4001 + 1) parts.push(...r.push(b.subarray(i, i + k)));
  assert.equal(parts.length, whole.length);
  parts.forEach((f, i) => { assert.deepEqual(f.data, whole[i].data); assert.equal(f.t, whole[i].t); });
  assert.ok(r.video, 'saw the video');
});

test('FLV: its video tags too, when asked: the decoder configuration first, then frames, keyframes marked', () => {
  const b = data('sine.flv');
  const r = D.flvReader({ video: true });
  for (let i = 0; i < b.length; i += 1000) r.push(b.subarray(i, i + 1000));
  const v = r.vtags;
  assert.ok(v.length > 5, `${v.length} video tags`);
  assert.ok(v[0].seq && v[0].codec === 'avc' && v[0].data[0] === 1, 'an AVCDecoderConfigurationRecord first');
  const frames = v.filter((x) => !x.seq);
  assert.ok(frames[0].key, 'the first frame is a keyframe');
  assert.ok(frames.every((x, i) => i === 0 || x.t >= frames[i - 1].t), 'in decode order');
  assert.ok(Math.abs(frames[0].t - 100) < 0.5, `on the stream's timestamps (${frames[0].t})`);
  assert.equal(D.flvReader().vtags.length, 0); // (not asked: none kept)
});

test('FLV: anything else is refused', () => {
  assert.throws(() => D.flvReader().push(data('sine.ts')), /not an FLV/);
  const b = data('sine.flv').slice();
  // the first audio tag's sound format → MP3 (2)
  for (let i = 13; i + 11 < b.length;) {
    const size = (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3];
    if (b[i] === 8) { b[i + 11] = (2 << 4) | (b[i + 11] & 0x0f); break; }
    i += 15 + size;
  }
  assert.throws(() => D.flvReader().push(b), /isn't AAC/);
});

test('MPEG-TS: the AAC stream, timed by its PES timestamps', () => {
  const { frames, ctx } = D.tsAudio(data('sine.ts'));
  assert.ok(frames.length >= 138 && frames.length <= 145, `${frames.length} frames`);
  checkFrames(frames, 48000, 2);
  assert.ok(frames[0].t > 99 && frames[0].t < 103, `PTS start ${frames[0].t}`);
  assert.ok(ctx.aac != null && ctx.codec == null);
  // a segment without its own PAT/PMT, read with the layout the last one gave
  const b = data('sine.ts');
  const later = b.subarray(188 * 40 - (188 * 40) % 188);
  const again = D.tsAudio(later, ctx);
  assert.ok(again.frames.length > 0 && again.frames.length < frames.length);
  checkFrames(again.frames, 48000, 2);
});

test('bare ADTS: frames split however the bytes arrive, no timestamps', () => {
  const b = data('sine.aac');
  const r = D.adtsReader();
  const frames = [];
  for (let i = 0; i < b.length; i += 333) frames.push(...r.push(b.subarray(i, i + 333)));
  assert.ok(frames.length >= 85 && frames.length <= 90, `${frames.length} frames`);
  checkFrames(frames, 44100, 1);
  assert.ok(frames.every((f) => f.t === null));
});

test('sniffing what a stream is', () => {
  assert.equal(D.sniff(data('sine.flv')), 'flv');
  assert.equal(D.sniff(data('sine.ts')), 'ts');
  assert.equal(D.sniff(data('sine.aac')), 'adts');
  assert.equal(D.sniff(new TextEncoder().encode('#EXTM3U\n#EXT-X-VERSION:3\n')), 'hls');
  assert.equal(D.sniff(new TextEncoder().encode('<html>')), null);
});

test('a silent frame is a valid ADTS frame of the stream\'s format', () => {
  for (const [sri, ch] of [[3, 2], [4, 1], [5, 2]]) {
    const f = D.silentFrame({ profile: 1, sri, ch });
    const h = D.adtsAt(f, 0);
    assert.equal(h.len, f.length);
    assert.equal(h.rate, D.RATES[sri]);
    assert.equal(h.ch, ch);
    assert.equal(h.profile, 1);
  }
  assert.equal(D.silentFrame({ profile: 1, sri: 3, ch: 6 }), null);
});

test('the AudioSpecificConfig becomes the ADTS header (HE-AAC as its AAC-LC core)', () => {
  assert.deepEqual(D.parseASC(Uint8Array.of(0x11, 0x90)), { profile: 1, sri: 3, rate: 48000, ch: 2 }); // LC 48k stereo
  assert.deepEqual(D.parseASC(Uint8Array.of(0x2b, 0x92, 0x08, 0x00)), { profile: 1, sri: 7, rate: 22050, ch: 2 }); // HE-AAC, 22.05k core
  assert.equal(D.parseASC(Uint8Array.of(0x17, 0x80)), null); // explicit rate (index 15)
});

test('PES timestamps unwrap across the 33-bit wrap', () => {
  const W = D.PTS_WRAP;
  assert.equal(D.ptsUnwrap(1, W - 1), W + 1);
  assert.equal(D.ptsUnwrap(W - 1, W + 1), W - 1);
  assert.equal(D.ptsUnwrap(5, 4), 5);
  assert.equal(D.ptsUnwrap(5, null), 5);
});

test('Apple packed audio: ADTS after an ID3 timestamp', () => {
  const adts = data('sine.aac');
  const owner = new TextEncoder().encode('com.apple.streaming.transportStreamTimestamp');
  const ts = 90000 * 1234.5;
  const priv = new Uint8Array(owner.length + 1 + 8);
  priv.set(owner);
  const hi = Math.floor(ts / 4294967296), lo = ts % 4294967296;
  priv.set([0, 0, 0, hi & 1, (lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff], owner.length + 1);
  const frame = D.concat(new TextEncoder().encode('PRIV'), Uint8Array.of(0, 0, 0, priv.length, 0, 0), priv);
  const n = frame.length;
  const id3 = D.concat(Uint8Array.of(0x49, 0x44, 0x33, 4, 0, 0, (n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f), frame);
  const { frames } = D.packedAudio(D.concat(id3, adts));
  assert.ok(frames.length >= 85);
  assert.ok(Math.abs(frames[0].t - 1234.5) < 1e-6);
  checkFrames(frames, 44100, 1);
});

test('fMP4 with video and audio in each fragment: the audio track, either way of giving offsets', () => {
  // ffmpeg's two fragmented layouts: default-base-is-moof, and an explicit base-data-offset in tfhd
  for (const f of ['sine_av_moof.mp4', 'sine_av_bdo.mp4']) {
    const b = data(f);
    const init = D.mp4Init(b);
    assert.ok(init && init.fmt, f);
    const { frames } = D.mp4Audio(b, init);
    assert.ok(frames.length >= 138 && frames.length <= 145, `${f}: ${frames.length} frames`);
    checkFrames(frames, 48000, 2);
  }
  // and the HLS layout: a separate init segment, the audio alone
  const init = D.mp4Init(data('sine_init.mp4'));
  const a = D.mp4Audio(data('sine_0.m4s'), init).frames, b = D.mp4Audio(data('sine_1.m4s'), init).frames;
  checkFrames([...a, ...b], 48000, 2);
  assert.ok(Math.abs(b[0].t - (a[a.length - 1].t + 1024 / 48000)) < 1e-6, 'the segments follow on');
});

test('MPEG-TS over HTTP as one stream: the same frames as the whole file, however the bytes arrive', () => {
  const b = data('sine.ts');
  const whole = D.tsAudio(b).frames;
  const r = D.tsReader();
  const got = [];
  for (let i = 0, k = 1; i < b.length; i += k, k = (k * 13 + 7) % 3001 + 1) got.push(...r.push(b.subarray(i, i + k)));
  // all but the last PES (it may still be growing: it comes with the next one)
  assert.ok(got.length >= whole.length - 12 && got.length < whole.length, `${got.length} of ${whole.length}`);
  got.forEach((f, i) => { assert.deepEqual(f.data, whole[i].data); assert.equal(f.t, whole[i].t); });
});

test('MPEG-TS over HTTP: a damaged packet costs its own audio only; a stream without AAC is refused', () => {
  const b = data('sine.ts');
  const whole = D.tsAudio(b).frames;
  // 100 bytes of a packet lost in the middle: the reader finds the packets again
  const at = 188 * 80;
  const cut = D.concat(b.subarray(0, at + 88), b.subarray(at + 188));
  const r = D.tsReader();
  const got = [];
  for (let i = 0; i < cut.length; i += 1500) got.push(...r.push(cut.subarray(i, i + 1500)));
  assert.ok(got.length >= whole.length - 20, `${got.length} of ${whole.length} frames`);
  assert.ok(got[got.length - 1].t > whole[whole.length - 30].t, 'it went on past the damage');
  // the PMT listing the audio as private data (0x06) instead of AAC (0x0f)
  const priv = b.slice();
  let patched = 0;
  for (let i = 0; i + 188 <= priv.length; i += 188) {
    if (priv[i + 1] & 0x40 && (((priv[i + 1] & 0x1f) << 8) | priv[i + 2]) === 0x1000) { // ffmpeg's PMT pid
      for (let j = i + 17; j < i + 40; j++) if (priv[j] === 0x0f && (priv[j + 1] & 0xe0) === 0xe0) { priv[j] = 0x06; patched++; break; }
    }
  }
  assert.ok(patched > 0, 'found the PMT to patch');
  assert.throws(() => { const q = D.tsReader(); for (let i = 0; i < priv.length; i += 4000) q.push(priv.subarray(i, i + 4000)); }, /no AAC audio/);
});

console.log(`${n} tests passed`);
