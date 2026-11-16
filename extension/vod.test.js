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
    assert.ok(lo <= 0 + 1 && hi >= 3600 + 600, `${lo}..${hi}`);
    assert.ok(hi <= 3600 + 600 + 60 + 25 + 227); // (the last stretch runs on by at most one)
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
