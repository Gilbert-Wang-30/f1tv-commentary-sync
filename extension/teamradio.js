// Team radio, filled in (offscreen.js): F1 TV's Track FX plays the team-radio sting ("beep bo
// beep") but, since about 2026-11-03, not the message itself. The messages are published (F1 live
// timing's TeamRadio, mirrored by OpenF1) as mp3s named after the moment they were recorded; fone
// hears F1 TV's sound (audiotap.js) and plays each message after its sting.
//
// Measured on the streamer's recordings of the 2026-11-01 and 11-08 races (fone/scratchpad
// teamradio REPORT): the sting is three pure tones, G5 D6 B5 (783.8, 1174.7, 987.6 Hz), at 0,
// 0.092 and 0.189 s, each about 50 ms; a message airs at the time in its file's name; its speech
// starts about STING_TO_SPEECH s after the sting (2.25 s on 11-01; on 11-08, Track FX without the
// radio, the sting came 1.1 s before where the speech would be). The detector: per 5 ms step, a
// 50 ms window's power at each tone against the strongest of its neighbours 40-250 Hz away (voices
// have harmonics on all three: G5:B5:D6 = 4:5:6), the three notes where the pattern puts them,
// the notes short (quiet just before and after). Pure functions, shared with the Node tests.
(function (root) {
  'use strict';

  const SR = 8000, WIN = 400, HOP = 40; // 50 ms window, 5 ms step
  const TONES = [783.8, 1174.7, 987.6], ON = [0, 0.092, 0.189];
  const REF = [-250, -180, -120, -70, -45, 45, 70, 120, 180, 250]; // Hz from each tone
  const THRESHOLD = 0.8; // (T >= 0.8: 17 of 21 on 11-01 under the streamer's voice, none false on 11-08's 2 h)
  const HANN = Float32Array.from({ length: WIN }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (WIN - 1)));

  // Power at f Hz of x[i0 .. i0 + WIN) (Hann-windowed), by Goertzel.
  function power(x, i0, f) {
    const w = (2 * Math.PI * f) / SR, c = 2 * Math.cos(w);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < WIN; i++) {
      const s0 = x[i0 + i] * HANN[i] + c * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    return s1 * s1 + s2 * s2 - c * s1 * s2;
  }

  // Each tone's salience at the frame starting at sample i0: log10(tone power / the strongest
  // neighbour's), clipped.
  function salience(x, i0) {
    return TONES.map((f) => {
      const p = power(x, i0, f);
      let ref = 1e-12;
      for (const d of REF) ref = Math.max(ref, power(x, i0, f + d));
      return Math.log10((p + 1e-12) / ref);
    });
  }

  const clip = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // Stings in x (8 kHz mono, F1 TV's sound): [{t (s from x[0]: the first note's onset), score}],
  // at least 1 s apart. `from` (s): only stings starting at or after it (what's been looked at).
  function stings(x, from = 0) {
    const n = Math.floor((x.length - WIN) / HOP) + 1;
    if (n <= 0) return [];
    // salience per frame, per tone (frame k covers x[k*HOP .. k*HOP + WIN))
    const S = new Array(n);
    const need = (k) => { if (k >= 0 && k < n && !S[k]) S[k] = salience(x, k * HOP); return k >= 0 && k < n ? S[k] : null; };
    const frame = (t) => Math.round((t * SR - WIN / 2) / HOP); // (the frame centred at t)
    const out = [];
    const last = (x.length / SR) - 0.189 - 0.12; // (room for the whole pattern after t)
    for (let t = Math.max(0, from); t <= last; t += HOP / SR) {
      // a quick look at the first note before the rest
      const f0 = need(frame(t + 0.0225));
      if (!f0 || f0[0] < 0.3) continue;
      let on = 0, off = 0, ok = true;
      for (let k = 0; k < 3; k++) {
        const c = need(frame(t + ON[k] + 0.0225)), b = need(frame(t + ON[k] - 0.04)), a = need(frame(t + ON[k] + 0.08));
        if (!c || !b || !a) { ok = false; break; }
        on += clip(c[k], -1, 1.5);
        off += clip(b[k], 0, 1.5) + clip(a[k], 0, 1.5);
      }
      if (!ok) continue;
      const score = on / 3 - (off / 6) * 1; // (mean on - half the mean of before and after, both sides)
      if (score < THRESHOLD) continue;
      const prev = out[out.length - 1];
      if (prev && t - prev.t < 1) { if (score > prev.score) Object.assign(prev, { t, score }); continue; }
      out.push({ t, score });
    }
    return out;
  }

  // A message's recording time from its file name (…_20261108_142204.mp3: local time at the
  // circuit) and the session's offset from UTC ("-03:00:00"): UTC seconds.
  function fileTime(url, gmtOffset) {
    const m = /_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\.mp3$/i.exec(String(url || ''));
    if (!m) return null;
    const local = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000;
    const g = /^(-)?(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(gmtOffset || '0:00'));
    const off = g ? (g[1] ? -1 : 1) * (+g[2] * 3600 + +g[3] * 60 + +(g[4] || 0)) : 0;
    return local - off;
  }

  // Where a message's speech starts (s into the mp3: each opens with a shared stretch of quiet
  // noise, 0-12 s), and whether it has any (some are the opening alone): the first 50 ms frame
  // whose level clears SPEECH_DB, null if none does for 0.3 s.
  const SPEECH_DB = -32;
  function speechOnset(y, sr) {
    const w = Math.round(sr * 0.05), thr = Math.pow(10, SPEECH_DB / 20);
    let run = 0, first = null;
    for (let i = 0; i + w <= y.length; i += w) {
      let s = 0;
      for (let j = i; j < i + w; j++) s += y[j] * y[j];
      if (Math.sqrt(s / w) >= thr) { if (!run) first = i / sr; run++; if (run >= 6) return first; } else run = 0;
    }
    return null;
  }

  root.FoneRadio = { SR, TONES, ON, THRESHOLD, stings, fileTime, speechOnset, STING_TO_SPEECH: 1.1 };
})(typeof globalThis !== 'undefined' ? globalThis : this);
