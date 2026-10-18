// Plays the in-browser recording (localcore.js) through the engine's <audio> with Media Source
// Extensions: the ADTS AAC appended a few seconds at a time, each run at its own m
// (timestampOffset), in a window around the playhead. The engine then steers this <audio>
// exactly as it steers the server's commentary under hls.js: seeks and tiny rate changes.
(function (root) {
  'use strict';

  const L = root.FoneLocal;
  const AHEAD = 20; // s appended ahead of the playhead
  const BEHIND = 15; // s kept behind it (the engine's small re-seeks land there)
  const TRIM = 45; // s behind before the old part is removed
  const BATCH = 5; // s of audio per append

  function create(audio, getBuf) {
    const P = { ms: null, sb: null, url: null, gen: null, buf: null, from: null, to: null, err: null, appends: 0, restarts: 0, dead: false };

    function release() {
      if (P.url) URL.revokeObjectURL(P.url);
      Object.assign(P, { ms: null, sb: null, url: null, gen: null, buf: null, from: null, to: null });
    }

    function open() {
      release();
      const ms = new MediaSource();
      P.ms = ms;
      P.url = URL.createObjectURL(ms);
      ms.addEventListener('sourceopen', () => {
        if (P.ms !== ms || P.dead) return;
        try {
          const sb = ms.addSourceBuffer('audio/aac');
          sb.mode = 'sequence'; // ADTS has no timestamps: each append is placed by timestampOffset
          // seeking isn't clamped to what is buffered so far (the recording is ahead and behind)
          ms.duration = 1e7;
          sb.addEventListener('updateend', pump);
          sb.addEventListener('error', () => { P.err = 'audio append failed'; });
          P.sb = sb;
          pump();
        } catch (e) {
          P.err = `audio: ${e.message || e}`;
        }
      }, { once: true });
      audio.src = P.url;
    }

    function appendFrom(B, k) {
      const cs = [];
      let d = 0;
      for (let i = k; i < B.chunks.length && d < BATCH; i++) { cs.push(B.chunks[i]); d += B.chunks[i].d; }
      if (!cs.length) return false;
      try {
        P.sb.timestampOffset = cs[0].m;
        P.sb.appendBuffer(cs.length === 1 ? cs[0].data : root.FoneDemux.concat(...cs.map((c) => c.data)));
      } catch (e) {
        if (e.name === 'QuotaExceededError' && P.from != null) { // drop what's behind, then try again
          const ct = audio.currentTime;
          if (ct - BEHIND > P.from) { P.sb.remove(P.from, ct - BEHIND); P.from = ct - BEHIND; }
          return true;
        }
        P.err = `audio: ${e.message || e}`;
        return false;
      }
      if (P.from == null) P.from = cs[0].m;
      P.to = cs[cs.length - 1].m + cs[cs.length - 1].d;
      P.appends++;
      return true;
    }

    function pump() {
      if (P.dead) return;
      const B = getBuf();
      if (!B) return;
      // a new format, or another buffer altogether (the recorder started over): start over too
      if (!P.ms || (P.gen != null && (P.gen !== B.gen || P.buf !== B))) { open(); P.gen = B.gen; P.buf = B; return; }
      P.gen ??= B.gen;
      P.buf ??= B;
      const sb = P.sb;
      if (!sb || sb.updating || P.ms.readyState !== 'open') return;
      const ct = audio.currentTime;
      const inside = P.from != null && ct >= P.from - 0.05 && ct <= P.to + 0.5;
      if (!inside) {
        // the playhead left what is appended (a seek, or the start): start over at it
        if (P.from != null) {
          P.from = P.to = null;
          P.restarts++;
          sb.remove(0, Infinity); // updateend: pump again
          return;
        }
        const k = L.chunkAt(B, ct);
        if (k >= 0 && k < B.chunks.length) appendFrom(B, k);
        return;
      }
      if (ct - P.from > TRIM) {
        sb.remove(P.from, ct - BEHIND);
        P.from = ct - BEHIND;
        return;
      }
      if (P.to < ct + AHEAD) {
        const k = L.chunkAt(B, P.to + 1e-6);
        if (k >= 0 && k < B.chunks.length) appendFrom(B, k);
        else if (k < 0) { P.from = P.to = null; } // what we appended has left the buffer: start over
      }
    }

    const onSeeking = () => pump();
    audio.addEventListener('seeking', onSeeking);
    audio.addEventListener('waiting', onSeeking);
    const timer = setInterval(pump, 250);
    pump();

    return {
      pump,
      state: () => ({ err: P.err, appends: P.appends, restarts: P.restarts, from: P.from, to: P.to }),
      destroy() {
        P.dead = true;
        clearInterval(timer);
        audio.removeEventListener('seeking', onSeeking);
        audio.removeEventListener('waiting', onSeeking);
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
        release();
      },
    };
  }

  root.FoneLocalPlayer = { create };
})(typeof globalThis !== 'undefined' ? globalThis : this);
