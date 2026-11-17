// The streamer's Bilibili replays: titles, which replays, sidx, the repeats, the timeline, the
// playlist and where to look (node vod.test.js).
'use strict';
require('./demux.js');
require('./vod.js');
const assert = require('node:assert/strict');
const V = globalThis.FoneVod;
let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

const lcg = (seed) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;

(async () => {
  await test('a replay title: the room title then, and the Beijing hour it went live in', () => {
    const p = V.parseTitle('【直播回放】【马莎F1】22点 英国 正赛 2025年07月06日21点场');
    assert.equal(p.live, '【马莎F1】22点 英国 正赛');
    assert.equal(p.slot, Date.UTC(2025, 6, 6, 13) / 1000); // 21:00 +08:00
    assert.equal(V.parseTitle('【直播回放】F1 巴西 巡游 2026年11月08日22点场').slot, Date.UTC(2026, 10, 8, 14) / 1000);
    assert.equal(V.parseTitle('some upload'), null);
  });

  await test('the replays that may hold a session: its hour and length against the events', () => {
    const h = 3600, E0 = 1e9, E1 = E0 + 2 * h;
    const list = [
      { bvid: 'before', slot: E0 - 6 * h, dur: 2 * h }, // over well before
      { bvid: 'pre', slot: E0 - 2 * h, dur: 1500 }, // ends before (its content by slot + 1 h + 25 min at the latest)
      { bvid: 'race', slot: E0 - h, dur: 4 * h },
      { bvid: 'restart', slot: E0 + h, dur: 2 * h },
      { bvid: 'after', slot: E1 + h, dur: h },
      { bvid: 'untitled', slot: null, dur: h },
    ];
    assert.deepEqual(V.candidates(list, E0, E1).map((r) => r.bvid), ['race', 'restart']);
  });

  // a sidx box (version 0) with segments of `durs` (timescale 48000) and `sizes` bytes
  const sidxBox = (durs, sizes, first = 0) => {
    const n = durs.length, b = new Uint8Array(32 + 12 * n), dv = new DataView(b.buffer);
    dv.setUint32(0, b.length); b.set([0x73, 0x69, 0x64, 0x78], 4);
    dv.setUint32(12, 1); dv.setUint32(16, 48000); dv.setUint32(20, 0); dv.setUint32(24, first); dv.setUint16(30, n);
    for (let k = 0; k < n; k++) { dv.setUint32(32 + 12 * k, sizes[k]); dv.setUint32(36 + 12 * k, durs[k]); dv.setUint32(40 + 12 * k, 0x90000000); }
    return b;
  };

  await test('a sidx: each segment where it is in the file, and when in the page', () => {
    const b = sidxBox([239592, 240640, 96240], [40495, 44325, 18000]);
    const segs = V.sidx(b, 828);
    assert.equal(segs.length, 3);
    assert.equal(segs[0].off, 828 + b.length);
    assert.equal(segs[1].off, 828 + b.length + 40495);
    assert.equal(segs[2].len, 18000);
    assert.ok(Math.abs(segs[1].t - 239592 / 48000) < 1e-9 && Math.abs(segs[2].d - 2.005) < 1e-9);
    assert.deepEqual(V.segRange(segs, 4, 2), [0, 2]); // 4..6 s: the first two
    assert.deepEqual(V.segRange(segs, 10.5, 100), [2, 3]);
    assert.deepEqual(V.segRange(segs, 50, 10), [3, 3]);
  });

  // packets: sound (60-400 B, random) with digital silence (8 B, all the same) here and there
  const packets = (count, seed) => {
    const r = lcg(seed);
    return Array.from({ length: count }, (_, i) => (i % 700 > 640 ? Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8)
      : Uint8Array.from({ length: 60 + Math.floor(r() * 340) }, () => Math.floor(r() * 256))));
  };

  await test('a repeat: the lag, and the earlier copy\'s last packet (where to cut after)', () => {
    const P = packets(1900, 3), K = 1000, L = 196;
    // the next fragment starts at K + 1 with a copy of [K + 1 - L, K], its first 3 packets encoded differently
    const Q = [...P.slice(0, K + 1), ...P.slice(K + 1 - L, K + 1).map((p, i) => (i < 3 ? Uint8Array.of(...p, 9) : p)), ...P.slice(K + 1)];
    const r = V.findRepeat(Q);
    assert.equal(r.lag, L);
    assert.equal(r.e, K);
    assert.equal(V.findRepeat(P), null); // (none: nothing repeats but the silence)
  });

  await test("a page's start repeating the last one's end, across the two", () => {
    const P = packets(940, 5), L = 195;
    const a = P.slice(0, 600), b = [...P.slice(600 - L, 600), ...P.slice(600)];
    const r = V.findRepeat([...a, ...b]);
    assert.equal(r.lag, L);
    assert.equal(r.e + 1, 600); // (the cut starts with page 2's first packet)
  });

  // a replay of two pages with 5 s segments, its frames from a function (no fMP4: frames as findCuts takes them)
  const pkt = 1024 / 48000;
  const fakeReplay = () => {
    const pages = [7200, 3000].map((dur, i) => ({ page: i + 1, dur, initInfo: { fmt: { rate: 48000 } },
      segs: Array.from({ length: Math.ceil(dur / 5) }, (_, k) => ({ t: 5 * k, d: Math.min(5, dur - 5 * k), off: 0, len: 0 })) }));
    // each page's packets, with repeats of 196 at 1804.4 s (and every ~1804.2 s on), page 2 starting with one
    const r = lcg(11);
    const src = Array.from({ length: Math.round(10300 / pkt) }, () => Uint8Array.from({ length: 80 + Math.floor(r() * 200) }, () => Math.floor(r() * 256)));
    let si = 0;
    const page = (dur, joins, lead) => {
      const out = [];
      if (lead) { for (let k = 0; k < 196; k++) out.push(src[si - 196 + k]); }
      while (out.length * pkt < dur) {
        if (joins.length && out.length === Math.round(joins[0] / pkt)) { joins.shift(); for (let k = 0; k < 196; k++) out.push(src[si - 196 + k]); continue; }
        out.push(src[si++]);
      }
      return out;
    };
    const p1 = page(7200, [1804.4, 3608.6, 5412.8], false), p2 = page(3000, [1804.2], true);
    const frames = async (i, t0, t1) => {
      const P = i ? p2 : p1, k0 = Math.max(0, Math.floor(t0 / 5) * 5 / pkt), k1 = Math.min(P.length, Math.ceil(t1 / 5) * 5 / pkt);
      const out = [];
      for (let k = Math.round(k0); k < Math.round(k1); k++) out.push({ t: k * pkt, data: Uint8Array.of(0, 0, 0, 0, 0, 0, 0, ...P[k]) });
      return out;
    };
    return { rep: { bvid: 'BVtest', title: 't', live: 'race', pages, total: 10200, cuts: [] }, frames };
  };

  await test('the repeats of a replay: each fragment join, and the page boundary', async () => {
    const { rep, frames } = fakeReplay();
    const cuts = await V.findCuts(rep, frames);
    const at = cuts.map((c) => Math.round(c.m * 10) / 10);
    assert.deepEqual(at, [1804.4, 3608.6, 5412.8, 7200, 9004.2]);
    assert.ok(cuts.every((c) => Math.abs(c.d - 196 * pkt) < 1e-3 && !c.assumed));
  });

  await test('a repeat away from the joins (a whole segment twice), found in a window ahead of playing', async () => {
    // one page; at packet K the 235 packets before it (5.013 s, one ~5 s segment) come again
    const r = lcg(21), K = 14000, L = 235;
    const src = Array.from({ length: 28000 }, () => Uint8Array.from({ length: 80 + Math.floor(r() * 200) }, () => Math.floor(r() * 256)));
    const P = [...src.slice(0, K), ...src.slice(K - L, K).map((p, i) => (i < 4 ? Uint8Array.of(...p, 7) : p)), ...src.slice(K)];
    const rep = { bvid: 'BVseg', pages: [{ page: 1, dur: P.length * pkt, initInfo: { fmt: { rate: 48000 } } }], cuts: [] };
    const frames = async (i, t0, t1) => {
      const out = [];
      for (let k = Math.max(0, Math.floor(t0 / pkt)); k < Math.min(P.length, Math.ceil(t1 / pkt)); k++) out.push({ t: k * pkt, data: Uint8Array.of(0, 0, 0, 0, 0, 0, 0, ...P[k]) });
      return out;
    };
    const c = await V.scanRepeat(rep, frames, K * pkt - 30, K * pkt + 30, []);
    assert.ok(c && c.ahead, JSON.stringify(c));
    assert.ok(Math.abs(c.d - L * pkt) < 1e-3);
    assert.ok(Math.abs(c.m - K * pkt) < 0.2, `${c.m} vs ${K * pkt}`); // (cut where the copy starts, give or take the few packets that differ)
    assert.equal(await V.scanRepeat(rep, frames, K * pkt - 30, K * pkt + 30, [{ m: c.m, d: c.d }]), null); // (known)
    assert.equal(await V.scanRepeat(rep, frames, 60, 120, []), null); // (none there)
  });

  await test('the replay on the wall clock: the repeats skipped, its pages one after the other', () => {
    const rep = { bvid: 'BV1', title: 'x', live: 'race', pages: [{ page: 1, dur: 3600 }, { page: 2, dur: 1000 }], cuts: [{ m: 1800, d: 4 }, { m: 3600, d: 4 }] };
    const tl = V.timeline(rep, 1000);
    assert.deepEqual(tl.pieces.map((p) => [p.m, p.d, p.w, p.f]), [[0, 1800, 1000, 0], [1804, 1796, 2800, 0], [3604, 996, 4596, 1]]);
    assert.equal(tl.files[1].offset, 3600);
    assert.equal(tl.files[1].title, 'race · P2');
    assert.equal(V.contentAt(rep, 1802), 1800); // (inside a repeat: where it was cut)
    assert.equal(V.contentAt(rep, 4000), 3992);
  });

  await test('the playlist: each page its init and byte ranges, a discontinuity between', () => {
    const seg = (t, off) => ({ t, d: 5.0133, off, len: 44000 });
    const rep = { pages: [{ init: [0, 817], segs: [seg(0, 18178), seg(5.0133, 62178)] }, { init: [0, 817], segs: [seg(0, 20266)] }] };
    const pl = V.playlist(rep, (i) => `https://vod.fone.invalid/BV1/${i}`);
    assert.match(pl, /^#EXTM3U\n/);
    assert.match(pl, /#EXT-X-MAP:URI="https:\/\/vod.fone.invalid\/BV1\/0",BYTERANGE="818@0"/);
    assert.match(pl, /#EXTINF:5.013300,\n#EXT-X-BYTERANGE:44000@62178\nhttps:\/\/vod.fone.invalid\/BV1\/0/);
    assert.equal(pl.match(/#EXT-X-DISCONTINUITY/g).length, 1);
    assert.match(pl, /#EXT-X-ENDLIST\n$/);
  });

  await test('where to look: the hour the replay may start in, nearest the likeliest first, chunks overlapping', () => {
    const slot = 1e9, rep = { slot, total: 7200, pages: [{ dur: 7200 }] };
    const E = slot + 3600; // an event an hour after the slot: the replay's 0..60 min, +delay
    const plan = V.searchPlan([rep], E, { chunk: 200, win: 25 });
    const lo = Math.min(...plan.map((c) => c.a)), hi = Math.max(...plan.map((c) => c.a + c.len));
    assert.ok(lo <= 0 + 1 && hi >= 3600 + 180, `${lo}..${hi}`);
    assert.ok(hi <= 3600 + 180 + 60 + 25 + 227); // (the last stretch runs on by at most one)
    // nearest E + 50 - (slot + 30 min) = 1850 first
    assert.ok(Math.abs(plan[0].a + plan[0].len / 2 - 1850) <= 120, JSON.stringify(plan[0]));
    // every stretch's look overlaps the next by the look's length
    const as = plan.map((c) => c.a).sort((a, b) => a - b);
    for (let i = 1; i < as.length; i++) assert.ok(as[i] - as[i - 1] <= 200 + 1e-9);
    assert.ok(plan.every((c) => c.len === 227 || c.a + c.len >= 7200 - 1e-6));
    // after misses: all of it
    const all = V.searchPlan([rep], E, { chunk: 200, win: 25, full: true });
    assert.equal(Math.min(...all.map((c) => c.a)), 0);
    assert.ok(Math.max(...all.map((c) => c.a + c.len)) >= 7199);
  });

  await test('content time and back: the repeats left out, and put back', () => {
    const rep = { cuts: [{ m: 3600, d: 4 }, { m: 1800, d: 4 }] };
    for (const m of [0, 1799, 1805, 3599, 3605, 9000]) assert.equal(V.atContent(rep, V.contentAt(rep, m)), m);
    assert.equal(V.atContent(rep, 1800), 1800); // (where the cut is: before it)
    assert.equal(V.atContent({}, 77), 77);
  });

  // F1 TV's sound faint in the stream: one look not sure, its likely place found again by the sound
  // heard after it (and a likely place by chance never is); the matcher's own, at 4 kHz
  await test('a likely place: found again by the sound heard after it; one by chance, never', async () => {
    require('./sound.js');
    const S = globalThis.FoneSound, sr = 4000, r = lcg(5);
    const g = () => { let s = 0; for (let i = 0; i < 12; i++) s += r(); return s - 6; }; // (~gaussian)
    // F1 TV's sound (300 s of it, noise with some colour) and the stream: the streamer's own sound
    // over it, F1 TV's faint in it from replay position 4000 on (the picture at 0)
    const N = 300 * sr, f1 = new Float32Array(N);
    let lp = 0;
    for (let i = 0; i < N; i++) { lp = 0.7 * lp + g(); f1[i] = lp; }
    const M0 = 3900, rep = { bvid: 'BVw', cuts: [{ m: 3950, d: 5 }] }; // (a repeat before the place: on the content clock)
    const at0 = 4000, total = 500, y = new Float32Array(total * sr);
    for (let i = 0; i < y.length; i++) y[i] = 9 * g();
    for (let i = 0; i < N; i++) {
      const j = Math.round((at0 - M0) * sr) + i;
      if (j < y.length) y[j] += 0.28 * f1[i];
    }
    const read = async (rp, a, len) => ({ m0: M0, y }); // (all of it)
    const E0 = 1e9; // the event at the picture's 0
    // the sound of picture pa..pa+len as a look takes it
    const look = (pa, len, run) => ({ q: f1.subarray(pa * sr, (pa + len) * sr), pa, pb: pa + len, E: E0 + pa, run });
    // look 1 (picture 0..30): not sure; its likely place the true one (m 4000), and one by chance
    const L1 = look(0, 30, 'run1'), hit = S.locate(L1.q, y.subarray((at0 - 20 - M0) * sr, (at0 + 60 - M0) * sr), sr);
    assert.ok(hit.score > 6 && hit.score < 9.5, `faint: ${hit.score}`); // (not sure by itself: VOD.SCORE 9.5)
    const cands = [];
    V.keepLikely(cands, [{ rep, m: at0 - 20 + hit.lag / sr, score: 7.6 }, { rep, m: 4210.4, score: 9.1 }, { rep, m: 4211, score: 8 }, { rep, m: 4300, score: 6 }], 1, L1);
    assert.deepEqual(cands.map((c) => Math.round(c.m)), [4210, 4000]); // (the strongest few, apart, 7 and up)
    const truth = cands[1];
    // the same sound again (picture 8..38): nothing fresh enough to check with
    let ck = await V.checkLikely(cands, look(8, 30, 'run1'), read, S.locate, { sr });
    assert.equal(ck.hit, null);
    assert.equal(ck.checked.length, 0);
    // 40 s on: the sound since found where the true place says (the chance one not)
    ck = await V.checkLikely(cands, look(40, 30, 'run1'), read, S.locate, { sr });
    assert.ok(ck.hit && ck.hit.cand === truth, JSON.stringify(ck.checked));
    assert.ok(Math.abs(ck.hit.m - (at0 + 40)) < 0.01 && Math.abs(ck.hit.E - (E0 + 40)) < 1e-6, `${ck.hit.m}`);
    assert.ok(ck.checked.length === 2 && ck.checked[0].score < 6.5, JSON.stringify(ck.checked)); // (the chance one, stronger, checked first: not there)
    console.log('   faint: look 1', hit.score.toFixed(1), '· found again', ck.hit.score.toFixed(1), `(the best elsewhere around it ${ck.checked[1].next})`,
      '· the chance one', ck.checked[0].score);
    // the place on the content clock: the repeat before it left out
    assert.ok(Math.abs(V.contentAt(rep, ck.hit.m) - (at0 + 40 - 5)) < 0.01);
    // a chance place only: never found again, let go after `drop` checks
    const only = cands.filter((c) => Math.round(c.m) === 4210);
    for (let k = 0; k < 4; k++) {
      ck = await V.checkLikely(only, look(40 + 30 * k, 30, 'run2'), read, S.locate, { sr, drop: 4 });
      assert.equal(ck.hit, null);
    }
    assert.equal(only.length, 0);
    // places by chance all over the stream, each checked with sound well after it: none found again
    const wrong = Array.from({ length: 40 }, (_, k) => ({ rep, m: 3905 + k * 7.9 + (k % 3) * 0.37, score: 8 }))
      .filter((c) => Math.abs(c.m - at0) > 5);
    let found = 0, top = 0;
    for (const c of wrong) {
      const one = [{ ...c, E: E0, pa: 0, pb: 30, run: 'run1', fails: 0 }];
      ck = await V.checkLikely(one, look(60, 30, 'run1'), read, S.locate, { sr });
      if (ck.hit) found++;
      top = Math.max(top, ...ck.checked.map((x) => x.score));
    }
    assert.equal(found, 0, `${found} of ${wrong.length} found by chance`);
    assert.ok(top < 6.5, `the best by chance ${top}`);
    // a stretch of the stream like this sound at many lags (copies of it a second apart, the one
    // where a place says a little the strongest): high there, but not standing out: not taken
    const yc = Float32Array.from(y);
    for (const [dt, g2] of [[-2, 1], [-1, 1], [0, 1.1], [1, 1], [2, 1]]) {
      const j0 = Math.round((4120.2 + dt - M0) * sr);
      for (let i = 0; i < 30 * sr; i++) yc[j0 + i] += 0.35 * g2 * f1[40 * sr + i];
    }
    const fake = [{ rep, m: 4080.2, score: 8, E: E0, pa: 0, pb: 30, run: 'run1', fails: 0 }];
    ck = await V.checkLikely(fake, look(40, 30, 'run1'), async () => ({ m0: M0, y: yc }), S.locate, { sr });
    const fk = ck.checked[0];
    assert.ok(ck.hit === null && fk.score >= 6.5 && Math.abs(fk.d) < 0.05 && fk.score < 1.3 * fk.next, JSON.stringify(ck.checked));
    // a seek (another run of F1 TV's sound): all of it fresh
    const c2 = [];
    V.keepLikely(c2, [{ rep, m: at0 - 20 + hit.lag / sr, score: 7.6 }], 1, L1);
    ck = await V.checkLikely(c2, look(150, 20, 'run3'), read, S.locate, { sr });
    assert.ok(ck.hit && Math.abs(ck.hit.m - (at0 + 150)) < 0.01, JSON.stringify(ck.checked));
    // too many: the weakest let go
    const c3 = [];
    for (let k = 0; k < 5; k++) V.keepLikely(c3, [{ rep, m: 100 * k, score: 7 + k }, { rep, m: 100 * k + 50, score: 12 - k }], k, L1, { max: 4 });
    assert.deepEqual(c3.map((c) => c.score).sort((a, b) => a - b), [10, 11, 11, 12]);
  });

  // the clock on the streamer's screen: a replay of two pages, its repeats cut; the extension's numbers
  const CK = { D0: 50, SCREEN: 1.5, near: 240, trust: 15, bound: 120 };
  const clockRep = (bvid, readings, status = 'ok') => ({ bvid, pages: [{ page: 1, dur: 3600 }, { page: 2, dur: 3600 }], total: 7200,
    cuts: [{ m: 1804.2, d: 4.18 }, { m: 3600, d: 4.18 }], clock: { status, readings } });

  await test('the clock on the streamer\'s screen: where a reading puts the replay, the one nearest the moment', () => {
    const W = 1.75e9;
    const A = clockRep('BVa', [{ page: 1, at: 1000, wall: W }, { page: 2, at: 500, wall: W + 4200 }]);
    assert.equal(V.pageStart(A, 2), 3600);
    assert.equal(V.pageStart(A, 3), null);
    // T0: the reading's wall at its place on the content clock, the delay at D0, less the screen's lead
    const T0a = W + 50 - 1000 - 1.5, T0b = W + 4200 + 50 - (4100 - 2 * 4.18) - 1.5;
    let k = V.clockAt([A], W + 30, CK);
    assert.ok(k.r === A && Math.abs(k.T0 - T0a) < 1e-6 && k.d === 30, JSON.stringify(k));
    k = V.clockAt([A], W + 4000, CK); // (nearer the second: it rules)
    assert.ok(Math.abs(k.T0 - T0b) < 1e-6 && k.d === 200);
    assert.equal(V.clockAt([A], W - 3600, CK), null); // (before the replay, by both)
    // the streamer restarted: the moment in the second replay by its own reading; one still being read, not used
    const B = clockRep('BVb', [{ page: 1, at: 100, wall: W + 9000 }]), C = clockRep('BVc', [{ page: 1, at: 0, wall: W + 9000 }], 'working');
    k = V.clockAt([A, B, C], W + 9100, CK);
    assert.ok(k.r === B && k.d === 100);
  });

  await test('the clock against where the replay plays: moved when off a reading near the moment, bounded by a far one', () => {
    const W = 1.75e9, A = clockRep('BVa', [{ page: 1, at: 1000, wall: W }]), B = clockRep('BVb', []);
    const k = V.clockAt([A], W + 100, CK);
    // off: T0 less the delay against the clock's T0 less D0 (a delay of 70 at T0 + 20 plays where D0 at T0 would)
    assert.equal(V.clockOff(k, A, k.T0 + 20, 70, 50), 0);
    assert.ok(Math.abs(V.clockOff(k, A, k.T0, 70, 50) - 20) < 1e-9);
    assert.equal(V.clockOff(k, B, k.T0, 50, 50), Infinity); // (it says another replay holds the moment)
    assert.equal(V.clockOff(null, A, k.T0, 50, 50), null);
    const moves = (off, d, o = {}) => V.clockMoves({ ...k, d }, off, { placed: true, ...CK, ...o });
    assert.equal(V.clockMoves(k, null, { placed: false, ...CK }), true); // (not placed: there at once)
    assert.equal(V.clockMoves(null, null, { placed: false, ...CK }), false);
    assert.equal(moves(10, 100), false); // (within sync by sound's own drift of a near reading)
    assert.equal(moves(20, 100), true);
    assert.equal(moves(20, 400), false); // (a reading minutes away only bounds it)
    assert.equal(moves(130, 400), true);
    assert.equal(moves(Infinity, 400), true);
    // sync by sound locked since: the streamer's delay stepped 20 s since a reading 100 s back,
    // sound has it now (re-placed by the reading, the commentary jumped back and forth every look)
    assert.equal(moves(20, 100, { held: true }), false);
    assert.equal(moves(130, 100, { held: true }), true); // (still never far from it)
    assert.equal(moves(Infinity, 100, { held: true }), true);
  });

  await test("the clock refuses a sound match far from where it says (a lap shown again after the session)", () => {
    // 2026 Italian GP qualifying (BV1ATbL6dEp9): a sure-looking match, 13.9 at 1.8× the rest, 28 min off the replay's place
    const W = 1.75e9, A = clockRep('BV1ATbL6dEp9', [{ page: 1, at: 1000, wall: W }, { page: 1, at: 2500, wall: W + 1500 }]);
    const k = V.clockAt([A], W + 60, CK), room = V.clockRoom(k, CK);
    assert.equal(room, 15);
    assert.equal(V.clockVeto(k, A, k.T0 + 28 * 60, room), true);
    assert.equal(V.clockVeto(k, A, k.T0 + 1.2, room), false); // (sound takes it the last second)
    assert.equal(V.clockVeto(k, clockRep('BVother', []), k.T0, room), true);
    assert.equal(V.clockVeto(null, A, k.T0 + 28 * 60, room), false); // (no clock: sound alone)
    // a reading 10 min from the moment: only the bound
    const far = V.clockAt([A], W + 600 + 1500, CK);
    assert.equal(V.clockRoom(far, CK), 120);
    assert.equal(V.clockVeto(far, A, far.T0 + 60, V.clockRoom(far, CK)), false);
  });

  await test('the clock pending (sound held back for it) and when to ask the server', () => {
    const W = 1.75e9, ok = clockRep('BVok', [{ page: 1, at: 1000, wall: W }]);
    const fresh = { bvid: 'BVnew' }, reading = { bvid: 'BVr', clock: { status: 'working', askedAt: 100 } };
    const none = { bvid: 'BVn', clock: { status: 'none', askedAt: 100 } };
    assert.equal(V.clockPending([ok, fresh], 10, { wait: 300 }), true); // (not asked yet)
    assert.equal(V.clockPending([ok, reading], 10, { wait: 300 }), true);
    assert.equal(V.clockPending([ok, none], 10, { wait: 300 }), false);
    assert.equal(V.clockPending([ok, reading], 301, { wait: 300 }), false); // (waited long enough)
    // F1 Academy, F2, F3: no session key, never asked: nothing to wait for
    assert.equal(V.clockPending([fresh], 10, { can: false, wait: 300 }), false);
    const O = { poll: 3, again: 20, near: 240 };
    ok.clock.askedAt = 100;
    const asks = (reps, E, t) => V.clockAsks(reps, E, t, O).map((r) => r.bvid);
    assert.deepEqual(asks([fresh, reading, none], W, 102), ['BVnew']);
    assert.deepEqual(asks([fresh, reading, none], W, 103), ['BVnew', 'BVr']);
    assert.deepEqual(asks([{ bvid: 'BVe', clock: { status: 'error', askedAt: 100 } }], W, 129), []);
    assert.deepEqual(asks([{ bvid: 'BVe', clock: { status: 'error', askedAt: 100 } }], W, 130), ['BVe']);
    assert.deepEqual(asks([ok], W + 100, 200), []); // (a reading near the moment)
    assert.deepEqual(asks([ok], W + 600, 119), []);
    assert.deepEqual(asks([ok], W + 600, 120), ['BVok']); // (none near a moment after a seek: asked for one there)
    assert.deepEqual(asks([ok], null, 200), []);
    assert.deepEqual(asks([{ ...ok, clock: { ...ok.clock, more: true } }], W, 103), ['BVok']); // (reading near E: polled)
  });

  await test("a replay's danmaku: where in the page, how, and the text unescaped", () => {
    const xml = '<?xml version="1.0"?><i><chatid>1</chatid><d p="6520.73200,1,25,16777215,1751886915,0,5ea38299,188572,10">乐扣冲出去了！！</d>'
      + '<d p="12.5,5,25,16646914,1751886909,0,ff2b1ef,188573,10">a &amp; b &lt;3 &#x1F600;</d><d p="x,1">bad</d></i>';
    const d = V.parseDanmaku(xml);
    assert.equal(d.length, 2);
    assert.deepEqual(d[0], { p: 12.5, m: 5, s: 25, c: 16646914, u: 'ff2b1ef', x: 'a & b <3 \u{1F600}' });
    assert.equal(d[1].p, 6520.732);
    assert.equal(d[1].x, '乐扣冲出去了！！');
  });

  console.log(`${n} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
