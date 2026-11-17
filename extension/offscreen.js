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
  S.vod = null; // (a Bilibili replay playing)
  if (S.vodBlob) { URL.revokeObjectURL(S.vodBlob); S.vodBlob = null; }
  S.base = null; // picked again on attach (the settings may list another, or none)
  audio.pause();
  audio.removeAttribute('src');
  Object.assign(S, { liveLock: null, minBehind: undefined, minLagW: undefined, synced: false, dashDelay: null, dashDelayAt: 0, dashAt: 0, lbuf: null, contentBusy: false,
    key: null, content: null, clock: null, clockFinal: false, delay: null, timeline: null, playlist: null,
    error: null, lastTarget: null, manualBase: null, steer: C.newSteer(), resync: true, nominal: null,
    direct: null, room: null, directErrAt: null, directBack: false, directOff: false, offArmed: false, offAt: null, recheckAt: 0, serverSync: null, serverTl: null, adSeenAt: null, carry: null, serverMutes: null, mutesAt: 0, mutesBusy: false,
    edgeStepAt: null, edgeMissAt: null, edgeSeenAt: null, flBest: undefined, upAges: [], upU: null, screen: null, clockAt: null,
    snd: null, vhist: [] });
}

async function attach(msg, key) {
  detach();
  const gen = S.gen;
  const local = msg.settings.source === 'local';
  Object.assign(S, { key, tab: msg.tab, cid: msg.cid, channel: msg.channel || null, servers: msg.settings.servers || [],
    source: local ? 'local' : 'server', stream: local ? String(msg.settings.stream || '').trim() : null,
    soundOn: msg.settings.soundSync !== false, vhist: [] });
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
    // (the server's recording: its sound decoded here too; listened to by hand as well: a Bilibili
    // replay is found by it, and kept there by it only by sound)
    if (!S.local) sndStart();
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
  if (S.soundOn) sndStart();
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
  if (B !== S.lbuf) { S.lbuf = B; S.liveLock = null; S.resync = true; if (S.snd) sndReset('a new recording'); }
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
  if (S.soundOn) sndStart();
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
  sndStart(); // (the server's recording now: its own place, listened for again)
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
    if (S.snd) sndReset('another clock'); // (its place was the old clock's)
    vodStop(); // (a Bilibili replay was put on the old clock: found again on this one)
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

const VOD_ON = Symbol('a Bilibili replay'); // (refreshTimeline: the server's timeline set aside)
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
    // nothing of the server's covers this replay: the streamer's Bilibili replay of it (looked
    // for again a minute after a failure, VOD.NONE_AGAIN s after none was found: one published
    // since); the server's timeline stays out of it until it does
    if (S.vod && !vodWanted(tl)) vodStop();
    else if (S.vod || vodWanted(tl)) {
      const V = S.vod, t = now();
      if (!V || (V.state === 'error' && t - (V.failedAt ?? 0) > 60) || (V.state === 'none' && t - V.at > VOD.NONE_AGAIN)) vodBegin(gen);
      if (!S.timeline || !S.timeline.vod) { S.timeline = tl; S.playlist = null; }
      S.error = null;
      throw VOD_ON;
    }
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
    if (gen === S.gen && e !== VOD_ON) S.error = e.message || String(e);
  }
  if (gen === S.gen && !S.local) {
    const live = S.timeline && (S.timeline.live || !S.timeline.complete);
    // often while anything is live (the video too: the streamer going live shows up in seconds)
    S.timelineTimer = setTimeout(() => refreshTimeline(gen), live || !S.clockFinal || S.clock === 'edge' ? 3000 : 60000);
  }
}

function loadPlaylist(path, src = path && S.base + path) {
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
    xhrSetup: vodXhrSetup, // (a Bilibili replay's requests: to its signed URLs)
  });
  hls.on(Hls.Events.ERROR, (_, data) => {
    const t = now();
    if (t - (DG.hlsAt.get(data.details) || 0) > 1) {
      DG.hlsAt.set(data.details, t);
      diag('hls', { kind: data.type, details: data.details, fatal: !!data.fatal, at: Math.round(audio.currentTime * 10) / 10 });
    }
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) vodFailed(data.frag?.url || data.context?.url); // (the next mirror)
    if (!data.fatal) return;
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
    else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
    else setTimeout(() => { if (S.hls === hls) loadPlaylist(path, src); }, 2000);
  });
  hls.loadSource(src);
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
// (`slew`: sync by sound's eased correction, the target moving that much faster or slower than
// the picture: the audio follows at that speed, resampled, no seek; sndSteer)
function drive(target, rate, src, slew = 0) {
  const nominal = C.nominalRate(rate);
  // rate is the speed someone chose (FoneCore.chosenRate), never F1 TV's trim; following a
  // change of it is counted apart from the corrections. It reaches us a few hundred ms after
  // the picture changed speed, and off 1× nothing nudges the audio back (only seeks past
  // 0.3 s), so re-lock right away: one seek at the button press beats trailing by ~0.25 s.
  const speedChange = S.nominal != null && nominal !== S.nominal;
  S.nominal = nominal;
  const k0 = S.steer?.k || 0;
  let { st, rate: r, seek } = C.steer(S.steer, {
    t: performance.now() / 1000,
    m: target,
    rate: nominal,
    slew,
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
    if (slew && S.snd) { S.snd.v = 0; r = nominal; } // (sync by sound's easing: back to 1x under cover of the seek)
  }
  if (audio.playbackRate !== r) audio.playbackRate = r;
  // (the steering's own corrections: not the easing's speed, which moves every tick)
  if (!speedChange && (st.k || 0) !== k0) countFix('rates');
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
    if (B && L.edgeRef != null && t - L.at < 90 && S.snd?.target == null) { // (by sound: the sound says)
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

// ---- sync by sound -------------------------------------------------------------------
// The streamer passes F1 TV's own sound through (its track sound, or the international feed's)
// under their voice, so where that sound sits in their stream says, to the sample, which moment of
// the stream goes with which picture: no delay to tune by ear, and it follows the streamer's own
// latency as it moves (their player stalling; 2026-11-01 it moved 4.4 s over one race). F1 TV's
// sound comes from audiotap.js (heard at wall times, put on F1 TV's position by the video reports);
// the stream's is decoded from what this browser records (live from the stream). Every SND.EVERY s
// the newest SND.WIN s of F1 TV's sound is looked for in the stream (FoneSound.locate): widely
// (±SND.WIDE s) until it's found, every SND.REWIDE s, and after two looks that missed (the
// streamer's latency stepped further than a close look sees); otherwise close by (±SND.NEAR s).
// A match counts when it's sure (score) and agrees with another of the last few (SND.AGREE s);
// then the commentary is brought there without a seek: its speed eased off 1× and back, no faster
// than SND.AMAX a second, to SND.VMAX at most, slowing so as to stop just there (0.6 s takes under
// a minute, 3 s about three; the pitch moves a third of a semitone at most). Jumped there instead:
// the first time it's found more than SND.JUMP s off (the delay it started from was a guess), and
// a step of more than SND.JUMP_LATER s (minutes of easing, out of sync all along). No sure match
// for SND.LOST s: lost, the delay holds and it listens again. A nudge of yours on top of where the
// sound puts it is kept (bias, per stream); one while it's still easing there takes from that first.
const SND = { EVERY: 15, WIN: 25, WIDE: 25, FAR: 240, NEAR: 4, REWIDE: 300, MISSES: 2, SCORE: 8, NEXT: 1.6, AGREE: 0.08, KEEP: 75, SPLICE: 0.02, BREAK: 1,
  VMAX: 0.02, AMAX: 0.001, JUMP: 1.5, JUMP_LATER: 3, LOST: 600, DEAF: 30, SR: 8000, DECODE_LAG: 0, SOON: 5, QUICK: 3, RESYNC_MAX: 90 };
// (SOON: the look after one that found it moved; QUICK: looks this often while a resync asked for
// looks for it, given up after RESYNC_MAX s)
// (a Bilibili replay's own: the streamer's setup then may not be theirs now)
const sndBiasKey = () => `soundBias|${S.timeline?.vod ? `vod:${S.timeline.vod}` : S.local && S.stream ? FoneStreams.parse(S.stream).key : `channel:${S.channel}`}`;
// (and whether its stream has been heard to carry F1 TV's sound: F1 TV's own ducked from the start)
const sndCarriesKey = () => sndBiasKey().replace('soundBias|', 'soundCarries|');
// (the stream recorded here: its nudge bias read back)
function sndStart() {
  let bias = 0, carries = false;
  try { bias = Number(JSON.parse(localStorage.getItem(sndBiasKey()) || 'null')?.bias) || 0; } catch { /* none */ }
  try { carries = localStorage.getItem(sndCarriesKey()) != null; } catch { /* none */ }
  S.snd = { bias, carries };
  sndReset('start');
}
// (a speed still easing carries over: it's let down gently, sndSteer)
function sndReset(why) {
  const bias = S.snd?.bias ?? 0, v = S.snd?.v ?? 0, carries = !!S.snd?.carries;
  S.snd = { runs: [], est: [], target: null, v, at: null, lock: S.liveLock, measAt: 0, wideAt: 0, miss: 0, accepted: 0, okAt: null,
    heardAt: null, seen: null, busy: false, startedAt: now(), bias, carries, state: 'listening', last: null, why: why || null };
}
// The video reports kept a while: where F1 TV's picture was at a wall time.
function vAt(w) {
  const h = S.vhist || [];
  for (let i = h.length - 1; i >= 0; i--) {
    const a = h[i];
    if (a.at > w) continue;
    const b = h[i + 1];
    if (a.paused || a.seeking || a.waiting || Math.abs((a.rate || 1) - 1) > 0.001) return null;
    if (b) { // (both ends playing on, nothing between them but time)
      if (b.paused || b.seeking || b.waiting || Math.abs((b.p - a.p) - (b.at - a.at)) > 0.08) return null;
    } else if (w - a.at > 1.5) return null;
    // (between two reports, at the pace the picture really went: F1 TV trims its player's speed by
    // a few % for seconds at a time to keep its sound and picture together)
    return b ? a.p + (w - a.at) * ((b.p - a.p) / (b.at - a.at)) : a.p + (w - a.at);
  }
  return null;
}
// F1 TV's sound as heard: put on F1 TV's position, joined into runs that follow on. A run's place
// is the average of where its pieces put it (each piece's, from the reports, is a few ms off). A
// piece that jumps (F1 TV's sound skipping or repeating a little, SND.SPLICE s and more, up to
// SND.BREAK) is spliced in where it belongs: what was skipped as silence, what came again cut;
// the run goes on (a break costs SND.WIN s of listening before the next look).
function sndHeard(msg) {
  const sn = S.snd;
  if (!sn || msg.sr !== SND.SR) return;
  for (const c of msg.chunks || []) {
    const p0 = vAt(c.w);
    if (p0 == null) continue;
    const bin = atob(c.b64), pcm = new Int16Array(bin.length >> 1);
    for (let i = 0; i < pcm.length; i++) pcm[i] = (bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8)) << 16 >> 16;
    let x = Float32Array.from(pcm, (v) => v / 32768);
    // F1 TV's sound as its player played it, sped up or slowed by those trims: put back on the
    // picture's own time (resampled to the stretch of picture it went with), so a run's samples
    // are the picture's time at SND.SR, whatever the trims did
    const p1 = vAt(c.w + x.length / SND.SR);
    if (p1 != null) {
      const ratio = (p1 - p0) / (x.length / SND.SR);
      if (ratio > 0.85 && ratio < 1.15 && Math.abs(ratio - 1) > 0.002) {
        const m = Math.max(1, Math.round(x.length * ratio)), y = new Float32Array(m), k = (x.length - 1) / Math.max(1, m - 1);
        for (let i = 0; i < m; i++) { const j = i * k, j0 = Math.floor(j), f = j - j0; y[i] = x[j0] * (1 - f) + (x[Math.min(x.length - 1, j0 + 1)] * f); }
        x = y;
      }
    }
    const runs = sn.runs, r = runs[runs.length - 1];
    const d = r ? p0 - (r.p0 + r.x.length / SND.SR) : null; // (> 0: this piece starts after the run's end)
    if (r && Math.abs(d) < SND.BREAK) {
      const jump = Math.abs(d) >= SND.SPLICE;
      // (a jump: the run's end moved to where this piece starts, padded or cut)
      const keep = jump && d < 0 ? Math.max(0, r.x.length - Math.round(-d * SND.SR)) : r.x.length;
      const pad = jump && d > 0 ? Math.round(d * SND.SR) : 0;
      const y = new Float32Array(keep + pad + x.length);
      y.set(r.x.subarray(0, keep)); y.set(x, keep + pad);
      const was = jump ? 0 : -d; // (how far this piece puts the run's end from where it was)
      r.x = y.length > SND.KEEP * SND.SR ? y.subarray(y.length - SND.KEEP * SND.SR) : y;
      r.n += x.length;
      if (jump) { r.pieces = 1; sn.splices = (sn.splices || 0) + 1; sn.gap = Math.round(d * 1000); }
      r.p0 = p0 + x.length / SND.SR - r.x.length / SND.SR + was * (1 - 1 / Math.min(r.pieces = (r.pieces || 1) + 1, 10));
    } else {
      if (r) { sn.breaks = (sn.breaks || 0) + 1; sn.gap = Math.round(d * 1000); } // (ms, for the status)
      runs.push({ p0, x, n: x.length, pieces: 1 });
    }
    while (runs.length > 4) runs.shift();
    sn.heardAt = now();
  }
}
// The stream's sound from m to m + d, as recorded here: decoded (the stored AAC frames as an
// ADTS file), 8 kHz mono; {m0: where it starts, y}. (Where it starts read before the decode: the
// recorder drops old chunks from the front of the same list meanwhile.)
async function streamSound(B, m, d) {
  const cs = B.chunks, i0 = Math.max(0, FoneLocal.chunkAt(B, m)), out = [];
  if (!cs.length || !cs[i0]) return null;
  const m0 = cs[i0].m;
  let len = 0;
  for (let i = i0; i < cs.length && cs[i].m < m + d; i++) { out.push(cs[i].data); len += cs[i].data.length; }
  if (!out.length) return null;
  const bytes = new Uint8Array(len);
  let k = 0;
  for (const b of out) { bytes.set(b, k); k += b.length; }
  const ab = await new OfflineAudioContext(1, 1, SND.SR).decodeAudioData(bytes.buffer);
  const y = new Float32Array(ab.length);
  for (let c = 0; c < ab.numberOfChannels; c++) { const ch = ab.getChannelData(c); for (let i = 0; i < y.length; i++) y[i] += ch[i] / ab.numberOfChannels; }
  return { m0: m0 + SND.DECODE_LAG, y };
}
// A server's recording's sound from m to m + d (its HLS segments, as hls.js plays them, on its
// media time): fetched (the last few kept), the AAC frames out of the MPEG-TS, decoded the same way.
// Each segment's frames go where hls.js plays that segment (its start): a hole before it filled
// with silent frames, an overlap with the one before skipped, so what follows isn't shifted.
const SEGS = new Map(); // url -> Promise<ADTS frames [{data, samples, rate}]>
async function serverSound(frags, m, d) {
  const sel = frags.filter((f) => f.start + f.duration > m && f.start < m + d);
  if (!sel.length) return null;
  const parts = [];
  let at = null, m0 = null;
  for (const f of sel) {
    let got = SEGS.get(f.url);
    if (!got) {
      got = fetch(f.url, { signal: AbortSignal.timeout(15000) })
        .then((r) => { if (!r.ok) throw new Error(`segment: HTTP ${r.status}`); return r.arrayBuffer(); })
        .then((ab) => FoneDemux.tsAudio(new Uint8Array(ab)).frames.map((x) => ({ data: x.data, samples: x.samples, rate: x.rate })));
      SEGS.set(f.url, got);
      got.catch(() => SEGS.delete(f.url));
      while (SEGS.size > 24) SEGS.delete(SEGS.keys().next().value);
    }
    const fr = await got;
    if (!fr.length) continue;
    const dur = fr[0].samples / fr[0].rate;
    if (at == null) { at = f.start; m0 = f.start; }
    const n = Math.round((f.start - at) / dur);
    let k = 0;
    if (n > 0) { // (a hole: silence up to this segment's start, 30 s at most)
      const h = FoneDemux.adtsAt(fr[0].data, 0), sil = h ? FoneDemux.silentFrame(h) : null;
      if (!sil || n * dur > 30) { if (parts.length) break; at = f.start; m0 = f.start; } else { for (let i = 0; i < n; i++) parts.push(sil); at += n * dur; }
    } else if (n < 0) k = Math.min(fr.length, -n); // (an overlap: what's there already)
    for (; k < fr.length; k++) { parts.push(fr[k].data); at += fr[k].samples / fr[k].rate; }
  }
  if (!parts.length) return null;
  const ab = await new OfflineAudioContext(1, 1, SND.SR).decodeAudioData(FoneDemux.concat(...parts).buffer);
  const y = new Float32Array(ab.length);
  for (let c = 0; c < ab.numberOfChannels; c++) { const ch = ab.getChannelData(c); for (let i = 0; i < y.length; i++) y[i] += ch[i] / ab.numberOfChannels; }
  return { m0: m0 + SND.DECODE_LAG, y };
}
// What the stream's sound can be read from: the stream recorded here, or the server's recording
// playing ({first, end} of what's there on the m axis, read(m, d)).
function sndSource() {
  if (S.local) {
    const B = FoneRecorder.buffer(S.stream);
    const end = B ? FoneLocal.playableEnd(B) : null, first = B?.chunks[0]?.m;
    return end == null || first == null ? null : { first, end, read: (m, d) => streamSound(B, m, d) };
  }
  if (S.timeline?.vod && S.vod?.cur) { // (a Bilibili replay: read from Bilibili)
    const r = S.vod.cur;
    return { first: 0, end: r.total, read: (m, d) => vodRead(r, m, d) };
  }
  const lv = S.hls?.levels?.[S.hls.currentLevel >= 0 ? S.hls.currentLevel : 0];
  const fr = lv?.details?.fragments;
  if (!fr?.length) return null;
  const last = fr[fr.length - 1];
  return { first: fr[0].start, end: last.start + last.duration, read: (m, d) => serverSound(fr, m, d) };
}
// Where the commentary sits against the picture: the stream's moment for picture p is p + cur
// (live: the lock's; a replay: the delay's mapping this tick, S.sndRef); err, how far the place the
// sound gave (sn.target: an offset on the lock live, a delay on a replay's clock) is from it.
function sndPlace() {
  const sn = S.snd, L = S.liveLock;
  if (S.clock === 'edge') {
    if (!L || !S.local) return null; // (live from a server's recording: not yet; its lock is re-placed by wall time)
    const cur = L.m0 - L.p0;
    return { live: true, cur, err: sn?.target != null ? sn.target - cur : 0 };
  }
  if (!S.sndRef || S.delay == null) return null;
  return { live: false, cur: S.sndRef.m - S.sndRef.p, err: sn?.target != null ? sn.target - S.delay : 0 };
}
// A replay's clock: the commentary's moment for picture p at a delay (null outside the recording).
const mAtDelay = (p, delay) => momentAt(C.eventTime(S.clock, S.content, p, null, now(), { manualBase: S.manualBase }) + delay);
// One look: the newest stretch of F1 TV's sound (older, when the newest would be looked for past
// what's recorded yet), found in the stream around where the sound was last (or the lock has it).
async function sndMeasure(t, vn) {
  // (15 s looks till it's found, quicker to a first lock; 25 s once locked: stronger matches)
  const WIN = S.snd?.target == null ? 15 : SND.WIN;
  const sn = S.snd, L = S.liveLock, pl = sndPlace(), src = sndSource();
  const r = sn.runs[sn.runs.length - 1];
  // (sn.why: what the last look came to, for the status and the diag)
  if (S.clock === 'edge' && !S.local) { sn.why = "live from the server's recording: not yet"; return; }
  if (!pl || !src || !r || r.x.length < WIN * SND.SR) { sn.why = !r || !pl || !src ? 'nothing to look in' : 'too little heard in one go'; return; }
  if (sn.seen?.r === r && sn.seen.n === r.n) { sn.why = 'nothing new heard'; return; }
  sn.seen = { r, n: r.n };
  // (a replay whose start is only a guess till it's found: F1 TV's F1 Academy, F2, F3 videos, no
  // session of F1's own to anchor them, F1's pre-roll borrowed: ±SND.FAR s. The streamer passes
  // those broadcasts on whole, picture and sound, so their sound is found strongly there)
  const guess = !pl.live && !S.timeline?.vod && S.clock === 'preroll' && S.content?.sessionKey == null && sn.target == null;
  const wide = sn.target == null || t - sn.wideAt > SND.REWIDE || sn.miss >= SND.MISSES, R = wide ? (guess ? SND.FAR : SND.WIDE) : SND.NEAR;
  // where the sound itself was, for picture p: at p + cAt(p) in the stream (live, the lock's offset;
  // a replay, the delay's mapping at p: it changes at the server's file boundaries)
  const cAt = (p) => {
    if (pl.live) return pl.cur + pl.err - sn.bias;
    const m = mAtDelay(p, (sn.target ?? S.delay) - sn.bias);
    return m == null ? null : m - p;
  };
  const { end, first } = src;
  const pNew0 = r.p0 + r.x.length / SND.SR - WIN, c = cAt(pNew0);
  if (c == null) { sn.why = 'not recorded there'; return; }
  // The newest stretch of F1 TV's sound; after a look that missed, every other look an older one
  // (as old as the run allows), so the look reaches R s past where it was within what's recorded:
  // the streamer's latency grown by more than the commentary's lead puts the newest out of reach.
  // (Not a silent one: F1 TV's sound may have started after the copy did.)
  const pEnd = r.p0 + r.x.length / SND.SR, pNew = pEnd - WIN;
  const stretch = (p) => { const i = Math.round((p - r.p0) * SND.SR); return r.x.subarray(i, i + WIN * SND.SR); };
  let pa = pNew, x = stretch(pNew);
  const pOld = Math.max(r.p0, Math.min(pNew, end - c - WIN - R));
  // (also when the newest one's window would be cut short by what's recorded: no look, no miss)
  if ((sn.miss % 2 === 1 || end - (pNew + c - R) < WIN + 2) && pOld < pNew - 1) {
    const xo = stretch(pOld);
    if (FoneSound.rms(xo) >= 1e-4) { pa = pOld; x = xo; }
  }
  // (F1 TV silent: muted in its own player, or nothing on its sound)
  if (FoneSound.rms(x) < 1e-4) { sn.state = 'quiet'; sn.why = 'F1 TV silent'; return; }
  const ca = cAt(pa);
  if (ca == null) { sn.why = 'not recorded there'; return; }
  const lo = Math.max(first, pa + ca - R), hi = Math.min(end, pa + ca + WIN + R);
  if (!(hi - lo >= WIN + 2)) { sn.why = 'not recorded there'; return; }
  sn.busy = true;
  try {
    const PL = S.playlist, got = await src.read(lo, hi - lo);
    if (!got || S.snd !== sn || S.liveLock !== L || S.playlist !== PL) { sn.why = 'moved on while decoding'; return; }
    const f = wide ? 2 : 1, sr = SND.SR / f;
    const y = FoneSound.decimate(got.y, f), xx = FoneSound.decimate(x, f);
    const res = FoneSound.locate(xx, y, sr);
    if (!res) { sn.why = 'no match computed'; return; }
    if (wide) sn.wideAt = t;
    const off = got.m0 + res.lag / sr - pa; // where F1 TV's sound for picture p is in the stream: p + off
    // What it says, in the place's own terms: live, that offset on the lock; a replay, the delay
    // that maps picture pa onto the moment found (read at pa: whatever plays now, wherever)
    let val = off;
    if (!pl.live) {
      const w = C.wallOf(S.timeline?.pieces, pa + off);
      val = w == null ? null : w - C.eventTime(S.clock, S.content, pa, null, t, { manualBase: S.manualBase });
    }
    const sure = val != null && res.score >= SND.SCORE && res.score >= SND.NEXT * res.next && !res.edge;
    sn.last = { at: t, off, val, score: Math.round(res.score * 10) / 10, next: Math.round(res.next * 10) / 10, sure, wide };
    const r2 = (v) => (v == null ? null : Math.round(v * 1000) / 1000);
    diag('sound', { off: r2(off), val: r2(val), score: sn.last.score, next: sn.last.next, sure, wide, c: r2(ca) });
    sn.state = sn.target != null ? 'locked' : 'listening';
    if (!sure) { sn.miss++; sn.why = 'not sure'; return; }
    // (found well away from where it was: look widely again till that's confirmed, and soon: the
    // commentary is that far off till then)
    const far = sn.target != null && Math.abs(val + sn.bias - sn.target) > 1;
    sn.miss = far ? SND.MISSES : 0;
    if (far) sn.measAt = Math.min(sn.measAt, t - SND.EVERY + SND.SOON);
    sn.est = [...sn.est.filter((e) => t - e.at < 180), { at: t, val }].slice(-4);
    const agree = sn.est.filter((e) => Math.abs(e.val - val) <= SND.AGREE);
    // (resync asked for: the first sure match will do)
    const quick = sn.quick != null;
    if (agree.length < 2 && !quick) { sn.why = 'waiting for a second match'; return; }
    sn.miss = 0;
    sn.why = quick ? 'resynced' : 'matched';
    const o = quick ? val : agree.map((e) => e.val).sort((a, b) => a - b)[agree.length >> 1];
    const now_ = sndPlace(); // (where it sits now: an easing may have moved it meanwhile)
    if (!now_) return;
    // (live: an offset on the lock, from where the lock is; a replay: the delay that puts it there)
    const want = o + sn.bias, err = now_.live ? want - now_.cur : want - S.delay;
    const fresh = sn.target == null;
    sn.target = want;
    sn.state = 'locked';
    sn.okAt = t;
    if (!sn.carries) { sn.carries = true; try { localStorage.setItem(sndCarriesKey(), String(Date.now())); } catch { /* private mode */ } }
    // found the first time far off (the delay was a guess), or a step too big to ease: there at
    // once (a resync: there at once, unless it's already there)
    if (Math.abs(err) > (quick ? 0.05 : fresh ? SND.JUMP : SND.JUMP_LATER)) {
      shiftCommentary(err, true);
      diag('sound', { jump: r2(err), resync: quick || undefined });
    }
    if (quick) {
      sn.quick = null;
      sn.resyncedAt = t;
      // by hand: a resync places it once, then it's yours again (the delay it set, to nudge)
      if (!S.soundOn) Object.assign(sn, { target: null, est: [], state: 'off', why: 'by hand' });
    }
    sn.accepted++;
    // the delay that puts it there (what relocks use, and the panel shows), kept: for the stream
    // recorded here, or the server's for this video (and the channel's live, as a nudge is)
    const B = S.local ? FoneRecorder.buffer(S.stream) : null, edge = B ? FoneLocal.liveEdge(B, t) : null;
    if (now_.live && edge != null) S.delay = Math.round((f1Lat(t, vn) - (edge - (vn.p + want))) * 100) / 100;
    S.delaySource = 'sound';
    if (t - (sn.savedAt || 0) > 120) {
      sn.savedAt = t;
      if (S.local) {
        try { localStorage.setItem(localDelayKey(), JSON.stringify({ delay: S.delay, at: Date.now(), v: 2, by: 'sound' })); } catch { /* private mode */ }
      } else if (S.timeline?.vod) vodSave(sn.target); // (a Bilibili replay: kept here, for this video)
      else saveServerDelay(sn.target); // (a replay: the delay it's easing to)
    }
  } catch (e) {
    sn.why = `failed: ${String(e?.message || e).slice(0, 80)}`;
    diag('sound', { err: String(e?.message || e).slice(0, 120) });
  } finally {
    sn.busy = false;
  }
}
// How it stands, each tick: F1 TV's sound not reaching fone (deaf), or no sure match for a while
// (lost: no target, so no easing, nudges plain again; the delay the last match set holds).
function sndCheck(t, v) {
  const sn = S.snd;
  if (!sn) return;
  // (time F1 TV isn't playing at 1× doesn't count: nothing is heard or looked for then)
  if (v.paused || v.seeking || v.waiting || Math.abs((v.rate || 1) - 1) > 0.001) { sn.stillAt ??= t; return; }
  if (sn.stillAt != null) {
    const d = t - sn.stillAt;
    sn.stillAt = null;
    if (sn.okAt != null) sn.okAt += d;
    if (sn.heardAt != null) sn.heardAt += d; else sn.startedAt += d;
  }
  const deaf = t - (sn.heardAt ?? sn.startedAt) > SND.DEAF;
  if (deaf) sn.state = 'deaf';
  else if (sn.state === 'deaf') sn.state = sn.target != null ? 'locked' : 'listening';
  if (sn.target != null && t - sn.okAt > SND.LOST) {
    Object.assign(sn, { target: null, est: [], miss: 0, state: deaf ? 'deaf' : 'lost' });
    diag('sound', { lost: true });
  }
}
// The commentary moved by d s on the lock (live) or the delay (a replay's clock): `seek`, at once
// (the steering seeks), else as part of an eased correction (the speed carries it).
function shiftCommentary(d, seek) {
  if (S.clock === 'edge' && S.liveLock) {
    S.liveLock.m0 += d;
    if (S.liveLock.w0 != null) S.liveLock.w0 += d;
  } else if (S.delay != null) S.delay += d;
  if (S.carry) S.carry.w += d;
  if (seek) S.resync = true;
}
// Each tick: the eased correction's speed (0 when there's none, or the picture isn't playing). A
// seek (a re-sync, a nudge, a jump: drive) or a new lock takes the speed back to 1× under cover of
// it; a correction cut short (lost, reset) is let down at SND.AMAX, not dropped (that's heard).
function sndSteer(t, v) {
  const sn = S.snd, L = S.liveLock, pl = sndPlace();
  const dt = sn?.at != null ? Math.min(0.5, Math.max(0, t - sn.at)) : 0;
  if (sn) sn.at = t;
  if (!sn || !S.soundOn || !pl || v.paused || v.seeking || v.waiting || Math.abs((v.rate || 1) - 1) > 0.001 || (pl.live && sn.lock !== L)) {
    if (sn) { sn.v = 0; sn.lock = L; }
    return 0;
  }
  // (the speed that still stops in time: v² = 2·AMAX·distance)
  const err = sn.target != null ? pl.err : 0;
  const want = sn.target != null ? Math.sign(err) * Math.min(SND.VMAX, Math.sqrt(2 * SND.AMAX * Math.abs(err))) : 0;
  sn.v += Math.max(-SND.AMAX * dt, Math.min(SND.AMAX * dt, want - sn.v));
  if (Math.abs(err) < 0.005 && Math.abs(sn.v) < 0.002) sn.v = 0;
  if (sn.v) shiftCommentary(sn.v * dt, false);
  return sn.v;
}

// ---- the streamer's Bilibili replays: replays no recording covers ---------------------------
// A fone server keeps its recordings for weeks; the streamer's Bilibili replays (直播回放) stay up
// for years. A replay the server has nothing for plays the replay of the channel's Bilibili room
// that holds it (vod.js), streamed from Bilibili. Its title says only which hour the streamer went
// live in, so where this moment is in it is found by sound: the newest VOD.WIN s of F1 TV's sound
// heard, which the streamer passes through, looked for over that hour plus the streamer's delay in
// each replay that may hold it (VOD.CHUNK s at a time, VOD.PAR at once, at 4 kHz, nearest the
// likeliest place first; what's fetched kept as 16-bit while it looks); after VOD.FULL misses, all
// of each replay now and then. A sure match (VOD.SCORE, VOD.RATIO over anything else), or a likely
// place found again by the sound heard after it, puts the replay on the wall clock so that the
// delay reads VOD.D0 as on a recording's, and sync by sound keeps it there as on any replay. Where it was put is kept for
// this video and replay, and the replay's ~5 s repeats (FoneVod.findCuts) for the replay. Sync by
// sound not confirming it in VOD.CONFIRM looks: looked for again, playing on meanwhile (then every
// VOD.AGAIN s while it still doesn't). Off the end of one replay (the streamer restarted): the
// next, found the same way. With a fone server: first and foremost by the clock on the streamer's
// screen (their MultiViewer header, the session and its clock: when the session's clock showed
// that is the event time on their screen there; vodclock.py reads it), sound then taking it the
// last second; sound alone, over the hour, only without one (or no clock on their screen).
// (real matches, 2026-11-11, 4 kHz: a median 14, a tenth under 8.1; the runner-up 4-7 over ±25 s)
// (WIN..WIN_MAX s of F1 TV's sound, a look every STEP s more of it; the replay fetched and decoded
// meanwhile, while it listens: a look is then only the sums, a few seconds)
const VOD = { WIN: 15, WIN_MAX: 30, STEP: 8, FULL: 5, FULL_EVERY: 8, KEEP: 30, CHUNK: 200, PAR: 3, F: 2, D0: 50, RETRY: 20, SCORE: 9.5, RATIO: 1.5, SURE: 14,
  WEAK: 7, AGREE: 0.3, VERIFY: 6.5, NEAR: 3, FRESH: 12, CANDS: 8, CONFIRM: 8, AGAIN: 600, URL: 'https://vod.fone.invalid/', AHEAD: 75, SCAN: 60,
  CLOCK_POLL: 3, CLOCK_AGAIN: 20, CLOCK_WAIT: 300, SCREEN: 1.5, CLOCK_NEAR: 240, TRUST: 15, BOUND: 120, RELOAD: 60, RELOAD_MAX: 1800,
  SCAN_WAIT: 30, SCAN_WAIT_MAX: 300, NONE_AGAIN: 300 };
// (RELOAD: a replay that wouldn't load tried again this many s on, twice as long each time to RELOAD_MAX)
// (the clock on the streamer's screen, read by a fone server: vodClock*. CLOCK_POLL s between asks
// while it reads, CLOCK_AGAIN for a reading near a new moment; sound waits CLOCK_WAIT s for it
// (unless sure at once). SCREEN: their screen's clock runs this far ahead of the sound they pass
// on (2026 Italian GP race: 1.2 and 1.7 s). A reading within CLOCK_NEAR s of the moment rules:
// where it plays is moved there when TRUST s off it (more than sync by sound's own drift); one
// further away only bounds sound to BOUND s of where it says)
// (AHEAD: repeats looked for this far ahead of what plays, SCAN s of the replay a look)
// (a look that isn't sure keeps its likeliest places, FoneVod.keepLikely: each checked against
// the F1 TV sound heard after it, VOD.FRESH s at least, VOD.VERIFY at where it says, as F1 TV
// plays on. Real matches, 2026-11-16, Track FX against 胡闹P房's 2026 Italian GP replay: 11.8
// at the formation lap, under 7 for a minute, then 10.9, 13.6, 23.6, all at the same place; the
// best elsewhere 6-7 over the hour, 9-10 over all 6 h of it)
function vodWanted(tl) {
  const c = S.content;
  if (!S.room || !c || c.p0 == null || !['preroll', 'multiviewer'].includes(S.clock) || !S.clockFinal) return false;
  const E0 = c.p0, E1 = c.p0 + (c.duration || 4 * 3600);
  return !(tl?.pieces || []).some((pc) => pc.w < E1 + 600 && pc.w + pc.d > E0);
}
const vodSay = (V, state, text) => { V.state = state; V.text = text; };
const vodWho = () => S.channel || 'the streamer';
function vodListenText(sn) {
  if (!sn) return `No recording covers this session: turn on Sync by sound and fone finds this moment in ${vodWho()}'s Bilibili replay`;
  if (sn.state === 'quiet') return `F1 TV is silent: turn its sound on, and fone finds this moment in ${vodWho()}'s Bilibili replay`;
  if (sn.state === 'deaf') return `F1 TV's sound isn't reaching fone (reload the page?): it finds this moment in ${vodWho()}'s replay by it`;
  return `Listening to F1 TV to find this moment in ${vodWho()}'s Bilibili replay…`;
}
async function vodBegin(gen) {
  const V = S.vod = { state: 'finding', text: `Looking for ${vodWho()}'s Bilibili replay of this session…`, reps: [], cur: null,
    tries: 0, checks: 0, cands: [], chunks: new Map(), busy: false, lastTryAt: null, at: now(), unloaded: [] };
  try {
    const room = /(\d+)\/?$/.exec(S.room)?.[1];
    if (!room) throw new Error('no Bilibili room');
    const who = await FoneVod.owner(room);
    const c = S.content, E0 = c.p0, E1 = c.p0 + (c.duration || 4 * 3600);
    const list = await FoneVod.replays(who, E0 - 86400);
    if (gen !== S.gen || S.vod !== V) return;
    const cands = FoneVod.candidates(list, E0, E1);
    diag('vod', { found: cands.map((r) => ({ bvid: r.bvid, slot: r.slot, dur: r.dur })), list: list.length });
    if (!cands.length) return vodSay(V, 'none', `No recording covers this session, nor any Bilibili replay of ${vodWho()}'s`);
    const reps = await vodLoad(V, cands);
    if (gen !== S.gen || S.vod !== V) return;
    if (!reps.length) throw V.loadErr;
    V.reps = reps;
    vodCuts(V, gen);
    reps.forEach(vodClockKept);
    const kept = vodKept(V);
    if (kept) return vodPlace(V, kept.rep, kept.T0, kept.delay, 'kept', Number(kept.hand) || 0);
    vodSay(V, 'listening', vodListenText(S.snd));
  } catch (e) {
    if (S.vod !== V) return;
    vodSay(V, 'error', `${vodWho()}'s Bilibili replay: ${e.message || e}`);
    V.failedAt = now();
    diag('vod', { err: String(e?.message || e).slice(0, 160) });
  }
}
// The replays that may hold it, each loaded on its own: one that won't (taken down, still being
// transcoded, its sound not AAC, a 412) doesn't keep the others from being used; it's tried again
// in a while (vodLoadMore). Those that loaded, by time.
async function vodLoad(V, cands) {
  const ok = [];
  for (const r of cands) {
    try {
      await FoneVod.load(r);
      ok.push(r);
    } catch (e) {
      V.unloaded.push(r);
      V.loadErr = e;
      diag('vod', { loadErr: r.bvid, err: String(e?.message || e).slice(0, 120) });
    }
  }
  if (V.unloaded.length) V.loadNext = now() + (V.loadWait = VOD.RELOAD);
  return ok;
}
async function vodLoadMore(V, gen) {
  V.loading = true;
  const wait = Math.min(VOD.RELOAD_MAX, 2 * (V.loadWait || VOD.RELOAD));
  try {
    const got = await vodLoad(V, V.unloaded.splice(0));
    if (gen !== S.gen || S.vod !== V || !got.length) return;
    V.reps = [...V.reps, ...got].sort((a, b) => a.slot - b.slot);
    got.forEach(vodClockKept);
    diag('vod', { loaded: got.map((r) => r.bvid) });
    vodCuts(V, gen);
  } finally {
    V.loading = false;
    if (V.unloaded.length) V.loadNext = now() + (V.loadWait = wait);
  }
}
function vodStop() {
  if (!S.vod) return;
  S.vod = null;
  if (S.timeline?.vod) { S.timeline = null; S.playlist = null; if (S.hls) { S.hls.destroy(); S.hls = null; } }
  if (S.vodBlob) { URL.revokeObjectURL(S.vodBlob); S.vodBlob = null; }
}
// Page i of replay r's AAC frames from t0 to t1 s (whole segments, by one range request).
async function vodFrames(r, i, t0, t1) {
  const pg = r.pages[i], a0 = Math.max(0, t0);
  const [k0, k1] = FoneVod.segRange(pg.segs, a0, Math.max(0, t1 - a0));
  if (k1 <= k0) return [];
  const b = await FoneVod.range(pg, pg.segs[k0].off, pg.segs[k1 - 1].off + pg.segs[k1 - 1].len - 1, r);
  return FoneDemux.mp4Audio(b, pg.initInfo).frames;
}
// Replay r's sound from m to m + d (within the page holding m), decoded 8 kHz mono: {m0, y}.
async function vodRead(r, m, d) {
  let off = 0, i = 0;
  while (i < r.pages.length - 1 && m >= off + r.pages[i].dur) off += r.pages[i++].dur;
  const fr = await vodFrames(r, i, m - off, Math.min(r.pages[i].dur, m + d - off));
  if (!fr.length) return null;
  const ab = await new OfflineAudioContext(1, 1, SND.SR).decodeAudioData(FoneDemux.concat(...fr.map((f) => f.data)).buffer);
  const y = new Float32Array(ab.length);
  for (let c = 0; c < ab.numberOfChannels; c++) { const ch = ab.getChannelData(c); for (let k = 0; k < y.length; k++) y[k] += ch[k] / ab.numberOfChannels; }
  return { m0: off + fr[0].t + SND.DECODE_LAG, y };
}
// The replays' ~5 s repeats, found once (kept by replay), in the background: the one playing is
// put on its timeline again with the moment playing where it was.
async function vodCuts(V, gen) {
  for (const r of [...V.reps]) {
    if (r.cutsDone || r.cutting) continue; // (another's looking: a replay loaded later started one)
    r.cutting = true;
    try {
      const joins = await FoneVod.findCuts(r, (i, t0, t1) => vodFrames(r, i, t0, t1));
      // (with the ones found ahead of playing meanwhile, where they aren't a join's)
      const ahead = r.cuts.filter((c) => c.ahead && !joins.some((j) => c.m < j.m + j.d + 1 && c.m + c.d > j.m - 1));
      r.cuts = [...joins, ...ahead].sort((a, b) => a.m - b.m);
      r.cutsDone = true;
      FoneVod.store.set(`vodCuts|${r.bvid}`, { cuts: r.cuts, at: Date.now(), joins: true });
      diag('vod', { cuts: r.bvid, n: r.cuts.length, assumed: r.cuts.filter((c) => c.assumed).length });
    } catch (e) {
      diag('vod', { cutsErr: String(e?.message || e).slice(0, 120) });
      return;
    } finally {
      r.cutting = false;
    }
    if (gen !== S.gen || S.vod !== V) return;
    if (V.cur === r && V.state === 'placed') { vodApply(V, true); vodSave(); }
  }
}
// Repeats away from the joins (Bilibili's recording now and then has a whole segment twice: the
// commentary heard twice, then 5 s late till sync by sound catches it), looked for a window at a
// time ahead of the moment playing, so it's cut before it's heard (kept with the joins').
// (failing, offline, Bilibili's 412: again VOD.SCAN_WAIT s on, twice as long each time to SCAN_WAIT_MAX)
async function vodScan(V, r, gen) {
  const a = r.scanTo, b = Math.min(r.total, a + VOD.SCAN);
  try {
    const c = await FoneVod.scanRepeat(r, (i, t0, t1) => vodFrames(r, i, t0, t1), a, b, r.cuts);
    r.scanWait = 0;
    if (r.scanTo === a) r.scanTo = b >= r.total ? r.total : b - 15; // (overlapping by more than a repeat is long)
    if (!c || gen !== S.gen || S.vod !== V) return;
    r.cuts = [...r.cuts, c].sort((x, y) => x.m - y.m);
    FoneVod.store.set(`vodCuts|${r.bvid}`, { cuts: r.cuts, at: Date.now(), joins: !!r.cutsDone });
    diag('vod', { ahead: c });
    if (V.cur === r && V.state === 'placed') { vodApply(V, true); vodSave(); }
  } catch (e) {
    r.scanWait = Math.min(VOD.SCAN_WAIT_MAX, r.scanWait ? 2 * r.scanWait : VOD.SCAN_WAIT);
    r.scanNext = now() + r.scanWait;
    diag('vod', { scanErr: String(e?.message || e).slice(0, 120), wait: r.scanWait });
  }
}
// The replay playing as the timeline (as a server's /api/timeline gives one) and its playlist.
// `keep`: the replay's repeats changed: the moment playing keeps its wall time.
function vodApply(V, keep = false) {
  const r = V.cur;
  if (keep && S.timeline?.vod === r.bvid && S.lastTarget != null) {
    const w = C.wallOf(S.timeline.pieces, S.lastTarget), w2 = C.wallOf(FoneVod.timeline(r, r.T0).pieces, S.lastTarget);
    if (w != null && w2 != null) r.T0 += w - w2;
  }
  const tl = FoneVod.timeline(r, r.T0);
  S.timeline = { ...tl, live: false, complete: true, edge: null, mutes: [], vod: r.bvid, playlist: `vod:${r.bvid}`, receivedAt: now() };
  if (S.playlist !== S.timeline.playlist) {
    if (S.vodBlob) URL.revokeObjectURL(S.vodBlob);
    S.vodBlob = URL.createObjectURL(new Blob([FoneVod.playlist(r, (i) => `${VOD.URL}${r.bvid}/${i}`)], { type: 'application/vnd.apple.mpegurl' }));
    loadPlaylist(S.timeline.playlist, S.vodBlob);
  }
}
// hls.js's requests for the replay: to the page's URL now (signed for a while, the mirror that works).
async function vodXhrSetup(xhr, url) {
  if (!url.startsWith(VOD.URL)) return;
  const [bvid, i] = url.slice(VOD.URL.length).split('/');
  const r = S.vod?.reps.find((x) => x.bvid === bvid), pg = r?.pages[+i];
  if (pg) xhr.open('GET', await FoneVod.urlOf(r, pg), true);
}
function vodFailed(url) {
  if (!url?.startsWith(VOD.URL)) return;
  const [bvid, i] = url.slice(VOD.URL.length).split('/');
  const pg = S.vod?.reps.find((x) => x.bvid === bvid)?.pages[+i];
  if (pg) FoneVod.failed(pg);
}
// `hand`: s of nudges in `delay` (vodClockOff leaves them out: yours on top of the clock's place;
// placed by sound, the nudge kept for its sound).
function vodPlace(V, r, T0, delay, how, hand = 0) {
  const was = V.state === 'placed' ? { r: V.cur, T0: V.cur?.T0, delay: S.delay } : null;
  r.T0 = T0;
  Object.assign(V, { cur: r, how, hand, placedAt: now(), looks0: S.snd?.looks || 0, rechecks: 0, chunks: new Map(), cands: [] });
  vodSay(V, 'placed', '');
  vodApply(V);
  // (a nudge on this replay's sound, kept for it: on top of where the sound puts it)
  if (S.snd) S.snd.bias = Number(FoneVod.store.get(sndBiasKey())?.bias) || 0;
  if (how === 'sound') V.hand = S.snd?.bias || 0;
  S.delay = Math.round((how === 'sound' ? delay + (S.snd?.bias || 0) : delay) * 1000) / 1000;
  // (what sync by sound found, a delay on the old place, or one this place overrules: found again from here)
  const sn = S.snd;
  if (sn && !(was && was.r === r && Math.abs(was.T0 - T0) < 1e-3 && Math.abs(was.delay - S.delay) < 1)) {
    Object.assign(sn, { target: null, est: [], miss: 0, state: sn.state === 'locked' ? 'listening' : sn.state });
  }
  S.delaySource = 'sound';
  S.resync = true;
  vodSave();
  diag('vod', { place: how, bvid: r.bvid, T0: Math.round(T0 * 10) / 10, delay: S.delay });
}
const vodKey = (r) => `vodPlace|${S.cid}|${r.bvid}`;
// Where the replay playing was put (and the delay on it), for this video: sync by sound's, a nudge's.
function vodSave(delay = S.delay) {
  const V = S.vod, r = V?.cur;
  if (!r || V.state !== 'placed' || delay == null) return;
  FoneVod.store.set(vodKey(r), { T0: r.T0, delay: Math.round(delay * 1000) / 1000, at: Date.now(), ...(V.hand ? { hand: V.hand } : {}) });
}
function vodKept(V) {
  let best = null;
  for (const r of V.reps) {
    const k = FoneVod.store.get(vodKey(r));
    if (k && Number.isFinite(k.T0) && Number.isFinite(k.delay) && !(best && best.at > k.at)) best = { rep: r, ...k };
  }
  return best;
}
// A stretch of the plan, fetched, decoded and kept (16-bit, 4 kHz: the match doesn't care for the
// scale) while it looks: the same promise for the look and the fetch ahead. `keep` false (a look
// over all of a replay, past the hour's): not kept, so the hour's stay.
const vodChunkKey = (ch) => `${ch.rep.bvid}/${ch.a}/${ch.len}`;
function vodChunk(V, ch, keep = true) {
  const key = vodChunkKey(ch);
  let got = V.chunks.get(key);
  if (got) {
    V.chunks.delete(key);
    V.chunks.set(key, got); // (the newest used: the last let go)
    return got;
  }
  got = vodRead(ch.rep, ch.a, ch.len).then((rd) => {
    if (!rd) return null;
    const y = FoneSound.decimate(rd.y, VOD.F);
    let mx = 1e-9;
    for (let i = 0; i < y.length; i++) mx = Math.max(mx, Math.abs(y[i]));
    const y16 = new Int16Array(y.length);
    for (let i = 0; i < y.length; i++) y16[i] = Math.round((y[i] / mx) * 32767);
    return { rep: ch.rep, m0: rd.m0, y: y16 };
  });
  if (!keep) return got;
  V.chunks.set(key, got);
  got.then((v) => { got.val = v; }, () => { if (V.chunks.get(key) === got) V.chunks.delete(key); });
  while (V.chunks.size > VOD.KEEP) V.chunks.delete(V.chunks.keys().next().value); // (~2 MB each)
  return got;
}
// Replay r's sound over a..a+len at the look's rate ({m0, y}, maybe more of it): from a stretch
// kept for the looks if one holds it, else fetched.
async function vodWindow(V, r, a, len) {
  const sr = SND.SR / VOD.F;
  for (const p of V.chunks.values()) {
    const c = p.val;
    if (c && c.rep === r && c.m0 <= a && c.m0 + c.y.length / sr >= a + len) return c;
  }
  const rd = await vodRead(r, a, len);
  return rd ? { m0: rd.m0, y: FoneSound.decimate(rd.y, VOD.F) } : null;
}
// (a look's matching, a stretch at a time, lets the rest of fone run between: ~0.25 s each)
const vodBreath = () => new Promise((r) => setTimeout(r, 0));
// A look over all of each replay, not just the hour its title gives: VOD.FULL looks in, then every VOD.FULL_EVERY.
const vodFull = (tries) => tries >= VOD.FULL && (tries - VOD.FULL) % VOD.FULL_EVERY === 0;
// While it listens for F1 TV's sound: the plan for the picture now fetched ahead (nearest first).
function vodPrefetch(V, gen, E) {
  if (V.fetching || V.fetchedFor === V.tries) return;
  V.fetching = true;
  const plan = FoneVod.searchPlan(V.reps, E, { chunk: VOD.CHUNK, win: VOD.WIN_MAX, guess: VOD.D0 }); // (the hour's)
  let k = 0;
  const worker = async () => { while (k < plan.length && S.vod === V && gen === S.gen) await vodChunk(V, plan[k++]).catch(() => null); };
  Promise.all(Array.from({ length: VOD.PAR }, worker)).finally(() => { V.fetching = false; V.fetchedFor = V.tries; });
}
// What to look for: the newest VOD.WIN s of F1 TV's sound heard, new since the last look, not
// silent ({x, pa: the picture it starts at, run}); null, and why for the panel, while there's none.
function vodQuery(V) {
  const sn = S.snd, run = sn?.runs[sn.runs.length - 1];
  if (!run || run.x.length < VOD.WIN * SND.SR) return { why: vodListenText(sn) };
  if (V.seen?.r === run && run.n - V.seen.n < VOD.STEP * SND.SR) return { why: null }; // (looked at this already)
  const n = Math.min(run.x.length, VOD.WIN_MAX * SND.SR);
  const x = run.x.subarray(run.x.length - n);
  if (FoneSound.rms(x) < 1e-4) return { why: vodListenText({ state: 'quiet' }) };
  return { x, pa: run.p0 + (run.x.length - n) / SND.SR, run };
}
// Not found yet: what the panel says while it listens on.
function vodMissText(V) {
  const n = V.cands.length;
  return `Not found in ${vodWho()}'s Bilibili replay yet: listening on${n ? ` (${n === 1 ? 'a likely place' : `${n} likely places`} checked as F1 TV plays on)` : ''}`
    + `${vodFull(V.tries) ? ' (all of it next)' : ''}`;
}
// One look: that sound looked for in the replays; first where earlier looks said it likely is
// (`scan` false: only there). True: placed.
async function vodSearch(V, gen, Q, scan = true) {
  const { x, pa } = Q;
  V.seen = { r: Q.run, n: Q.run.n };
  const E = C.eventTime(S.clock, S.content, pa, null, now(), { manualBase: S.manualBase });
  const placed = V.state === 'placed';
  const sr = SND.SR / VOD.F, q = FoneSound.decimate(x, VOD.F), hits = [];
  const L = { E, pa, pb: pa + x.length / SND.SR, run: Q.run, q };
  const r1 = (v) => Math.round(v * 10) / 10, r2 = (v) => Math.round(v * 100) / 100;
  if (!placed && scan) vodSay(V, 'searching', `Looking for this moment in ${vodWho()}'s Bilibili replay…`);
  let checked = [];
  if (!placed && V.cands.length) {
    V.checks++;
    const ck = await FoneVod.checkLikely(V.cands, L, (r, a, len) => vodWindow(V, r, a, len).catch(() => null), FoneSound.locate,
      { sr, near: VOD.NEAR, fresh: VOD.FRESH, agree: VOD.AGREE, need: VOD.VERIFY, pause: vodBreath });
    if (gen !== S.gen || S.vod !== V) return false;
    checked = ck.checked;
    const h = ck.hit;
    // (where the clock on the streamer's screen says, or it still being read: not elsewhere)
    const kc = h ? vodClockAt(V, h.E) : null, hT0 = h ? h.E + VOD.D0 - FoneVod.contentAt(h.cand.rep, h.m) : null;
    if (h && (vodClockPending(V) || FoneVod.clockVeto(kc, h.cand.rep, hT0, VOD.BOUND))) {
      diag('vod', { clockVeto: { bvid: h.cand.rep.bvid, m: r2(h.m), score: r1(h.score), off: kc?.r === h.cand.rep ? r1(hT0 - kc.T0) : null } });
    } else if (h) {
      // F1 TV's sound heard since found again where the likely place said: this moment is there
      diag('vod', { again: { bvid: h.cand.rep.bvid, m: r2(h.m), score: r1(h.score), d: r2(h.d), from: h.cand.look, then: r1(h.cand.score) },
        look: V.tries, pa: r1(pa), checked });
      vodPlace(V, h.cand.rep, hT0, VOD.D0, 'sound');
      return true;
    }
    if (!scan && checked.length) diag('vod', { check: V.checks, pa: r1(pa), checked, cands: V.cands.length });
  }
  if (!scan) {
    if (!placed && /^Not found/.test(V.text || '')) V.text = vodMissText(V);
    return false;
  }
  const full = vodFull(V.tries), opts = { chunk: VOD.CHUNK, win: VOD.WIN_MAX, guess: VOD.D0 };
  const plan = FoneVod.searchPlan(V.reps, E, { ...opts, full });
  const hour = full ? new Set(FoneVod.searchPlan(V.reps, E, opts).map(vodChunkKey)) : null;
  V.tries++;
  let k = 0, done = 0, stop = false, err = null;
  const rivalOf = (h) => Math.max(h.next, 0, ...hits.filter((o) => o !== h && (o.rep !== h.rep || Math.abs(o.m - h.m) > 1)).map((o) => o.score));
  const worker = async () => {
    while (!stop && k < plan.length) {
      const ch = plan[k++];
      const got = await vodChunk(V, ch, !hour || hour.has(vodChunkKey(ch))).catch((e) => { err = e; return null; });
      if (gen !== S.gen || S.vod !== V) { stop = true; return; }
      if (!got) continue;
      const res = FoneSound.locate(q, got.y, sr);
      done++;
      await vodBreath();
      if (gen !== S.gen || S.vod !== V) { stop = true; return; }
      if (!placed) V.text = `Looking for this moment in ${vodWho()}'s Bilibili replay… ${Math.round((100 * done) / plan.length)}%`;
      if (!res || res.edge) continue;
      const h = { rep: ch.rep, m: got.m0 + res.lag / sr, score: res.score, next: res.next };
      hits.push(h);
      if (h.score >= VOD.SURE && h.score >= 2 * rivalOf(h)) stop = true; // (sure at once: far above all else)
    }
  };
  await Promise.all(Array.from({ length: VOD.PAR }, worker));
  if (gen !== S.gen || S.vod !== V) return false;
  hits.sort((a, b) => b.score - a.score);
  const best = hits[0], rival = best ? rivalOf(best) : 0;
  diag('vod', { look: V.tries, full, E: Math.round(E), pa: r1(pa), plan: plan.length, done, err: err ? String(err.message || err).slice(0, 100) : null,
    best: best ? { bvid: best.rep.bvid, m: r2(best.m), score: r1(best.score), next: r1(best.next) } : null, rival: r1(rival),
    more: hits.slice(1, 3).map((h) => [r2(h.m), r1(h.score)]), checked, cands: V.cands.length });
  // (placed already, and sync by sound not confirming it: moved only by a match far above all else)
  // (the clock on the streamer's screen still being read: sound only when sure at once)
  const hold = !placed && vodClockPending(V);
  const sure = placed || hold ? !!best && best.score >= VOD.SURE && best.score >= 2 * rival
    : !!best && best.score >= VOD.SCORE && best.score >= VOD.RATIO * rival;
  // (and never far from where the clock says: the F1 feed shows the same pictures, so the same
  // sound, again and again, laps replayed after a session)
  const ck = best ? vodClockAt(V, E) : null;
  const T0 = best ? E + VOD.D0 - FoneVod.contentAt(best.rep, best.m) : null;
  if (sure && ck && FoneVod.clockVeto(ck, best.rep, T0, FoneVod.clockRoom(ck, VOD_CLOCK))) {
    diag('vod', { clockVeto: { bvid: best.rep.bvid, m: r2(best.m), score: r1(best.score), off: ck.r === best.rep ? r1(T0 - ck.T0) : null } });
  } else if (sure) {
    // F1 TV's sound at picture pa is at best.m in the replay: put there with the delay at VOD.D0
    // (and the nudge on top of the sound, as sync by sound keeps it)
    const delay = VOD.D0;
    if (!(placed && V.cur === best.rep && Math.abs(T0 - best.rep.T0) < 1)) vodPlace(V, best.rep, T0, delay, 'sound');
    return true;
  }
  if (!placed) {
    // not sure: its likeliest places kept, checked against the sound F1 TV plays on with
    FoneVod.keepLikely(V.cands, hits, V.tries, L, { weak: VOD.WEAK, top: 3, max: VOD.CANDS });
    vodSay(V, 'listening', err && !hits.length ? `${vodWho()}'s Bilibili replay: ${err.message || err} (trying again)` : vodMissText(V));
  }
  return false;
}
// Each tick with a Bilibili replay: a look when one is due (VOD.RETRY s after the last, as soon as
// there's F1 TV's sound to look for; between, the likely places checked with each VOD.STEP s more
// of it), and, placed, again when sync by sound hasn't confirmed it in VOD.CONFIRM looks of its
// own while hearing F1 TV (playing on meanwhile).
function vodTick(t, v) {
  const V = S.vod, sn = S.snd;
  // (none loaded at all: 'error', vodBegin again)
  if (V?.unloaded.length && V.state !== 'error' && !V.loading && t >= V.loadNext) vodLoadMore(V, S.gen).catch(() => null);
  // repeats ahead of the moment playing (from where it plays, after a seek)
  const r = V?.cur, m = S.lastTarget;
  if (V && r && V.state === 'placed' && S.timeline?.vod === r.bvid && m != null && !V.scanning && !(t < r.scanNext)) {
    if (r.scanTo == null || r.scanTo < m - 30 || r.scanTo > m + VOD.AHEAD + VOD.SCAN) r.scanTo = Math.max(0, m - 15);
    if (r.scanTo < Math.min(r.total, m + VOD.AHEAD)) {
      V.scanning = true;
      vodScan(V, r, S.gen).finally(() => { V.scanning = false; });
    }
  }
  if (V && V.reps.length && !V.clockBusy && !v.seeking) {
    V.clockBusy = true;
    const E = C.eventTime(S.clock, S.content, C.videoNow(v, t).p, null, t, { manualBase: S.manualBase });
    vodClockStep(V, S.gen, E).catch(() => null).finally(() => { V.clockBusy = false; });
  }
  if (!V || V.busy || !sn || v.paused || v.seeking || v.waiting) return;
  const since = V.lastTryAt == null ? Infinity : t - V.lastTryAt;
  // (listening: a look whenever there's STEP s more of F1 TV's sound; after a whole plan missed, RETRY s on)
  const due = V.state === 'listening' && (V.tries < VOD.FULL || since >= VOD.RETRY);
  const check = V.state === 'listening' && !due && V.cands.length > 0;
  if (V.state === 'listening') {
    const vn = C.videoNow(v, t);
    vodPrefetch(V, S.gen, C.eventTime(S.clock, S.content, vn.p, null, t, { manualBase: S.manualBase }));
  }
  // (placed by the clock: it says where; sync by sound finds the last second near there itself)
  const unsure = V.state === 'placed' && V.how !== 'clock' && sn.target == null && (sn.looks || 0) - (V.looks0 || 0) >= VOD.CONFIRM
    && sn.state === 'listening' && since >= (V.rechecks ? VOD.AGAIN : 60);
  if (!due && !unsure && !check) return;
  const Q = vodQuery(V);
  if (!Q.x) { if (Q.why && V.state === 'listening' && (V.tries === 0 || !/^Not found/.test(V.text || ''))) V.text = Q.why; return; }
  V.busy = true;
  if (unsure) { V.rechecks++; diag('vod', { recheck: V.rechecks }); }
  const scan = due || unsure;
  vodSearch(V, S.gen, Q, scan).catch((e) => { if (V.state !== 'placed') vodSay(V, 'listening', `${vodWho()}'s Bilibili replay: ${e.message || e}`); })
    .finally(() => { V.busy = false; if (scan) V.lastTryAt = now(); if (V.state === 'searching') V.state = 'listening'; });
}
// Off the end (or before the start) of the replay playing: the streamer's next (or previous) one.
function vodNeighbour(state) {
  const V = S.vod, i = V?.reps.indexOf(V.cur);
  if (!V || i < 0) return null;
  return state === 'after' ? V.reps[i + 1] || null : state === 'before' ? V.reps[i - 1] || null : null;
}
function vodSwitch(r) {
  const V = S.vod, k = FoneVod.store.get(vodKey(r));
  diag('vod', { switch: r.bvid, kept: !!k });
  if (k && Number.isFinite(k.T0) && Number.isFinite(k.delay)) return vodPlace(V, r, k.T0, k.delay, 'kept', Number(k.hand) || 0);
  Object.assign(V, { tries: 0, lastTryAt: null, seen: null, cands: [] });
  vodSay(V, 'listening', vodListenText(S.snd));
}
// The replay's own danmaku (the live chat on it) from `from` to `to` on its wall clock (the 弹幕
// overlay's: danmakuClock's, the audio playing): {items (as /api/danmaku's), live: false}.
async function vodDanmaku(from, to) {
  const V = S.vod, r = V?.cur;
  if (!r || V.state !== 'placed' || S.timeline?.vod !== r.bvid) return { items: [], live: false };
  if (!r.dm) { r.dm = Promise.all(r.pages.map((pg) => FoneVod.danmaku(pg.cid))); r.dm.catch(() => { r.dm = null; }); }
  const pages = await r.dm, pcs = S.timeline.pieces, items = [];
  let off = 0;
  pages.forEach((list, i) => {
    for (const d of list) {
      const w = C.wallOf(pcs, off + d.p);
      if (w != null && w >= from && w < to) items.push({ t: Math.round(w * 1000) / 1000, x: d.x, m: d.m, s: d.s, c: d.c, u: d.u });
    }
    off += r.pages[i].dur;
  });
  return { items, live: false };
}
// The Bilibili replay's own page, at the moment playing (the page of it, and the second in that).
function vodPageUrl() {
  const V = S.vod, r = V?.cur || V?.reps[0];
  if (!r) return null;
  const m = V.state === 'placed' && S.timeline?.vod === r.bvid ? S.lastTarget : null;
  let off = 0, i = 0;
  while (m != null && i < r.pages.length - 1 && m >= off + r.pages[i].dur) off += r.pages[i++].dur;
  const q = m == null ? '' : `?p=${r.pages[i]?.page ?? 1}&t=${Math.max(0, Math.floor(m - off))}`;
  return `https://www.bilibili.com/video/${r.bvid}/${q}`;
}
// For the panel and the diagnostics.
function vodBrief() {
  const V = S.vod;
  if (!V) return null;
  const r = V.cur;
  return { state: V.state, text: V.text || null, bvid: r?.bvid ?? null, title: r?.live ?? null, how: V.how ?? null, tries: V.tries,
    likely: V.state === 'placed' ? 0 : V.cands.length, reps: V.reps.length, cuts: r ? (r.cutsDone ? r.cuts.length : null) : null,
    clock: V.reps.some((x) => x.clock?.status === 'ok') ? 'ok' : V.reps.some((x) => x.clock?.status === 'working') ? 'working'
      : V.reps.some((x) => x.clock) ? (V.reps.find((x) => x.clock)?.clock.status ?? null) : null };
}

// ---- the streamer's screen: where the replay is by the clock on it ---------------------------
// A fone server reads it (vodclock.py): readings [{page, at, wall}], the event time the streamer's
// screen showed `at` s into the replay's page `page`. Each puts the replay on the event clock
// (T0, as a sound match does); the one nearest the moment playing is used, the streamer's own
// delay moving now and then. Asked again (with E) for one near a new moment after a seek.
const vodClockKey = (r) => `vodClock|${r.bvid}|${S.content?.sessionKey}`;
// (the rules: FoneVod.clock*, with VOD's numbers)
const VOD_CLOCK = { D0: VOD.D0, SCREEN: VOD.SCREEN, near: VOD.CLOCK_NEAR, trust: VOD.TRUST, bound: VOD.BOUND };
// The replay that holds event time E by its clock, and where (T0): {r, T0, d (s from the reading)}.
const vodClockAt = (V, E) => FoneVod.clockAt(V.reps, E, VOD_CLOCK);
// The clock's readings kept from before: placed by them at once (asked again all the same).
function vodClockKept(r) {
  if (!vodClockCan()) return;
  const k = FoneVod.store.get(vodClockKey(r));
  if (k?.readings?.length) r.clock = { status: 'ok', readings: k.readings, askedAt: 0, kept: true };
}
// (none to wait for without a session key, F1 Academy, F2, F3: vodClockStep never asks)
const vodClockCan = () => !!(S.base && S.content?.sessionKey);
const vodClockPending = (V) => FoneVod.clockPending(V.reps, now() - V.at, { can: vodClockCan(), wait: VOD.CLOCK_WAIT });
// What the clock says against where the replay plays (by T0 and the delay, your nudges left out:
// yours on top of its place): seconds off, or null.
function vodClockOff(V, E) {
  const r = V.cur;
  return V.state !== 'placed' ? null : FoneVod.clockOff(vodClockAt(V, E), r, r?.T0, (S.delay ?? VOD.D0) - (V.hand || 0), VOD.D0);
}
// Placed by the clock: when not placed yet, or off it by more than VOD.TRUST (a reading near E),
// VOD.BOUND (only further ones: the streamer's delay may have moved since; sync by sound has it).
// Sync by sound locked since it was placed: it has the streamer's delay now, the clock only bounds
// it. Moved on the same replay: your nudges kept on top.
function vodClockPlace(V, E) {
  const k = vodClockAt(V, E);
  const off = vodClockOff(V, E), placed = V.state === 'placed', held = placed && S.snd?.target != null;
  if (!FoneVod.clockMoves(k, off, { placed, held, ...VOD_CLOCK })) return;
  if (placed) diag('vod', { clockMoves: Math.round(Math.min(off, 1e6) * 10) / 10, from: V.how, held: held || undefined });
  const hand = placed && V.cur === k.r ? V.hand || 0 : 0;
  vodPlace(V, k.r, k.T0, VOD.D0 + hand, 'clock', hand);
}
// Each tick: ask the server while it reads (or for a reading near a moment it has none near), then place.
async function vodClockStep(V, gen, E) {
  const key = S.content?.sessionKey;
  if (!vodClockCan()) return;
  const asks = FoneVod.clockAsks(V.reps, E, now(), { poll: VOD.CLOCK_POLL, again: VOD.CLOCK_AGAIN, near: VOD.CLOCK_NEAR });
  await Promise.all(asks.map(async (r) => {
    const q = `bvid=${r.bvid}&key=${key}${r.slot ? `&slot=${r.slot}` : ''}${E != null ? `&E=${Math.round(E)}` : ''}`;
    const was = r.clock;
    try {
      const j = await api(`/api/vod/clock?${q}`);
      r.clock = { ...j, askedAt: now() };
      if (j.status === 'ok' && j.readings?.length) FoneVod.store.set(vodClockKey(r), { readings: j.readings, at: Date.now() });
      if (j.status !== was?.status || (j.readings?.length || 0) !== (was?.readings?.length || 0))
        diag('vod', { clock: r.bvid, status: j.status, n: j.readings?.length || 0, why: j.why || null, more: !!j.more });
    } catch (e) {
      // (an older server without it: none; else asked again in a while, what it read kept)
      const gone = /HTTP 404/.test(String(e.message));
      r.clock = was?.status === 'ok' ? { ...was, askedAt: now() } : { status: gone ? 'none' : 'error', why: String(e.message || e), askedAt: now() };
    }
  }));
  if (gen !== S.gen || S.vod !== V || E == null) return;
  vodClockPlace(V, E);
  if (V.state !== 'placed' && vodClockPending(V))
    V.text = `Finding this moment by the clock on ${vodWho()}'s screen in their replay…`;
}

// ---- team radio, filled in ----------------------------------------------------------
// F1 TV's Track FX plays the team-radio sting but not the message since about 2026-11-03. The
// session's messages (OpenF1's copy of F1 live timing's TeamRadio: mp3s named after the moment
// they were recorded) are fetched as F1 TV gets near them; the sting is listened for in F1 TV's
// own sound (the copy sync by sound keeps, on the picture's time: teamradio.js); a message whose
// time fits plays STING_TO_SPEECH s after it, its speech there (the quiet opening each file has
// skipped), following the picture: pauses, seeks, speed. Which message: the one whose time, with
// what the matches so far say the clock is off by (TR.C: a replay's start is an estimate), is
// nearest. Only with Track FX (English Int. has the radio itself).
const TR = { FETCH: 120, WINDOW: 25, WINDOW_CAL: 5, VOL: 1, KEEP: 40 };
async function trLoad(t) {
  const c = S.content, R = S.tr;
  if (!c?.sessionKey || R.loading || t - (R.loadedAt || 0) < (S.clock === 'edge' ? 60 : 3600)) return;
  R.loading = true;
  try {
    const get = (u) => fetch(u, { signal: AbortSignal.timeout(15000) }).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
    if (R.gmt == null) R.gmt = (await get(`https://api.openf1.org/v1/sessions?session_key=${c.sessionKey}`))?.[0]?.gmt_offset ?? '0';
    const list = await get(`https://api.openf1.org/v1/team_radio?session_key=${c.sessionKey}`);
    if (S.tr !== R) return;
    for (const m of list || []) {
      if (!m?.recording_url || R.clips.some((x) => x.url === m.recording_url)) continue;
      const T = FoneRadio.fileTime(m.recording_url, R.gmt);
      if (T != null) R.clips.push({ url: m.recording_url, T, num: m.driver_number, name: m.recording_url.split('/').pop(), state: 'new' });
    }
    R.clips.sort((a, b) => a.T - b.T);
    R.loadedAt = t;
    R.err = null;
  } catch (e) {
    R.err = `messages: ${String(e?.message || e).slice(0, 60)}`;
    R.loadedAt = t - 3540; // (again in a minute)
  } finally { R.loading = false; }
}
// A message fetched and looked at: where its speech starts (null: none, the opening alone).
function trFetch(x) {
  if (x.state === 'new') x.loading = trFetch1(x);
  return x.loading;
}
async function trFetch1(x) {
  x.state = 'fetching';
  try {
    const r = await fetch(x.url, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const blob = await r.blob();
    const ab = await new OfflineAudioContext(1, 1, SND.SR).decodeAudioData(await blob.arrayBuffer());
    const y = ab.getChannelData(0);
    x.onset = FoneRadio.speechOnset(y, ab.sampleRate);
    x.dur = ab.duration;
    x.src = URL.createObjectURL(blob);
    x.state = x.onset == null ? 'empty' : 'ready';
  } catch (e) {
    x.state = 'failed';
    x.err = String(e?.message || e).slice(0, 60);
  }
}
// The time on F1 TV's picture at position p (F1 TV's own clock live; a replay's anchor else).
function trE(p) {
  if (S.clock === 'edge') return S.video?.utc0 != null ? S.video.utc0 + p : null;
  return S.content ? C.eventTime(S.clock, S.content, p, null, now(), { manualBase: S.manualBase }) : null;
}
// Stings in what's been heard since the last look (the newest run), each matched to a message.
function trListen(t) {
  const R = S.tr, sn = S.snd, r = sn?.runs?.[sn.runs.length - 1];
  if (!r) return;
  const end = r.p0 + r.x.length / SND.SR, from = Math.max(r.p0, R.heardTo ?? -Infinity, end - 20);
  if (end - from < 0.6) return;
  const i0 = Math.max(0, Math.round((from - 0.15 - r.p0) * SND.SR));
  const found = FoneRadio.stings(r.x.subarray(i0), (from - r.p0) - i0 / SND.SR);
  R.heardTo = end - 0.35; // (the pattern's whole length after its start, and a frame)
  for (const g of found) {
    const ps = r.p0 + i0 / SND.SR + g.t;
    if (R.stings.some((q) => Math.abs(q.p - ps) < 1)) continue;
    R.stings.push({ p: ps, at: t, score: Math.round(g.score * 100) / 100 });
    while (R.stings.length > 20) R.stings.shift();
    trMatch(ps, g.score, t);
  }
}
function trMatch(ps, score, t) {
  const R = S.tr, E = trE(ps);
  if (E == null) return;
  const speech = E + FoneRadio.STING_TO_SPEECH; // (when its speech is due, on the picture's clock)
  const cal = R.cal.length >= 2, win = cal ? TR.WINDOW_CAL : TR.WINDOW;
  let best = null;
  for (const x of R.clips) {
    if (x.state === 'empty' || x.state === 'failed' || x.state === 'playing') continue; // (played: again, rewound)
    const d = speech - (x.T + (x.onset ?? 3)) - (cal ? R.C : 0);
    if (Math.abs(d) <= win && (!best || Math.abs(d) < Math.abs(best.d))) best = { x, d };
  }
  diag('tr', { sting: Math.round(ps * 100) / 100, score: Math.round(score * 100) / 100, E: Math.round(E * 10) / 10, clip: best?.x.name ?? null, d: best ? Math.round(best.d * 100) / 100 : null });
  if (!best) { R.last = { at: t, what: 'a sting, no message near it' }; return; }
  const x = best.x;
  if (R.playing?.x === x) { // (started ahead, by the clock: put where the sting says, if it's off)
    const pOn = ps + FoneRadio.STING_TO_SPEECH, pl = R.playing, want = pOn - (x.onset - pl.t0);
    if (Math.abs(want - pl.pStart) > 0.25) pl.pStart = want;
  }
  if (x.onset != null) {
    R.cal.push(speech - (x.T + x.onset));
    if (R.cal.length > 7) R.cal.shift();
    R.C = [...R.cal].sort((a, b) => a - b)[R.cal.length >> 1];
  }
  if (R.playing?.x !== x) trPlay(x, ps + FoneRadio.STING_TO_SPEECH);
}
// Play a message with its speech at picture position pOn (from just before it: the opening skipped).
async function trPlay(x, pOn) {
  const R = S.tr;
  await trFetch(x);
  if (S.tr !== R || (x.state !== 'ready' && x.state !== 'played')) return;
  if (R.playing) trStop();
  const el = new Audio(x.src);
  el.preservesPitch = true;
  const t0 = Math.max(0, x.onset - 0.3); // (mp3 time to start from: just before the speech)
  R.playing = { x, el, pStart: pOn - (x.onset - t0), t0, began: null };
  diag('tr', { play: x.name, pOn: Math.round(pOn * 100) / 100, p: Math.round((S.sndRef?.p ?? 0) * 100) / 100, onset: Math.round(x.onset * 100) / 100 });
  x.state = 'playing';
  R.last = { at: now(), what: `${x.name.split('_')[0]}` };
}
function trStop() {
  const R = S.tr, pl = R?.playing;
  if (!pl) return;
  try { pl.el.pause(); pl.el.removeAttribute('src'); pl.el.load(); } catch { /* gone */ }
  pl.x.state = 'played';
  R.playing = null;
}
// Each tick: the messages near the picture fetched, the sting listened for, the one playing kept
// on the picture.
function trTick(t, v, vn) {
  const want = S.trWant;
  if (!want?.on || !want.fx || !S.content?.sessionKey || !S.snd) { if (S.tr?.playing) trStop(); return; }
  if (!S.tr || S.tr.cid !== S.cid) { if (S.tr?.playing) trStop(); S.tr = { cid: S.cid, clips: [], cal: [], C: 0, stings: [], playing: null }; }
  const R = S.tr;
  trLoad(t);
  const E = trE(vn.p);
  if (E != null) for (const x of R.clips) if (x.state === 'new' && Math.abs(x.T - E) < TR.FETCH) trFetch(x);
  if (!v.paused && !v.seeking && !v.waiting) trListen(t);
  // once two matches agree on the clock, a message starts on time by it, ahead of its sting (which
  // is heard a second or so late: waiting for it cuts the message's first words); the sting then
  // only puts it right
  const cal = R.cal.length >= 2 && Math.max(...R.cal) - Math.min(...R.cal) < 1.5;
  if (cal && E != null && !R.playing && !v.paused) {
    for (const x of R.clips) {
      if (x.state !== 'ready' || x.onset == null) continue;
      const pOn = vn.p + (x.T + x.onset + R.C - E), lead = pOn - vn.p;
      if (lead < 0.6 && lead > -1) { trPlay(x, pOn); break; }
    }
  }
  const pl = R.playing;
  if (pl) {
    const tau = pl.t0 + (vn.p - pl.pStart); // (where in the mp3 the picture is)
    if (tau > pl.x.dur || tau < pl.t0 - 30) trStop();
    else if (tau >= pl.t0) {
      const el = pl.el, rate = v.rate || 1;
      el.volume = S.muted ? 0 : Math.min(1, (S.volume ?? 1) * TR.VOL);
      if (el.playbackRate !== rate) el.playbackRate = rate;
      if (v.paused || v.seeking || v.waiting) { if (!el.paused) el.pause(); }
      else {
        // (not chopped: put right only when it's well off, and not while it's starting)
        if (el.paused) { el.currentTime = tau; el.play().catch((e) => { R.err = `play: ${e.message}`; }); pl.began = now(); }
        else if (now() - (pl.began ?? 0) > 1 && Math.abs(el.currentTime - tau) > 0.4) el.currentTime = tau;
      }
    }
  }
  return R;
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
// what came of it, the sound fone picks (mode), F1 TV's own mute button (muted: held by fone's
// gain; own: a mute of F1 TV's own held so) and the subtitles asked for, a rebuilt pipeline (new
// MSE handle), the onboard views coming and going.
// Each with the position and state around it, so a crash can be put next to its trigger.
function diagPlayer(prev, v) {
  const a = v.dx?.a, b = prev?.dx?.a;
  const r = v.dx?.r, q = prev?.dx?.r;
  const at = { p: Math.round((v.p || 0) * 10) / 10, ps: r?.ps ?? null, h: v.dx?.h ?? null, nv: v.dx?.nv ?? null };
  if (prev && q && r && q.ps !== r.ps) diag('pstate', { from: q.ps, to: r.ps, ...at, want: r.want, sdk: r.sdk, err: r.err, audio: a?.cur ?? null });
  if (a && (a.v !== b?.v || a.cur !== b?.cur || a.err !== b?.err)) {
    diag('audio', { from: b?.cur ?? null, to: a.cur, kind: a.kind, auto: a.auto, manual: a.manual, on: a.on, fx: a.fx, err: a.err,
      mode: a.mode ?? null, muted: !!a.muted, own: !!a.own, subs: v.dx?.subs?.want ?? null, ...at });
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

// fone's copy of F1 TV's sound, for the snap (its element lists only while it isn't copying: the
// server keeps events under 4 kB)
function tapBrief(tp) {
  if (!tp) return null;
  const { seen, media, els, ...rest } = tp;
  return tp.copying ? rest : { ...rest, els, media };
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
    // sync by sound: where it stands and what the last look came to (the first real sessions judge it)
    sound: st.sound ? { state: st.sound.state, score: st.sound.score, err: st.sound.err, v: st.sound.v, bias: st.sound.bias,
      why: st.sound.why, looks: st.sound.looks, breaks: st.sound.breaks, splices: st.sound.splices, runs: st.sound.runs,
      tap: tapBrief(S.video?.dx?.a?.tap) } : null,
    // (the streamer's Bilibili replay, a session nothing else covers; its text is the snap's)
    vod: st.vod ? { state: st.vod.state, bvid: st.vod.bvid, how: st.vod.how, tries: st.vod.tries, cuts: st.vod.cuts } : null,
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
  // (a video with no timing session too: the stats then show the streamer's screen)
  if (t - S.dashAt < DASH.EVERY || !S.content) return;
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
    sessionKey: S.content.sessionKey ?? null, cid: S.cid, server: S.base, live: S.clock === 'edge',
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
    // the streamer's live page (↗); a Bilibili replay playing: that video, at the moment playing
    page: S.vod?.reps.length ? vodPageUrl() : FoneStreams.pageOf(S.local ? S.stream : S.room) ?? null,
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
  // the streamer's Bilibili replay of a session nothing else covers: being found, or this moment in it
  base.vod = vodBrief();
  if (S.vod && S.vod.state !== 'placed') {
    pauseAudio();
    vodTick(t, v);
    return report({ ...base, state: S.vod.state === 'none' ? 'none' : S.vod.state === 'error' ? 'error' : 'syncing', text: S.vod.text });
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
    // off the end of a Bilibili replay, or before its start: the streamer's next (previous) one
    const nb = S.timeline.vod ? vodNeighbour(map.state) : null;
    if (nb) {
      vodSwitch(nb);
      return report({ ...base, state: 'syncing', text: `${vodWho()}'s next Bilibili replay…` });
    }
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
  // sync by sound, live and replays: a look every SND.EVERY s while it plays (S.sndRef: where the
  // commentary sits for the picture this tick); how it stands, for the panel
  S.sndRef = { p: vn.p, m: map.m };
  const sn = S.snd;
  // (a resync asked for: looks every SND.QUICK s, by hand too, till one is sure or it gives up)
  if (sn?.quick != null && t - sn.quick > SND.RESYNC_MAX) {
    Object.assign(sn, { quick: null, why: 'resync: not found' });
    if (!S.soundOn) sn.state = 'off';
    diag('sound', { resync: 'not found' });
  }
  if (sn && (S.soundOn || sn.quick != null)) {
    if (!sn.busy && t - sn.measAt >= (sn.quick != null ? SND.QUICK : SND.EVERY) && !v.paused && !v.seeking && !v.waiting && (S.clock !== 'edge' || S.liveLock?.cid === S.cid)) {
      sn.measAt = t;
      sn.looks = (sn.looks || 0) + 1;
      sndMeasure(t, vn);
    }
    sndCheck(t, v);
    const pl = sndPlace(), err = sn.target != null && pl ? pl.err : null;
    base.sound = { state: sn.state, score: sn.last?.score ?? null, at: sn.last?.at ?? null, err: err == null ? null : Math.round(err * 1000) / 1000,
      v: Math.round(sn.v * 10000) / 10000, bias: sn.bias, last: sn.last, miss: sn.miss, why: sn.why ?? null, looks: sn.looks || 0, breaks: sn.breaks || 0,
      splices: sn.splices || 0, gap: sn.gap ?? null, runs: sn.runs.map((r) => Math.round(r.x.length / SND.SR)),
      // (the panel's Resync: looking, or just done)
      resync: sn.quick != null ? 'looking' : sn.resyncedAt != null && t - sn.resyncedAt < 8 ? 'done' : null,
      // (a Bilibili replay placed: it carries F1 TV's sound, it was found by it: F1 TV's own off)
      carries: !!sn.carries || S.vod?.state === 'placed' };
  }
  // by hand on a Bilibili replay: F1 TV's own sound still off (the replay carries it), nothing kept by it
  if (!S.soundOn && S.vod?.state === 'placed') base.sound = { state: 'off', carries: true, why: 'by hand' };
  // team radio, filled in: how it stands, for Details
  try {
    const R = trTick(t, v, vn);
    if (R) base.radio = { n: R.clips.length, ready: R.clips.filter((x) => x.state === 'ready').length, C: Math.round(R.C * 10) / 10,
      cal: R.cal.length, stings: R.stings.length, playing: R.playing?.x.name ?? null, last: R.last ?? null, err: R.err ?? null };
  } catch (e) { base.radio = { err: String(e?.message || e).slice(0, 80) }; }
  if (S.vod) vodTick(t, v); // (placed: looked for again if sync by sound doesn't confirm it)
  base.file = S.local ? null : fileTitle(map.file);
  const pf = S.local ? null : S.timeline.files?.[map.file];
  S.pic = S.timeline.vod ? { src: 'vod', bvid: S.timeline.vod, m: map.m, rate: v.rate || 1, playing: !v.paused && !v.seeking && !v.waiting } : S.local ? { src: 'stream', stream: S.stream, gen: FoneRecorder.status().gen, m: map.m, rate: v.rate || 1, playing: !v.paused && !v.seeking && !v.waiting }
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
  drive(map.m, v.rate || 1, v.src, sndSteer(t, v));
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

// The panel's Resync: F1 TV's sound looked for in the stream again, now and widely, and the
// commentary put where the first sure match says (the lock's own looks wait for two that agree).
// By hand too: placed once, then yours again. A Bilibili replay still being looked for: again.
function resync() {
  const sn = S.snd;
  if (!sn) return;
  Object.assign(sn, { quick: now(), est: [], miss: SND.MISSES, measAt: 0, wideAt: 0, seen: null, why: 'resyncing…' });
  if (!S.soundOn) Object.assign(sn, { target: null, state: 'listening' });
  const V = S.vod;
  if (V && V.state !== 'placed' && !V.busy) Object.assign(V, { tries: 0, lastTryAt: null });
  diag('sound', { resync: 'asked' });
}

function nudge(delta) {
  if (S.delay == null) return;
  const sn = S.snd, pl = sndPlace(); // (where it stood before the nudge)
  S.delay = Math.round((S.delay + delta) * 100) / 100;
  diag('nudge', { delta, delay: S.delay });
  // synced by sound: the nudge is a preference on top of what the sound says (you like the
  // commentary that much earlier or later), kept for the stream; the sound goes on placing it.
  // While a correction is still easing there, the nudge goes that way first (you heard what it's
  // fixing): only what goes past where the sound puts it, or the other way, is a preference.
  if (sn?.target != null) {
    const e = pl ? pl.err : 0;
    const err = Math.abs(e) > 0.05 ? e : 0; // (a few ms left by the easing, or a look's jitter, isn't a correction under way)
    const took = Math.sign(err) === Math.sign(delta) ? Math.sign(delta) * Math.min(Math.abs(delta), Math.abs(err)) : 0;
    const extra = delta - took;
    if (Math.abs(extra) > 0.0005) {
      sn.bias = Math.round((sn.bias + extra) * 1000) / 1000;
      sn.target += extra;
      try { localStorage.setItem(sndBiasKey(), JSON.stringify({ bias: sn.bias, at: Date.now() })); } catch { /* private mode */ }
    }
  }
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
  if (S.timeline?.vod) { // (a Bilibili replay: its place kept here, the nudges on it too)
    if (S.vod?.state === 'placed') S.vod.hand = Math.round(((S.vod.hand || 0) + delta) * 1000) / 1000;
    return vodSave();
  }
  saveServerDelay(S.delay, 800);
}

// The delay kept on the server for this video (and, live, as the channel's starting point): a
// nudge's, or the one sync by sound measured. (`wait` ms first: presses in a row save once.)
function saveServerDelay(delay, wait = 0) {
  const { cid, channel, clock, base } = S; // (a re-attach may come before the save)
  if (!base || delay == null) return;
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(() => {
    fetch(`${base}/api/sync/${cid}`, {
      signal: AbortSignal.timeout(10000),
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel, clock: clock === 'edge' ? 'edge2' : clock, delay: Math.round(delay * 1000) / 1000 }), // (serverSync)
    }).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); })
      .catch((e) => { S.error = `save failed: ${e.message}`; });
  }, wait);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;
  if (msg.type === 'f1audio') { if (msg.tab === S.tab && S.snd) sndHeard(msg); return; }
  if (msg.type === 'golive') { sendResponse(msg.tab === S.tab ? goLive(!!msg.holding, !!msg.chase, msg.pMax ?? null) : { handled: false }); return; }
  if (msg.type === 'vod-dm') { // (the 弹幕 overlay, on a Bilibili replay: its own danmaku)
    vodDanmaku(Number(msg.from), Number(msg.to)).then(sendResponse, (e) => sendResponse({ error: String(e?.message || e) }));
    return true;
  }
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
    // (where the picture was when: sync by sound puts F1 TV's sound on it, vAt)
    if (msg.tab === S.tab || S.tab == null) {
      const v = S.video, at = v.at ?? v.receivedAt;
      S.vhist = [...(S.vhist || []).filter((h) => at - h.at < 90 && h.at < at), { at, p: v.p, rate: v.rate, paused: v.paused, seeking: v.seeking, waiting: v.waiting }];
    }
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
      if (d && S.snd) sndReset('F1 TV re-based its position');
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
        if (L?.cid === S.cid) {
          const p0 = L.p0;
          if (L.u0 != null) L.p0 = L.u0 - u; else if (L.carried) L.u0 = u + L.p0; else L.relock = true;
          if (S.snd && Math.abs(L.p0 - p0) > 0.05) sndReset('F1 TV re-based its position'); // (what it heard was on the old one)
        }
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
    S.trWant = { on: msg.settings.teamRadio !== false, fx: msg.settings.f1Sound !== 'eng' };
    if (!!msg.settings.anticipate !== !!S.anticipate) {
      S.anticipate = !!msg.settings.anticipate;
      if (S.delaySource === 'measured' && S.sync) { S.delay = measuredDelay(S.sync); S.resync = true; }
    }
    const st = msg.settings;
    const key = `${msg.tab}|${msg.cid}|${msg.channel || ''}|${(st.servers || []).join(',')}|${st.source || ''}|${st.source === 'local' ? st.stream || '' : st.liveDirect === false ? 'server-live' : ''}`;
    // sync by sound on or off (the panel's Sync row): switched as it goes, nothing started over
    // (a Bilibili replay being found, or placed, stays so)
    const soundOn = st.soundSync !== false;
    if (key === S.key && soundOn !== S.soundOn) {
      S.soundOn = soundOn;
      if (S.snd && soundOn) sndReset('sync by sound on');
      else if (S.snd) Object.assign(S.snd, { target: null, est: [], miss: 0, state: 'off', why: 'by hand' });
      else if (soundOn) sndStart();
      diag('sound', { on: soundOn });
    }
    if ((S.local || S.directBack) && key === S.key) { S.bufferMin = st.bufferMin; wantRecording(); } // still wanted (and the buffer's length)
    if (key !== S.key) attach(msg, key);
    // Paused, seeked or resumed: act now rather than on the next 100 ms tick (a quick
    // F1 TV seek can come and go between two ticks, skipping the silent pre-seek).
    else if (prev && (prev.paused !== S.video.paused || prev.seeking !== S.video.seeking || Math.abs(prev.p - S.video.p) > 1)) tick();
  } else if (msg.type === 'nudge') {
    nudge(msg.delta);
  } else if (msg.type === 'resync') {
    resync();
  } else if (msg.type === 'detach' && (msg.tab == null || msg.tab === S.tab)) {
    detach();
  }
});

// Test hook (headless e2e): read engine state without going through the page.
globalThis.__fone = { S, audio };
