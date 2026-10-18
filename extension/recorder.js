// The in-browser recorder, for watching without a fone server: the extension records the
// streamer's live stream itself, keeps only its audio, and holds the last few minutes
// (localcore.js) for the engine to play in step with F1 TV, so rewinding F1 TV a minute
// finds the commentary that went with it. Lives in the offscreen document next to the engine
// and outlives an F1 TV tab: it keeps recording LINGER after the engine last wanted it.
// The stream comes from streams.js (a platform's room URL, or a stream URL as is).
(function (root) {
  'use strict';

  const L = root.FoneLocal, D = root.FoneDemux, ST = root.FoneStreams;
  const LINGER = 10 * 60 * 1000; // ms recording goes on after the engine last wanted it
  const OFFLINE_RETRY = 30000; // ms between checks while the streamer is off air
  const STALL = 12000; // ms without data (or an answer) before a connection is dropped and made again
  const YOUNG = 20000; // ms: a connection that died sooner counts as failed (backoff, next alternate)
  const KEEP_MIN = 1, KEEP_MAX = 180; // minutes of buffer allowed

  const R = {
    url: null, spec: null, buf: null, run: 0, conn: 0, state: 'idle', text: '', err: null,
    info: null, // what the resolver said: {platform, name, title, kind}
    wantUntil: 0, abort: null, since: 0, bytes: [],
    fails: 0, // connections in a row that died young (the backoff)
    alt: 0, // which of the resolver's URLs to use (moves on when one dies young)
    hls: null, // {tl, seq}: the last HLS segment taken, so a reconnect carries on from it
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nowS = () => Date.now() / 1000;
  const set = (state, text, err = null) => { R.state = state; R.text = text; R.err = err; };

  // Bytes received over the last 10 s (the whole stream, video included), for the panel.
  function countBytes(n) {
    const t = Date.now();
    R.bytes.push([t, n]);
    while (R.bytes.length && t - R.bytes[0][0] > 10000) R.bytes.shift();
  }
  const netKbps = () => (Date.now() - R.since < 10000 || !R.bytes.length ? null
    : Math.round(R.bytes.reduce((a, b) => a + b[1], 0) * 8 / 10 / 1000));

  // A request with a deadline (its body included), also ended by stop(). A timeout is an error
  // like any other; a stop shows as `signal.aborted`.
  async function fetchFor(url, signal, ms, read) {
    const r = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(ms)]), cache: 'no-store', credentials: 'omit' });
    if (!r.ok) throw Object.assign(new Error(`${new URL(url).hostname} → HTTP ${r.status}`), { status: r.status });
    return read(r);
  }

  async function readTimeout(reader, ms) {
    let timer;
    const stall = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('stream stalled')), ms); });
    try { return await Promise.race([reader.read(), stall]); } finally { clearTimeout(timer); }
  }

  // HTTP-FLV, MPEG-TS or bare ADTS: one long response, demuxed as it arrives.
  async function pullStream(src, run, tlBase) {
    const ctrl = new AbortController();
    R.abort = ctrl;
    const connecting = setTimeout(() => ctrl.abort(), STALL); // no answer at all: try again
    let res;
    try {
      res = await fetch(src.url, { signal: ctrl.signal, cache: 'no-store', credentials: 'omit' });
    } finally {
      clearTimeout(connecting);
    }
    if (!res.ok) throw new Error(`stream → HTTP ${res.status}`);
    const reader = res.body.getReader();
    const conn = ++R.conn;
    let parser = null, kind = null, tl = undefined;
    try {
      for (;;) {
        const { value, done } = await readTimeout(reader, STALL);
        if (done || run !== R.run || Date.now() > R.wantUntil) return;
        if (!value?.length) continue;
        countBytes(value.length);
        if (!parser) {
          kind = src.kind === 'auto' ? D.sniff(value) : src.kind;
          if (kind === 'hls') { // a direct URL that turned out to be a playlist
            ctrl.abort();
            return pullHls({ ...src, kind: 'hls' }, run, tlBase);
          }
          if (kind !== 'flv' && kind !== 'ts' && kind !== 'adts' && kind !== 'aac') throw new Error("this URL isn't an FLV, HLS, MPEG-TS or AAC stream");
          parser = kind === 'flv' ? D.flvReader() : kind === 'ts' ? D.tsReader() : D.adtsReader();
        }
        const frames = parser.push(value);
        if (!frames.length) continue;
        if (kind === 'ts') for (const f of frames) if (f.t != null) { f.t = D.ptsUnwrap(f.t, R.ref ?? f.t); R.ref = f.t; }
        // The stream's own timeline when its timestamps don't start at 0 with the connection
        // (Douyin's and Huya's FLV run on from the stream's start; Bilibili's start again at 0).
        if (tl === undefined) tl = frames[0].t != null && frames[0].t >= 2 ? `${tlBase}|${kind}` : null;
        L.push(R.buf, frames, { conn, at: nowS(), tl });
        if (R.state !== 'recording') set('recording', '');
      }
    } finally {
      ctrl.abort();
    }
  }

  // ---- HLS ---------------------------------------------------------------------------------

  const attrs = (line) => {
    const out = {};
    for (const m of line.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) out[m[1]] = m[2].replace(/^"|"$/g, '');
    return out;
  };

  // What to record from a master playlist: an audio rendition of its own if there is one
  // (YouTube's; AAC-LC before HE-AAC), else an audio-only variant (Twitch's), else the smallest
  // that is at least 360p (YouTube's smaller ones carry 48 kbps audio), else the smallest.
  function pickVariant(text, base) {
    const lines = text.split(/\r?\n/);
    const vs = [];
    const media = lines.filter((l) => l.startsWith('#EXT-X-MEDIA:')).map((l) => attrs(l.slice(13)))
      .filter((a) => a.TYPE === 'AUDIO' && a.URI);
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
      const a = attrs(lines[i].slice(18));
      let j = i + 1;
      while (j < lines.length && (!lines[j].trim() || lines[j].startsWith('#'))) j++;
      if (j >= lines.length) break;
      const h = Number((a.RESOLUTION || '').split('x')[1]) || 0;
      const codecs = a.CODECS || '';
      const audioOnly = /audio_only/i.test(lines[j] + (a.VIDEO || '') + (a['IVS-NAME'] || '')) || (!!codecs && !/avc|hvc|hev|av01|vp0/.test(codecs) && /mp4a/.test(codecs));
      vs.push({ url: new URL(lines[j].trim(), base).href, bw: Number(a.BANDWIDTH) || 0, h, audioOnly, codecs, audio: a.AUDIO });
    }
    if (media.length) {
      const lc = new Set(vs.filter((v) => /mp4a\.40\.2/.test(v.codecs)).map((v) => v.audio));
      return new URL((media.find((m) => lc.has(m['GROUP-ID'])) || media[media.length - 1]).URI, base).href;
    }
    if (!vs.length) return null;
    const by = (xs) => xs.sort((x, y) => x.bw - y.bw)[0];
    return (by(vs.filter((v) => v.audioOnly)) || by(vs.filter((v) => v.h >= 360)) || by(vs)).url;
  }

  // A media playlist: its segments with their sequence and discontinuity numbers (the
  // discontinuity sequence names the timeline a segment's timestamps are on).
  function parseMedia(text, base) {
    const lines = text.split(/\r?\n/);
    const pl = { seq: 0, dseq: 0, target: 4, end: false, map: null, segs: [] };
    let dur = null, disc = false, title = '', ad = false, dn = 0;
    for (const raw of lines) {
      const l = raw.trim();
      if (!l) continue;
      if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) pl.seq = Number(l.slice(22)) || 0;
      else if (l.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:')) pl.dseq = Number(l.slice(30)) || 0;
      else if (l.startsWith('#EXT-X-TARGETDURATION:')) pl.target = Number(l.slice(22)) || 4;
      else if (l.startsWith('#EXT-X-ENDLIST')) pl.end = true;
      else if (l.startsWith('#EXT-X-MAP:')) pl.map = new URL(attrs(l.slice(11)).URI, base).href; // fMP4: the init segment
      else if (l === '#EXT-X-DISCONTINUITY') { disc = true; dn++; }
      else if (l.startsWith('#EXTINF:')) {
        const [d, ...t] = l.slice(8).split(',');
        dur = Number(d);
        title = t.join(',');
      } else if (l.startsWith('#EXT-X-DATERANGE') && /stitched-ad/i.test(l)) ad = true;
      else if (!l.startsWith('#')) {
        pl.segs.push({ seq: pl.seq + pl.segs.length, dseq: pl.dseq + dn, url: new URL(l, base).href, dur: dur ?? pl.target, disc,
          map: pl.map, ad: ad || /^Amazon\b|\bad\b/i.test(title) });
        dur = null; disc = false; title = ''; ad = false;
      }
    }
    return pl;
  }

  // Which segments to take from a playlist, given the last one taken (null: none yet) and the
  // oldest one the previous playlist had: the newer ones; the newest `fresh` when starting; none
  // from a playlist that's behind the last (a lagging edge answering: the next poll catches up);
  // and the newest `fresh` again when the sequence really started over (newest < the old oldest).
  function pickSegments(pl, last, oldest, fresh) {
    if (!pl.segs.length) return { segs: [], restart: false };
    const newest = pl.segs[pl.segs.length - 1].seq;
    if (last == null) return { segs: pl.segs.slice(-fresh), restart: false };
    if (newest >= last) return { segs: pl.segs.filter((s) => s.seq > last), restart: false };
    if (oldest != null && newest >= oldest) return { segs: [], restart: false };
    return { segs: pl.segs.slice(-fresh), restart: true };
  }

  async function pullHls(src, run, tlBase) {
    const ctrl = new AbortController();
    R.abort = ctrl;
    const getText = (u) => fetchFor(u, ctrl.signal, 10000, (r) => r.text());
    let url = src.url;
    let text = await getText(url);
    if (/#EXT-X-STREAM-INF/.test(text)) {
      url = pickVariant(text, url);
      if (!url) throw new Error('no playable variant in the playlist');
      text = await getText(url);
    }
    const tlOf = (s) => `${tlBase}|hls|d${s.dseq}`;
    // a reconnect on the same timeline carries on from the last segment taken (its playlist may
    // hold an hour: YouTube's); a new one starts with the newest minute
    let last = null, oldest = null, ctx = {}, ref = null, conn = ++R.conn, fails = 0;
    let init = null, initUrl = null; // fMP4: the init segment's sound track
    let newAt = Date.now(); // the last new segment: a playlist that stops growing has ended
    let first = true;
    while (run === R.run && Date.now() <= R.wantUntil) {
      const pl = parseMedia(text, url);
      const keep = R.buf ? Math.ceil(R.buf.keep / pl.target) : 12;
      const fresh = Math.max(1, Math.ceil(60 / pl.target));
      if (first && R.hls && pl.segs.some((s) => tlOf(s) === R.hls.tl && (s.seq === R.hls.seq || s.seq === R.hls.seq + 1))) last = R.hls.seq;
      first = false;
      let { segs, restart } = pickSegments(pl, last, oldest, fresh);
      if (last != null && !restart) segs = segs.slice(-keep); // a long way behind: no more than is kept
      if (restart) { conn = ++R.conn; ref = null; ctx = {}; }
      if (pl.segs.length && !(last != null && segs.length === 0 && pl.segs[pl.segs.length - 1].seq < last)) oldest = pl.segs[0].seq;
      for (const s of segs) {
        if (run !== R.run) return;
        if (s.disc && last != null) { conn = ++R.conn; ref = null; ctx = {}; }
        let bytes = null;
        for (let tries = 0; !bytes && tries < 2; tries++) {
          try {
            if (tries) await sleep(700);
            bytes = await fetchFor(s.url, ctrl.signal, Math.max(10000, s.dur * 3000), async (r) => new Uint8Array(await r.arrayBuffer()));
          } catch (e) {
            if (ctrl.signal.aborted) throw e;
          }
        }
        if (!bytes) { last = s.seq; continue; } // skip it: the timestamps leave a hole, filled with silence
        newAt = Date.now();
        countBytes(bytes.length);
        if (s.map && s.map !== initUrl) { // a (new) init segment: its sound track and AAC config
          init = D.mp4Init(await fetchFor(s.map, ctrl.signal, 10000, async (r) => new Uint8Array(await r.arrayBuffer())));
          initUrl = s.map;
          if (!init) throw new Error('the stream has no sound track');
          if (!init.fmt) throw new Error(`the stream's audio isn't AAC (${init.codec})`);
        }
        const kind = s.map ? 'mp4' : D.sniff(bytes);
        const out = kind === 'mp4' ? D.mp4Audio(bytes, init) : kind === 'adts' ? D.packedAudio(bytes) : D.tsAudio(bytes, ctx);
        ctx = out.ctx || ctx;
        if (ctx.codec != null) throw new Error(`the stream's audio isn't AAC (stream type 0x${ctx.codec.toString(16)})`);
        for (const f of out.frames) if (f.t != null) { f.t = D.ptsUnwrap(f.t, ref); ref = f.t; }
        // an ad stitched in (Twitch) replaces the commentary: record silence instead
        if (s.ad && R.buf.fmt) { const sil = D.silentFrame(R.buf.fmt); if (sil) for (const f of out.frames) f.data = sil; }
        L.push(R.buf, out.frames, { conn, at: nowS(), tl: tlOf(s) });
        last = s.seq;
        R.hls = { tl: tlOf(s), seq: s.seq };
        if (out.frames.length && R.state !== 'recording') set('recording', '');
      }
      if (pl.end) return;
      if (Date.now() - newAt > Math.max(30000, pl.target * 4000)) throw new Error('the playlist stopped growing');
      await sleep(Math.max(1000, Math.min(pl.target * 500, 3000)));
      try {
        text = await getText(url);
        fails = 0;
      } catch (e) {
        if (ctrl.signal.aborted || ++fails >= 3 || e.status === 404 || e.status === 403) throw e;
      }
    }
  }

  // ---- the loop ------------------------------------------------------------------------------

  async function loop(run) {
    while (run === R.run) {
      if (Date.now() > R.wantUntil) { set('idle', 'Stopped: no live F1 TV video'); R.run++; return; }
      if (R.state !== 'recording') set('resolving', 'Looking for the stream…', R.err);
      let src;
      try {
        src = await ST.resolve(R.spec);
      } catch (e) {
        if (run !== R.run) return;
        R.fails++;
        set('error', e.message || String(e), e.message || String(e));
        await sleep(Math.min(60000, 5000 * R.fails));
        continue;
      }
      if (run !== R.run) return;
      R.info = { platform: R.spec.platform, name: src.name || null, title: src.title || null, kind: src.kind };
      if (!src.live) {
        set('offline', src.reason || 'Not live right now');
        await sleep(OFFLINE_RETRY);
        continue;
      }
      if (R.state !== 'recording') set('connecting', 'Connecting to the stream…');
      const t0 = Date.now();
      // the resolver's other URLs for the stream (CDN lines, protocols), in turn while they die
      // young; each its own timeline (the same stream on another protocol isn't timed alike)
      const alts = [{ kind: src.kind, url: src.url }, ...(src.alt || [])];
      const i = R.alt % alts.length;
      const pick = { ...src, ...alts[i] };
      R.info.kind = pick.kind;
      const tlBase = `${R.url}|${i}`;
      try {
        if (pick.kind === 'hls') await pullHls(pick, run, tlBase);
        else await pullStream(pick, run, tlBase);
        R.err = null;
      } catch (e) {
        if (run !== R.run) return;
        R.err = e.message || String(e);
      }
      if (run !== R.run) return;
      // a connection that died young: back off and try the next URL; one that ran a while:
      // reconnect right away to the same
      if (Date.now() - t0 < YOUNG) { R.fails++; R.alt++; } else R.fails = 0;
      set('reconnecting', R.err ? `Reconnecting (${R.err})` : 'Reconnecting…', R.err);
      await sleep(R.fails ? Math.min(30000, 1000 * 2 ** Math.min(R.fails, 5)) : 200);
    }
  }

  function stop() {
    R.run++;
    try { R.abort?.abort(); } catch { /* already */ }
    R.abort = null;
  }

  function start() {
    R.since = Date.now();
    R.fails = 0;
    R.bytes = [];
    loop(R.run);
  }

  // The engine wants this stream recorded (called with every F1 TV report while the video is
  // live, so it's cheap): starts it, switches to another stream, or keeps it going LINGER longer.
  // A recording that had stopped starts on a fresh buffer: what it kept is from another time.
  function want(url, keepMin) {
    const keep = 60 * Math.min(KEEP_MAX, Math.max(KEEP_MIN, Number(keepMin) || 15));
    R.wantUntil = Date.now() + LINGER;
    if (url !== R.url) {
      stop();
      R.url = url;
      R.spec = ST.parse(url);
      R.buf = L.newBuffer(keep);
      R.info = null;
      R.alt = 0;
      R.hls = null;
      R.ref = null;
      if (R.spec.error) { set('error', R.spec.error, R.spec.error); return R; }
      start();
    } else if (R.buf) {
      R.buf.keep = keep;
      if (R.state === 'idle' && !R.spec.error) {
        R.buf = L.newBuffer(keep);
        R.hls = null;
        R.ref = null;
        start();
      }
    }
    return R;
  }

  // For the panel and the diagnostics.
  function status() {
    const s = R.buf ? L.stats(R.buf) : null;
    return {
      state: R.state, text: R.text, err: R.err, url: R.url, platform: R.spec?.platform ?? null, label: R.spec?.label ?? null,
      name: R.info?.name ?? null, title: R.info?.title ?? null, kept: s ? Math.round(s.kept) : 0, kbps: s?.kbps ?? null,
      net: netKbps(), filled: s?.filled ?? 0, end: R.buf ? Math.round(R.buf.end * 1000) / 1000 : null,
      edge: R.buf && R.buf.offset != null ? Math.round(L.liveEdge(R.buf, nowS()) * 1000) / 1000 : null, // the m arriving now
      lastAt: R.buf?.lastAt ?? null, // when audio last came in (s)
      fmt: s?.fmt ? `${s.fmt.rate / 1000} kHz ${s.fmt.ch === 1 ? 'mono' : s.fmt.ch === 2 ? 'stereo' : `${s.fmt.ch} ch`}` : null,
    };
  }

  // The buffer of the stream at `url` (null for any other: the recorder may hold another's).
  const buffer = (url) => (url == null || url === R.url ? R.buf : null);

  root.FoneRecorder = { want, stop, status, buffer, pickVariant, parseMedia, pickSegments, _R: R };
})(typeof globalThis !== 'undefined' ? globalThis : this);
