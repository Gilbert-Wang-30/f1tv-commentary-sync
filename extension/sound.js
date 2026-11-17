// Sync by sound: where F1 TV's own sound is in the stream's (the streamer passes F1 TV's sound
// through, its track sound or its international feed, under their voice). Pure, shared with the
// Node tests (sound.test.js): mono PCM in, a lag and how sure it is out.
//
// The match is a generalised cross-correlation with phase transform (GCC-PHAT): both signals'
// spectra are whitened, so a copy that's quiet under a louder voice still gives one sharp peak
// where it lines up, and a stretch with no copy in it gives none. How sure: the peak over the
// spread of the rest (its height in standard deviations, away from the peak itself).
(function (root) {
  'use strict';

  // In-place radix-2 FFT of (re, im), length a power of two; inverse when inv.
  function fft(re, im, inv = false) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = ((inv ? 2 : -2) * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < half; k++) {
          const a = i + k, b = a + half;
          const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
          const t = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = t;
        }
      }
    }
    if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }

  const pow2 = (n) => 2 ** Math.ceil(Math.log2(Math.max(2, n)));
  const rms = (x) => {
    let s = 0;
    for (let i = 0; i < x.length; i++) s += x[i] * x[i];
    return Math.sqrt(s / Math.max(1, x.length));
  };

  // Where x (F1 TV's sound, the shorter) is in y (the stream's): the lag in samples (y[lag + i]
  // ~ x[i]), with how sure (`score`: the peak's height over the rest, in standard deviations)
  // and the runner-up's (`next`: the best peak at least `apart` s from it). Only frequencies in
  // [lo, hi] Hz count (below, rumble and hum; above, what the codecs cut).
  function locate(x, y, sr, { lo = 150, hi = 3600, apart = 0.25 } = {}) {
    const span = y.length - x.length;
    if (span < 0 || !x.length) return null;
    const n = pow2(x.length + y.length);
    const xr = new Float64Array(n), xi = new Float64Array(n), yr = new Float64Array(n), yi = new Float64Array(n);
    xr.set(x);
    yr.set(y);
    fft(xr, xi);
    fft(yr, yi);
    // Y conj(X), whitened, in the band; the inverse gives the correlation at every lag
    const k0 = Math.ceil((lo * n) / sr), k1 = Math.floor((hi * n) / sr);
    for (let k = 0; k < n; k++) {
      const f = k <= n / 2 ? k : n - k;
      if (f < k0 || f > k1) { yr[k] = 0; yi[k] = 0; continue; }
      const r = yr[k] * xr[k] + yi[k] * xi[k], i = yi[k] * xr[k] - yr[k] * xi[k];
      const m = Math.hypot(r, i) || 1;
      yr[k] = r / m; yi[k] = i / m;
    }
    fft(yr, yi, true);
    // the peak over lags 0..span (one sample either side for a sub-sample estimate)
    let best = 0;
    for (let k = 1; k <= span; k++) if (yr[k] > yr[best]) best = k;
    const away = Math.round(apart * sr);
    let s = 0, s2 = 0, c = 0, next = -Infinity;
    for (let k = 0; k <= span; k++) {
      if (Math.abs(k - best) <= away) continue;
      s += yr[k]; s2 += yr[k] * yr[k]; c++;
      if (yr[k] > next) next = yr[k];
    }
    const mean = c ? s / c : 0, sd = c > 1 ? Math.sqrt(Math.max(1e-30, s2 / c - mean * mean)) : 1;
    let frac = 0;
    if (best > 0 && best < span) {
      const a = yr[best - 1], b = yr[best], d = yr[best + 1], den = a - 2 * b + d;
      if (den < 0) frac = Math.max(-0.5, Math.min(0.5, (0.5 * (a - d)) / den));
    }
    return { lag: best + frac, score: (yr[best] - mean) / sd, next: c ? (next - mean) / sd : 0, edge: best === 0 || best === span };
  }

  // locate over a long y a stretch at a time, `span` s of lags each (2 s more, so a peak at one's
  // end is inside the next), `pause()` awaited between them: one FFT of millions of points (a
  // ±240 s look: 2^21, ~67 MB, about a second) held up everything else the page does. The best
  // peak of them all; its runner-up the best of the rest away from it (scores per stretch: each
  // over its own lags). A y no longer than one stretch: locate itself.
  async function locateLong(x, y, sr, { span = 50, pause = null, ...o } = {}) {
    const lags = y.length - x.length, n = Math.round(span * sr), ov = Math.round(2 * sr);
    if (lags <= n + ov) return locate(x, y, sr, o);
    const k = Math.ceil(lags / n), step = Math.ceil(lags / k), away = Math.round((o.apart ?? 0.25) * sr);
    const got = [];
    for (let a = 0; a < lags; a += step) {
      const res = locate(x, y.subarray(a, Math.min(lags, a + step + ov) + x.length), sr, o);
      if (res) got.push({ ...res, lag: a + res.lag, inner: res.edge && a + res.lag > 0 && a + res.lag < lags });
      if (pause) await pause();
    }
    // (a stretch's peak at its own end: the next one's, whole there)
    const best = got.filter((g) => !g.inner).reduce((b, g) => (!b || g.score > b.score ? g : b), null);
    if (!best) return null;
    const next = Math.max(best.next, ...got.filter((g) => Math.abs(g.lag - best.lag) > away).map((g) => g.score));
    return { lag: best.lag, score: best.score, next, edge: best.edge };
  }

  // Box-filtered decimation by an integer factor (the band that matters is under 3.6 kHz).
  function decimate(x, f) {
    if (f <= 1) return x;
    const out = new Float32Array(Math.floor(x.length / f));
    for (let i = 0; i < out.length; i++) {
      let s = 0;
      for (let j = 0; j < f; j++) s += x[i * f + j];
      out[i] = s / f;
    }
    return out;
  }

  // ---- sync by sound's rules (offscreen.js's sndMeasure; P: its SND numbers) ---------------------

  // How far a look reaches either side of where the sound was, in s: ±P.NEAR once locked; ±P.WIDE
  // till then, every P.REWIDE s, and after P.MISSES looks that missed (the streamer's latency
  // stepped further than a close look sees); ±P.FAR for a replay whose start is only a guess.
  function lookRange({ locked, sinceWide, misses, guess }, P) {
    const wide = !locked || sinceWide > P.REWIDE || misses >= P.MISSES;
    return { wide, R: wide ? (guess ? P.FAR : P.WIDE) : P.NEAR };
  }
  // A replay whose start is only a guess till it's found: F1 TV's F1 Academy, F2, F3 videos, no
  // session of F1's own to anchor them, F1's pre-roll borrowed (on its clock, no session key; not
  // live, not a Bilibili replay; nothing found yet).
  const guessed = ({ live, vod, clock, sessionKey, locked }) => !live && !vod && clock === 'preroll' && sessionKey == null && !locked;

  // One look's verdict. st: {target (the place it's locked on, null: none), bias (a nudge of yours
  // on top), est (the sure looks of the last few minutes, [{at, val}]), quick (a resync asked
  // for)}; m: the look {val (the place it found; null: not recorded there), score, next, edge};
  // t: now. A look counts when it's sure (P.SCORE, P.NEXT × the runner-up, not at the window's
  // edge) and agrees with another of the last few (P.AGREE s; a resync takes the first). {sure,
  // far (found well away from where it was), est (the new list), o (where to: the median of
  // those agreeing; null: wait for another), why}.
  function judge(st, m, t, P) {
    const sure = m.val != null && m.score >= P.SCORE && m.score >= P.NEXT * m.next && !m.edge;
    if (!sure) return { sure, far: false, est: st.est, o: null, why: 'not sure' };
    const far = st.target != null && Math.abs(m.val + st.bias - st.target) > 1;
    const est = [...st.est.filter((e) => t - e.at < 180), { at: t, val: m.val }].slice(-4);
    const agree = est.filter((e) => Math.abs(e.val - m.val) <= P.AGREE);
    const quick = st.quick != null;
    if (agree.length < 2 && !quick) return { sure, far, est, o: null, why: 'waiting for a second match' };
    const o = quick ? m.val : agree.map((e) => e.val).sort((a, b) => a - b)[agree.length >> 1];
    return { sure, far, est, o, why: quick ? 'resynced' : 'matched' };
  }
  // How far off where it plays a place found is jumped to rather than eased, in s: a resync's
  // (unless it's there already), the first lock's (the delay it started from was a guess), a
  // later one's (a step too big to ease: minutes out of sync).
  const jumpOver = ({ quick, fresh }, P) => (quick ? 0.05 : fresh ? P.JUMP : P.JUMP_LATER);

  root.FoneSound = { fft, locate, locateLong, decimate, rms, pow2, lookRange, guessed, judge, jumpOver };
})(typeof globalThis !== 'undefined' ? globalThis : this);
