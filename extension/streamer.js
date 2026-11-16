// The streamer's picture, in step with the commentary: a box over F1 TV (streamerbox.js puts this
// page in an iframe) or a window of its own. Muted: the commentary's sound is the engine's. Where
// the picture comes from follows the engine's clock (offscreen.js pictureClock, BroadcastChannel
// 'fone-clock', 10 a second):
//  * the stream recorded here: its FLV video from the recorder ('fone-video'), on the audio's m
//    axis, kept here (KEEP s of it, from the recorder's last 20 s on), decoded (WebCodecs) just
//    ahead of the moment the commentary plays and drawn at it, rewinds included;
//  * a server's recording: its video handoff (/api/video/<file>/index.m3u8, hls.js), the file's
//    picture at the commentary's position in it.
'use strict';

const KEEP = 180; // s of the stream's video kept here, for rewinds
const AHEAD = 0.5; // s of the stream's video decoded ahead of the picture shown
const STALE = 1.5; // s without a clock from the engine: not following anything
const OLD = 0.5; // s: a frame this much older than the moment isn't its picture
const HOLE = 1; // s between two chunks: a hole (the decoder starts again at a keyframe after it)
const $ = (id) => document.getElementById(id);
const canvas = $('c'), g2d = canvas.getContext('2d'), video = $('v'), msg = $('msg');
const clockCh = new BroadcastChannel('fone-clock'), videoCh = new BroadcastChannel('fone-video');

// In the box: clicks don't take the keyboard from F1 TV (V, Space, fone's keys).
if (new URLSearchParams(location.search).get('mode') === 'box') document.addEventListener('mousedown', (e) => e.preventDefault(), true);

let clock = null; // the engine's last clock (its `at`: Date.now() / 1000 when it was made)
const nowS = () => Date.now() / 1000;
// Where the commentary is now: its clock moved on at its rate (no further than STALE).
function target(key) {
  if (!clock || clock[key] == null || nowS() - clock.at > STALE) return null;
  return clock[key] + (clock.playing ? (nowS() - clock.at) * (clock.rate || 1) : 0);
}

const say = (text) => { if (msg.textContent !== (text || '')) msg.textContent = text || ''; msg.hidden = !text; };

// ---- the stream recorded here: WebCodecs --------------------------------------------------------

// One recording's video (url, gen: a fresh recorder buffer is a new one). chunks: [{m, key, data,
// seq}] in decode order (seq: the recorder's numbering).
const P = {
  url: null, gen: null, cfg: null, chunks: [], maxSeq: null, novideo: false,
  dec: null, decKey: null, next: 0, lastFed: null, frames: [], shown: null, drawn: 0,
  fatal: null, decErr: null, retryAt: 0, retries: 0, got: false, wantAvc: false,
};
let since = null; // (missed some: ask for what came after this one)

function hex(n) { return n.toString(16).padStart(2, '0'); }
// The codec string a decoder configuration record names (avcC, hvcC: RFC 6381, ISO/IEC 14496-15).
function codecOf(cfg) {
  const d = cfg.desc;
  if (cfg.codec === 'avc') return d.length >= 4 ? `avc1.${hex(d[1])}${hex(d[2])}${hex(d[3])}` : null;
  if (cfg.codec === 'hevc' && d.length >= 13) {
    const space = d[1] >> 6, tier = (d[1] >> 5) & 1, profile = d[1] & 0x1f;
    let compat = ((d[2] << 24) | (d[3] << 16) | (d[4] << 8) | d[5]) >>> 0, rev = 0;
    for (let i = 0; i < 32; i++) { rev = ((rev << 1) | (compat & 1)) >>> 0; compat >>>= 1; }
    const cons = Array.from(d.subarray(6, 12));
    while (cons.length && cons[cons.length - 1] === 0) cons.pop();
    return [`hvc1.${['', 'A', 'B', 'C'][space]}${profile}`, rev.toString(16), `${tier ? 'H' : 'L'}${d[12]}`, ...cons.map((b) => b.toString(16))].join('.');
  }
  return null;
}

function closeFrames() {
  for (const f of P.frames) f.close();
  P.frames = [];
}
function closeDecoder() {
  closeFrames();
  if (P.dec && P.dec.state !== 'closed') P.dec.close();
  P.dec = null;
  P.decKey = null;
}
function resetStream(url, gen) {
  closeDecoder();
  Object.assign(P, { url, gen, cfg: null, chunks: [], maxSeq: null, novideo: false, next: 0, lastFed: null, shown: null,
    fatal: null, decErr: null, retries: 0, got: false });
  since = null;
}

videoCh.onmessage = (e) => {
  const d = e.data;
  if (!d) return;
  // for another stream (the engine's clock says which: a clock without one, or on a server, keeps it)
  if (clock?.src === 'stream' && d.url !== clock.stream) return;
  if (d.url !== P.url || d.gen !== P.gen) resetStream(d.url, d.gen);
  if (d.type === 'novideo') { P.novideo = true; return; }
  if (d.type === 'cfg') {
    const same = P.cfg && P.cfg.codec === d.codec && P.cfg.desc.length === d.desc.length && P.cfg.desc.every((b, i) => b === d.desc[i]);
    if (!same) { // another configuration: the chunks kept are the old one's
      closeDecoder();
      Object.assign(P, { cfg: d, chunks: [], maxSeq: null, next: 0, lastFed: null, shown: null, fatal: null, decErr: null, retries: 0 });
    }
    return;
  }
  if (d.type !== 'chunks' || !d.list.length) return;
  P.got = true;
  P.novideo = false;
  if (P.maxSeq != null && d.list[0].seq > P.maxSeq + 1) since = P.maxSeq; // (some missed: asked for with the next hello)
  for (const c of d.list) {
    if (P.maxSeq == null || c.seq > P.maxSeq) { P.chunks.push(c); P.maxSeq = c.seq; continue; }
    // one missed, sent again: in its place by its number
    let lo = 0, hi = P.chunks.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (P.chunks[mid].seq < c.seq) lo = mid + 1; else hi = mid; }
    if (P.chunks[lo]?.seq === c.seq) continue;
    P.chunks.splice(lo, 0, c);
    if (lo < P.next) P.next++;
  }
  // keep KEEP s, from a keyframe
  const last = P.chunks[P.chunks.length - 1];
  let cut = 0;
  while (cut < P.chunks.length && last.m - P.chunks[cut].m > KEEP) cut++;
  while (cut < P.chunks.length && !P.chunks[cut].key) cut++;
  if (cut) {
    P.chunks.splice(0, cut);
    P.next = Math.max(0, P.next - cut);
  }
};

// A decoder for the configuration, from the keyframe `keyChunk` on (both as they were asked for:
// the store may change during the check).
async function startDecoder(keyChunk) {
  const cfg = P.cfg, codec = codecOf(cfg);
  if (!codec) { P.fatal = `The stream's picture is ${cfg.codec.toUpperCase()}: this window can't show it`; return; }
  const config = { codec, description: cfg.desc, optimizeForLatency: true };
  let ok;
  try { ok = await VideoDecoder.isConfigSupported(config); } catch (err) { ok = { supported: false, err }; }
  if (cfg !== P.cfg) return; // (another configuration meanwhile: the next frame starts over)
  if (!ok.supported) {
    // HEVC it can't decode: the stream's H.264 instead (the recorder takes it where the platform has both)
    if (cfg.codec === 'hevc' && cfg.avc) { P.wantAvc = true; P.decErr = 'Switching the stream to H.264 for this browser…'; P.retryAt = performance.now() + 2000; hello(); return; }
    P.fatal = `This browser can't decode the stream's picture (${cfg.codec.toUpperCase()})`;
    return;
  }
  const at = P.chunks.indexOf(keyChunk);
  if (at < 0 || !keyChunk.key) return; // (trimmed meanwhile: the next frame picks another keyframe)
  closeDecoder();
  P.dec = new VideoDecoder({
    output: (f) => {
      P.frames.push(f);
      if (P.frames.length > 40) P.frames.shift().close();
    },
    error: (err) => decoderFailed(err),
  });
  P.dec.configure(config);
  Object.assign(P, { decKey: cfg, next: at, lastFed: null });
}
// The decoder failed (a bad packet, the GPU process restarting, a background tab's codec taken
// back): start it again from a keyframe, a little later each time.
function decoderFailed(err) {
  closeDecoder();
  P.retries++;
  P.decErr = `The picture's decoder: ${err?.message || err}`;
  P.retryAt = performance.now() + Math.min(10000, 500 * 2 ** Math.min(P.retries - 1, 5));
}

let starting = false;
function drawStream(m) {
  if (P.fatal) return say(P.fatal);
  if (P.novideo) return say('This stream has no picture (only its audio)');
  if (!P.chunks.length || !P.cfg) return say(P.got ? 'The picture is starting…' : 'Waiting for the picture…');
  if (m == null) return;
  if (P.decErr && performance.now() < P.retryAt) return say(P.decErr);
  const first = P.chunks[0], last = P.chunks[P.chunks.length - 1];
  if (m < first.m - 0.2) return say('No picture this far back (it’s kept from when this window opened)');
  if (m > last.m + 1) return say('Waiting for the picture…');
  // the keyframe to decode from: a fresh decoder, a rewind, or a jump past what's decoded
  const ahead = P.next < P.chunks.length ? P.chunks[P.next].m : last.m;
  // (a jump forward only to a later keyframe: with keyframes far apart, decoding on gets there)
  const reset = !P.dec || P.dec.state !== 'configured' || P.decKey !== P.cfg
    || (P.shown != null && m < P.shown - 0.3)
    || (m > ahead + 3 && P.chunks.some((c, i) => i > P.next && c.key && c.m <= m + 0.05));
  if (reset) {
    if (starting) return;
    let k = null;
    for (let i = 0; i < P.chunks.length && P.chunks[i].m <= m + 0.05; i++) if (P.chunks[i].key) k = P.chunks[i];
    if (!k) return say('The picture is starting…');
    starting = true;
    P.shown = null;
    startDecoder(k).finally(() => { starting = false; });
    return;
  }
  // feed it up to AHEAD past the moment shown (its B-frames come a little out of order); past a
  // hole in what came in, from the next keyframe
  while (P.next < P.chunks.length && P.chunks[P.next].m <= m + AHEAD && P.dec.decodeQueueSize < 12) {
    const c = P.chunks[P.next];
    if (P.lastFed && !c.key && (c.m - P.lastFed.m > HOLE || c.seq !== P.lastFed.seq + 1)) {
      const j = P.chunks.findIndex((x, i) => i > P.next && x.key);
      if (j < 0) break;
      P.next = j;
      continue;
    }
    P.next++;
    try {
      P.dec.decode(new EncodedVideoChunk({ type: c.key ? 'key' : 'delta', timestamp: Math.round(c.m * 1e6), data: c.data }));
      P.lastFed = c;
    } catch (err) { decoderFailed(err); return; }
  }
  // the newest frame at or before the moment, the older ones let go
  P.frames.sort((a, b) => a.timestamp - b.timestamp);
  let pick = -1;
  for (let i = 0; i < P.frames.length; i++) if (P.frames[i].timestamp <= m * 1e6 + 5000) pick = i;
  if (pick < 0) return;
  const f = P.frames[pick];
  for (const old of P.frames.splice(0, pick)) old.close();
  if (m - f.timestamp / 1e6 > OLD) return say('Waiting for the picture…'); // (not this moment's: a hole)
  if (canvas.width !== f.displayWidth || canvas.height !== f.displayHeight) { canvas.width = f.displayWidth; canvas.height = f.displayHeight; }
  g2d.drawImage(f, 0, 0, canvas.width, canvas.height);
  if (P.shown !== f.timestamp / 1e6) P.drawn++;
  P.shown = f.timestamp / 1e6;
  if (P.decErr) Object.assign(P, { decErr: null, retries: 0 });
  say('');
}

// ---- a server's recording: its video handoff -------------------------------------------------
// Fetched by the engine (offscreen.js, BroadcastChannel 'fone-fetch'): this page, in an iframe in
// F1 TV's https page, can't reach an http server itself (mixed content); the engine can.

const fetchCh = new BroadcastChannel('fone-fetch');
const waiting = new Map();
fetchCh.onmessage = (e) => {
  const d = e.data, w = d?.type === 'got' && waiting.get(d.id);
  if (w) { waiting.delete(d.id); w(d); }
};
let fetchSeq = 0;
function proxyGet(url, text) {
  return new Promise((resolve) => {
    const id = `${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}.${fetchSeq++}`;
    const timer = setTimeout(() => { waiting.delete(id); resolve({ ok: false, status: 0, error: 'no answer' }); }, 25000);
    waiting.set(id, (d) => { clearTimeout(timer); resolve(d); });
    fetchCh.postMessage({ type: 'get', id, url, text });
  });
}
// hls.js's loader, through it. The server's 202 (still indexing the file) is asked again; no
// answer at all goes to hls.js as a 503, which it retries (a code 0 it wouldn't).
class ProxyLoader {
  constructor() {
    this.context = null;
    this.aborted = false;
    this.stats = { aborted: false, loaded: 0, retry: 0, total: 0, chunkCount: 0, bwEstimate: 0,
      loading: { start: 0, first: 0, end: 0 }, parsing: { start: 0, end: 0 }, buffering: { start: 0, first: 0, end: 0 } };
  }
  load(context, config, callbacks) {
    this.context = context;
    const st = this.stats;
    st.loading.start = performance.now();
    const go = (tries) => proxyGet(context.url, context.responseType !== 'arraybuffer').then((r) => {
      if (this.aborted) return;
      if (r.status === 202 && tries < 30) { setTimeout(() => { if (!this.aborted) go(tries + 1); }, 2000); return; }
      st.loading.first = st.loading.end = performance.now();
      if (!r.ok || r.status === 202) return callbacks.onError({ code: r.status || 503, text: r.error || `HTTP ${r.status}` }, context, null, st);
      st.loaded = st.total = typeof r.body === 'string' ? r.body.length : r.body.byteLength;
      callbacks.onSuccess({ url: context.url, data: r.body, code: r.status }, st, context, null);
    });
    go(0);
  }
  abort() { this.aborted = true; this.stats.aborted = true; }
  destroy() { this.abort(); this.context = null; }
}

const H = { key: null, gen: 0, hls: null, info: null, err: null, note: null };

function dropServer() {
  if (H.hls) H.hls.destroy();
  Object.assign(H, { key: null, hls: null, info: null, err: null, note: null });
  H.gen++;
}

async function loadServer(server, file) {
  dropServer();
  H.key = `${server}|${file}`;
  const gen = H.gen;
  H.note = 'Loading the recording’s picture…';
  try {
    const r = await proxyGet(`${server}/api/video/${encodeURIComponent(file)}/info`, true);
    if (gen !== H.gen) return;
    if (r.status === 202) { // still indexing it (a long file the first time): ask again
      let pc = null;
      try { pc = JSON.parse(r.body).progress; } catch { /* no progress given */ }
      H.note = `Indexing the recording’s picture…${pc != null ? ` ${Math.round(pc * 100)}%` : ''}`;
      setTimeout(() => { if (gen === H.gen) H.key = null; }, 2000);
      return;
    }
    if (!r.ok) throw new Error(r.status === 404 ? 'no picture in this recording' : r.error || `HTTP ${r.status}`);
    const info = JSON.parse(r.body);
    if (info.mOffset == null) throw new Error('no picture in this recording');
    H.info = info;
    // (from the commentary's position: a growing file's playlist would otherwise start at its end)
    const hls = new Hls({ enableWorker: false, loader: ProxyLoader, maxBufferLength: 20, maxMaxBufferLength: 40, backBufferLength: 20,
      startPosition: Math.max(0, (target('media') ?? info.mOffset) - info.mOffset) });
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (!data.fatal || gen !== H.gen) return;
      H.err = `The recording's picture: ${data.details}`; // (said for a moment, then loaded again from here)
      setTimeout(() => { if (gen === H.gen) H.key = null; }, 3000);
    });
    hls.loadSource(`${server}/api/video/${encodeURIComponent(file)}/index.m3u8`);
    hls.attachMedia(video);
    H.hls = hls;
    H.note = null;
  } catch (err) {
    if (gen !== H.gen) return;
    H.err = `The server's recording: ${err.message || err}`;
    if (!/no picture in this recording/.test(H.err)) setTimeout(() => { if (gen === H.gen) H.key = null; }, 3000); // (asked again)
  }
}

function driveServer() {
  if (H.err) return say(H.err);
  if (!H.info) return say(H.note || '');
  const media = target('media');
  if (media == null) return;
  const v = media - H.info.mOffset;
  if (video.readyState < 2) { if (Math.abs(video.currentTime - v) > 1) video.currentTime = Math.max(0, v); return say('Loading the recording’s picture…'); }
  const drift = video.currentTime - v, rate = clock.rate || 1;
  if (Math.abs(drift) > 0.5) video.currentTime = Math.max(0, v);
  else video.playbackRate = rate * (1 - Math.max(-0.05, Math.min(0.05, drift)));
  if (clock.playing && video.paused) video.play().catch(() => {});
  if (!clock.playing && !video.paused) video.pause();
  say('');
}

// ---- following the engine ------------------------------------------------------------------

clockCh.onmessage = (e) => {
  if (e.data?.type !== 'clock') return;
  clock = e.data;
  if (clock.channel && document.title !== `${clock.channel} · fone`) document.title = `${clock.channel} · fone`;
};
function hello() {
  // (avc: while the stream's HEVC can't be decoded here; since: some chunks missed)
  clockCh.postMessage({ type: 'hello', fresh: !P.got, avc: P.wantAvc && P.cfg?.codec === 'hevc', since });
  since = null;
}
hello();
setInterval(hello, 2000);

function frame() {
  requestAnimationFrame(frame);
  const src = clock && nowS() - clock.at <= STALE && clock.m != null ? clock.src : null;
  canvas.hidden = src !== 'stream';
  video.hidden = src !== 'server';
  if (src !== 'server' && H.key) dropServer();
  if (src === 'stream') {
    if (clock.stream !== P.url || (clock.gen != null && clock.gen !== P.gen)) resetStream(clock.stream, clock.gen);
    drawStream(target('m'));
  } else if (src === 'server') {
    if (!clock.file || !clock.server) return say('No picture for this moment');
    if (H.key !== `${clock.server}|${clock.file}`) loadServer(clock.server, clock.file);
    driveServer();
  } else {
    if (!video.paused) video.pause();
    say(!clock || nowS() - clock.at > STALE ? 'Waiting for the commentary…' : clock.text || 'No commentary playing');
  }
}
requestAnimationFrame(frame);

// What it's showing, for the e2e tests (and a look in DevTools).
setInterval(() => {
  document.documentElement.dataset.state = JSON.stringify({
    at: nowS(), src: clock?.src ?? null, target: target(clock?.src === 'server' ? 'media' : 'm'), shown: P.shown, drawn: P.drawn,
    chunks: P.chunks.length, kept: P.chunks.length ? P.chunks[P.chunks.length - 1].m - P.chunks[0].m : 0,
    vtime: video.currentTime, mOffset: H.info?.mOffset ?? null, msg: msg.hidden ? '' : msg.textContent,
  });
}, 250);
