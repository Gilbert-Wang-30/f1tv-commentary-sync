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
  // The position whose content time is c (contentAt's inverse).
  function atContent(rep, c) {
    let m = c;
    for (const x of [...(rep.cuts || [])].sort((a, b) => a.m - b.m)) {
      if (x.m >= m) break;
      m += x.d;
    }
    return m;
  }

  // ---- placing by sound over several looks -----------------------------------------------------
  // A look that isn't sure (F1 TV's sound faint in the stream: the streamer talking over it, a
  // quiet stretch of the race, F1 TV's Track FX against the feed the streamer passes on) still
  // has likely places: its strongest few (`weak` and up, `top` of them; the strongest `max` kept).
  // Each is checked against F1 TV's sound heard since: at least `fresh` s of it from outside the
  // stretch of picture whose sound found it (the same sound would find the same place again
  // whether or not it's the place; heard again after a seek back, too), after it or before it,
  // looked for where that place says it is now (`near` s either side). Found there again (within
  // `agree` s, `need` high, and `ratio` over the best elsewhere around it: a stretch of the stream
  // that's like anything has peaks all over it): this moment is there. One checked `drop` times
  // without is let go. (A hit marked `sure`: a sure match the clock refused, kept as such.)
  function keepLikely(cands, hits, look, L, { weak = 7, top = 3, max = 8 } = {}) {
    const got = [];
    for (const h of [...hits].sort((a, b) => b.score - a.score)) {
      if (h.score < weak || got.length >= top) break;
      if (!got.some((o) => o.rep === h.rep && Math.abs(o.m - h.m) < 1)) got.push(h);
    }
    for (const h of got) cands.push({ rep: h.rep, m: h.m, score: h.score, look, E: L.E, pa: L.pa, pb: L.pb, run: L.run, fails: 0, ...(h.sure ? { sure: true } : {}) });
    while (cands.length > max) cands.splice(cands.indexOf(cands.reduce((a, b) => (b.score < a.score ? b : a))), 1);
    return got.length;
  }
  // A sure match kept (keepLikely's, `sure`) that another puts at the same place: replay rep
  // placed at T0 (its first sample's wall time, the delay at D0), within `agree` s. Null: none.
  const foundAgain = (cands, rep, T0, { D0, agree }) => cands.find((c) => c.sure && c.rep === rep && Math.abs(c.E + D0 - contentAt(rep, c.m) - T0) <= agree) || null;
  // L: this look's sound {q (at sr), pa..pb (the picture's), E (the event at pa), run}; read(rep,
  // a, len): the replay's sound over a..a+len at sr {m0, y} (or more of it), null if it can't.
  // {hit: {cand, m (where the fresh sound starts in the replay), E (its event), score, d}, checked}.
  async function checkLikely(cands, L, read, locate, { sr, near = 3, fresh = 12, agree = 0.3, need = 6.5, ratio = 1.3, drop = 10, pause = null } = {}) {
    const checked = [];
    let hit = null;
    for (const c of [...cands].sort((a, b) => b.score - a.score)) {
      // (the picture's own time, whatever the run: the longer of what's after and before that stretch)
      const b0 = Math.max(L.pa, c.pb), a1 = Math.min(L.pb, c.pa);
      const [f0, f1] = L.pb - b0 >= a1 - L.pa ? [b0, L.pb] : [L.pa, a1];
      if (f1 - f0 < fresh) continue;
      const q = L.q.subarray(Math.round((f0 - L.pa) * sr), Math.round((f1 - L.pa) * sr)), Ef = L.E + (f0 - L.pa);
      const at = atContent(c.rep, contentAt(c.rep, c.m) + (Ef - c.E)), a = at - near, len = q.length / sr + 2 * near;
      const w = at - near >= 0 ? await read(c.rep, a, len) : null;
      const i0 = w ? Math.round((a - w.m0) * sr) : -1, i1 = i0 + Math.round(len * sr);
      if (!w || i0 < 0 || i1 > w.y.length) continue;
      const res = locate(q, w.y.subarray(i0, i1), sr);
      if (pause) await pause();
      if (!res) continue;
      const m = a + res.lag / sr, d = m - at;
      checked.push({ look: c.look, score: Math.round(res.score * 10) / 10, next: Math.round(res.next * 10) / 10, d: Math.round(d * 100) / 100 });
      if (!res.edge && Math.abs(d) <= agree && res.score >= need && res.score >= ratio * res.next) { hit = { cand: c, m, E: Ef, score: res.score, d }; break; }
      c.fails++;
    }
    for (let i = cands.length - 1; i >= 0; i--) if (cands[i].fails >= drop) cands.splice(i, 1);
    return { hit, checked };
  }

  // ---- the clock on the streamer's screen ------------------------------------------------------
  // A fone server reads it off their replay (vodclock.py): readings [{page, at, wall}], the event
  // time the streamer's screen showed `at` s into page `page`. Each puts the replay on the event
  // clock as a sound match does (T0, the wall time of its first sample, with the delay at D0;
  // SCREEN: their screen's clock runs that far ahead of the sound they pass on). The rules here;
  // asking the server and acting on them: offscreen.js's vodClock*.
  // dE: F1 TV's own event time that far after the screen's (0: as given). Their screen tells the
  // event time rightly; F1 TV's is exact on an exact anchor (MultiViewer's, the server's timing's,
  // MultiViewer's start time's), but only a guess on the pre-roll's (the schedule's), minutes off
  // now and then (the 2026 Japanese GP: 599 s), the clock's place as far off. Sound puts that
  // right (clockShift).

  // Whether F1 TV's anchor (its event time: the content's `anchor`) is only a guess: any but the
  // server's exact ones (f1.py: MultiViewer's start dated by F1's archive, by the server's timing
  // or by MultiViewer's own start time), so the pre-roll's, or none. The same set as the clock's,
  // FoneCore.exactAnchor: a replay on the exact clock never has its anchor taken for a guess here.
  const EXACT_ANCHORS = new Set(['multiviewer', 'timing', 'pdt']);
  const anchorGuessed = (anchor) => !EXACT_ANCHORS.has(anchor);

  // Where page `page` starts on the replay's m axis (null: no such page).
  function pageStart(rep, page) {
    let off = 0;
    for (const pg of rep.pages || []) { if (pg.page === page) return off; off += pg.dur; }
    return null;
  }
  // T0 by one reading (null: not on this replay's pages).
  function readingT0(rep, rd, { D0, SCREEN, dE = 0 }) {
    const p0 = pageStart(rep, rd.page);
    return p0 == null ? null : rd.wall + dE + D0 - contentAt(rep, p0 + rd.at) - SCREEN;
  }
  // The replay that holds event time E by its clock, and where: {r, T0, d (s from the reading)},
  // by the reading nearest E (the streamer's own delay moves now and then). o: {D0, SCREEN, dE}.
  function clockAt(reps, E, { D0, SCREEN, dE = 0 }) {
    let best = null;
    for (const r of reps) {
      if (r.clock?.status !== 'ok') continue;
      for (const rd of r.clock.readings || []) {
        const T0 = readingT0(r, rd, { D0, SCREEN, dE });
        if (T0 == null) continue;
        const c = E + D0 - T0; // (E's place in this replay's content, by this reading)
        if (c < 0 || c > contentAt(r, r.total)) continue;
        const d = Math.abs(rd.wall + dE - E);
        if (!best || d < best.d) best = { r, T0, d };
      }
    }
    return best;
  }
  // The dE (s) that puts replay rep's clock where sound found it (at T0, for event time E): by its
  // reading nearest E so put right. Null: no reading on it to put it right by. o: {D0, SCREEN}.
  function clockShift(rep, T0, E, { D0, SCREEN }) {
    let best = null;
    for (const rd of rep.clock?.status === 'ok' ? rep.clock.readings || [] : []) {
      const t0 = readingT0(rep, rd, { D0, SCREEN });
      if (t0 == null) continue;
      const dE = T0 - t0, d = Math.abs(rd.wall + dE - E);
      if (!best || d < best.d) best = { dE, d };
    }
    return best ? best.dE : null;
  }
  // The dE kept for a video ({dE, p0 (its anchor then)}) on the anchor it has now: moved with p0
  // as F1 TV's event time is (keptOn's); 0 on an exact one (`guessed` false), or none kept.
  const shiftOn = (k, p0, guessed) => (!guessed || !Number.isFinite(k?.dE) ? 0
    : k.dE + (Number.isFinite(k.p0) && Number.isFinite(p0) ? p0 - k.p0 : 0));
  // The clock may still come, `waited` s on: a replay not asked about yet, or being read, for
  // `wait` s at most. (`can` false: it can't be asked, a video with no session key, F1 Academy,
  // F2, F3: nothing to wait for.)
  const clockPending = (reps, waited, { can = true, wait }) => can && waited < wait && reps.some((r) => !r.clock || r.clock.status === 'working');
  // The replays to ask the server about at t: while it reads (every `poll` s), after an error
  // (`retry` s on), and with readings but none within `near` s of E (every `again` s).
  function clockAsks(reps, E, t, { poll, again, near, retry = 30, dE = 0 }) {
    return reps.filter((r) => {
      const c = r.clock;
      if (!c || c.status === 'working' || c.more) return t - (c?.askedAt || 0) >= poll;
      if (c.status === 'error') return t - c.askedAt >= retry;
      if (c.status !== 'ok' || E == null) return false;
      return !(c.readings || []).some((rd) => Math.abs(rd.wall + dE - E) < near) && t - (c.askedAt || 0) >= again;
    });
  }
  // How far replay `rep` placed at T0, playing at `delay`, is from where the clock (k, clockAt's)
  // says, in s: Infinity when it says another replay holds the moment; null, nothing to compare.
  const clockOff = (k, rep, T0, delay, D0) => (!k || !rep ? null : k.r !== rep ? Infinity : Math.abs((T0 - delay) - (k.T0 - D0)));
  // How far from the clock's place a reading lets it be: `trust` from one within `near` s of the
  // moment, `bound` from one further away (the streamer's delay may have moved since).
  const clockRoom = (k, { near, trust, bound }) => (k.d <= near ? trust : bound);
  // What the clock does about where the replay plays (off: clockOff's), each tick: 'move' (placed
  // where it says), 'stay', and with sync by sound locked (`lock`: its target) on a place a reading
  // near the moment disagrees with: 'check' (sound asked to look again, widely: FoneVod.clockCheck),
  // 'wait' (it's looking), 'held' (it found its lock again: the streamer's delay stepped since the
  // reading). `check`: {T0 (the clock's place it's for), target (the lock), says}, for this reading
  // and lock when within `same` s of both. Not placed yet, more than `bound` off, or a near reading
  // more than its room off without a lock, or one `reach` s off (more than sound's wide look sees
  // either side: no step it followed from the clock's place; a kept place or an hour-wide match
  // gone wrong), or a look again that didn't find the lock: 'move'. Off by its room or less
  // (`trust` s from a near reading, `bound` from a further one): 'stay', sound has it. (Re-placed
  // by the reading every tick while sound found its own place every look: the commentary jumped
  // back and forth.)
  function clockRule(k, off, { placed, lock = null, check = null, near, trust, bound, reach = Infinity, same = 1 }) {
    if (!k) return 'stay';
    if (!placed) return 'move';
    if (!(off > clockRoom(k, { near, trust, bound }))) return 'stay';
    if (lock == null || off > Math.min(reach, bound)) return 'move';
    const c = check && Math.abs(check.T0 - k.T0) <= same && Math.abs(check.target - lock) <= same ? check : null;
    if (!c) return 'check';
    return c.says === 'confirmed' ? 'held' : c.says === 'refuted' ? 'move' : 'wait';
  }
  // A look again under way (chk: {at (asked), looks, seen (the last look counted), says}), a step:
  // `last`, sync by sound's latest look ({at, val, sure, wide}); lock: {target, bias}. A wide look
  // since: sure where the lock is (within `agree` s): 'confirmed'; sure elsewhere, or `tries`
  // looks not sure: 'refuted'; none that says in `wait` s (F1 TV silent, paused): 'refuted'.
  function clockCheck(chk, last, { target, bias = 0 }, t, { tries = 3, wait = 120, agree = 1 } = {}) {
    if (chk.says) return chk;
    let c = chk;
    if (last && last.wide && last.at > c.at && last.at !== c.seen) {
      c = { ...c, seen: last.at, looks: (c.looks || 0) + 1 };
      if (last.sure && last.val != null && target != null && Math.abs(last.val + bias - target) <= agree) return { ...c, says: 'confirmed' };
      if (last.sure || c.looks >= tries) return { ...c, says: 'refuted' };
    }
    return t - c.at > wait ? { ...c, says: 'refuted' } : c;
  }
  // The look again's own clock: it stands still while F1 TV isn't playing at 1× (paused, seeking,
  // another speed), since sound looks at nothing then; a pause past `wait` refuted a right lock,
  // and the clock moved the commentary only for sound to put it back. chk.still: s it stood still
  // before, chk.stillAt: since when it stands still. [the check, the t to give clockCheck].
  function checkClock(chk, playing, t) {
    let c = chk;
    if (!playing && c.stillAt == null) c = { ...c, stillAt: t };
    else if (playing && c.stillAt != null) c = { ...c, still: (c.still || 0) + t - c.stillAt, stillAt: null };
    return [c, t - (c.still || 0) - (c.stillAt != null ? t - c.stillAt : 0)];
  }
  // Where the clock puts it (k: clockAt's): its replay at its T0 with the delay at D0; your nudges
  // (`hand`) kept on top when it's the replay playing (`cur`), none on another.
  function clockPlace(k, cur, hand, D0) {
    const h = cur === k.r ? Number(hand) || 0 : 0;
    return { rep: k.r, T0: k.T0, delay: D0 + h, hand: h };
  }
  // A place found by sound (rep at T0) the clock refuses: another replay, or more than `room` s
  // from where it says.
  const clockVeto = (k, rep, T0, room) => !!k && (k.r !== rep || Math.abs(T0 - k.T0) > room);

  // ---- where it was put before -----------------------------------------------------------------
  // A place kept for this video ({T0, delay, p0, hand, at}) on the anchor F1 TV's picture has now:
  // T0 is on the event clock the picture was put on then (E = p0 + p); p0 since refined (the
  // pre-roll's guess, MultiViewer's exact one later) moves it as much, so the picture's moment
  // in the replay stays where it was found. (One kept before p0 was: as it is.) Null: none.
  function keptOn(k, p0) {
    if (!k || !Number.isFinite(k.T0) || !Number.isFinite(k.delay)) return null;
    const dp = Number.isFinite(k.p0) && Number.isFinite(p0) ? p0 - k.p0 : 0;
    return { T0: k.T0 + dp, delay: k.delay, hand: Number(k.hand) || 0, at: k.at || 0 };
  }

  // ---- placing it, and trying again (offscreen.js's vodPlace, vodTick, vodLoad*, vodScan) --------

  // The delay a placement plays at, and the nudges in it (`hand`: what the clock's place leaves
  // out, clockOff): found by sound, `delay` with the nudge kept for the replay's sound (`bias`) on
  // top; else as given, with the nudges it carries.
  const round3 = (v) => Math.round(v * 1000) / 1000;
  const placing = (how, delay, hand, bias) => (how === 'sound' ? { delay: round3(delay + (bias || 0)), hand: bias || 0 } : { delay: round3(delay), hand: hand || 0 });
  // Whether what sync by sound found is dropped on a placement ({rep, T0, delay}) after `was` (the
  // one before, null: none): a lock on the old place, or a delay this one overrules. Kept only when
  // it's the same replay, at the same T0, playing within 1 s of the same delay.
  const placeResets = (was, now) => !(was && was.rep === now.rep && Math.abs(was.T0 - now.T0) < 1e-3 && Math.abs(was.delay - now.delay) < 1);
  // Placed, whether to look for the moment over the hour again: not placed by the clock (it says
  // where; unless F1 TV's anchor is only a guess, `guessed`: then it's as far off) and sync by
  // sound not locked, `since` s since the last look and the placement (`first` the first time,
  // `again` after); sound's own looks not finding it in `confirm` of them since (listening), or
  // the moment outside a place kept from before (no sound looks there).
  function recheckDue({ how, locked, since, rechecks, looks, listening, outside, guessed = false }, { first = 60, again, confirm }) {
    if ((how === 'clock' && !guessed) || locked || !(since >= (rechecks ? again : first))) return false;
    return outside ? how === 'kept' : looks >= confirm && listening;
  }
  // The wait before trying again after a failure: `first` s, twice the last one each time, `max` at most.
  const backoff = (wait, first, max) => Math.min(max, wait ? 2 * wait : first);

  // ---- which of the streamer's replays ---------------------------------------------------------
  // What's known of where a replay is, for event time E: where it was put before for this video
  // (kk: keptOn's), else by its clock's reading nearest E, at the delay D0. {T0, delay} or null.
  function placeOf(rep, E, kk, o) {
    if (kk) return { T0: kk.T0, delay: kk.delay };
    let best = null;
    for (const rd of rep.clock?.status === 'ok' ? rep.clock.readings || [] : []) {
      const T0 = readingT0(rep, rd, o), d = Math.abs(rd.wall + (o.dE || 0) - E);
      if (T0 != null && !(best && best.d <= d)) best = { T0, delay: o.D0, d };
    }
    return best && { T0: best.T0, delay: best.delay };
  }
  // E's place in replay rep's content placed so ({T0, delay}): null outside it.
  const contentOf = (rep, E, p) => { const c = E + p.delay - p.T0; return c >= 0 && c < contentAt(rep, rep.total) ? c : null; };
  // The replay that holds event time E by what's known: {rep, T0, delay, hand, how ('kept' |
  // 'clock')} or null. The clock says which replay; where it was put before, to the sample, is
  // taken when it's that one. kept(rep): keptOn's for it; o: {D0, SCREEN}.
  function holder(reps, E, kept, o) {
    const k = clockAt(reps, E, o);
    if (k) {
      const kk = kept(k.r);
      if (kk && contentOf(k.r, E, kk) != null) return { rep: k.r, T0: kk.T0, delay: kk.delay, hand: kk.hand || 0, how: 'kept' };
      if (contentOf(k.r, E, { T0: k.T0, delay: o.D0 }) != null) return { rep: k.r, T0: k.T0, delay: o.D0, hand: 0, how: 'clock' };
    }
    for (const r of reps) {
      const kk = kept(r);
      if (kk && contentOf(r, E, kk) != null) return { rep: r, T0: kk.T0, delay: kk.delay, hand: kk.hand || 0, how: 'kept' };
    }
    return null;
  }
  // The moment off the end of the replay playing (cur), or before its start (`state`, mapWall's):
  // {to}: the replay that holds it (holder's); else the next ones (previous ones) in turn, past
  // each known to end before it (start after it): {listen: rep}, the first nothing's known of
  // yet: found by sound or its clock; {gap: s, or null: till cur}: between two (the streamer off
  // air, or restarting), s till the later one; null: none further. Never to one known not to hold
  // it: each of two replays placed before put the moment in the other, swapped every tick.
  function outside(reps, cur, E, state, kept, o) {
    const h = holder(reps, E, kept, o);
    if (h) return h.rep !== cur ? { to: h } : null;
    const i = reps.indexOf(cur), step = state === 'after' ? 1 : state === 'before' ? -1 : 0;
    if (i < 0 || !step) return null;
    let wait = null; // (going back: till the one after the one looked at; cur's, map.wait)
    for (let j = i + step; j >= 0 && j < reps.length; j += step) {
      const nb = reps[j], p = placeOf(nb, E, kept(nb), o);
      if (!p) return { listen: nb };
      const c = E + p.delay - p.T0; // (the moment on its content)
      const past = c >= contentAt(nb, nb.total);
      if (step > 0 && c < 0) return { gap: -c };
      if (step < 0 && past) return { gap: wait };
      if (c >= 0 && !past) return null; // (in it after all: the clock's and sound's to say)
      wait = -c;
    }
    return null;
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
  // for the repeats), or all of it (`full`); nearest a middle guess first. (dmax: the streamer's
  // delay is 40-55 s; 600 let a lap replayed after a session match 10 minutes before the slot)
  // `wider`: s more either side, E only a guess (lookWider).
  function searchPlan(reps, E, { dmin = -120, dmax = 180, chunk = 200, win = 20, guess = 50, full = false, wider = 0 } = {}) {
    const out = [];
    for (const r of reps) {
      const lo = full ? 0 : Math.max(0, E + dmin - wider - (r.slot + 3600) - 60);
      const hi = full ? r.total : Math.min(r.total, E + dmax + wider - r.slot + 60 + win);
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

  // How much wider a look over the hour is (searchPlan's `wider`, s either side): placed by the
  // clock on the streamer's screen, or where it was put before (the clock's place, maybe), F1 TV's
  // anchor only a guess (`guessed`, anchorGuessed's: the pre-roll's), `wider`; else 0. The hour
  // is around F1 TV's event time, as far off as the guess is, the clock's place with it, and the
  // moment may lie past the hour's last stretch for all of the video: the 2026 Japanese GP's race
  // (F1 TV's guess 599 s before the screen's) had it at 3682 s into the replay, the hour's plan
  // ending at 3632 (and holding it on the screen's event time). A look over all of each replay
  // would find it, but placed the first is the sixth look again, ~50 min on (offscreen's vodFull).
  const lookWider = ({ placed, how, guessed }, wider) => (placed && guessed && (how === 'clock' || how === 'kept') ? wider : 0);

  // What a look's hit h stands out from: its own runner-up, or the best of the others (another
  // replay, or more than 1 s from it).
  const rivalOf = (hits, h) => Math.max(h.next, 0, ...hits.filter((o) => o !== h && (o.rep !== h.rep || Math.abs(o.m - h.m) > 1)).map((o) => o.score));
  // One look over a plan (searchPlan's), `par` stretches at once: look(ch) matches one, a hit
  // {rep, m, score, next} or null (a throw: none, the first error kept). Every stretch of the
  // hour (hour(ch): all of the hour's own plan) is looked at: stopped at the first match sure at
  // once (`sure`, `twice` its rival so far), it stopped on a repeat (F1's music beds, a stretch the
  // streamer showed again) at 15-44 in all 7 wrong places of a sweep over real replays, the place
  // itself 45-96 further on (2026-11). Past the hour's (a look over all of each replay): stopped
  // by one. gone(): moved on meanwhile, stopped. {hits, err}.
  async function lookOver(plan, look, { par = 3, hour = () => true, sure = 14, twice = 2, gone = () => false } = {}) {
    const hits = [];
    let k = 0, left = plan.filter(hour).length, stop = false, err = null;
    const worker = async () => {
      while (!stop && k < plan.length) {
        const ch = plan[k++];
        let h = null;
        try { h = await look(ch); } catch (e) { err = err || e; }
        if (gone()) { stop = true; return; }
        if (hour(ch)) left--;
        if (h) hits.push(h);
        if (left <= 0 && hits.some((x) => x.score >= sure && x.score >= twice * rivalOf(hits, x))) stop = true;
      }
    };
    await Promise.all(Array.from({ length: par }, worker));
    return { hits, err };
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

  // Whether the list kept ({at, items, done}) reaches back to replays from `since`.
  const listReaches = (kept, since) => !!kept && (!!kept.done || (kept.items || []).some((r) => r.slot != null && r.slot <= since));
  // Whether the list kept does for replays back to `since` at t: it reaches back that far, and
  // `since` is over a week before it was read (its replays long up), or it's under 6 h old; under
  // 10 min when it was read before `until` (the session so recent then that its replays may not
  // all have been published: one may be up since). Read after that, the session's are all in it,
  // whenever the streamer went live for it.
  function listDoes(kept, since, t, until = -Infinity) {
    if (!listReaches(kept, since)) return false;
    return since < kept.at - 7 * 86400 || t - kept.at < (kept.at < until ? 600 : 6 * 3600);
  }
  // Their replays back to `since` (unix s), newest first: {items: [{bvid, title, live, slot, dur}],
  // at (when the list was read)}. Kept; read again (from the newest, merged with what's kept) when
  // what's kept won't do (listDoes, `until`). Bilibili failing that (a 412, offline): what's kept,
  // when it reaches back that far (warn(e) told), else the error.
  async function replays({ uid, sid }, since, { until = -Infinity, warn = null } = {}) {
    const k = `vodList|${uid}`, t = Date.now() / 1000;
    const kept = store.get(k)?.sid === sid ? store.get(k) : null;
    const items = kept?.items || [];
    if (listDoes(kept, since, t, until)) return { items, at: kept.at };
    const seen = new Set(items.map((r) => r.bvid));
    let done = false;
    try {
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
    } catch (e) {
      if (!listReaches(kept, since)) throw e;
      if (warn) warn(e);
      return { items: items.sort((x, y) => (y.slot ?? 0) - (x.slot ?? 0)), at: kept.at };
    }
    items.sort((x, y) => (y.slot ?? 0) - (x.slot ?? 0));
    store.set(k, { at: t, sid, items, done: done || !!kept?.done });
    return { items, at: t };
  }
  // 'none' (no replay of the session in the list read at `listAt`, found so at `at`): looked for
  // again `every` s on while that list was read before `until` (one may have been published
  // since); never after: the list read then has them all.
  const noneAgain = ({ at, listAt }, t, until, every) => listAt != null && listAt < until && t - at >= every;

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

  root.FoneVod = { parseTitle, parseDanmaku, danmaku, loadVideo, candidates, sidx, segRange, hash, findRepeat, findCuts, timeline, contentAt, atContent,
    playlist, searchPlan, lookWider, rivalOf, lookOver, keepLikely, foundAgain, checkLikely, owner, replays, load, sound, urlOf, range, failed, store, FRAG, scanRepeat,
    pageStart, anchorGuessed, clockAt, clockShift, shiftOn, clockPending, clockAsks, clockOff, clockRoom, clockRule, clockCheck, checkClock, clockPlace, clockVeto, listDoes, noneAgain, keptOn,
    placing, placeResets, recheckDue, backoff, placeOf, holder, outside };
})(typeof globalThis !== 'undefined' ? globalThis : this);
