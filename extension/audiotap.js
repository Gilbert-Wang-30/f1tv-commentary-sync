// F1 TV's sound, heard by fone (sync by sound). F1 TV's player plays through Web Audio (an
// AudioWorklet its WASM core feeds); this runs in the page's own world before F1 TV's scripts
// (manifest: document_start, MAIN), so whatever connects to the speakers goes through fone's gain
// instead with a copy kept, 8 kHz mono, stamped with the wall time it's heard at. page.js takes the
// copy every second (window.__foneTap.take) and hands it to the engine. F1 TV's own mute button is
// carried out by that gain at 0 (page.js, "F1 TV's mute button"): F1 TV's player itself left
// unmuted, so its sound can still be heard here. Held through page loads: the gain starts at 0
// where page.js left that in this page's localStorage.
(() => {
  'use strict';
  if (window.__foneTap) return;
  const SR = 8000, N = 4096, KEEP = 40; // Hz kept; the copier's buffer; s kept here between takes
  const MUTE_KEY = 'fone.f1Muted'; // (page.js's)
  const connect = AudioNode.prototype.connect, disconnect = AudioNode.prototype.disconnect;
  const T = { gain: 1, taps: new Map(), chunks: [], heardAt: 0, peak: 0, err: null, anchored: 0,
    seen: {}, // (what connected to what, by kind, for the diagnostics: how F1 TV's player plays its sound)
    mine: new Set() }; // (ids of the audio tracks of MediaStreams copied through the graph already)
  try { if (localStorage.getItem(MUTE_KEY) === '1') T.gain = 0; } catch { /* storage blocked */ }

  // (route: F1 TV's sound to the speakers through fone's gain; else a copy only, of sound F1 TV
  // sends elsewhere: into a MediaStream an <audio> element plays, which fone's gain can't silence)
  function tapOf(ctx, route = true) {
    let t = T.taps.get(ctx);
    if (t) { if (route && !t.g) addGain(t); return t; }
    t = { ctx, g: null, sp: null, srcs: new Set() };
    if (route) addGain(t);
    // the copier: a ScriptProcessor (an AudioWorklet would need a module this page's CSP may
    // refuse), into a silent gain so it runs
    const sp = ctx.createScriptProcessor(N, 2, 1), z = ctx.createGain();
    t.sp = sp;
    z.gain.value = 0;
    connect.call(sp, z);
    connect.call(z, ctx.destination);
    let acc = 0, sum = 0, cnt = 0; // (the resampler's state, across buffers)
    // When each buffer was rendered, on the context's clock: counted in samples from an anchor
    // (base: buffer 0's, nb buffers since). Chrome's playbackTime is taken when the event is
    // dispatched on this thread, late by however the audio thread renders in bursts and whatever
    // this thread was busy with, now and then a render quantum early: each buffer says where buffer
    // 0 was (cands, the last 64), and the anchor is a low tenth of them (the earliest dispatches,
    // not the odd early one). Late by half a buffer and more twice running, by the same amount:
    // buffers were lost, so anchored again from there. (A backlog after a busy spell comes late by
    // a buffer less each time: the low tenth already leaves it out.)
    let base = null, nb = -1, cands = [], late = [];
    sp.onaudioprocess = (e) => { try { copy(e); } catch (err) { T.err = String(err?.message || err).slice(0, 120); } };
    const copy = (e) => {
      const b = e.inputBuffer, sr = b.sampleRate, n = b.length;
      const l = b.getChannelData(0), r = b.numberOfChannels > 1 ? b.getChannelData(1) : l;
      // The input's first sample was rendered two buffers before this buffer's playbackTime at
      // the earliest dispatch (Chrome's ScriptProcessor double-buffers; measured against a step at
      // a known context time: the earliest 2N, the median 2N + 128, the latest up to 2N + 1500
      // with a busy page), and is heard when the context's output clock reaches that render time.
      const at = e.playbackTime - (2 * n) / sr;
      nb++;
      const c0 = at - (nb * n) / sr;
      if (base != null) {
        late.push(c0 - base);
        if (late.length > 2) late.shift();
        if (late.length === 2 && Math.min(...late) > n / sr / 2 && Math.max(...late) - Math.min(...late) < n / sr / 4) {
          cands = [];
          late = [];
          T.anchored++;
        }
      }
      cands.push(c0);
      if (cands.length > 64) cands.shift();
      base = [...cands].sort((x, y) => x - y)[Math.floor(cands.length / 10)];
      const rendered = base + (nb * n) / sr;
      // on the wall clock (Date.now's, as the picture's reports are: the performance clock runs
      // apart from it, and stops while the computer sleeps)
      const ts = ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null;
      const wall0 = Date.now() - performance.now();
      const heard = ts && ts.contextTime > 0
        ? wall0 + ts.performanceTime + (rendered - ts.contextTime) * 1000
        : Date.now() + (rendered - ctx.currentTime) * 1000;
      const step = sr / SR, out = new Float32Array(Math.ceil(n / step) + 1);
      let k = 0, first = null, peak = 0;
      for (let i = 0; i < n; i++) { // box-filtered to 8 kHz, mono
        sum += (l[i] + r[i]) / 2;
        cnt++;
        if (++acc >= step) {
          acc -= step;
          if (first == null) first = i;
          const v = sum / cnt;
          out[k++] = v;
          if (Math.abs(v) > peak) peak = Math.abs(v);
          sum = 0; cnt = 0;
        }
      }
      if (!k) return;
      T.chunks.push({ w: (heard + (first / sr) * 1000) / 1000, s: out.subarray(0, k) });
      T.heardAt = Date.now();
      T.peak = Math.max(peak, T.peak * 0.95);
      while (T.chunks.length && T.chunks.length * N / sr > KEEP) T.chunks.shift();
    };
    T.taps.set(ctx, t);
    return t;
  }
  function addGain(t) {
    const g = t.ctx.createGain();
    g.gain.value = T.gain;
    connect.call(g, t.ctx.destination);
    t.g = g;
  }
  const kind = (x) => { try { return x?.constructor?.name || typeof x; } catch { return '?'; } };
  function note(src, dest) {
    const k = `${kind(src)}>${kind(dest)}`;
    T.seen[k] = (T.seen[k] || 0) + 1;
  }

  AudioNode.prototype.connect = function (dest, ...rest) {
    try { if (Object.keys(T.seen).length < 40) note(this, dest); } catch { /* never in F1 TV's way */ }
    if (dest instanceof AudioDestinationNode) {
      const t = tapOf(dest.context);
      t.srcs.add(this);
      connect.call(this, t.sp);
      connect.call(this, t.g);
      return dest;
    }
    // sent into a MediaStream (an <audio> element plays it): copied as well, left going there
    if (typeof MediaStreamAudioDestinationNode === 'function' && dest instanceof MediaStreamAudioDestinationNode) {
      try {
        const t = tapOf(dest.context, false);
        if (!t.srcs.has(this)) { t.srcs.add(this); connect.call(this, t.sp); }
        for (const tr of dest.stream.getAudioTracks()) T.mine.add(tr.id);
      } catch { /* the copy only */ }
    }
    return connect.call(this, dest, ...rest);
  };
  AudioNode.prototype.disconnect = function (...args) {
    if (args[0] instanceof AudioDestinationNode) {
      const t = T.taps.get(args[0].context);
      if (t && t.g && t.srcs.delete(this)) {
        try { disconnect.call(this, t.g); disconnect.call(this, t.sp); } catch { /* already */ }
        return undefined;
      }
    }
    return disconnect.apply(this, args);
  };

  // F1 TV's player as of November 2026 plays its sound from a <video> whose srcObject is a
  // MediaStream, with no Web Audio graph in this page to tap (the user's diagnostics, 2026-11-11:
  // nothing connected, one video playing a stream). The audio tracks of a playing element's stream
  // are copied in an AudioContext of fone's own, left playing where they are (fone's gain isn't on
  // them: F1 TV's own mute button works as F1 TV's). Looked for every second.
  let own = null;
  const fed = new Map(); // track id -> its source in fone's context
  // Media elements that play, in the page or not (a player can play its sound from an Audio()
  // never put in the page: nothing in the page to find): seen as they start playing or get a
  // stream to play.
  const media = new Set();
  const caps = new WeakMap(); // element -> its captureStream()
  const captured = new Set(); // (the elements captured: what fone turns down when it ducks F1 TV)
  // Ducking: while fone has found F1 TV's sound in the streamer's stream (it carries its own copy,
  // in step with the commentary), F1 TV's own is turned down to 0 so it isn't heard twice (two
  // copies a few ms apart sound like a flanger). The copy fone hears must not go with it: if the
  // level copied falls away within 3 s, turning it down deafens the copy too: undone, and not
  // tried again on this page.
  const D = { on: false, at: 0, before: 0, vols: new Map(), failed: null };
  function duckTick() {
    if (D.on && !D.failed) {
      for (const el of captured) {
        if (el.volume !== 0) { if (!D.vols.has(el)) D.vols.set(el, el.volume); el.volume = 0; }
      }
      if (Date.now() - D.at > 3000 && Date.now() - D.at < 6000 && D.before > 0.01 && T.peak < D.before * 0.1) {
        D.failed = "fone's copy goes quiet with F1 TV's volume";
        unduck();
      }
    }
  }
  function unduck() {
    for (const [el, v] of D.vols) { try { if (el.volume === 0) el.volume = v; } catch { /* gone */ } }
    D.vols.clear();
  }
  const mediaKind = (el) => `${el.tagName?.toLowerCase()}:${el.srcObject ? (el.srcObject.constructor?.name || 'object') : el.currentSrc ? 'src' : 'none'}${el.isConnected ? '' : ':detached'}`;
  function remember(el) {
    if (!(el instanceof HTMLMediaElement) || media.has(el)) return;
    media.add(el);
    const k = `play>${mediaKind(el)}`;
    T.seen[k] = (T.seen[k] || 0) + 1;
    while (media.size > 16) media.delete(media.values().next().value);
  }
  try {
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...a) { try { remember(this); } catch { /* never in the way */ } return play.apply(this, a); };
    const so = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject');
    if (so?.set) {
      Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', { ...so,
        set(v) { so.set.call(this, v); try { if (v) remember(this); } catch { /* never in the way */ } } });
    }
  } catch { /* not patchable: the page's own elements are still looked at */ }
  function ownCtx() {
    if (own) return own;
    own = new AudioContext();
    const resume = () => { if (own.state === 'suspended') own.resume().catch(() => {}); };
    for (const ev of ['pointerdown', 'keydown']) addEventListener(ev, resume, { capture: true, passive: true });
    resume();
    return own;
  }
  function scan() {
    try {
      if (typeof document === 'undefined' || !document.querySelectorAll) return;
      const now = new Set();
      for (const el of new Set([...document.querySelectorAll('video, audio'), ...media])) {
        if (el.paused) continue;
        // a MediaStream played: its audio tracks; anything else (MSE, a file: F1 TV's player plays
        // its sound from a <video> never put in the page, fed by a MediaSource in a worker): the
        // element's own output, captured (captureStream: a copy, the element left playing)
        let ms = el.srcObject instanceof MediaStream ? el.srcObject : caps.get(el);
        if (!ms && typeof el.captureStream === 'function') {
          try { ms = el.captureStream(); caps.set(el, ms); captured.add(el); T.seen[`capture>${mediaKind(el)}`] = (T.seen[`capture>${mediaKind(el)}`] || 0) + 1; } catch (e) { caps.set(el, null); T.err = `capture: ${String(e?.message || e).slice(0, 80)}`; }
        }
        if (!ms) continue;
        for (const tr of ms.getAudioTracks()) {
          if (tr.readyState !== 'live' || T.mine.has(tr.id)) continue;
          now.add(tr.id);
          if (fed.has(tr.id)) continue;
          const ctx = ownCtx(), t = tapOf(ctx, false), src = ctx.createMediaStreamSource(new MediaStream([tr]));
          connect.call(src, t.sp);
          fed.set(tr.id, src);
          T.seen['stream track>copy'] = (T.seen['stream track>copy'] || 0) + 1;
        }
      }
      for (const [id, src] of fed) if (!now.has(id)) { try { disconnect.call(src); } catch { /* gone */ } fed.delete(id); }
      if (own?.state === 'suspended') own.resume().catch(() => {});
    } catch (e) { T.err = String(e?.message || e).slice(0, 120); }
  }
  setInterval(scan, 1000);
  setInterval(() => { try { duckTick(); } catch { /* never in the way */ } }, 250);

  window.__foneTap = Object.freeze({
    // fone's volume for F1 TV's sound (0: muted with F1 TV's own button), eased so it doesn't click
    setGain(v) {
      T.gain = v;
      for (const t of T.taps.values()) {
        if (!t.g) continue;
        try { t.g.gain.setTargetAtTime(v, t.ctx.currentTime, 0.02); } catch { t.g.gain.value = v; }
      }
    },
    gain: () => T.gain,
    // F1 TV's sound goes through here (something connected to the speakers: fone's gain mutes it)
    routed: () => [...T.taps.values()].some((t) => t.g),
    // F1 TV's sound is being copied here (heard in the last 2 s)
    live: () => T.taps.size > 0 && Date.now() - T.heardAt < 2000,
    // copied at all (to the speakers, elsewhere, or off a playing element's stream)
    copying: () => T.taps.size > 0,
    // fone's own context for a stream's copy: its state ('suspended' until the page is interacted with)
    own: () => own?.state ?? null,
    // F1 TV's own sound turned down while fone has it in the stream (see D above)
    duck(on) {
      on = !!on && !D.failed;
      if (on === D.on) return;
      D.on = on;
      if (on) { D.at = Date.now(); D.before = T.peak; duckTick(); } else unduck();
    },
    ducked: () => D.on && !D.failed && captured.size > 0,
    duckFailed: () => D.failed,
    // the media elements seen playing (out of the page too)
    media: () => [...media].map((el) => `${mediaKind(el)}${el.srcObject?.getAudioTracks ? `(a${el.srcObject.getAudioTracks().length})` : ''}${el.paused ? '' : ':playing'}${el.muted ? ':muted' : ''}`),
    // what connected to what in this page's Web Audio (kinds, counts), for the diagnostics
    seen: () => ({ ...T.seen }),
    level: () => T.peak,
    // why the copy failed (an exception in the copier), if it did
    err: () => T.err || null,
    anchored: () => T.anchored, // (times buffers were lost)
    // what was heard since the last take: [{w: wall s of its first sample, s: Float32Array, 8 kHz}]
    take() { const c = T.chunks; T.chunks = []; return c; },
    SR,
  });
})();
