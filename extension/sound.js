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

  root.FoneSound = { fft, locate, decimate, rms, pow2 };
})(typeof globalThis !== 'undefined' ? globalThis : this);
