// The streamer's Bilibili replays (直播回放) as the commentary of a replay that no recording covers
// (offscreen.js): a fone server keeps its recordings for weeks, the streamer's replays stay on
// their Bilibili space for years. Streamed from Bilibili as F1 TV plays, nothing downloaded first.
//
// Bilibili makes a 直播回放 of every live, in the uploader's '直播回放' series, titled
// '【直播回放】<room title> YYYY年MM月DD日HH点场' (HH: the Beijing hour it went live in: where it
// starts is known only to the hour), in pages of whole ~30-min fragments; every fragment (a page
// too) starts by repeating the previous one's last ~5 s (server/fone/backfill_dedup.py measured
// it: the repeat is the same AAC packets, byte for byte, after a few). The sound is DASH: one fMP4
// per page and quality, a sidx of ~5 s segments, fetched by byte range; the URLs are signed for
// this IP for ~2 h, served by several mirrors of very different speeds from here.
//
// Where the commentary is in it is found by sound (offscreen.js): F1 TV's sound, which the
// streamer passes through, looked for over the hour the replay may start in; then the replay is
// put on the wall clock so that the delay reads as usual, and sync by sound keeps it.
// The pure parts are shared with the Node tests (vod.test.js).
(function (root) {
  'use strict';

  // ---- titles and which replays ---------------------------------------------------------------

  const TITLE = /^【直播回放】(.*?)\s*(\d{4})年(\d{1,2})月(\d{1,2})日(\d{1,2})点场$/;
  // A replay's title: the room's title then, and the slot (unix s of the Beijing hour it went live in).
  function parseTitle(title) {
    const m = TITLE.exec(String(title || '').trim());
    if (!m) return null;
    return { live: m[1].trim(), slot: Date.UTC(+m[2], +m[3] - 1, +m[4], +m[5]) / 1000 - 8 * 3600 };
  }

  // The replays that may hold the commentary for events E0..E1 (wall times): a replay's content
  // starts in its slot's hour and lasts `dur`; the commentary of an event goes some dmin..dmax s
  // after it (the streamer's delay, F1 TV's anchor's error). By time, earliest first.
  function candidates(list, E0, E1, { dmin = -120, dmax = 600 } = {}) {
    return list.filter((r) => r.slot != null && r.slot < E1 + dmax && r.slot + 3600 + r.dur > E0 + dmin).sort((a, b) => a.slot - b.slot);
  }

  // ---- fMP4 -------------------------------------------------------------------------------------

  const u32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  const u64 = (b, i) => u32(b, i) * 4294967296 + u32(b, i + 4);

  // The segments a sidx lists ('index_range' of the DASH representation; b: its bytes, from file
  // offset `at`): [{t, d (s, from the page's start), off, len (bytes in the file)}].
  function sidx(b, at) {
    let i = 0;
    for (;;) {
      if (i + 8 > b.length) throw new Error('no sidx');
      const size = u32(b, i), type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
      if (type === 'sidx') break;
      if (size < 8) throw new Error('bad box');
      i += size;
    }
    const end = i + u32(b, i), v = b[i + 8];
    let p = i + 12 + 4; // (version, flags; reference_ID)
    const ts = u32(b, p); p += 4;
    let first;
    if (v === 0) { first = u32(b, p + 4); p += 8; } else { first = u64(b, p + 8); p += 16; }
    const n = (b[p + 2] << 8) | b[p + 3];
    p += 4;
    if (p + 12 * n > b.length) throw new Error('sidx cut short');
    const segs = [];
    let off = at + end + first, t = 0;
    for (let k = 0; k < n; k++, p += 12) {
      const a = u32(b, p), d = u32(b, p + 4);
      if (a & 0x80000000) throw new Error('nested sidx');
      const len = a & 0x7fffffff;
      segs.push({ t: t / ts, d: d / ts, off, len });
      off += len;
      t += d;
    }
    return segs;
  }

  // The segments covering [t, t + d) s of a page: their indices [i0, i1).
  function segRange(segs, t, d) {
    let lo = 0, hi = segs.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (segs[mid].t + segs[mid].d <= t) lo = mid + 1; else hi = mid; }
    let i1 = lo;
    while (i1 < segs.length && segs[i1].t < t + d) i1++;
    return [lo, Math.max(lo, i1)];
  }

  // ---- the ~5 s repeats ------------------------------------------------------------------------

  // FNV-1a of a packet (with its length).
  function hash(u8) {
    let h = 0x811c9dc5;
    for (let i = 0; i < u8.length; i++) { h ^= u8[i]; h = Math.imul(h, 0x01000193); }
    return (h ^ u8.length) >>> 0;
  }

  // A repeat in a run of AAC packets (raw, in order): the same packets again `lag` later. Seeds are
  // packets with sound (not digital silence's few bytes, nor quiet ones, which repeat by chance)
  // whose hash occurs exactly twice; the lag most of them share, if it covers enough of itself
  // with sound, is the repeat. {e: the earlier copy's last matching packet, lag, loud} or null.
  // What to cut is the `lag` packets after e: the packet before the seam is then the one the
  // decoder would have had before the later copy's (backfill_dedup.py's bit-exact splice).
  function findRepeat(P, { minLag = 90, maxLag = 600, need = 0.4 } = {}) {
    const n = P.length;
    if (n < 2 * minLag) return null;
    const H = new Uint32Array(n), size = new Uint32Array(n);
    for (let i = 0; i < n; i++) { H[i] = hash(P[i]); size[i] = P[i].length; }
    const med = Array.from(size).sort((a, b) => a - b)[n >> 1];
    const loud = (i) => size[i] >= Math.max(24, 0.15 * med);
    const at = new Map();
    for (let i = 0; i < n; i++) if (loud(i)) { const a = at.get(H[i]); if (a) a.push(i); else at.set(H[i], [i]); }
    const lags = new Map();
    for (const a of at.values()) {
      if (a.length !== 2) continue;
      const L = a[1] - a[0];
      if (L >= minLag && L <= maxLag) lags.set(L, (lags.get(L) || 0) + 1);
    }
    let L = 0, c = 0;
    for (const [k, v] of lags) if (v > c) { L = k; c = v; }
    if (!L) return null;
    // the loud matches at that lag, the densest stretch of them (no longer than the lag itself)
    const hits = [];
    for (let i = 0; i + L < n; i++) if (H[i] === H[i + L] && loud(i)) hits.push(i);
    let bestN = 0, bestEnd = -1;
    for (let a = 0, b = 0; b < hits.length; b++) {
      while (hits[b] - hits[a] > L + 20) a++;
      if (b - a + 1 > bestN) { bestN = b - a + 1; bestEnd = hits[b]; }
    }
    if (bestN < need * L) return null;
    let e = bestEnd;
    while (e + 1 + L < n && H[e + 1] === H[e + 1 + L]) e++;
    return { e, lag: L, loud: bestN };
  }

  // ---- the replay as a timeline ----------------------------------------------------------------

  // rep: {bvid, title, pages: [{page, dur, ...}], cuts: [{m, d}]}, its pages back to back on one
  // axis m (as the playlist plays them); cuts, the repeats (skipped). Placed at T0 (the wall time
  // of its first sample): {files, pieces, total}, as a fone server's /api/timeline gives them.
  function timeline(rep, T0) {
    const files = [];
    let off = 0;
    rep.pages.forEach((pg) => {
      files.push({ id: `${rep.bvid}/${pg.page}`, name: `${rep.bvid}/${pg.page}`,
        title: `${rep.live || rep.title}${rep.pages.length > 1 ? ` · P${pg.page}` : ''}`, offset: off, duration: pg.dur, inPlaylist: true });
      off += pg.dur;
    });
    const total = off, pieces = [];
    const fileAt = (m) => { let f = 0; for (let i = 0; i < files.length; i++) if (m >= files[i].offset - 1e-6) f = i; return f; };
    let m = 0, w = T0;
    for (const c of [...(rep.cuts || [])].sort((a, b) => a.m - b.m)) {
      if (c.m > m) { pieces.push({ m, d: c.m - m, w, f: fileAt(m) }); w += c.m - m; }
      m = Math.max(m, c.m + c.d);
    }
    if (total > m) pieces.push({ m, d: total - m, w, f: fileAt(m) });
    for (const f of files) {
      const pc = pieces.find((x) => f.offset >= x.m && f.offset < x.m + x.d) || pieces.find((x) => x.m >= f.offset);
      f.wallStart = pc ? pc.w + Math.max(0, f.offset - pc.m) : null;
    }
    return { files, pieces, total };
  }

  // The content time of position m (s from the replay's start, the repeats left out).
  function contentAt(rep, m) {
    let c = m;
    for (const x of rep.cuts || []) if (x.m < m) c -= Math.min(x.d, m - x.m);
    return c;
  }

  // An HLS playlist of the replay's sound (fMP4 by byte range: hls.js plays it as it plays a
  // server's), each page from url(i): its init segment, then its segments; pages back to back.
  function playlist(rep, url) {
    let max = 1;
    for (const pg of rep.pages) for (const s of pg.segs) max = Math.max(max, s.d);
    const L = ['#EXTM3U', '#EXT-X-VERSION:7', `#EXT-X-TARGETDURATION:${Math.ceil(max)}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-INDEPENDENT-SEGMENTS'];
    rep.pages.forEach((pg, i) => {
      const u = url(i);
      if (i) L.push('#EXT-X-DISCONTINUITY');
      L.push(`#EXT-X-MAP:URI="${u}",BYTERANGE="${pg.init[1] + 1}@0"`);
      for (const s of pg.segs) L.push(`#EXTINF:${s.d.toFixed(6)},`, `#EXT-X-BYTERANGE:${s.len}@${s.off}`, u);
    });
    L.push('#EXT-X-ENDLIST');
    return `${L.join('\n')}\n`;
  }

  // Where to look for F1 TV's sound heard at event time E (its picture's): stretches of `chunk` s
  // (+ win + 2, so a match across two is in one) of each replay's pages, over where the replay may
  // hold it (it starts in its slot's hour; the commentary dmin..dmax s after the event; a minute
  // for the repeats), or all of it (`full`); nearest a middle guess first.
  function searchPlan(reps, E, { dmin = -120, dmax = 600, chunk = 200, win = 20, guess = 50, full = false } = {}) {
    const out = [];
    for (const r of reps) {
      const lo = full ? 0 : Math.max(0, E + dmin - (r.slot + 3600) - 60);
      const hi = full ? r.total : Math.min(r.total, E + dmax - r.slot + 60 + win);
      const mid = E + guess - (r.slot + 1800);
      let off = 0;
      for (let i = 0; i < r.pages.length; i++) {
        // (on a grid from the page's start: the same stretches whatever the picture, kept between looks)
        const pg = r.pages[i], a0 = off + Math.floor(Math.max(0, Math.max(lo, off) - off) / chunk) * chunk, a1 = Math.min(hi, off + pg.dur);
        for (let a = a0; a < a1 - win; a += chunk) {
          const len = Math.min(chunk + win + 2, off + pg.dur - a);
          if (len >= win + 2) out.push({ rep: r, page: i, a, len, dist: Math.abs(a + len / 2 - mid) });
        }
        off += pg.dur;
      }
    }
    return out.sort((x, y) => x.dist - y.dist);
  }

  // ---- Bilibili ---------------------------------------------------------------------------------
  // Its web pages' own APIs, without a login (the Referer/Origin they want: background.js's
  // session rules, FoneStreams.HEADERS).

  async function json(url) {
    const r = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(12000) });
    if (r.status === 412) throw new Error('Bilibili refused this network for now (412): it will try again');
    if (!r.ok) throw new Error(`Bilibili: HTTP ${r.status}`);
    const j = await r.json();
    if (j.code !== 0) throw new Error(`Bilibili: ${j.message || j.msg || `code ${j.code}`}`);
    return j.data;
  }
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full, or private */ } },
  };

  // The room's streamer and their replays' series: {uid, sid} (kept: they don't change).
  async function owner(room) {
    const k = `vodOwner|${room}`, kept = store.get(k);
    if (kept?.uid && kept?.sid) return kept;
    const info = await json(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${room}`);
    const uid = info.uid;
    const ss = await json(`https://api.bilibili.com/x/polymer/web-space/seasons_series_list?mid=${uid}&page_num=1&page_size=20`);
    const s = (ss?.items_lists?.series_list || []).find((x) => x.meta?.name === '直播回放');
    if (!s) throw new Error("the streamer's Bilibili space has no 直播回放 (replays off?)");
    const o = { uid, sid: s.meta.series_id };
    store.set(k, o);
    return o;
  }

  // Their replays back to `since` (unix s), newest first: [{bvid, title, live, slot, dur}]. Kept;
  // read again (from the newest, merged with what's kept) when what's kept doesn't reach back to
  // `since`, or is over 6 h old and `since` within a week of when it was read.
  async function replays({ uid, sid }, since) {
    const k = `vodList|${uid}`, t = Date.now() / 1000;
    const kept = store.get(k)?.sid === sid ? store.get(k) : null;
    const items = kept?.items || [];
    const oldest = items.reduce((a, r) => Math.min(a, r.slot ?? Infinity), Infinity);
    if (kept && (kept.done || oldest <= since) && (t - kept.at < 6 * 3600 || since < kept.at - 7 * 86400)) return items;
    const seen = new Set(items.map((r) => r.bvid));
    let done = false;
    for (let pn = 1; pn <= 30; pn++) {
      const d = await json(`https://api.bilibili.com/x/series/archives?mid=${uid}&series_id=${sid}&only_normal=true&sort=desc&pn=${pn}&ps=100`);
      const arcs = d?.archives || [];
      for (const a of arcs) {
        if (seen.has(a.bvid)) continue;
        seen.add(a.bvid);
        const p = parseTitle(a.title);
        items.push({ bvid: a.bvid, title: a.title, live: p?.live ?? a.title, slot: p?.slot ?? null, dur: a.duration });
      }
      done = !arcs.length || pn * 100 >= (d?.page?.total ?? 0);
      if (done || arcs.some((a) => (a.pubdate ?? Infinity) < since)) break;
    }
    items.sort((x, y) => (y.slot ?? 0) - (x.slot ?? 0));
    store.set(k, { at: t, sid, items, done: done || !!kept?.done });
    return items;
  }

  // A replay's pages and their sound: rep.pages [{page, cid, dur, init: [a, b], index: [a, b],
  // initInfo (FoneDemux.mp4Init's), urls, deadline, segs}] (dur from its sidx: the playlist's own
  // durations), rep.total, and its repeats if found before (rep.cuts, kept by replay).
  async function load(rep) {
    if (rep.pages?.length && rep.total) return rep;
    const list = await json(`https://api.bilibili.com/x/player/pagelist?bvid=${rep.bvid}`);
    const pages = [];
    for (const p of [...list].sort((a, b) => a.page - b.page)) {
      const pg = { page: p.page, cid: p.cid, dur: p.duration, mirror: 0 };
      await sound(rep, pg);
      const b = await range(pg, 0, pg.index[1]); // (the init segment and the index, at once)
      pg.initInfo = root.FoneDemux.mp4Init(b.subarray(0, pg.init[1] + 1));
      if (!pg.initInfo?.fmt) throw new Error("this replay's sound isn't AAC");
      pg.segs = sidx(b.subarray(pg.index[0]), pg.index[0]);
      pg.dur = pg.segs.reduce((s, x) => s + x.d, 0);
      pages.push(pg);
    }
    rep.pages = pages;
    rep.total = pages.reduce((s, pg) => s + pg.dur, 0);
    const cuts = store.get(`vodCuts|${rep.bvid}`);
    rep.cuts = Array.isArray(cuts?.cuts) ? cuts.cuts : [];
    // (joins: false, only repeats found ahead of playing so far: the joins' still to look for)
    rep.cutsDone = Array.isArray(cuts?.cuts) && cuts.joins !== false;
    return rep;
  }

  // The repeats of a replay: [{m, d}] on its m axis (assumed: where one is due but none was heard).
  // frames(i, t0, t1): page i's AAC frames ({t, data: ADTS}) from t0 to t1 s. Each page's start
  // repeats the previous page's end; within a page a fragment join is due every FRAG s after the
  // last (looked for JOIN_WIN s either side); one not heard (its copies the same silence) is taken
  // to be where it was due, as long as the others'.
  const FRAG = 1804.2, JOIN_WIN = 20, LAG = 196;
  async function findCuts(rep, frames) {
    const cuts = [], lags = [];
    const lag = () => (lags.length ? [...lags].sort((a, b) => a - b)[lags.length >> 1] : LAG);
    const raw = (fr) => fr.map((f) => f.data.subarray(7)); // (ADTS header off: the packet itself)
    let off = 0;
    for (let i = 0; i < rep.pages.length; i++) {
      const pg = rep.pages[i], pkt = 1024 / (pg.initInfo?.fmt?.rate || 48000);
      if (i > 0) {
        const prev = rep.pages[i - 1], a = await frames(i - 1, prev.dur - JOIN_WIN, prev.dur), b = await frames(i, 0, JOIN_WIN);
        const r = findRepeat(raw([...a, ...b]));
        if (r && r.e + 1 < a.length + b.length) {
          const k = r.e + 1;
          cuts.push({ m: k < a.length ? off - prev.dur + a[k].t : off + b[k - a.length].t, d: r.lag * pkt });
          lags.push(r.lag);
        } else cuts.push({ m: off, d: lag() * pkt, assumed: true });
      }
      for (let due = FRAG; due < pg.dur - 10;) {
        const fr = await frames(i, due - JOIN_WIN, due + JOIN_WIN);
        const r = fr.length ? findRepeat(raw(fr)) : null;
        let t = due;
        if (r && r.e + 1 < fr.length) {
          t = fr[r.e + 1].t;
          cuts.push({ m: off + t, d: r.lag * pkt });
          lags.push(r.lag);
        } else cuts.push({ m: off + t, d: lag() * pkt, assumed: true });
        due = t + FRAG;
      }
      off += pg.dur;
    }
    return cuts.map((c) => ({ ...c, m: Math.round(c.m * 1e4) / 1e4, d: Math.round(c.d * 1e4) / 1e4 }));
  }

  // Repeats anywhere, not just at the joins: Bilibili's recording now and then has a whole ~5 s
  // segment twice (the 2026 Japanese GP race's replay, page 1 at 1:25:42: the same 235 packets
  // again, the commentary heard twice and then 5 s late). Looked for ahead of where the replay
  // plays (offscreen.js), a window m0..m1 (its axis) at a time, within the page m0 is in: the cut
  // {m, d} of the repeat there, unless it's one of `known` (a join's, found before), else null.
  async function scanRepeat(rep, frames, m0, m1, known = []) {
    let off = 0, i = 0;
    while (i < rep.pages.length - 1 && m0 >= off + rep.pages[i].dur) off += rep.pages[i++].dur;
    const pg = rep.pages[i], pkt = 1024 / (pg.initInfo?.fmt?.rate || 48000);
    const fr = await frames(i, Math.max(0, m0 - off), Math.min(pg.dur, m1 - off));
    if (fr.length < 200) return null;
    const r = findRepeat(fr.map((f) => f.data.subarray(7)), { minLag: 40, maxLag: 640 });
    if (!r || r.e + 1 >= fr.length) return null;
    const m = off + fr[r.e + 1].t, d = r.lag * pkt;
    if (known.some((c) => m < c.m + c.d + 1 && m + d > c.m - 1)) return null;
    return { m: Math.round(m * 1e4) / 1e4, d: Math.round(d * 1e4) / 1e4, ahead: true };
  }

  // A page's sound (AAC-LC ~72 kbps: 30232; else whatever AAC there is): its URLs, signed for ~2 h
  // (deadline); other upos mirrors serve the same signed path.
  const MIRRORS = ['upos-sz-mirrorcosov.bilivideo.com', 'upos-sz-mirrorali.bilivideo.com', 'upos-sz-mirrorhw.bilivideo.com',
    'upos-sz-mirrorbd.bilivideo.com', 'upos-sz-mirrorcos.bilivideo.com', 'upos-sz-mirroraliov.bilivideo.com'];
  // pg.kind 'video': its picture instead (H.264, the tallest up to VIDEO_H; the streamer window's:
  // the streamer's stream is their timing screen, its small print wants 1080p).
  const VIDEO_H = 1080, AVC = 7;
  async function sound(rep, pg) {
    const d = await json(`https://api.bilibili.com/x/player/playurl?bvid=${rep.bvid}&cid=${pg.cid}&fnval=16&fnver=0&qn=0&try_look=1`);
    let a;
    if (pg.kind === 'video') {
      const vs = (d?.dash?.video || []).filter((x) => x.codecid === AVC && x.height <= VIDEO_H);
      a = vs.sort((x, y) => y.height - x.height || y.bandwidth - x.bandwidth)[0];
      if (!a) throw new Error('Bilibili gave no H.264 picture for this replay');
    } else {
      const as = d?.dash?.audio || [];
      a = as.find((x) => x.id === 30232) || as.find((x) => x.id === 30280) || as[0];
      if (!a) throw new Error('Bilibili gave no sound for this replay');
    }
    const base = a.baseUrl || a.base_url, backups = a.backupUrl || a.backup_url || [];
    const sb = a.segment_base || a.SegmentBase || {};
    const rng = (s) => String(s || '').split('-').map(Number);
    const urls = [base];
    let host = null;
    try { host = new URL(base).host; } catch { /* as given */ }
    if (host && /^upos-/.test(host)) for (const h of MIRRORS) if (h !== host) urls.push(base.replace(host, h));
    urls.push(...backups.filter((u) => !urls.includes(u)));
    const dl = Number(new URL(base).searchParams.get('deadline')) || Date.now() / 1000 + 3600;
    Object.assign(pg, { urls, deadline: dl, init: rng(sb.initialization || sb.Initialization), index: rng(sb.index_range || sb.indexRange), codecs: a.codecs });
    if (!(pg.init[1] >= 0) || !(pg.index[1] > pg.index[0])) throw new Error("Bilibili's sound for this replay has no index");
  }

  // A page's URL to fetch from now: asked again near its deadline.
  async function urlOf(rep, pg) {
    if (Date.now() / 1000 > pg.deadline - 600) await sound(rep, pg);
    return pg.urls[pg.mirror % pg.urls.length];
  }
  const failed = (pg) => { pg.mirror++; };

  // Bytes a..b (inclusive) of a page's sound, from the mirror that last worked (the next on a failure).
  async function range(pg, a, b, rep = null) {
    let err = null;
    for (let k = 0; k < Math.min(4, pg.urls.length + 1); k++) {
      const u = rep ? await urlOf(rep, pg) : pg.urls[pg.mirror % pg.urls.length];
      try {
        const r = await fetch(u, { credentials: 'omit', headers: { Range: `bytes=${a}-${b}` }, signal: AbortSignal.timeout(20000) });
        if (r.status === 403) pg.deadline = 0; // (its signature refused: asked again before the next try)
        if (r.status !== 206 && r.status !== 200) throw new Error(`HTTP ${r.status}`);
        const buf = new Uint8Array(await r.arrayBuffer());
        return r.status === 200 ? buf.subarray(a, b + 1) : buf;
      } catch (e) {
        err = e;
        failed(pg);
      }
    }
    throw new Error(`Bilibili's sound: ${err?.message || err}`);
  }

  // A replay page's danmaku (the live chat Bilibili put on it: x/v1/dm/list.so, XML, each <d p=
  // "progress,mode,size,colour,sent,pool,uid hash,id,…">): [{p (s into the page), m, s, c, u, x}].
  const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  const unescapeXml = (t) => t.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, e) => (e[0] === '#'
    ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e] ?? all));
  function parseDanmaku(xml) {
    const out = [];
    for (const m of String(xml || '').matchAll(/<d p="([^"]+)">([\s\S]*?)<\/d>/g)) {
      const f = m[1].split(',');
      const p = Number(f[0]);
      if (!Number.isFinite(p)) continue;
      out.push({ p, m: Number(f[1]) || 1, s: Number(f[2]) || 25, c: Number(f[3]) || 0xffffff, u: f[6] || '', x: unescapeXml(m[2]) });
    }
    return out.sort((a, b) => a.p - b.p);
  }
  async function danmaku(cid) {
    const r = await fetch(`https://api.bilibili.com/x/v1/dm/list.so?oid=${cid}`, { credentials: 'omit', signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`Bilibili's danmaku: HTTP ${r.status}`);
    return parseDanmaku(await r.text());
  }

  // A replay's picture, for the streamer window: {bvid, pages [{page, cid, dur, init, segs, urls, …}],
  // offs (each page's start on the replay's m axis, its sound's: the engine's clock)}.
  async function loadVideo(bvid) {
    const list = await json(`https://api.bilibili.com/x/player/pagelist?bvid=${bvid}`);
    const rep = { bvid, pages: [] };
    for (const p of [...list].sort((a, b) => a.page - b.page)) {
      const pg = { page: p.page, cid: p.cid, dur: p.duration, mirror: 0, kind: 'video' };
      await sound(rep, pg);
      const b = await range(pg, pg.index[0], pg.index[1]);
      pg.segs = sidx(b, pg.index[0]);
      pg.dur = pg.segs.reduce((s, x) => s + x.d, 0);
      rep.pages.push(pg);
    }
    return rep;
  }

  root.FoneVod = { parseTitle, parseDanmaku, danmaku, loadVideo, candidates, sidx, segRange, hash, findRepeat, findCuts, timeline, contentAt, playlist, searchPlan,
    owner, replays, load, sound, urlOf, range, failed, store, FRAG, scanRepeat };
})(typeof globalThis !== 'undefined' ? globalThis : this);
