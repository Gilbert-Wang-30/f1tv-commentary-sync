// The in-browser recorder's buffer (recorder.js fills it, localplayer.js plays from it, the
// engine steers by it): the commentary's audio as received, on one continuous position axis m
// (seconds since this recording started), the role the server's playlist position plays.
// Holes (a dropped connection, a missed segment) hold silence, so a moment of the stream
// always sits at the same m and the live lock (offscreen.js) keeps holding across them.
// Pure, shared with the Node tests (localcore.test.js).
(function (root) {
  'use strict';

  const D = root.FoneDemux;

  const CHUNK = 0.5; // s of audio per stored chunk (the player appends whole chunks)
  // s: a source timestamp this close to the expected one is continuous on the same connection
  // (timestamps that jitter); a new one's must be within half a frame (its burst repeats ours)
  const TOL = 0.1;
  // A reconnect is placed by its own timestamps when they are the old connection's timeline (the
  // recorder says so: `tl`, the same stream on the same protocol, timestamps that run on across
  // connections) and continue it: ahead by at most the time it was away (plus slack), behind by
  // at most a burst (a CDN's cached seconds; the recorder resumes HLS where it left off). Anything
  // else (FLV that starts each connection at 0, a new rendition, the streamer starting a new
  // stream whose timestamps start again) is placed by arrival.
  const BURST = 15, AHEAD = 5;
  const JUMP = 60; // s: a jump this big on one connection is the stream restarting
  // s: a connection placed by arrival waits this long, to be out of its burst (the CDN's cached
  // seconds come within a few hundred ms of connecting; what follows is real time)
  const SETTLE = 1.5;
  const EDGE_WINDOW = 60; // s of arrivals the live edge is judged by

  function newBuffer(keep) {
    return {
      keep, // s of audio kept behind the newest
      gen: 0, // bumped when the audio format changes (the player starts over)
      fmt: null, // {rate, ch, sri, profile} of the audio
      chunks: [], // [{m, d, data, n}], in order and contiguous
      open: null, // the chunk being filled {m, d, frames}
      end: 0, // m where the next frame goes
      conn: null, // the connection the last frame came from
      tl: null, // its timeline (the recorder's key; null: its timestamps are its own only)
      next: null, // the source timestamp expected next on it
      tOff: null, // m - source timestamp on it (its video goes on the same axis: tOffset)
      lastAt: null, // when the newest audio arrived
      pend: null, // a connection waiting to be placed by arrival {conn, since, list: [{at, frames}]}
      arr: [], // [[at, at - m end]] per batch: how fresh the audio is, for the live edge
      offset: null, // the live edge's offset (the freshest of arr; kept while nothing arrives)
      received: 0, dropped: 0, filled: 0, bytes: 0, // frames in, frames dropped as repeats, s of silence
    };
  }

  const durOf = (f) => f.samples / f.rate;

  function fmtOf(f) {
    const h = D.adtsAt(f.data, 0);
    return h ? { rate: h.rate, ch: h.ch, sri: h.sri, profile: h.profile } : null;
  }

  function closeOpen(B) {
    const o = B.open;
    if (!o) return;
    const data = D.concat(...o.frames);
    B.chunks.push({ m: o.m, d: o.d, data, n: o.frames.length });
    B.bytes += data.length;
    B.open = null;
  }

  function append(B, data, dur) {
    if (!B.open) B.open = { m: B.end, d: 0, frames: [] };
    B.open.frames.push(data);
    B.open.d += dur;
    B.end += dur;
    if (B.open.d >= CHUNK - 1e-9) closeOpen(B);
  }

  // Silence up to m (the frame grid stays the audio's own: whole frames, rounded).
  function fillTo(B, m) {
    const gap = m - B.end;
    if (!(gap > 0) || !B.fmt) return;
    if (gap > B.keep) { // longer than the buffer: start over there, nothing old is kept anyway
      closeOpen(B);
      B.chunks = [];
      B.bytes = 0;
      B.end = m;
      return;
    }
    const sil = D.silentFrame(B.fmt);
    const dur = 1024 / B.fmt.rate;
    const n = Math.round(gap / dur);
    if (!sil) { closeOpen(B); B.chunks = []; B.bytes = 0; B.end = m; return; } // no silent frame for this layout
    for (let k = 0; k < n; k++) append(B, sil, dur);
    B.filled += n * dur;
  }

  function evict(B) {
    const from = B.end - B.keep;
    let k = 0;
    while (k < B.chunks.length && B.chunks[k].m + B.chunks[k].d < from) { B.bytes -= B.chunks[k].data.length; k++; }
    if (k) B.chunks.splice(0, k);
  }

  function sample(B, at) {
    B.lastAt = at;
    B.arr.push([at, at - B.end]);
    while (B.arr.length && at - B.arr[0][0] > EDGE_WINDOW) B.arr.shift();
    B.offset = Math.min(...B.arr.map((a) => a[1]));
  }

  // Frames of one connection that can't be placed by their timestamps: wait until it is past its
  // burst, then put its freshest audio exactly as fresh as the old connection's was (the
  // stream's latency doesn't change because the connection did), dropping what overlaps and
  // filling what's missing.
  function settle(B, now) {
    const P = B.pend;
    if (!P || now - P.since < SETTLE) return;
    B.pend = null;
    let rel = 0, minA = Infinity;
    for (const b of P.list) {
      for (const f of b.frames) rel += durOf(f);
      minA = Math.min(minA, b.at - rel);
    }
    const m0 = B.offset != null ? minA - B.offset : B.end;
    fillTo(B, m0);
    let skip = B.end - m0;
    let last = null;
    for (const b of P.list) {
      for (const f of b.frames) {
        const d = durOf(f);
        last = f;
        if (skip > d / 2) { skip -= d; B.dropped++; continue; }
        if (f.t != null) B.tOff = B.end - f.t;
        append(B, f.data, d);
      }
      sample(B, b.at);
    }
    B.conn = P.conn;
    B.tl = P.tl;
    B.next = last && last.t != null ? last.t + durOf(last) : null;
    evict(B);
  }

  // Frames that arrived at `at` (s, wall clock) on connection `conn` (any value; a new one
  // when the recorder reconnects or the stream has a discontinuity), whose timestamps are on
  // timeline `tl` (a key: equal keys, comparable timestamps; null: this connection's only).
  function push(B, frames, { conn, at, tl = null }) {
    if (!frames.length) return;
    settle(B, at);
    const fmt = fmtOf(frames[0]);
    if (!fmt) return;
    if (B.fmt && (fmt.rate !== B.fmt.rate || fmt.ch !== B.fmt.ch)) { // new audio format: the player starts over
      closeOpen(B);
      B.chunks = [];
      B.bytes = 0;
      B.pend = null;
      B.gen++;
    }
    B.fmt = fmt;
    if (B.pend) {
      if (B.pend.conn === conn) { B.pend.list.push({ at, frames }); return void settle(B, at); }
      B.pend = null; // it went away before it settled: at most a burst lost
    }
    B.received += frames.length;
    const first = B.conn == null && !B.chunks.length && !B.open;
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      const d = durOf(f);
      const same = conn === B.conn;
      let place = first || (same && (f.t == null || B.next == null));
      if (!place && f.t != null && B.next != null) {
        const gap = f.t - B.next;
        const away = B.lastAt != null ? Math.max(0, at - B.lastAt) : 0;
        place = same ? Math.abs(gap) < JUMP : tl != null && tl === B.tl && gap > -BURST && gap < away + AHEAD;
        const tol = same ? TOL : d / 2;
        if (place && gap < -tol) { B.dropped++; continue; } // a repeat: already have it
        if (place && gap > tol) fillTo(B, B.end + gap); // a hole: silence
      }
      if (!place) { // place the rest by arrival, once it settles
        B.pend = { conn, tl, since: at, list: [{ at, frames: frames.slice(i) }] };
        break;
      }
      if (f.t != null) B.tOff = B.end - f.t;
      append(B, f.data, d);
      B.conn = conn;
      B.tl = tl;
      B.next = f.t != null ? f.t + d : null;
    }
    if (!B.pend) sample(B, at);
    evict(B);
  }

  // The live edge at `now`: the m arriving now, judged by the freshest arrivals of the last
  // minute (HLS segments arrive in bursts, FLV in a stream; this is steady for both). null
  // before any audio.
  function liveEdge(B, now) {
    settle(B, now);
    return B.offset == null ? null : now - B.offset;
  }

  // The newest m a player can have (whole chunks).
  function playableEnd(B) {
    const c = B.chunks[B.chunks.length - 1];
    return c ? c.m + c.d : null;
  }

  // The index of the chunk holding m (-1: before the buffer, chunks.length: after it).
  function chunkAt(B, m) {
    const cs = B.chunks;
    if (!cs.length || m < cs[0].m) return -1;
    let lo = 0, hi = cs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (cs[mid].m <= m) lo = mid; else hi = mid - 1;
    }
    return m < cs[lo].m + cs[lo].d ? lo : cs.length;
  }

  // The engine's timeline (as the server's /api/timeline answers it): one piece from the
  // oldest audio kept to the newest, w being when that audio arrived here.
  function timeline(B, now) {
    settle(B, now);
    const c0 = B.chunks[0];
    const to = playableEnd(B);
    const base = { local: true, live: true, complete: false, receivedAt: now, mutes: [], edge: null, playlist: null };
    if (!c0) return { ...base, pieces: [], files: [] };
    const off = B.offset ?? 0;
    return {
      ...base,
      pieces: [{ w: c0.m + off, m: c0.m, d: to - c0.m, f: 0 }],
      files: [{ id: 'local', inPlaylist: true, growing: true, wallStart: c0.m + off, wallEnd: to + off, duration: to - c0.m }],
    };
  }

  // For the panel: seconds kept, bitrate of what's kept.
  function stats(B) {
    const c0 = B.chunks[0], to = playableEnd(B);
    const kept = c0 ? to - c0.m : 0;
    return { kept, kbps: kept > 0 ? Math.round((B.bytes * 8) / kept / 1000) : null, filled: Math.round(B.filled), dropped: B.dropped, fmt: B.fmt };
  }

  // m - source timestamp for connection `conn`'s stream, once its audio is placed (null while it
  // waits to be placed by arrival, or for any other connection): its video goes on the same axis.
  const tOffset = (B, conn) => (B && B.conn === conn && !(B.pend && B.pend.conn === conn) ? B.tOff : null);

  root.FoneLocal = { newBuffer, push, liveEdge, playableEnd, chunkAt, timeline, stats, tOffset, CHUNK, SETTLE, EDGE_WINDOW };
})(typeof globalThis !== 'undefined' ? globalThis : this);
