// Audio engine. Lives in an offscreen document so it isn't subject to the F1 TV
// page's mixed-content/CSP rules, and keeps playing while the tab is fullscreen.
'use strict';

const C = globalThis.FoneCore;
const audio = document.getElementById('a');

const S = {
  gen: 0,
  key: null, tab: null, cid: null, channel: null, channels: [],
  servers: [], base: null,
  // source 'local': no fone server for the commentary, the extension records the stream itself
  // (recorder.js); local = what it records, lplayer = its <audio> feed (localplayer.js)
  source: 'server', stream: null, local: null, lplayer: null,
  content: null, contentAt: 0, clock: null, clockFinal: false,
  delay: null, delaySource: null, saveTimer: null,
  manualBase: null,
  timeline: null, timelineAt: 0, timelineTimer: null,
  hls: null, playlist: null,
  video: null, volume: 1, muted: false,
  steer: C.newSteer(), resync: true, preSeekAt: 0, lastTarget: null, nominal: null,
  fixes: { seeks: [], rates: [], speeds: [], nSeeks: 0, nRates: 0, nSpeeds: 0 }, // audible corrections (Details, e2e)
  error: null, lastReport: 0, lastState: null,
  dashDelay: null, dashDelayAt: 0, dashAt: 0, // stats dashboard clock (dashClock)
};

const now = () => Date.now() / 1000;

// ---- server ------------------------------------------------------------------

async function pickServer(servers) {
  for (const base of servers) {
    try {
      const r = await fetch(base.replace(/\/$/, '') + '/api/health', { signal: AbortSignal.timeout(2000) });
      if (r.ok) return base.replace(/\/$/, '');
    } catch { /* try next */ }
  }
  throw new Error('fone server unreachable — check the extension options');
}

async function api(path, opts = {}) {
  const r = await fetch(S.base + path, { signal: AbortSignal.timeout(10000), ...opts });
  if (!r.ok) throw new Error(`${path.split('?')[0]} → HTTP ${r.status}`);
  return r.json();
}

// The PC's clock against the server's (kept by NTP). Live, F1 TV's clock on the picture is
// compared with the time now, so a PC clock a second off would put the stream recorded here a
// second off (the user's Windows clock ran ~1.1 s slow, 2026-10-25, by when its diagnostics
// reached the server). Measured over /api/health (its `now`): the quickest of a few round trips,
// again every 10 min; none without a server.
const SKEW = { EVERY: 600, TRIES: 3, MAX_RTT: 0.5 };
async function refreshSkew(gen) {
  S.skewAt = now();
  let best = null;
  for (let i = 0; i < SKEW.TRIES; i++) {
    try {
      const t0 = now(), r = await api('/api/health'), t1 = now();
      if (gen !== S.gen) return;
      if (Number.isFinite(r?.now) && t1 - t0 < SKEW.MAX_RTT && !(best && best.rtt <= t1 - t0)) best = { rtt: t1 - t0, skew: r.now - (t0 + t1) / 2 };
    } catch { /* again next time */ }
  }
  if (!best) return;
  if (S.skew == null || Math.abs(best.skew - S.skew) > 0.1) diag('skew', { skew: Math.round(best.skew * 1000) / 1000, rtt: Math.round(best.rtt * 1000) });
  S.skew = best.skew;
}
// the time now by the server's clock (this PC's, without one); and a wall time of the stream
// recorded here (this PC's clock: when it came in) on the server's, as a server's recording's are
const skewNow = () => (S.base ? S.skew ?? 0 : 0);
const trueNow = (t) => t + skewNow();

// ---- attach / detach -----------------------------------------------------------

function detach() {
  S.gen++;
  FoneLivePos.stop();
  clearTimeout(S.timelineTimer);
  if (S.hls) { S.hls.destroy(); S.hls = null; }
  if (S.lplayer) { S.lplayer.destroy(); S.lplayer = null; } // the recorder itself goes on (LINGER)
  S.local = null;
  S.base = null; // picked again on attach (the settings may list another, or none)
  audio.pause();
  audio.removeAttribute('src');
  Object.assign(S, { liveLock: null, minBehind: undefined, minLagW: undefined, synced: false, dashDelay: null, dashDelayAt: 0, dashAt: 0, lbuf: null, contentBusy: false,
    key: null, content: null, clock: null, clockFinal: false, delay: null, timeline: null, playlist: null,
    error: null, lastTarget: null, manualBase: null, steer: C.newSteer(), resync: true, nominal: null,
    direct: null, room: null, directErrAt: null, directBack: false, directOff: false, offArmed: false, offAt: null, recheckAt: 0, serverSync: null, serverTl: null, adSeenAt: null, carry: null, serverMutes: null, mutesAt: 0, mutesBusy: false,
    edgeStepAt: null, edgeMissAt: null, edgeSeenAt: null, flBest: undefined, upAges: [], upU: null, screen: null, clockAt: null });
}

async function attach(msg, key) {
  detach();
  const gen = S.gen;
  const local = msg.settings.source === 'local';
  Object.assign(S, { key, tab: msg.tab, cid: msg.cid, channel: msg.channel || null, servers: msg.settings.servers || [],
    source: local ? 'local' : 'server', stream: local ? String(msg.settings.stream || '').trim() : null });
  try {
    if (local) return await attachLocal(msg, gen);
    const base = await pickServer(S.servers);
    if (gen !== S.gen) return;
    S.base = base;
    if (S.skew == null || now() - (S.skewAt ?? 0) > SKEW.EVERY) refreshSkew(gen);
    S.channels = await api('/api/channels');
    if (!S.channel) S.channel = S.channels[0]?.name ?? null;
    if (!S.channel) throw new Error('No recordings found on the server yet');
    S.bufferMin = msg.settings.bufferMin;
    S.room = await directStream(S.channel); // (its live page, ↗; and live straight from it)
    S.direct = msg.settings.liveDirect === false ? null : S.room;
    if (gen !== S.gen) return;
    await loadContent(gen);
    if (gen !== S.gen) return;
    await refreshTimeline(gen);
  } catch (e) {
    if (gen === S.gen) S.error = e.message || String(e);
  }
}

// ---- without a server: the stream recorded here ---------------------------------------------
// The commentary is the streamer's live stream, recorded by this browser (recorder.js) while
// F1 TV is open, the last few minutes kept: live sessions only, edge to edge as with a server's
// recording, and rewinding F1 TV works as far back as the recording goes. A server listed in
// the settings is still used for what only it has (the stats, the diagnostics), if reachable.
async function attachLocal(msg, gen) {
  if (!S.stream) throw new Error("No stream set: open fone's settings (toolbar icon) and paste the streamer's live URL");
  S.local = true;
  S.bufferMin = msg.settings.bufferMin;
  S.channel = FoneStreams.parse(S.stream).label;
  S.channels = [];
  S.lplayer = FoneLocalPlayer.create(audio, () => FoneRecorder.buffer(S.stream));
  S.resync = true;
  wantRecording();
  const base = S.servers.length ? await pickServer(S.servers).catch(() => null) : null;
  if (gen !== S.gen) return;
  S.base = base;
  await loadContent(gen);
  if (gen !== S.gen) return;
  refreshLocal(gen);
}

// The stream is recorded while the video is live, or may be (the player hasn't said yet): not
// on a replay, which it can't play with (it would only cost the stream's bandwidth). With a
// server: while live plays from the stream, and while F1 TV is rewound into the server's
// recording from it (for the way back).
function wantRecording() {
  const url = S.local ? S.stream : S.directBack ? S.direct : null;
  if (url && (!S.clockFinal || S.clock === 'edge')) FoneRecorder.want(url, S.bufferMin);
}

function refreshLocal(gen) {
  clearTimeout(S.timelineTimer);
  if (gen !== S.gen || !S.local) return;
  const B = FoneRecorder.buffer(S.stream);
  // a fresh buffer (the recorder had stopped, or the stream changed): its positions are new ones
  if (B !== S.lbuf) { S.lbuf = B; S.liveLock = null; S.resync = true; }
  S.timeline = B ? FoneLocal.timeline(B, now()) : null;
  const rs = FoneRecorder.status();
  if (rs.url === S.stream) {
    if (S.source === 'local') S.channel = rs.name || rs.label; // (with a server: its channel's name stays)
    if (rs.state === 'recording') S.error = null; // (an interrupted play() left in it, say)
  }
  if (S.source === 'server' && directGivenUp(rs)) return goServer(gen, false, `the stream: ${rs.err || rs.text || rs.state}`);
  if (S.source === 'server' && S.base && !S.mutesBusy && now() - (S.mutesAt || 0) > MUTES_EVERY) refreshServerMutes(gen);
  if (S.content && !S.clockFinal) decideClock(gen).catch(() => {});
  else if (S.content && now() - S.contentAt > 600 && !S.contentBusy) {
    S.contentBusy = true;
    S.contentAt = now(); // next try in 10 min, answered or not
    loadContent(gen).catch(() => {}).finally(() => { S.contentBusy = false; });
  }
  S.timelineTimer = setTimeout(() => refreshLocal(gen), 500);
}

// ---- with a server, live: the commentary straight from the stream ---------------------------
// A fone server's recording of a live stream grows a recorder keyframe group at a time (4-6 s
// every ~5 s, measured 2026-10-23 on 胡闹P房's room), so the commentary must stay ~7 s behind it
// and its late groups held F1 TV back. The same stream pulled into the browser arrives
// continuously (as the Bilibili web player gets it): live, the engine plays that instead, recorded
// here as without a server, and the server goes on giving everything else (the content, the
// stats, the danmaku, the diagnostics, the sponsor clips it found). The channel's Bilibili room is
// the one the server listens to for its danmaku.
const DIRECT_GIVEUP = 20; // s of the stream not coming in here (from 2 s after its last audio) before the server's recording plays instead
const DIRECT_BACK = 10; // s: rewound into the server's recording, back once F1 TV is this far inside the stream's
const MUTES_EVERY = 1.5; // s between looks at the server's sponsor clips, live from the stream (they're known late)
async function directStream(channel) {
  try {
    const st = await api('/api/danmaku/status');
    const room = Object.entries(st.rooms || {}).find(([, r]) => r?.channel === channel)?.[0];
    return room && /^\d+$/.test(room) ? `https://live.bilibili.com/${room}` : null;
  } catch {
    return null; // a server without the danmaku service: the server's recording, as before
  }
}

// With a server, a stream this browser can't get (its CDN refusing, say, or its API, or a
// connection gone quiet) isn't worth more than the server's recording of it: back to that until
// the engine attaches again (another video or tab, a settings change). True once given up
// (S.direct cleared). Off air isn't failing: the server's recording is off air too.
function directGivenUp(rs) {
  if (!S.direct || rs.url !== S.direct) return false;
  const t = now(), quiet = !(rs.lastAt > t - 2);
  S.directErrAt = rs.state === 'offline' || rs.state === 'idle' || !quiet ? null : S.directErrAt ?? t;
  if (S.directErrAt == null || t - S.directErrAt < DIRECT_GIVEUP || rs.lastAt > t - DIRECT_GIVEUP) return false;
  diag('direct', { on: false, gaveUp: rs.err || rs.text || rs.state });
  Object.assign(S, { direct: null, directBack: false, directErrAt: null });
  return true;
}

function goDirect(gen) {
  if (S.local || !S.direct || gen !== S.gen) return;
  // back from a rewind: the server's lock, if carried there, is the exact moment (one made from
  // the server's edge, say by Re-sync, isn't: the stream locks from its own then, unless rewound)
  const carry = carryLock(S.directBack && !!S.liveLock?.carried) ?? (S.directBack && S.carry?.cid === S.cid ? S.carry : null);
  if (S.hls) { S.hls.destroy(); S.hls = null; }
  audio.removeAttribute('src');
  S.serverSync = { sync: S.sync, delay: S.delay, delaySource: S.delaySource }; // the server's recording's, for the way back
  Object.assign(S, { local: true, stream: S.direct, directBack: false, carry,
    playlist: null, liveLock: null, resync: true, lbuf: null, timeline: null });
  S.lplayer = FoneLocalPlayer.create(audio, () => FoneRecorder.buffer(S.stream));
  const sync = localSync();
  Object.assign(S, { sync, delay: sync.delay, delaySource: sync.source });
  wantRecording();
  diag('direct', { on: true, carry: !!carry });
  refreshLocal(gen);
}

// Back to the server's recording: the video is no longer live (a replay plays from it), the
// stream can't be had here, or (`back`) F1 TV was rewound past what this browser has recorded,
// and then the stream goes on being recorded and the commentary goes back to it once F1 TV is
// back within it (backInDirect).
function goServer(gen, back = false, why = null) {
  if (!S.local || S.source !== 'server' || gen !== S.gen) return;
  // (still live: the moment carries over, rewound; a clock change starts a new timeline)
  const carry = S.clock === 'edge' ? carryLock(back) : null;
  clearTimeout(S.timelineTimer);
  if (S.lplayer) { S.lplayer.destroy(); S.lplayer = null; } // the recorder stops by itself, once unwanted
  audio.pause();
  audio.removeAttribute('src');
  // still live: the server's recording's own delay (a new clock's is set already, decideClockOnce)
  if (S.clock === 'edge' && S.serverSync) Object.assign(S, S.serverSync);
  Object.assign(S, { local: null, stream: null, directBack: back, carry, liveLock: null, resync: true, lbuf: null, timeline: null, playlist: null });
  diag('direct', { on: false, why, carry: !!carry });
  refreshTimeline(gen);
}

// A switch between the server's recording and the stream recorded here while F1 TV is rewound:
// the moment playing (its wall time) carries over, so the commentary neither jumps nor loses the
// rewind (a lock from the edge knows a rewind only to within F1 TV's edge steps). At the live
// edge the new source locks from its own edge, at its own delay; `force`: whatever F1 TV's
// distance from its edge (a rewind's round trip, where the lock is the exact moment throughout).
function carryLock(force = false) {
  const L = S.liveLock, v = S.video;
  if (!L || L.cid !== S.cid || !v) return null;
  const t = now(), vn = C.videoNow(v, t);
  if (clockLost(t, vn)) return null; // (its moment can't be put on the picture now)
  if (!force && rewoundBy(t, vn) < 2 * EDGE_STEP) return null;
  const w = lockWall(L, vn);
  // (carried in the server's clock: the stream recorded here's walls are this PC's)
  return w == null ? null : { cid: S.cid, w: S.local ? w + skewNow() : w, p: vn.p, u: f1Clock(vn) };
}

// A live lock: the commentary at m0 + (p - p0), linear in F1 TV's position. On a server's
// recording that holds within one file, but its m runs on across files without the time between
// them (a streamer's reconnect: a gap; an overlap, clipped), so the lock also keeps its wall time
// (w0 at p0) and its file (f). The linear m stands while it's in that file, or past its end with
// that file still the newest (waiting at the live edge); anywhere else (another file, a clipped
// overlap, past a newer file's end) the moment is placed by its wall time: a gap is a gap
// (silence, F1 TV not held), the commentary in step with the picture after it. Within its file an
// edge lock's wall time follows the server's mapping as it firms up (a carried one's is the
// picture's own, from this browser's recording). Null in a gap (L.gap: how long until the audio).
// A lock whose moment came from a wall time (`wall`: carried, or placed across files) keeps
// that wall time instead, its m following the file's mapping when that moves (0.3 s or more).
function lockM(L, vn) {
  const m = L.m0 + (vn.p - L.p0);
  L.gap = null;
  if (S.local || L.w0 == null) return m;
  const pcs = S.timeline?.pieces;
  if (!pcs?.length) return m;
  const pc = pcs.find((x) => m >= x.m && m < x.m + x.d), last = pcs[pcs.length - 1];
  const w = L.w0 + (vn.p - L.p0);
  if (pc ? pc.f === L.f : m >= last.m + last.d && last.f === L.f) {
    if (!pc) return m;
    const mw = pc.m + (w - pc.w);
    if (!L.wall) L.w0 = pc.w + (m - pc.m) - (vn.p - L.p0);
    else if (Math.abs(mw - m) >= 0.3) { Object.assign(L, { m0: mw, p0: vn.p, u0: f1Clock(vn), w0: w }); return mw; }
    return m;
  }
  const at = C.mapWall(pcs, w);
  if (at.state === 'gap') { L.gap = at.wait; return null; }
  const placed = at.state === 'ok' ? { m: at.m, f: pcs[at.piece].f }
    : at.state === 'after' ? { m: last.m + (w - last.w), f: last.f }
      : { m: pcs[0].m - (pcs[0].w - w), f: pcs[0].f }; // (before the recording: rewound before it)
  // (a file-set change that lands it back in its own file keeps its kind: lockM's in-file rule)
  const same = L.f === -1 && L.fid != null && S.timeline.files?.[placed.f]?.id === L.fid;
  Object.assign(L, { m0: placed.m, p0: vn.p, u0: f1Clock(vn), w0: w, f: placed.f, wall: L.wall || !same, fid: null });
  return placed.m;
}

// The wall time of the moment a live lock plays (lockM's, also in a gap).
function lockWall(L, vn) {
  return !S.local && L.w0 != null ? L.w0 + (vn.p - L.p0) : wallAt(L.m0 + (vn.p - L.p0));
}

// A new lock at m0 now: on a server's recording, with its wall time (`w0` given, else m0's, from
// the next piece if m0 has none: a clipped overlap) and the file that wall time falls in (lockM).
// (`u0`: F1 TV's own clock at p0, when its player gives it: the lock keeps to that picture when
// its content position is re-based, the 'video' message. Wherever p0 moves, u0 moves with it.)
function newLock(m0, vn, t, extra) {
  const L = { cid: S.cid, m0, p0: vn.p, at: t, u0: f1Clock(vn), ...extra };
  if (!S.local) {
    const pcs = S.timeline?.pieces || [], nx = pcs.find((x) => x.m > m0);
    L.w0 = extra?.w0 ?? wallAt(m0) ?? (nx ? nx.w - (nx.m - m0) : null);
    const at = L.w0 != null && pcs.length ? C.mapWall(pcs, L.w0) : null;
    const pc = at?.state === 'ok' ? pcs[at.piece] : at?.state === 'gap' ? pcs.find((x) => x.w > L.w0)
      : at?.state === 'before' ? pcs[0] : pcs[pcs.length - 1];
    L.f = pc?.f ?? null;
    if (extra?.w0 != null && at?.state === 'ok') L.m0 = at.m; // (a wall time given decides the moment)
  }
  return (S.liveLock = L);
}

// The wall time at which commentary position m was live, on the timeline playing. The stream
// recorded here is one timeline, its wall clock linear in m (before what's kept too, where a
// rewind goes); a server's recording past its newest audio (live) likewise.
function wallAt(m) {
  const pcs = S.timeline?.pieces;
  if (!pcs?.length) return null;
  if (S.local) return pcs[0].w + (m - pcs[0].m);
  const last = pcs[pcs.length - 1];
  return C.wallOf(pcs, m) ?? (m >= last.m + last.d ? last.w + (m - last.m) : m < pcs[0].m ? pcs[0].w + (m - pcs[0].m) : null);
}

// The other way round: the position of wall time w on the timeline playing, also where it has no
// audio (before the recording, after it, in a gap between two files: the server's m has no room
// for a gap, so there as the server's own live lock would place it).
function momentAt(w) {
  const pcs = S.timeline?.pieces;
  if (!pcs?.length) return null;
  if (S.local) return pcs[0].m + (w - pcs[0].w);
  const at = C.mapWall(pcs, w), last = pcs[pcs.length - 1];
  if (at.state === 'ok') return at.m;
  if (at.state === 'before') return pcs[0].m - at.wait;
  if (at.state === 'after') return last.m + (w - last.w);
  const next = pcs.find((pc) => pc.w > w);
  return next ? next.m - (next.w - w) : null;
}

// Rewound into the server's recording from the stream (goServer `back`): F1 TV is back within
// what this browser has recorded (Go live, or a seek forward), DIRECT_BACK s inside it at wall
// time w, and the stream is still coming in.
function backInDirect(t, w) {
  const rs = FoneRecorder.status();
  if (w == null || rs.url !== S.direct || localIdle(rs, t) || !(rs.lastAt > t - 3)) return false;
  const B = FoneRecorder.buffer(S.direct);
  const first = B && FoneLocal.timeline(B, t).pieces[0];
  return !!first && w > first.w + DIRECT_BACK;
}

// The sponsor clips the server found, by wall time (the stream recorded here has no playlist
// positions of the server's), over what the buffer keeps. The server knows of a clip only a few
// seconds into it (its recording's lumps, then 2-3 s of the clip to recognise it), when the
// stream recorded here plays it already: its first seconds are heard.
async function refreshServerMutes(gen) {
  S.mutesAt = now();
  S.mutesBusy = true;
  try {
    const t = now();
    const from = Math.floor(t - 60 * (S.bufferMin || 15) - 60), to = Math.ceil(t + 60);
    const tl = await api(`/api/timeline?channel=${encodeURIComponent(S.channel)}&from=${from}&to=${to}`);
    if (gen === S.gen) { S.serverMutes = tl.mutes || []; S.serverTl = tl; }
    // the server's recording growing while this browser's recorder says off air: ask it again now
    // rather than at its next 30 s check
    const rs = FoneRecorder.status(), last = tl.pieces?.[tl.pieces.length - 1];
    if (gen === S.gen && rs.url === S.direct && rs.state === 'offline' && tl.live && last && last.w + last.d > trueNow(now()) - 15
      && now() - S.recheckAt > 10) {
      S.recheckAt = now();
      FoneRecorder.recheck(S.direct);
    }
  } catch { /* keep the last */ } finally {
    if (gen === S.gen) S.mutesBusy = false;
  }
}

// The sponsor clip (if any) at commentary position m, to mute it. A break is several clips back
// to back, and live the server recognises each one on its own, AD.RECOG s into it once its audio
// has reached the recording: right after one clip's end, the next isn't known yet. So the mute
// holds past a clip's end until the server's analysis (files' adsAnalyzedTo) is AD.RECOG s past
// it, when the next clip would have been recognised (at most AD.HOLD s). Live from the stream
// recorded here, the match is by wall time, padded by AD.PAD s (the two clocks' arrival times differ).
const AD = { RECOG: 3, HOLD: 12, PAD: 1, FADE: 1.2 };
function adAt(m) {
  const tl = S.local ? S.serverTl : S.timeline;
  if (!tl?.mutes?.length) return null;
  // the moment on the server's timeline (the stream recorded here: by its wall time)
  let sm = m, w = null;
  if (S.local) {
    w = wallAt(m);
    if (w == null) return null;
    w += skewNow(); // (the server's clock, its mutes')
    const hit = tl.mutes.find((x) => w >= x.w - AD.PAD && w < x.w + x.d + AD.PAD);
    if (hit) return hit;
    const at = C.mapWall(tl.pieces, w), last = tl.pieces[tl.pieces.length - 1];
    sm = at.state === 'ok' ? at.m : at.state === 'after' && last ? last.m + last.d + at.past : null;
    if (sm == null) return null;
  } else {
    const hit = tl.mutes.find((x) => m >= x.m && m < x.m + x.d);
    if (hit) return hit;
  }
  // just past a clip: held while the server can't yet know whether another follows
  return tl.mutes.find((x) => sm >= x.m + x.d && sm < x.m + x.d + AD.HOLD && analyzedAt(tl, x.m + x.d) < x.m + x.d + AD.RECOG) || null;
}
// How far the server's sponsor-clip analysis has got, on its timeline's m, in the file holding m.
// (on into the next file while one is analysed to its end: a clip ending a file's last seconds)
function analyzedAt(tl, m) {
  const fs = (tl.files || []).filter((f) => f.inPlaylist && f.offset != null).sort((a, b) => a.offset - b.offset);
  let i = fs.findIndex((x) => m >= x.offset && m < x.offset + x.duration);
  if (i < 0) i = fs.length - 1;
  let f = fs[i];
  if (f?.adsAnalyzedTo == null) return -Infinity;
  while (f.adsAnalyzedTo >= f.duration - 0.01 && fs[i + 1]?.adsAnalyzedTo != null) f = fs[++i];
  return f.offset + f.adsAnalyzedTo;
}

// F1 TV's own description of the video (anonymous, as the server's f1.py reads it): only what
// the engine needs without a server, whether it's live.
const F1TV_META = 'https://f1tv.formula1.com/2.0/R/ENG/WEB_DASH/ALL/CONTENT/VIDEO/{cid}/F1_TV_Pro_Annual/2';
async function f1Content(cid) {
  try {
    const r = await fetch(F1TV_META.replace('{cid}', encodeURIComponent(cid)), { credentials: 'omit', signal: AbortSignal.timeout(8000) });
    const m = (await r.json())?.resultObj?.containers?.[0]?.metadata;
    if (!m) throw new Error('no metadata');
    return { contentId: cid, title: m.title || null, subtype: m.contentSubtype || null, p0: null, anchor: null };
  } catch (e) {
    return { contentId: cid, error: `F1 TV: ${e.message || e}` };
  }
}

// The delay set for this stream last time (live, edge to edge), kept in this browser. Otherwise
// the default: nearer the edge for the platforms that give HTTP-FLV (it arrives continuously) than
// for HLS, which arrives a segment at a time.
const FLV_PLATFORMS = new Set(['bilibili', 'douyin', 'huya']);
const defaultDelayOf = (stream) => (!stream ? C.SERVER_LIVE_DELAY : FLV_PLATFORMS.has(FoneStreams.parse(stream).platform) ? C.LOCAL_EDGE_DELAY : C.LIVE_EDGE_DELAY);
const liveDefaultDelay = () => defaultDelayOf(S.local && S.stream);
// How far behind its edge the commentary aims to be, live (Go live's aim; auto-hold lets F1 TV go
// again near it): HTTP-FLV pulled here, which comes in continuously, LOCAL_ALLOW; HLS here and a
// server's recording, a segment or a keyframe group at a time, LIVE_EDGE_LAG; or the delay set's
// lag (where F1 TV usually starts) if that's nearer. `stream`: the stream recorded here (its own
// slack), else a server's recording.
const LOCAL_ALLOW = 3;
const allowOf = (delay, stream) => Math.max((stream ? 1 : 2.5) + 1,
  Math.min(stream && FLV_PLATFORMS.has(FoneStreams.parse(stream).platform) ? LOCAL_ALLOW : C.LIVE_EDGE_LAG,
    C.DEFAULT_LIVE_LATENCY - Math.max(delay ?? 0, defaultDelayOf(stream))));
const liveAllow = () => allowOf(S.delay, S.local && S.stream);
const localDelayKey = (stream = S.stream) => `delay|${FoneStreams.parse(stream).key}`;
function localSync(stream = S.stream) {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(localDelayKey(stream)) || 'null'); } catch { /* none */ }
  // (saved before 0.3.8, v unset: against a live latency of 30 s, now 32: the same lag there)
  return Number.isFinite(saved?.delay) ? { delay: saved.delay + (saved.v >= 2 ? 0 : 2), source: 'stream' } : { delay: defaultDelayOf(stream), source: 'live' };
}

async function loadContent(gen) {
  const content = S.source !== 'local' ? await api(`/api/f1tv/${S.cid}`)
    : S.base ? await api(`/api/f1tv/${S.cid}`).catch(() => f1Content(S.cid)) : await f1Content(S.cid);
  if (gen !== S.gen) return;
  S.content = content;
  S.contentAt = now();
  syncLivePos();
  S.clockFinal = false;
  await decideClock(gen);
}

// Live clocks depend on the player's seekable range, which only exists once the
// video has loaded — keep re-deciding until it has, then stick with the answer.
async function decideClock(gen) {
  if (S.deciding) return; // messages arrive at 4 Hz; one decision at a time
  S.deciding = true;
  try { await decideClockOnce(gen); } finally { S.deciding = false; }
}

// The server's delay for this video on `clock`. Live delays set since 0.3.8 are kept as clock
// 'edge2'; one set before ('edge': against a 30 s latency and the server's edge, which ran ~4 s
// stale) is read on the new scale (the default went 23 -> 21 the same way).
async function serverSync(clock) {
  const q = (c) => api(`/api/sync/${S.cid}?channel=${encodeURIComponent(S.channel)}&clock=${c}`);
  if (clock !== 'edge') return q(clock);
  const now2 = await q('edge2');
  if (now2.source === 'content') return now2;
  const old = await q('edge').catch(() => null);
  return old?.source === 'content' ? { ...old, delay: old.delay - 2 } : now2;
}

async function decideClockOnce(gen) {
  const v = S.video;
  const clock = C.chooseClock(S.content, v, now());
  if (clock !== S.clock) {
    const sync = S.source === 'local' ? localSync() : await serverSync(clock);
    if (gen !== S.gen) return;
    S.clock = clock;
    S.sync = sync;
    S.delay = sync.source === 'measured' ? measuredDelay(sync) : sync.delay;
    S.delaySource = sync.source;
    if (clock === 'edge' && !['content', 'stream', 'live'].includes(sync.source)) {
      // Replay calibrations measure lag behind real events; live works edge to edge.
      // ('live': the stream recorded here's own live default, already.)
      S.delay = C.SERVER_LIVE_DELAY;
      S.delaySource = 'live';
    }
    if (clock === 'edge' && S.source !== 'local') refreshDashDelay(gen);
    S.manualBase = null;
    S.resync = true;
    if (clock === 'edge' && S.direct && !S.local) goDirect(gen); // live: the stream itself, fresher
    else if (clock !== 'edge' && S.local && S.source === 'server') goServer(gen); // a replay: the server's
  }
  // Final once the player has told us enough: a UTC position, a replay, or a live
  // edge. Never from the label fallback (it can't tell live edges). An item F1 TV lists as
  // LIVE isn't settled until the player says it plays it live (or as the replay it became):
  // its first reports come before the player knows, and 2026-10-10 a Mac stuck on the
  // replay's anchored clock for a whole live qualifying (seeking every 1.5 s at the edge).
  const listedLive = S.content?.subtype === 'LIVE';
  S.clockFinal = !!(v && v.ready && !String(v.src || '').startsWith('label')
    && (v.p > 1e9 || v.seekEnd != null || (!v.live && !listedLive)));
}

// A measured delay is the streamer's screen delay (the recording's F1 TV sound then coincides
// with the picture: no echo against F1 TV's own sound, lip-sync for pass-through interviews)
// plus, when asked for, their reaction time, so the commentary runs a little ahead of the
// action instead of after it.
function measuredDelay(sync) {
  const screen = Number.isFinite(sync.screen) ? sync.screen : sync.delay - (sync.reaction || 0);
  return Math.round((screen + (S.anticipate ? sync.reaction || 0 : 0)) * 1000) / 1000;
}

// The player can switch between content seconds and UTC (live wall clock appearing or
// a fallback); mapping one through the other's clock lands decades off.
const domainMismatch = (v) => S.clock != null && S.clock !== 'edge' && (v.p > 1e9) !== (S.clock === 'epoch');

function timelineWindow() {
  const t = now();
  const c = S.content;
  if (S.clock === 'multiviewer' || S.clock === 'preroll') {
    const from = c.p0 + S.delay - 2 * 3600;
    const to = c.p0 + (c.duration || 4 * 3600) + S.delay + 2 * 3600;
    return [from, Math.max(to, Math.min(t + 3600, to + 6 * 3600))];
  }
  return [t - 30 * 3600, t + 3600];
}

async function refreshTimeline(gen) {
  if (S.local) return; // the stream recorded here: refreshLocal's loop (its timer is S.timelineTimer too)
  clearTimeout(S.timelineTimer);
  try {
    // Live sessions get upgraded to the exact anchor once MultiViewer publishes it.
    if (S.content && S.content.anchor !== 'multiviewer' && now() - S.contentAt > 600) await loadContent(gen);
    else if (S.content && !S.clockFinal) await decideClock(gen);
    if (S.local) return; // gone live from the stream itself (refreshLocal's loop now)
    if (S.directBack) directGivenUp(FoneRecorder.status()); // (rewound into this recording: the way back)
    const [from, to] = timelineWindow();
    const tl = await api(`/api/timeline?channel=${encodeURIComponent(S.channel)}&from=${from}&to=${to}`);
    if (gen !== S.gen || S.local) return;
    tl.receivedAt = now();
    // the file set changed (a backfill import joined, an old file left the window): positions and
    // files' offsets may have moved under the lock; it's placed again by its wall time (lockM)
    if (S.liveLock?.w0 != null && S.playlist && tl.playlist !== S.playlist) {
      Object.assign(S.liveLock, { fid: S.timeline?.files?.[S.liveLock.f]?.id ?? null, f: -1 });
    }
    S.timeline = tl;
    S.error = null;
    if (S.clock === 'manual' && S.manualBase == null && tl.pieces.length) {
      // Nothing to anchor on: start the video at the beginning of the newest recording.
      const last = tl.files.filter((f) => f.inPlaylist).pop();
      S.manualBase = (last ? last.wallStart : tl.pieces[0].w) - S.delay;
    }
    if (tl.playlist !== S.playlist) loadPlaylist(tl.playlist);
  } catch (e) {
    if (gen === S.gen) S.error = e.message || String(e);
  }
  if (gen === S.gen && !S.local) {
    const live = S.timeline && (S.timeline.live || !S.timeline.complete);
    // often while anything is live (the video too: the streamer going live shows up in seconds)
    S.timelineTimer = setTimeout(() => refreshTimeline(gen), live || !S.clockFinal || S.clock === 'edge' ? 3000 : 60000);
  }
}

function loadPlaylist(path) {
  S.playlist = path;
  if (S.hls) { S.hls.destroy(); S.hls = null; }
  if (!path) return;
  const hls = new Hls({
    enableWorker: false, // MV3 extension pages can't spawn blob: workers
    startPosition: S.lastTarget ?? 0,
    maxBufferLength: 20,
    maxMaxBufferLength: 40,
    backBufferLength: 30,
    liveDurationInfinity: true,
    manifestLoadingMaxRetry: 6,
    levelLoadingMaxRetry: 6,
    fragLoadingMaxRetry: 6,
  });
  hls.on(Hls.Events.ERROR, (_, data) => {
    const t = now();
    if (t - (DG.hlsAt.get(data.details) || 0) > 1) {
      DG.hlsAt.set(data.details, t);
      diag('hls', { kind: data.type, details: data.details, fatal: !!data.fatal, at: Math.round(audio.currentTime * 10) / 10 });
    }
    if (!data.fatal) return;
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
    else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
    else setTimeout(() => { if (S.hls === hls) loadPlaylist(path); }, 2000);
  });
  hls.loadSource(S.base + path);
  hls.attachMedia(audio);
  S.hls = hls;
  S.resync = true;
}

// ---- live car positions (E3) ---------------------------------------------------
// LIVE content only: livepos.js relays F1's car positions from the viewer's own F1 TV login
// to the server (the dashboard's track map). The token never passes through here: livepos
// asks the background for it right before each connection, and sends it to F1 only.
const f1Token = () => chrome.runtime.sendMessage({ target: 'background', type: 'f1-token' });

function syncLivePos() {
  const c = S.content;
  if (S.base && c?.subtype === 'LIVE' && c.sessionKey) FoneLivePos.start({ sessionKey: c.sessionKey, server: S.base, getToken: f1Token });
  else FoneLivePos.stop();
}

// For Details: is the track map being fed? (status() never holds the token.)
function livePosBrief() {
  const p = FoneLivePos.status();
  return p.state === 'idle' ? null : { state: p.state, text: p.text, relayed: p.relayed, error: p.lastError };
}

// ---- sync loop -----------------------------------------------------------------

function pauseAudio() {
  if (!audio.paused) audio.pause();
  S.steer = C.holdSteer(S.steer); // re-acquire when the video plays again
}

// F1 TV is paused or seeking: line the paused commentary up now (silently), so it is
// buffered and ready when the picture resumes instead of seeking after it.
function preSeek(m) {
  const t = performance.now();
  if (audio.seeking || Math.abs(audio.currentTime - m) < 0.5 || t - S.preSeekAt < 400) return;
  audio.currentTime = m;
  S.preSeekAt = t;
}

const ranges = (tr) => Array.from({ length: tr.length }, (_, i) => [tr.start(i), tr.end(i)]);

// See FoneCore.steer: the audio runs free and is only corrected when it is really off.
function drive(target, rate, src) {
  const nominal = C.nominalRate(rate);
  // rate is the speed someone chose (FoneCore.chosenRate), never F1 TV's trim; following a
  // change of it is counted apart from the corrections. It reaches us a few hundred ms after
  // the picture changed speed, and off 1× nothing nudges the audio back (only seeks past
  // 0.3 s), so re-lock right away: one seek at the button press beats trailing by ~0.25 s.
  const speedChange = S.nominal != null && nominal !== S.nominal;
  S.nominal = nominal;
  const { st, rate: r, seek } = C.steer(S.steer, {
    t: performance.now() / 1000,
    m: target,
    rate: nominal,
    audio: audio.currentTime,
    paused: audio.paused,
    seeking: audio.seeking || (!audio.paused && audio.readyState < 3),
    coarse: C.isCoarse(src),
    precise: C.isPrecise(src),
    resync: S.resync || speedChange,
    buffered: ranges(audio.buffered),
  });
  S.steer = st;
  S.resync = false;
  // At 1× the gentle corrections go through Chrome's resampler (a brief, slight pitch
  // shift) instead of WSOLA, which clicks every time the rate changes. Pitch is only
  // preserved for real speed changes. (Flipping this also clicks, so only on change.)
  const pp = nominal !== 1;
  if (audio.preservesPitch !== pp) audio.preservesPitch = pp;
  if (speedChange) {
    countFix('speeds');
    diag('speed', { to: nominal, src });
  }
  if (seek != null) {
    diag('seek', { from: Math.round(audio.currentTime * 100) / 100, to: Math.round(seek * 100) / 100,
      target: Math.round(target * 100) / 100, rate: nominal, src, ahead: audioAhead() });
    audio.currentTime = seek;
    countFix('seeks');
  }
  if (audio.playbackRate !== r) {
    audio.playbackRate = r;
    if (!speedChange) countFix('rates');
  }
  if (audio.paused) audio.play().catch((e) => { S.error = `audio: ${e.message}`; });
}

// The engine's seeks (each one clicks), rate changes (resampled now, so silent; v0.2.1's
// clicked) and the speed changes it followed (pitch kept off 1×, so each one clicks; v0.2.6
// took F1 TV's trims for them), counted for Details and the e2e test.
const FIX_TOTALS = { seeks: 'nSeeks', rates: 'nRates', speeds: 'nSpeeds' };
function countFix(kind) {
  const f = S.fixes;
  f[kind].push(now());
  f[FIX_TOTALS[kind]]++;
}

function fixStats() {
  const f = S.fixes, t = now();
  for (const k of Object.keys(FIX_TOTALS)) while (f[k].length && t - f[k][0] > 60) f[k].shift();
  return { seeks: f.seeks.length, rates: f.rates.length, speeds: f.speeds.length, nSeeks: f.nSeeks, nRates: f.nRates,
    nSpeeds: f.nSpeeds, rate: audio.playbackRate, pp: audio.preservesPitch };
}

// The commentary's moment, for the danmaku the tab scrolls over the picture (danmaku.js): the
// wall time the audio playing now went out at, so they move with what you hear (paused,
// seeked, at speed); at `at` (unix s), advancing at `rate` while `run`.
function danmakuClock() {
  const pieces = S.timeline?.pieces;
  const w0 = pieces ? C.wallOf(pieces, audio.currentTime) : null;
  if (w0 == null) return null;
  const w = w0 + (S.local ? skewNow() : 0); // (the stream recorded here: its arrivals, on this PC's clock)
  return { w, at: Date.now() / 1000, rate: audio.playbackRate, run: !audio.paused && !audio.seeking && audio.readyState >= 3 };
}

function report(st) {
  st.dm = danmakuClock();
  pictureClock(st);
  const tw = now();
  if (st.state !== S.lastState) diag('state', { from: S.lastState, to: st.state, text: st.text });
  if (tw - DG.snapAt >= DIAG.SNAP) { DG.snapAt = tw; diagSnap(st); }
  flushDiag(tw);
  const t = performance.now();
  if (st.state === S.lastState && t - S.lastReport < 250) return;
  S.lastState = st.state;
  S.lastReport = t;
  chrome.runtime.sendMessage({ target: 'background', type: 'status', tab: S.tab, status: st }).catch(() => {});
}

// ---- the streamer window (streamer.js: a box over F1 TV, or a window of its own) -------------
// It asks on BroadcastChannel 'fone-clock' (hello, every 2 s while open) and gets the commentary's
// clock with every tick (10 a second): the moment playing and on which timeline. The stream
// recorded here: m, its video coming from the recorder on 'fone-video' on the same axis. A
// server's recording: the file and the position in it (its video handoff, /api/video).
// `playing`: moving at `rate`; m null: no commentary to show a picture for (state, text say why).
const picCh = (() => { try { return new BroadcastChannel('fone-clock'); } catch { return null; } })();
let picAt = 0;
if (picCh) picCh.onmessage = (e) => {
  if (e.data?.type !== 'hello') return;
  picAt = now();
  if (!S.local) return;
  if (e.data.avc) FoneRecorder.preferAvc();
  FoneRecorder.wantPicture(!!e.data.fresh, e.data.since ?? null);
};
// Its requests to the server's video handoff (it can't make them itself, from F1 TV's https page):
// that server's /api/video only.
const picFetch = (() => { try { return new BroadcastChannel('fone-fetch'); } catch { return null; } })();
if (picFetch) picFetch.onmessage = async (e) => {
  const q = e.data;
  if (q?.type !== 'get') return;
  const answer = (o) => picFetch.postMessage({ type: 'got', id: q.id, ...o });
  if (!S.base || typeof q.url !== 'string' || !q.url.startsWith(`${S.base}/api/video/`)) return answer({ ok: false, status: 0, error: 'not the server' });
  try {
    const r = await fetch(q.url, { signal: AbortSignal.timeout(20000) });
    answer({ ok: r.ok, status: r.status, body: q.text ? await r.text() : await r.arrayBuffer() });
  } catch (err) {
    answer({ ok: false, status: 0, error: err.message || String(err) });
  }
};

function pictureClock(st) {
  if (!picCh || now() - picAt > 10) return;
  const o = { type: 'clock', at: now(), state: st.state, text: st.text, channel: S.channel, m: null };
  const pic = st.state === 'sync' || st.state === 'syncing' || st.state === 'paused' || st.state === 'buffering' ? S.pic : null;
  if (pic) Object.assign(o, pic);
  picCh.postMessage(o);
}

function fileTitle(idx) {
  const f = S.timeline?.files?.[idx];
  return f ? f.title || f.name : null;
}

// ---- live: lock once, then follow F1 TV's playhead ----------------------------
// Both streams are live and both advance in real time, so after one alignment the
// commentary position is m0 + (p - p0): it moves only when you seek F1 TV or nudge.
// No per-tick re-derivation from F1 TV's live edge (it advances in segment-sized steps)
// or from the server's wall-clock mapping (delivery jitter) — those made it chase.
const LIVE = { IN: 0.4, OUT: 1.0 };
const EDGE_STEP = 6; // s: F1 TV's live edge advances in 5.76 s steps
const LOCAL_IDLE = 30; // s without audio from the stream recorded here before it counts as stopped
// The lead (how much commentary exists past the playhead, auto-hold's measure) leaves this much
// for audio that's not playable yet: a server's 2 s segments and 3 s timeline refresh; the stream
// recorded here, its 0.5 s chunks.
const slack = () => (S.local ? 1 : 2.5);

function commentaryEdge(t) {
  if (S.local) { // the stream recorded here: its live edge, but never past what can be played yet
    const B = FoneRecorder.buffer(S.stream);
    const e = B && FoneLocal.liveEdge(B, t), end = B && FoneLocal.playableEnd(B);
    // (a reconnect waiting to be placed, localcore's SETTLE: its audio is in hand, at the edge)
    return e == null || end == null ? null : B.pend ? e : Math.min(e, end + 0.25);
  }
  const tl = S.timeline;
  if (!serverLive()) return null;
  const last = tl.pieces[tl.pieces.length - 1];
  if (!last) return null;
  return last.m + last.d + Math.min(3, t - tl.receivedAt); // grows in real time between refreshes
}

// A server's recording counts as live while its file grows (up to FONE_GROWING_IDLE_SECONDS
// after the streamer stopped); not while this browser's recorder of the same stream (rewound
// into the server's recording from it, or off air when the page opened) says it's off air.
function serverLive() {
  const tl = S.timeline;
  if (!tl) return false;
  if (!S.directBack) return !!tl.live;
  // Off air from the recorder's answer (offAt: the stream's last audio here) until the server has
  // audio that began after it and is still coming in (the streamer back: this browser's re-check
  // may be 30 s off; the stopped file's last lumps, or a false start, don't count).
  const rs = FoneRecorder.status(), t = now(), last = tl.pieces?.[tl.pieces.length - 1];
  if (rs.url === S.direct) {
    if (rs.state === 'offline' && !S.offArmed) Object.assign(S, { offArmed: true, directOff: true, offAt: rs.lastAt ?? t });
    else if (rs.state === 'recording') S.offArmed = false;
  }
  // (this browser recording the stream again: the way back to it is backInDirect's; the server's
  // stopped file, still in its idle, isn't live for that)
  const fresh = !!last && last.w + last.d > S.offAt + skewNow() + 2 && last.w + last.d > trueNow(t) - 15;
  if (S.offArmed) S.directOff = !fresh;
  else if (S.directOff && fresh) S.directOff = false;
  return !!tl.live && !S.directOff;
}

// F1 TV's own clock on the picture playing (live, from its player: utc0 + p), or null.
const f1Clock = (vn) => (S.video?.utc0 != null ? S.video.utc0 + vn.p : null);

// How far F1 TV is behind where it played most live this session: by its own clock when its
// player gives it (how far behind that clock it plays, flBest at its most live), else by wall time
// (its content position runs with the clock while it plays, minLagW). Anything behind its best is
// a rewind, a pause or a stall. (Its reported edge isn't the measure: it steps by 5.76 s, a little
// late each time, and drifts by a few seconds between double steps.) Learned while live.
function learnLive(t, vn) {
  if (vn.seekEnd == null) return;
  const lag = t - vn.p, behind = Math.max(0, vn.seekEnd - vn.p);
  S.minLagW = Math.min(S.minLagW ?? lag, lag);
  S.minBehind = Math.min(S.minBehind ?? behind, behind);
  const c = f1Clock(vn);
  if (c != null) {
    S.flBest = Math.min(S.flBest ?? Infinity, trueNow(t) - c);
    // (the same, on the timeline playing now and by this PC's clock: for when the clock goes)
    S.minLagW = S.flBest + S.video.utc0 - (trueNow(t) - t);
  }
}
function rewoundBy(t, vn) {
  if (vn.seekEnd == null) return 0;
  const c = f1Clock(vn);
  if (c != null && S.flBest != null) return Math.max(0, trueNow(t) - c - S.flBest);
  return S.minLagW == null ? 0 : Math.max(0, t - vn.p - S.minLagW);
}

// F1 TV's live latency: how far behind live its picture is, by its own clock against the time now
// (where its player starts a live stream that's 31-34 s, a different place each load, and every
// pause or rewind adds to it). Without its clock, as if it had started at the usual place.
function f1Lat(t, vn) {
  const c = f1Clock(vn);
  return c != null ? trueNow(t) - c : C.DEFAULT_LIVE_LATENCY + rewoundBy(t, vn);
}

// F1 TV's clock gone a moment from a lock that keeps to it (its player rebuilding, its timeline
// maybe re-based: its position can't be put on the picture until the clock is proven again): the
// commentary waits rather than following a position that may be minutes off, up to CLOCK_GRACE s.
const CLOCK_GRACE = 3;
const clockLost = (t, vn) => S.clock === 'edge' && S.liveLock?.cid === S.cid && S.liveLock.u0 != null
  && f1Clock(vn) == null && S.clockAt != null && t - S.clockAt < CLOCK_GRACE;

function liveTarget(t, vn) {
  const L = S.liveLock;
  if (L) L.gap = null; // (only lockM, this tick, says it's in a gap)
  // F1 TV's most live position this session (learnLive): anything behind it is you having
  // rewound (none known: at it, rewound by nothing)
  learnLive(t, vn);
  // the stream recorded here: its edge as judged by the freshest arrivals so far
  const B = S.local && FoneRecorder.buffer(S.stream);
  // the lock made as if the edge were now (no live edge then): an edge lock once there is one,
  // unless it's playing an older file than the newest (F1 TV rewound into what was recorded)
  if (L?.noEdge && L.cid === S.cid && !L.relock && !B && commentaryEdge(t) != null) {
    const pcs = S.timeline.pieces, last = pcs[pcs.length - 1], at = C.mapWall(pcs, lockWall(L, vn));
    if (!(at.state === 'ok' && last && pcs[at.piece].f !== last.f)) L.relock = true;
  }
  if (L && L.cid === S.cid && !(L.relock)) {
    // Recorded here, the edge firms up over the first minute: HLS segments arrive in steps and
    // the first playlist can't say how long its newest one has been out, so the freshest
    // arrival keeps improving for a while. Keep the commentary as far behind the edge as was
    // chosen: follow the edge forward then (never back: an arrival only ever shows it fresher).
    if (B && L.edgeRef != null && t - L.at < 90) {
      const e = FoneLocal.liveEdge(B, t) - t;
      if (e > L.edgeRef + 0.1) { L.m0 += e - L.edgeRef; L.edgeRef = e; }
    }
    return lockM(L, vn);
  }
  // a switch of source while rewound (carryLock): the same moment on the new timeline
  const K = S.carry;
  S.carry = null;
  const mk = K && K.cid === S.cid ? momentAt(S.local ? K.w - skewNow() : K.w) : null;
  if (mk != null) {
    const m0 = mk + (vn.p - K.p);
    return lockM(newLock(m0, vn, t, { edgeRef: B ? FoneLocal.liveEdge(B, t) - t : null, carried: true, wall: true, w0: K.w + (vn.p - K.p) }), vn);
  }
  const edge = B ? FoneLocal.liveEdge(B, t) : commentaryEdge(t);
  // How far behind its edge the commentary goes: F1 TV's latency less the delay (F1 TV further
  // behind live, by where its player started it, a pause or a rewind: the commentary as much)
  const lag = f1Lat(t, vn) - S.delay;
  if (edge == null) {
    // A server's recording that isn't live (the streamer off air, F1 TV still live): one lock as
    // if its edge were now, by wall time (F1 TV's edge steps would saw a mapping made every tick);
    // a reconnect, or rewinding into what it recorded, is placed by it. Else none: the caller
    // falls back to the wall mapping.
    if (B || !S.timeline?.pieces?.length) return null;
    const w = trueNow(t) - lag, m0 = momentAt(w);
    return m0 == null ? null : lockM(newLock(m0, vn, t, { wall: true, w0: w, noEdge: true }), vn);
  }
  // The stream recorded here: behind its edge (as fresh as its freshest arrivals, which it
  // follows). A server's recording: behind the time now, by wall time (its edge is only as fresh
  // as the recorder's last keyframe group, 0-8 s old by when the lock is made; m0 may be in an
  // older file's tail while the newest is shorter than the lag).
  if (B) return lockM(newLock(edge - lag, vn, t, { edgeRef: edge - t }), vn);
  const w = trueNow(t) - lag; // (the server's clock: F1 TV's on the picture + the delay)
  return lockM(newLock(momentAt(w) ?? edge - lag, vn, t, { w0: w }), vn);
}

// ---- Go live -------------------------------------------------------------------------
// F1 TV's LIVE badge, the panel's Go live, L: F1 TV to the most recent moment it can play, and the
// commentary with it as far as the commentary can keep up. F1 TV's most recent, by its own clock:
// where its reported live edge is at its freshest (the edge steps by 5.76 s, each step a little
// later than the last until a double step catches up; 2026-10-25 its picture there was ~30 s
// behind that clock, 31-34 s where the player starts). A seek goes no further than the edge
// reported now (Player.seek stops there, and F1 TV plays on past it between steps), so what's out
// of reach now is `more`: content.js asks again once the edge has stepped on. Without its clock:
// GOLIVE.F1 s behind the edge it will report just before its next step, or back to where it played
// most live (a pause, a rewind), whichever is further. The commentary goes as close to its edge
// as liveAllow (where auto-hold doesn't hold): behind that (held, stalled, paused, rewound) a jump
// forward; ahead of it (just held) a step back, instead of waiting paused for it to catch up. The
// stream recorded here that stopped coming in has no edge: F1 TV's own alone.
const GOLIVE = { F1: 1.5, MIN: 0.4, CHASE: 0.6, UP_WINDOW: 180 };

// The freshest F1 TV's reported live edge has been of late, by its own clock: how far behind that
// clock its picture is at the edge (the 'video' message keeps one per step), or null.
function upFreshest(t) {
  const xs = (S.upAges || []).filter(([at]) => t - at < GOLIVE.UP_WINDOW).map(([, a]) => a).sort((a, b) => a - b);
  return xs.length ? xs[Math.min(1, xs.length - 1)] : null; // (the second freshest: one lucky report isn't where a seek lands)
}

// How long since F1 TV's reported live edge last stepped forward ('video' reports): a whole step
// when it doesn't step (it moves on with every report), none when that isn't known yet.
function edgePhase(t) {
  // (modulo F1 TV's step only past a step missed in the report that carried a seek: its steps
  // otherwise come every ~5.86 s, a little late, and a modulo would read 'just stepped')
  if (S.edgeStepAt != null && t - S.edgeStepAt < 3 * EDGE_STEP) {
    const x = t - S.edgeStepAt;
    if (S.edgeMissAt != null && S.edgeMissAt > S.edgeStepAt) return x % 5.76;
    return x > EDGE_STEP + 0.5 ? Math.min(EDGE_STEP, x - 5.86) : Math.min(EDGE_STEP, x); // (overdue: a reload skipped)
  }
  const stepless = S.edgeSeenAt != null && t - S.edgeSeenAt > 3 * EDGE_STEP && (S.edgeStepAt == null || t - S.edgeStepAt > 3 * EDGE_STEP);
  return stepless ? EDGE_STEP : 0;
}

// The stream recorded here stopped coming in: off air, failing, or nothing for LOCAL_IDLE s.
const localIdle = (rec, t) => rec.state === 'offline' || rec.state === 'error' || (rec.lastAt != null && t - rec.lastAt > LOCAL_IDLE);

// `held`: auto-hold has F1 TV paused (content.js). `chase`: one of the asks after the first (logged
// only when they move F1 TV), `pMax` the furthest F1 TV has been since it began: back a second or
// more from there (a rewind or seek of yours; ours only ever go forward) and it's over (`took`).
function goLive(held = false, chase = false, pMax = null) {
  const v = S.video;
  const L = S.liveLock?.cid === S.cid ? S.liveLock : null;
  // (rewound into a server's recording whose timeline isn't in: the moment carried there)
  const K = !L && !S.local && S.directBack && S.carry?.cid === S.cid ? S.carry : null;
  if (!v || S.clock !== 'edge' || (!L && !K)) return { handled: false };
  const t = now(), vn = C.videoNow(v, t);
  if (chase && Number.isFinite(pMax) && vn.p < pMax - 1) return { handled: true, by: 0, more: 0, took: true, limit: 'f1' };
  // (F1 TV's clock gone a moment: where the commentary is can't be told from its position now)
  if (clockLost(t, vn)) return { handled: true, by: 0, more: 0, wait: true, limit: 'f1' };
  const w = L ? lockWall(L, vn) : K.w + (vn.p - K.p); // the moment playing, by wall time (across a server's files too)
  const edge = S.local && localIdle(FoneRecorder.status(), t) ? null : commentaryEdge(t);
  const ew = edge != null ? wallAt(edge) : null;
  // (the stream recorded here: its aim is behind its live edge, as its lock's is, not behind what
  // can be played yet, which trails it by a segment on HLS: 2-6 s)
  const B = S.local && edge != null ? FoneRecorder.buffer(S.stream) : null;
  const le = B ? FoneLocal.liveEdge(B, t) : null;
  const ewAim = le != null ? wallAt(le) : ew;
  // F1 TV: how far it is behind its most recent (by its clock, else by its reported edge and its
  // own best this session), and how far a seek can take it now
  const c = f1Clock(vn), fl = c != null ? trueNow(t) - c : null, up = c != null ? upFreshest(t) : null;
  const reach = vn.seekEnd != null ? vn.seekEnd - vn.p : null;
  const dF = fl != null && up != null ? Math.max(0, fl - up)
    : reach != null ? Math.max(reach - GOLIVE.F1 - (EDGE_STEP - edgePhase(t)), rewoundBy(t, vn), 0) : null;
  // The commentary: as near its edge as liveAllow; a server's recording, as near the time now as
  // its lock goes (its edge is only as fresh as its last keyframe group: 0-8 s stale)
  let dC = w == null || ew == null ? null : !S.local && L ? trueNow(t) - C.SERVER_LIVE_LAG - w : ewAim - liveAllow() - w;
  // rewound into the server's recording from the stream: the way back is to the stream's edge
  // (its wall time is now), at the stream's own allowance
  const rs = !S.local && S.directBack ? FoneRecorder.status() : null;
  if (w != null && rs && rs.url === S.direct && !localIdle(rs, t) && rs.lastAt > t - 3) dC = trueNow(t) - allowOf(localSync(S.direct).delay, S.direct) - w;
  let want = Math.min(dF ?? Infinity, dC ?? Infinity);
  if (!Number.isFinite(want)) return { handled: false };
  // Back only for the commentary's sake when it needs it: auto-hold holding F1 TV, or about to (a
  // lead under a second, by its edge now). F1 TV merely nearer live than the commentary's aim
  // plays on there.
  const lead = ew != null && w != null ? ew - w - slack() : null;
  if (want < 0 && !held && !(lead != null && lead < 1)) want = 0;
  // forward no further than the edge F1 TV reports now (back, always)
  let by = want > 0 && reach != null ? Math.min(want, Math.max(0, reach)) : want;
  if (Math.abs(by) < GOLIVE.MIN) by = 0;
  // (the rest after its edge steps on: worth a chase from GOLIVE.CHASE)
  const more = want > 0 && want - by >= (chase ? GOLIVE.MIN : GOLIVE.CHASE) ? want - by : 0;
  const r = (x) => (x == null ? null : Math.round(x * 100) / 100);
  if (!chase || by) diag('golive', { by: r(by), more: r(more), dF: r(dF), dC: r(dC), fl: r(fl), up: r(up), reach: r(reach), p: r(vn.p), held, chase });
  const limit = dC != null && (dF == null || dC < dF) && !(want === 0 && (dF ?? 0) < GOLIVE.MIN) ? 'commentary' : 'f1';
  return { handled: true, by: r(by), more: r(more), limit };
}

// ---- diagnostics -------------------------------------------------------------------
// What playback looked like, for debugging on machines nobody is watching over (a Mac after
// it slept, glitches at 2×): a snapshot every 5 s plus the notable moments (seeks, speed and
// state changes, audio stalls, the computer waking up), posted to the fone server
// (POST /api/diag, read back with GET /api/diag). Playback state only: no token, no cookie.
const DIAG = { SNAP: 5, FLUSH: 5, MAX: 300 };
const diagQ = [];
const DG = { snapAt: 0, flushAt: 0, skew: null, tick: null, hlsAt: new Map(), sent: 0, err: null, sdkSeen: new Set(), fatalSeen: new Set() };
let diagClient = null;
try { // offscreen documents have no chrome.storage; their localStorage is the extension's
  diagClient = localStorage.getItem('diagClient');
  if (!diagClient) localStorage.setItem('diagClient', (diagClient = `c${Math.random().toString(36).slice(2, 10)}`));
} catch { diagClient = 'anon'; }
const platform = navigator.userAgentData?.platform || navigator.platform || '';
// The build, for the log. (Offscreen documents get only part of chrome.runtime: no getManifest.)
let buildVersion = '';
fetch('manifest.json').then((r) => r.json()).then((m) => { buildVersion = m.version || ''; }).catch(() => {});

function diag(type, data) {
  diagQ.push({ t: Math.round(now() * 1000) / 1000, type, ...data });
  if (diagQ.length > DIAG.MAX) diagQ.splice(0, diagQ.length - DIAG.MAX);
}

function flushDiag(t) {
  if (!S.base || !diagQ.length || t - DG.flushAt < DIAG.FLUSH) return;
  DG.flushAt = t;
  const events = diagQ.splice(0, diagQ.length);
  let body;
  try {
    body = JSON.stringify({ client: diagClient, build: buildVersion, platform, events });
  } catch (e) { // never let the log break playback
    DG.err = `encode: ${e.message || e}`;
    return;
  }
  fetch(`${S.base}/api/diag`, {
    method: 'POST', credentials: 'omit', signal: AbortSignal.timeout(8000),
    headers: { 'content-type': 'application/json' }, body,
  }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    DG.sent += events.length;
    DG.err = null;
  }).catch((e) => {
    DG.err = e.message || String(e);
    diagQ.unshift(...events.slice(-100)); // the newest go again next time
  });
}

// A computer that slept: the wall clock jumped, the monotonic one (macOS) didn't move.
function diagClocks(t) {
  const mono = performance.now() / 1000;
  const skew = t - mono;
  if (DG.skew != null && Math.abs(skew - DG.skew) > 3) diag('wake', { slept: Math.round(skew - DG.skew) });
  if (DG.tick != null && mono - DG.tick > 3) diag('gap', { s: Math.round(mono - DG.tick) });
  DG.skew = skew;
  DG.tick = mono;
}

function audioAhead() {
  const b = audio.buffered, c = audio.currentTime;
  for (let i = 0; i < b.length; i++) if (c >= b.start(i) - 0.1 && c <= b.end(i)) return Math.round((b.end(i) - c) * 10) / 10;
  return 0;
}

// The moments the snapshots miss: F1 TV's player changing state (playing → internally-stopped:
// the player died), its audio track changing (fone's Track FX switch, or the user's menu) and
// what came of it, a rebuilt pipeline (new MSE handle), the onboard views coming and going.
// Each with the position and state around it, so a crash can be put next to its trigger.
function diagPlayer(prev, v) {
  const a = v.dx?.a, b = prev?.dx?.a;
  const r = v.dx?.r, q = prev?.dx?.r;
  const at = { p: Math.round((v.p || 0) * 10) / 10, ps: r?.ps ?? null, h: v.dx?.h ?? null, nv: v.dx?.nv ?? null };
  if (prev && q && r && q.ps !== r.ps) diag('pstate', { from: q.ps, to: r.ps, ...at, want: r.want, sdk: r.sdk, err: r.err, audio: a?.cur ?? null });
  if (a && (a.v !== b?.v || a.cur !== b?.cur || a.err !== b?.err)) {
    diag('audio', { from: b?.cur ?? null, to: a.cur, kind: a.kind, auto: a.auto, manual: a.manual, on: a.on, fx: a.fx, err: a.err, ...at });
  }
  if (prev && v.dx?.h != null && prev.dx?.h != null && v.dx.h !== prev.dx.h) diag('handle', { from: prev.dx.h, to: v.dx.h, ...at, audio: a?.cur ?? null, want: r?.want ?? null });
  const obs = (x) => (x?.dx?.ob ? x.dx.ob.map((o) => `${o.ch ?? '-'}:${o.state}`).join(',') : '');
  if (prev && obs(prev) !== obs(v)) diag('ob', { from: obs(prev), to: obs(v), ...at, err: v.dx?.obErr ?? null });
  // page.js's SDK call log and the core's fatal errors come with every report: each once
  const sdk = v.dx?.sdk;
  if (sdk) {
    for (const e of sdk.log || []) {
      const k = `${e.t}|${e.name}`;
      if (e.ms == null || DG.sdkSeen.has(k)) continue; // in flight, or sent
      DG.sdkSeen.add(k);
      diag('sdk', { ...e, pid: sdk.pid });
    }
    for (const e of sdk.fatal || []) {
      if (DG.fatalSeen.has(e.t)) continue;
      DG.fatalSeen.add(e.t);
      diag('fatal', { ...e, pid: sdk.pid });
    }
    if (DG.sdkSeen.size > 500) DG.sdkSeen = new Set([...DG.sdkSeen].slice(-200));
    if (prev?.dx?.sdk && prev.dx.sdk.pid !== sdk.pid) diag('player', { from: prev.dx.sdk.pid, to: sdk.pid, ...at });
    if (prev?.dx?.sdk && !prev.dx.sdk.dead && sdk.dead) diag('dead', { ...at, pid: sdk.pid });
  }
}

function diagSnap(st) {
  const v = S.video || {};
  diag('snap', {
    state: st.state, text: st.text, clock: st.clock, delay: st.delay, cid: st.cid, drift: st.drift ?? null,
    nominal: S.nominal, fixes: st.fixes ?? null, err: st.error ?? null,
    audio: { paused: audio.paused, rs: audio.readyState, rate: audio.playbackRate, pp: audio.preservesPitch,
      ct: Math.round(audio.currentTime * 10) / 10, ahead: audioAhead() },
    video: { p: v.p, rate: v.rate, paused: v.paused, waiting: v.waiting, src: v.src, live: v.live, seekEnd: v.seekEnd ?? null,
      utc0: v.utc0 ?? null, dx: v.dx ?? null },
    // live: F1 TV behind its own clock, the commentary's lead over its edge, F1 TV's edge at its
    // freshest, and the streamer's delay as the server measures it off their screen (for the next
    // calibration: none of it is known to be right but by ear)
    live: st.clock === 'edge' ? { fl: st.f1Lat ?? null, lead: st.lead == null ? null : Math.round(st.lead * 100) / 100,
      up: (() => { const u = upFreshest(now()); return u == null ? null : Math.round(u * 100) / 100; })(), screen: S.screen ?? null,
      skew: S.skew == null ? null : Math.round(S.skew * 1000) / 1000 } : null,
  });
}

// ---- stats dashboard clock ---------------------------------------------------------
// The dashboard (dashboard.html, beside F1 TV in its tab or in its own window) shows the
// timing data as of the moment on screen, E (real-world UTC). Replays know E exactly. Live,
// the edge clock only guesses F1 TV's latency, and a guess that's too short puts lap times
// on the dashboard before the car crosses the line on screen. But live, the picture is held
// in step with the commentary, whose real-world time is known: the wall time it went out
// at, minus the streamer's delay. Showing data a little late beats spoiling it, so hold back
// a bit more than the delay's error: 2 s once it's measured off this stream, 5 s on the
// channel's last calibration (that moved by 4 s from one day to the next). Without commentary
// in step, fall back to a long latency.
const DASH = { EVERY: 0.2, LIVE_LATENCY: 50, SAFETY_MEASURED: 2, SAFETY: 5, DELAY_TTL: 300 };

async function refreshDashDelay(gen) {
  S.dashDelayAt = now();
  try { // the streamer's delay behind real events (measured off their screen, or calibrated)
    const sync = await api(`/api/sync/${S.cid}?channel=${encodeURIComponent(S.channel)}&clock=multiviewer`);
    if (gen !== S.gen) return;
    S.dashDelay = sync.delay + (sync.source === 'measured' ? DASH.SAFETY_MEASURED : DASH.SAFETY);
    const screen = sync.source === 'measured' && Number.isFinite(sync.screen) ? sync.screen : null;
    if (screen !== S.screen) diag('screen', { screen, file: sync.file ?? null, confidence: sync.confidence ?? null });
    S.screen = screen;
  } catch { /* keep the last one */ }
}

function dashClock(t, v, vn, E, liveM) {
  if (t - S.dashAt < DASH.EVERY || S.content?.sessionKey == null) return;
  S.dashAt = t;
  let e = E;
  if (S.clock === 'edge') {
    // (the stream recorded here has no measured delay on a server: the long guess below)
    if (S.source !== 'local' && t - S.dashDelayAt > DASH.DELAY_TTL) refreshDashDelay(S.gen);
    const w0 = liveM != null && S.synced && S.dashDelay != null ? C.wallOf(S.timeline?.pieces, liveM) : null;
    const w = w0 == null ? null : w0 + (S.local ? skewNow() : 0); // (UTC: the stream recorded here's walls are this PC's)
    e = w != null ? w - S.dashDelay : t - DASH.LIVE_LATENCY - Math.max(0, (vn.seekEnd ?? vn.p) - vn.p);
  }
  if (!Number.isFinite(e)) return;
  chrome.runtime.sendMessage({
    target: 'dashboard', type: 'clock', tab: S.tab, E: e, playing: !v.paused, rate: v.rate || 1, at: t,
    sessionKey: S.content.sessionKey, cid: S.cid, server: S.base, live: S.clock === 'edge',
  }).catch(() => {});
}

function tick() {
  if (!S.key || !S.video) return;
  const t = now();
  diagClocks(t);
  if (S.base && t - (S.skewAt ?? 0) > SKEW.EVERY) refreshSkew(S.gen);
  const v = S.video;
  const rec = S.local ? { ...FoneRecorder.status(), player: S.lplayer?.state() ?? null } : null;
  const base = {
    channel: S.channel, channels: S.channels.map((c) => c.name), server: S.base,
    clock: S.clock, delay: S.delay, delaySource: S.delaySource, cid: S.cid,
    title: S.content?.title, session: S.content?.sessionName, anchor: S.content?.anchor,
    source: S.source, direct: S.local && S.source === 'server', rec,
    // the streamer on air, as the commentary's source knows it (a Bilibili room showing replays,
    // 轮播, isn't; a server's recording counts as live while its file grows): null, not known
    onAir: rec ? (rec.state === 'offline' ? false : rec.state === 'recording' && !localIdle(rec, t) ? true : null)
      : S.timeline ? serverLive() : null,
    playing: !v.paused && t - v.receivedAt <= 4, // the picture is moving (self-update waits)
    page: FoneStreams.pageOf(S.local ? S.stream : S.room) ?? null, // the streamer's live page (↗)
    diag: { q: diagQ.length, sent: DG.sent, err: DG.err },
    livepos: livePosBrief(),
  };
  if (t - v.receivedAt > 4) { // tab closed/frozen, or the player stopped giving a position
    pauseAudio();
    return report({ ...base, state: 'loading', text: 'Waiting for the F1 TV player…' });
  }
  // rewound into a server's recording that can't be had (its timeline fetch failing): the way back
  // to the stream needs no server
  if (!S.timeline && !S.local && S.directBack && S.clock === 'edge' && S.delay != null) {
    const vn = C.videoNow(v, t);
    // (backInDirect takes the stream recorded here's walls: this PC's clock)
    const w = S.carry?.cid === S.cid ? S.carry.w - skewNow() + (vn.p - S.carry.p) : t - f1Lat(t, vn) + S.delay;
    if (backInDirect(t, w)) {
      goDirect(S.gen);
      return report({ ...base, state: 'syncing', text: 'Back to the stream…' });
    }
  }
  if (!S.timeline || !S.content || S.delay == null) {
    pauseAudio();
    return report({ ...base, state: S.error ? 'error' : 'loading', text: S.error || (S.local ? base.rec.text : '') || 'Connecting…' });
  }
  if (S.local) { // recorded here: live only, and only once there is something recorded
    if (S.clock !== 'edge') {
      pauseAudio();
      return report({ ...base, state: S.clockFinal ? 'none' : 'loading',
        text: S.clockFinal ? 'Without a fone server, commentary plays on live sessions only' : 'Waiting for the F1 TV player…' });
    }
    const who = rec.name || rec.label;
    if (!S.timeline.pieces.length) {
      // off air since the page opened, F1 TV rewound: the server's recording has what was on (and
      // back to the stream once the streamer is on air and F1 TV within it: backInDirect)
      const vn = C.videoNow(v, t);
      learnLive(t, vn); // (as liveTarget does)
      if (S.source === 'server' && rec.state === 'offline' && rewoundBy(t, vn) >= 2 * EDGE_STEP) {
        goServer(S.gen, true, 'off air here');
        return report({ ...base, state: 'syncing', text: "Off air: the server's recording…" });
      }
      pauseAudio();
      const state = rec.state === 'offline' ? 'none' : rec.state === 'error' ? 'error' : 'loading';
      return report({ ...base, state, text: rec.state === 'offline' ? `${who}: ${rec.text.toLowerCase()}` : rec.text || 'Connecting to the stream…', error: rec.err });
    }
    // The stream stopped coming in (off air, or nothing for LOCAL_IDLE s): no live edge to be
    // behind, so no lead either (auto-hold lets F1 TV go), and the panel says why. What was
    // recorded still plays when F1 TV is rewound into it.
    if (localIdle(rec, t)) {
      const vn = C.videoNow(v, t);
      const m = liveTarget(t, vn);
      const end = FoneLocal.playableEnd(FoneRecorder.buffer(S.stream));
      if (m == null || end == null || m > end - 3.5) { // (before auto-hold's zone, 3 s from the edge)
        pauseAudio();
        const text = rec.state === 'offline' ? `${who}: ${rec.text.toLowerCase()}` : `The stream stopped coming in${rec.err ? ` (${rec.err})` : ''}`;
        return report({ ...base, state: 'after', text, lead: null, error: rec.err, p: vn.p, at: t });
      }
    }
  }
  if (domainMismatch(v)) {
    pauseAudio();
    return report({ ...base, state: 'syncing', text: 'Re-syncing…' });
  }
  const vn = C.videoNow(v, t);
  if (clockLost(t, vn)) {
    pauseAudio();
    return report({ ...base, state: 'syncing', text: 'Re-syncing…' });
  }
  // (live with F1 TV's own clock: the time on its picture, the commentary's that much later)
  const E = S.clock === 'edge' && f1Clock(vn) != null ? f1Clock(vn) : C.eventTime(S.clock, S.content, vn.p, vn.seekEnd, t, { manualBase: S.manualBase });
  const W = E + S.delay;
  let map = C.mapWall(S.timeline.pieces, W);
  const liveM = S.clock === 'edge' ? liveTarget(t, vn) : null;
  dashClock(t, v, vn, E, liveM);
  if (S.clock === 'edge') {
    const m = liveM;
    base.leadAim = liveAllow() - slack(); // (auto-hold lets F1 TV go again near it)
    // (backInDirect takes the stream recorded here's walls, this PC's clock: the lock's moment is
    // the server's; without one, where F1 TV's picture puts it on this PC's)
    const lw = S.liveLock?.cid === S.cid ? lockWall(S.liveLock, vn) : null;
    const bw = lw != null ? lw - skewNow() : S.liveLock?.cid === S.cid ? null : t - f1Lat(t, vn) + S.delay;
    if (!S.local && S.directBack && backInDirect(t, bw)) {
      goDirect(S.gen);
      return report({ ...base, state: 'syncing', text: 'Back to the stream…' });
    }
    if (m != null) {
      const edge = commentaryEdge(t);
      if (edge != null && m > edge - 1) {
        pauseAudio();
        Object.assign(base, { E, W, lead: edge - slack() - m, error: S.error, fixes: fixStats(), p: vn.p, at: t });
        return report({ ...base, state: 'waiting', text: `Commentary ${Math.ceil(m - edge + 1)}s behind` });
      }
      const first = S.timeline.pieces[0], last = S.timeline.pieces[S.timeline.pieces.length - 1];
      map = first && m < first.m ? { state: 'before', wait: first.m - m }
        // past a recording that has ended: the streamer went off air (no audio to play there)
        : !S.local && !serverLive() && last && m >= last.m + last.d ? { state: 'after', past: m - last.m - last.d }
          // (the file of the piece holding m: past the newest's end, waiting at the edge, that one)
          : { state: 'ok', m, file: (S.timeline.pieces.find((x) => m >= x.m && m < x.m + x.d) || last)?.f ?? 0 };
      // rewound past what this browser has recorded, live from the stream: the server's recording
      // has it (more than the part of the lag a just-begun recording doesn't hold yet)
      if (map.state === 'before' && S.local && S.source === 'server'
        && map.wait > Math.max(0.5, (S.flBest ?? C.DEFAULT_LIVE_LATENCY) - S.delay + 2 - first.d)) {
        goServer(S.gen, true, 'rewound');
        return report({ ...base, state: 'syncing', text: "Rewound past this browser's recording: the server's…" });
      }
    } else if (S.liveLock?.gap != null) { // between two of a server's files (lockM): back in so long
      map = { state: 'gap', wait: S.liveLock.gap };
    }
  }
  // How much commentary exists ahead of the playhead (live only) — drives auto-hold.
  const edge = S.timeline.live && S.timeline.edge != null ? S.timeline.edge + (t - S.timeline.receivedAt) : null;
  const mEdge = S.clock === 'edge' && map.state === 'ok' ? commentaryEdge(t) : null;
  const lead = mEdge != null ? mEdge - slack() - map.m
    : S.clock !== 'edge' && edge != null ? edge - 2.5 - W : null; // 2.5 s: segment + refresh slack
  Object.assign(base, { E, W, lead, error: S.error, fixes: fixStats(), p: vn.p, at: t,
    rewound: S.clock === 'edge' ? Math.round(rewoundBy(t, vn) * 10) / 10 : null,
    // F1 TV behind live by its own clock (null: its player doesn't give it)
    f1Lat: S.clock === 'edge' && f1Clock(vn) != null ? Math.round(f1Lat(t, vn) * 100) / 100 : null });

  if (map.state !== 'ok') {
    pauseAudio();
    if (map.state === 'after' && (S.local || serverLive())) {
      return report({ ...base, state: 'waiting', text: `Commentary ${Math.ceil(map.past)}s behind` });
    }
    // F1 TV is live and the streamer isn't (yet, or any more: off air, or showing replays, 轮播)
    if (S.clock === 'edge' && !S.local && !serverLive() && (map.state === 'after' || map.state === 'none')) {
      const who = S.channel || 'The streamer';
      return report({ ...base, state: 'waiting', text: S.liveLock ? `${who} is off air` : `Waiting for ${who} to go live` });
    }
    const text = {
      none: 'No recording covers this session',
      before: S.local ? `Before the recording: it has the last ${fmtDur(base.rec.kept)}` : `Commentary starts in ${fmtDur(map.wait)}`,
      gap: `Stream dropped — back in ${fmtDur(map.wait)}`,
      after: 'Commentary recording ended',
    }[map.state];
    return report({ ...base, state: map.state, text });
  }

  S.lastTarget = map.m;
  base.file = S.local ? null : fileTitle(map.file);
  const pf = S.local ? null : S.timeline.files?.[map.file];
  S.pic = S.local ? { src: 'stream', stream: S.stream, gen: FoneRecorder.status().gen, m: map.m, rate: v.rate || 1, playing: !v.paused && !v.seeking && !v.waiting }
    : { src: 'server', server: S.base, file: pf?.id ?? null, media: pf?.offset != null ? map.m - pf.offset : null, m: map.m,
      rate: v.rate || 1, playing: !v.paused && !v.seeking && !v.waiting };
  // the streamer's sponsor clips, found by the server: not heard
  const ad = adAt(map.m);
  base.ad = ad?.name ?? null;
  // (back from a break, faded in over AD.FADE s rather than at once)
  if (ad) S.adSeenAt = t;
  const fade = S.adSeenAt != null ? Math.min(1, Math.max(0, (t - S.adSeenAt) / AD.FADE)) : 1;
  const vol = S.muted || ad ? 0 : Math.round(S.volume * fade * 1000) / 1000;
  if (audio.volume !== vol) audio.volume = vol;
  base.vol = vol;
  if (v.paused || v.seeking || v.waiting) {
    pauseAudio();
    if (!v.waiting) preSeek(map.m);
    return report({ ...base, state: v.paused ? 'paused' : 'buffering', text: v.paused ? 'Paused' : 'Buffering…' });
  }
  drive(map.m, v.rate || 1, v.src);
  const drift = audio.currentTime - map.m;
  Object.assign(base, { m: map.m, audioTime: audio.currentTime });
  const ok = !audio.paused && !audio.seeking && audio.readyState >= 3;
  // Hysteresis so the status doesn't flicker between "In sync" and "Syncing…"; off 1×, from what
  // the steering itself lets be there (it corrects only past FAST.SEEK × speed: at 2× a seek can
  // land 0.46 s off and stay, which isn't 'Syncing…' for ever).
  const a = Math.abs(drift), nominal = C.nominalRate(v.rate || 1);
  const syncIn = nominal === 1 ? LIVE.IN : Math.max(LIVE.IN, C.STEER.FAST.SEEK * nominal);
  S.synced = ok && (S.synced ? a < Math.max(LIVE.OUT, syncIn + 0.6) : a < syncIn);
  const liveText = S.clock === 'edge' && S.liveLock ? 'Live' : 'In sync';
  report({ ...base, state: S.synced ? 'sync' : 'syncing', text: S.synced ? liveText : 'Syncing…', drift });
}

setInterval(tick, 100);

function fmtDur(s) {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// ---- messages ------------------------------------------------------------------

function nudge(delta) {
  if (S.delay == null) return;
  S.delay = Math.round((S.delay + delta) * 100) / 100;
  diag('nudge', { delta, delay: S.delay });
  S.delaySource = S.local ? 'stream' : 'content';
  S.resync = true; // jump to the new position now
  if (S.liveLock) { // live: move the lock, don't re-derive it
    S.liveLock.m0 += delta;
    if (S.liveLock.w0 != null) S.liveLock.w0 += delta;
  }
  if (S.carry) S.carry.w += delta; // (a switch of source under way)
  clearTimeout(S.saveTimer);
  if (S.local) { // recorded here: kept in this browser, per stream
    try { localStorage.setItem(localDelayKey(), JSON.stringify({ delay: S.delay, at: Date.now(), v: 2 })); } catch { /* private mode */ }
    return;
  }
  const { cid, channel, clock, delay, base } = S; // (a re-attach may come before the save)
  if (!base) return;
  S.saveTimer = setTimeout(() => {
    fetch(`${base}/api/sync/${cid}`, {
      signal: AbortSignal.timeout(10000),
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel, clock: clock === 'edge' ? 'edge2' : clock, delay }), // (serverSync)
    }).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); })
      .catch((e) => { S.error = `save failed: ${e.message}`; });
  }, 800);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;
  if (msg.type === 'golive') { sendResponse(msg.tab === S.tab ? goLive(!!msg.holding, !!msg.chase, msg.pMax ?? null) : { handled: false }); return; }
  if (msg.type === 'relive') { // "Re-sync to live": re-anchor to the commentary's live edge
    diag('relive', { delay: S.delay, keep: msg.keep ?? null, clock: S.video?.utc0 != null });
    // (after fone's own feed switch: with F1 TV's clock the lock keeps to the picture as it is)
    if (Number.isFinite(msg.keep) && S.video?.utc0 != null) return;
    if (S.liveLock) S.liveLock.relock = true;
    S.minBehind = undefined;
    // `keep`: F1 TV that far behind its most live, still (after fone's own feed switch: only the
    // two feeds' live delays are re-measured, not your rewind, a pause or a hold before it)
    const vn = Number.isFinite(msg.keep) && S.video ? C.videoNow(S.video, now()) : null;
    S.minLagW = vn ? now() - vn.p - Math.max(0, msg.keep) : undefined;
    S.resync = true;
    return;
  }
  if (msg.type === 'video') {
    // Several F1 TV tabs: follow the one that's playing; don't flap between them.
    if (S.tab != null && msg.tab !== S.tab && S.video) {
      const currentAlive = now() - S.video.receivedAt < 2;
      const currentPlaying = currentAlive && !S.video.paused;
      if (currentPlaying || (currentAlive && msg.video.paused)) return;
    }
    const prev = S.video;
    S.video = { ...msg.video, receivedAt: now() };
    diagPlayer(prev, S.video);
    if (S.video.seekEnd == null) S.edgeSeenAt = null; // F1 TV's live edge: when it last stepped (edgePhase)
    else {
      S.edgeSeenAt ??= S.video.receivedAt;
      // (a step: the edge on by more than a second while F1 TV played on as usual, not a seek)
      const played = prev ? Math.abs((S.video.p - prev.p) - (S.video.paused ? 0 : (S.video.receivedAt - prev.receivedAt) * (prev.rate || 1))) < 1 : false;
      if (prev?.seekEnd != null && S.video.seekEnd - prev.seekEnd > 1) S[played ? 'edgeStepAt' : 'edgeMissAt'] = S.video.receivedAt;
      // F1 TV's player rebuilt (a new MSE handle, or a pause in its reports) with its content
      // position re-based: p and its edge jump together, the picture where it was (a seek moves p
      // alone). The lock (and the rest measured in p) moves with it, so the commentary goes on where
      // it was rather than jumping minutes back (2026-10-23, FP1: 585 s).
      // (with F1 TV's own clock on both, that clock says it: below)
      const rebuilt = prev && ((S.video.dx?.h ?? null) !== (prev.dx?.h ?? null) || S.video.receivedAt - prev.receivedAt > 1);
      let d = 0;
      if (rebuilt && prev.seekEnd != null && msg.cid === S.cid) {
        const exp = prev.paused ? 0 : (S.video.receivedAt - prev.receivedAt) * (prev.rate || 1);
        const dB = (S.video.seekEnd - S.video.p) - (prev.seekEnd - prev.p);
        d = (S.video.p - prev.p) - exp;
        if (!(Math.abs(d) > 20 && Math.abs(dB) < Math.abs(d) / 4)) d = 0;
      }
      if (d && (prev.utc0 == null || S.video.utc0 == null)) {
        if (S.liveLock) S.liveLock.p0 += d;
        if (S.carry) S.carry.p += d;
        if (S.minLagW != null) S.minLagW -= d;
        diag('rebase', { d: Math.round(d * 100) / 100 });
      }
      // F1 TV's own clock: the picture's time doesn't move when its content position is re-based,
      // so the lock (and the moment carried) keeps to the picture (the rewind: flBest, by the clock).
      // And how far behind that clock its reported edge is, per step (Go live's most recent).
      const u = S.video.utc0;
      if (u != null) S.clockAt = S.video.receivedAt;
      if (u != null && msg.cid === S.cid) {
        const L = S.liveLock;
        // (a lock made before its clock was known, as if F1 TV were where it usually starts: again,
        // by where it is; only one carried over from the other source's moment keeps that)
        if (L?.cid === S.cid) { if (L.u0 != null) L.p0 = L.u0 - u; else if (L.carried) L.u0 = u + L.p0; else L.relock = true; }
        const K = S.carry;
        if (K?.cid === S.cid) { if (K.u == null) K.u = u + K.p; else K.p = K.u - u; }
        // (another clock: a re-base, or another feed whose edge may be staler: those ages start over)
        if (S.upU != null && Math.abs(u - S.upU) > 0.05) S.upAges = [];
        S.upU = u;
        if (prev?.seekEnd == null || S.video.seekEnd - prev.seekEnd > 1 || !S.upAges?.length) {
          S.upAges = [...(S.upAges || []).filter(([at]) => S.video.receivedAt - at < GOLIVE.UP_WINDOW),
            [S.video.receivedAt, trueNow(S.video.at ?? S.video.receivedAt) - (u + S.video.seekEnd)]];
        }
      }
    }
    if (S.content && domainMismatch(S.video)) { S.clockFinal = false; decideClock(S.gen).catch(() => {}); }
    S.volume = msg.settings.volume;
    S.muted = msg.settings.muted;
    if (!!msg.settings.anticipate !== !!S.anticipate) {
      S.anticipate = !!msg.settings.anticipate;
      if (S.delaySource === 'measured' && S.sync) { S.delay = measuredDelay(S.sync); S.resync = true; }
    }
    const st = msg.settings;
    const key = `${msg.tab}|${msg.cid}|${msg.channel || ''}|${(st.servers || []).join(',')}|${st.source || ''}|${st.source === 'local' ? st.stream || '' : st.liveDirect === false ? 'server-live' : ''}`;
    if ((S.local || S.directBack) && key === S.key) { S.bufferMin = st.bufferMin; wantRecording(); } // still wanted (and the buffer's length)
    if (key !== S.key) attach(msg, key);
    // Paused, seeked or resumed: act now rather than on the next 100 ms tick (a quick
    // F1 TV seek can come and go between two ticks, skipping the silent pre-seek).
    else if (prev && (prev.paused !== S.video.paused || prev.seeking !== S.video.seeking || Math.abs(prev.p - S.video.p) > 1)) tick();
  } else if (msg.type === 'nudge') {
    nudge(msg.delta);
  } else if (msg.type === 'detach' && (msg.tab == null || msg.tab === S.tab)) {
    detach();
  }
});

// Test hook (headless e2e): read engine state without going through the page.
globalThis.__fone = { S, audio };
