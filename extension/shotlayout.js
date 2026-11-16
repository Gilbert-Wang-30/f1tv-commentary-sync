// The streamer's timing screen, read from their picture: where each part of it is, so the stats can
// show each part in its own panel ("theirs", dashboard.js) whatever the recording. Their screen is
// a live-timing app with tabs, laid out differently from one session to the next: the overview's
// two columns of driver rows (10 a column in 2025, 11 in 2026), or the race tab's one wide table
// of all 22; the track map wherever its window is and as large, ads and other panels around it.
// So nothing is at a fixed place. What is always there: every row starts with the driver's tag (a
// box in the team's colour with the position in it), so the tags repeat down the screen at the
// row pitch and give the table, its rows and its scale; the track map is the largest connected
// line drawing right of the table (the ads there are solid pictures); the session bar is the top
// line, its track-status box the widest run of columns on a coloured ground.
// detect() works on an RGBA frame of any size (the dashboard draws the picture at 960×540 for it)
// and gives boxes in that frame's px; bar() on the session bar's strip at the picture's own px.
// Pure: shared with the Node tests (shotlayout.test.js).
(function (root) {
  'use strict';

  const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };

  // A tag's box, or anything as bright and coloured: a team colour, or the white and grey of the
  // teams that use those.
  function brightMask(img) {
    const { data: d, width: W, height: H } = img, m = new Uint8Array(W * H);
    for (let i = 0, j = 0; j < W * H; i += 4, j++) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      m[j] = mx >= 100 && (mx - mn >= 50 || mn >= 140) ? 1 : 0;
    }
    return m;
  }

  // Each x: the longest chain of tag-tall vertical runs at a steady pitch (one row may be missing
  // from it: a dimmed tag, a pill in the way).
  function chainsAt(m, W, H) {
    const y0 = Math.round(0.06 * H), y1 = Math.round(0.985 * H);
    const hMin = Math.max(4, Math.round(0.009 * H)), hMax = Math.round(0.042 * H);
    const pMin = 0.022 * H, pMax = 0.065 * H, tol = Math.max(1.5, 0.0035 * H);
    const out = [];
    for (let x = 0; x < W; x++) {
      const runs = [];
      for (let y = y0; y < y1; y++) {
        if (!m[y * W + x]) continue;
        let e = y;
        while (e < y1 && m[e * W + x]) e++;
        if (e - y >= hMin && e - y <= hMax) runs.push([y, e - y]);
        y = e;
      }
      let best = null;
      for (let i = 0; i < runs.length; i++) {
        for (let j = i + 1; j < Math.min(runs.length, i + 3); j++) {
          let p = runs[j][0] - runs[i][0];
          if (p < pMin || p > pMax) continue;
          const first = runs[i][0], hs = [runs[i][1]];
          let hits = 1, lastIdx = 0, idx = 1, streak = 1;
          for (let k = i + 1; k < runs.length;) {
            const exp = first + idx * p, y = runs[k][0];
            if (y < exp - tol) { k++; continue; }
            if (y <= exp + tol) {
              hits++; hs.push(runs[k][1]); lastIdx = idx; streak++;
              p = (y - first) / idx; // the pitch from the whole chain, not one pair's rounding
              idx++; k++;
              continue;
            }
            // one row missing, between runs of at least two (icons every other row aren't tags)
            if (idx - lastIdx >= 2 || streak < 2) break;
            streak = 0;
            idx++;
          }
          if (!best || hits > best.hits) best = { x, y: first, p, hits, n: lastIdx + 1, h: median(hs) };
        }
      }
      if (best && best.hits >= 3) out.push(best);
    }
    return out;
  }

  // Neighbouring x with the same chain (the same pitch and phase, runs as tall): one column of
  // tag-like boxes [xa, xb]. (A tag's digits break its runs at some x: chains a few px apart, or
  // starting a row later, are still the same column.)
  function groups(chains, tol) {
    const out = [];
    const phase = (y, g) => { const k = (y - g.y) / g.p; return Math.abs(k - Math.round(k)) * g.p; };
    for (const c of chains) {
      let g = null;
      for (let i = out.length - 1; i >= 0 && c.x - out[i].xb <= 4; i--) {
        const o = out[i];
        if (Math.abs(c.p - o.p) <= 0.8 && phase(c.y, o) <= 2 * tol && Math.abs(c.h - o.h) <= Math.max(2, 0.3 * o.h)) { g = o; break; }
      }
      if (g) { g.xb = c.x; g.list.push(c); } else out.push({ xa: c.x, xb: c.x, y: c.y, p: c.p, h: c.h, list: [c] });
    }
    return out.map((g) => {
      const p = median(g.list.map((c) => c.p));
      const y = Math.min(...g.list.map((c) => c.y)), last = Math.max(...g.list.map((c) => c.y + (c.n - 1) * c.p));
      return { xa: g.xa, xb: g.xb, w: g.xb - g.xa + 1, y, p, h: median(g.list.map((c) => c.h)),
        rows: Math.round((last - y) / p) + 1, hits: Math.max(...g.list.map((c) => c.hits)) };
    });
  }

  // How many different colours a column's boxes come in, row by row: tags have their teams'
  // (and the white and grey ones), a column of timing pills is all green or all purple.
  function hues(img, g, rows) {
    const { data: d, width: W, height: H } = img, seen = new Set();
    for (let k = 0; k < rows; k++) {
      // the row's most coloured pixel across the box (its digits are white)
      let best = null;
      for (let dy = -2; dy <= 2; dy++) {
        const y = Math.round(g.y + k * g.p + 0.5 * g.h) + dy;
        if (y < 0 || y >= H) continue;
        for (let x = g.xa; x <= g.xb; x++) {
          const i = 4 * (y * W + x), r = d[i], gg = d[i + 1], b = d[i + 2], mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
          if (mx >= 60 && (!best || mx - mn > best.s)) best = { s: mx - mn, r, g: gg, b, mx, mn };
        }
      }
      if (!best) continue;
      const { s, r, g: gg, b, mx } = best;
      if (s < 40) { seen.add(mx > 160 ? 'w' : 'g'); continue; }
      const h = mx === r ? ((gg - b) / s + 6) % 6 : mx === gg ? (b - r) / s + 2 : (r - gg) / s + 4;
      seen.add(Math.floor(h * 2)); // twelve hues
    }
    return seen.size;
  }

  // A tag dimmed (a car out, stopped) at row k of a column: its box (grey, or its colour darkened)
  // still stands out from the table's ground between the rows.
  function dimTag(img, g, k) {
    const { data: d, width: W, height: H } = img;
    const top = g.y + k * g.p, y0 = Math.round(top + 0.25 * g.h), y1 = Math.round(top + 0.75 * g.h);
    const gy0 = Math.round(top - 0.75 * (g.p - g.h)), gy1 = Math.max(gy0 + 1, Math.round(top - 0.25 * (g.p - g.h)));
    if (gy0 < 0 || y1 >= H) return false;
    const x1 = Math.min(g.xb, g.xa + 0.5 * g.p);
    const mean = (ya, yb, lit) => {
      let n = 0, on = 0, sum = 0;
      for (let y = ya; y < yb; y++) {
        for (let x = g.xa; x <= x1; x++) {
          const i = 4 * (y * W + x), mx = Math.max(d[i], d[i + 1], d[i + 2]);
          n++; sum += mx; if (mx >= lit) on++;
        }
      }
      return { m: n ? sum / n : 0, on: n ? on / n : 0 };
    };
    const box = mean(y0, y1, 40), ground = mean(gy0, gy1, 40);
    return box.on >= 0.55 && box.m >= 40 && box.m >= ground.m + 12;
  }

  // The table: its kind ('columns': the overview's columns of rows side by side, 'table': one wide
  // table with a header line), the row pitch p, rows per column, each column's [x, w], the rows'
  // top, and the header line's band (the table kind). Null: no table on screen.
  // cars: how many the season has (22 from 2026, 20 before), when known: the rows then aren't
  // guessed from dimmed tags (a car out, a stopped one: greyed, hard to tell from the table's lines).
  function table(img, cars = null, m = brightMask(img)) {
    const { width: W, height: H } = img, tol = Math.max(1.5, 0.0035 * H);
    const gs = groups(chainsAt(m, W, H), tol);
    // a tag's box is solid (the column of runs is wide), unlike a tyre's ring or a gauge's arc
    const tags = gs.filter((g) => g.w >= Math.max(3, 0.3 * g.p) && g.hits >= 3).sort((a, b) => a.xa - b.xa);
    const most = Math.max(0, ...tags.map((g) => g.hits));
    if (most < 8) return null;
    const main = tags.find((g) => g.hits >= 0.8 * most && hues(img, g, g.rows) >= 3);
    if (!main) return null;
    // the overview's other column: tags in the same rows (as tall, the same pitch and phase), well
    // right of these, in teams' colours
    const cols = [main], aligned = (g) => { const k = (g.y - main.y) / main.p; return Math.abs(k - Math.round(k)) * main.p <= 2 * tol; };
    for (const g of tags) {
      const last = cols[cols.length - 1];
      if (g.xa < last.xa + 6 * main.p || g.hits < Math.max(3, 0.45 * main.hits) || g.w < Math.max(3, 0.3 * main.p)) continue;
      if (Math.abs(g.p - main.p) > 0.8 || Math.abs(g.h - main.h) > Math.max(2, 0.3 * main.h) || !aligned(g)) continue;
      if (hues(img, g, g.rows) < 3) continue;
      cols.push(g);
    }
    const p = main.p, h = main.h;
    // The race tab's rows are packed (a tag fills most of its row); the overview's have room
    // around their tags. (Its second column can be all dimmed: the cars out of qualifying.)
    const kind = cols.length > 1 || h / p < 0.72 ? 'columns' : 'table';
    // rows: from the first tag, on through dimmed ones (11 a column, 22 in all: 2026's grid)
    const top0 = Math.min(...cols.map((c) => main.y + Math.round((c.y - main.y) / p) * p));
    let rows = 0;
    const maxRows = kind === 'columns' ? Math.ceil((cars || 22) / 2) : cars || 22;
    for (const c of cols) {
      let n = Math.min(maxRows, Math.round((c.y - top0) / p) + c.rows);
      while (n < maxRows && (cars || dimTag(img, { ...c, y: top0 }, n))) n++;
      rows = Math.max(rows, n);
    }
    const y = top0 - (p - h) / 2;
    let right = edge(img, { top: y, rows, p }, cols[cols.length - 1].xb);
    const xs = cols.map((c) => Math.max(0, c.xa - 0.16 * p));
    // an overview column is ~13 rows' pitch wide: one found alone gets its own width, and the
    // other column beside it where the table's ground goes on that far
    const COL = 13.2 * p;
    if (kind === 'columns' && xs.length === 1) {
      if (right - xs[0] >= 1.8 * COL) xs.push(xs[0] + COL + 0.1 * p);
      else right = Math.min(right, xs[0] + COL);
    }
    if (kind === 'columns') right = Math.min(right, xs[xs.length - 1] + COL + 0.2 * p);
    const columns = xs.map((x, i) => ({ x, w: (i + 1 < xs.length ? xs[i + 1] - 0.08 * p : right) - x }));
    return {
      kind, p, h, rows, top: y, cols: columns, right,
      header: kind === 'table' && y - 1.15 * p >= 0 ? { y: y - 1.15 * p, h: 1.15 * p } : null,
    };
  }

  // Where the table's own ground ends, right of x0: the mean of its rows' background (text left
  // out) drops (to the black, or the darker grey, around the app's panels) and stays down.
  function edge(img, t, x0) {
    const { data: d, width: W, height: H } = img;
    const y0 = Math.max(0, Math.round(t.top)), y1 = Math.min(H, Math.round(t.top + t.rows * t.p));
    const bg = (x) => {
      let sum = 0, n = 0;
      for (let y = y0; y < y1; y += 2) {
        const i = 4 * (y * W + x), v = (d[i] + d[i + 1] + d[i + 2]) / 3;
        if (v < 80) { sum += v; n++; }
      }
      return n >= 0.3 * (y1 - y0) / 2 ? sum / n : null;
    };
    const ref = median(Array.from({ length: Math.round(2.5 * t.p) }, (_, i) => bg(Math.min(W - 1, Math.round(x0 + 0.5 * t.p + i)))).filter((v) => v != null));
    const low = ref - Math.max(5, 0.25 * ref);
    let run = 0;
    for (let x = Math.round(x0); x < W; x++) {
      const v = bg(x);
      run = v != null && v < low ? run + 1 : 0;
      if (run >= 0.4 * t.p) return x - run + 1;
    }
    return W;
  }

  // The table's rows as bands of slices for the tower panel (in the frame's px), widest first:
  // the whole of them; then without what fone shows elsewhere or needn't (the race tab's rpm,
  // speed, gear and pedals; the overview's gauges and mini-sectors); then the least.
  function towerParts(t) {
    const p = t.p, y = t.top, h = t.rows * p;
    if (t.kind === 'columns') {
      const one = (c, xs) => ({ y, h, xs: xs.map(([a, w]) => [c.x + a * p, Math.min(w * p, c.w - a * p)]) });
      return [
        t.cols.map((c) => ({ y, h, xs: [[c.x, c.w]] })),
        // tag and positions gained; last/best and interval/leader; tyre
        t.cols.map((c) => one(c, [[0, 2.5], [4.1, 4.05], [12.25, 0.95]])),
        t.cols.map((c) => one(c, [[0, 2.5], [4.1, 4.05]])),
      ];
    }
    const c = t.cols[0], hd = t.header;
    const band = (f) => [...(hd ? [{ y: hd.y, h: hd.h, xs: [[c.x, f * c.w]] }] : []), { y, h, xs: [[c.x, f * c.w]] }];
    // (fractions of the table's width: driver … last lap 0.38, three stints of the tyre history
    // 0.5, the sectors 0.77, then rpm, speed, gear, pedals)
    return [band(0.77), band(0.5), band(0.385)];
  }

  // Race control's messages, under the table (left of the radio transcripts).
  function rcBox(t, H) {
    const c = t.cols[0], y = t.top + t.rows * t.p + 0.3 * t.p;
    if (y > H - 2 * t.p) return null;
    return { x: c.x, y, w: t.kind === 'columns' ? c.w : 0.5 * c.w, h: H - y };
  }

  // The track map: right of the table, the largest connected line drawing (its outline, cars and
  // labels on it) in the upper part of the screen. Ads and logos there are solid pictures: a
  // drawing that fills more than half its box isn't the map.
  function mapBox(img, x0) {
    const { data: d, width: W, height: H } = img;
    x0 = Math.max(0, Math.min(W - 10, Math.round(x0)));
    const y1 = Math.round(0.62 * H), RW = W - x0, RH = y1;
    const m = new Uint8Array(RW * RH);
    for (let y = 0; y < RH; y++) {
      for (let x = 0; x < RW; x++) {
        const i = 4 * (y * W + x + x0);
        m[y * RW + x] = Math.max(d[i], d[i + 1], d[i + 2]) >= 50 ? 1 : 0;
      }
    }
    const seen = new Int32Array(RW * RH), stack = [], comps = [];
    let best = null, id = 0;
    for (let s = 0; s < RW * RH; s++) {
      if (!m[s] || seen[s]) continue;
      id++;
      let n = 0, xa = RW, xb = 0, ya = RH, yb = 0;
      stack.push(s); seen[s] = id;
      while (stack.length) {
        const q = stack.pop(), x = q % RW, y = (q - x) / RW;
        n++;
        if (x < xa) xa = x; if (x > xb) xb = x; if (y < ya) ya = y; if (y > yb) yb = y;
        if (x > 0 && m[q - 1] && !seen[q - 1]) { seen[q - 1] = id; stack.push(q - 1); }
        if (x < RW - 1 && m[q + 1] && !seen[q + 1]) { seen[q + 1] = id; stack.push(q + 1); }
        if (y > 0 && m[q - RW] && !seen[q - RW]) { seen[q - RW] = id; stack.push(q - RW); }
        if (y < RH - 1 && m[q + RW] && !seen[q + RW]) { seen[q + RW] = id; stack.push(q + RW); }
      }
      const c = { n, xa, xb, ya, yb };
      comps.push(c);
      const w = xb - xa + 1, h = yb - ya + 1;
      if (w < 0.08 * H || h < 0.05 * H || n / (w * h) > 0.5) continue;
      if (!best || n > best.n) best = c;
    }
    if (!best || best.n < 0.0008 * W * H) return null;
    // with the corner numbers round it (small round discs standing off the track; not the letters of
    // a logo or a caption nearby, which are taller, or strokes, which aren't round)
    let { xa, xb, ya, yb } = best;
    const reach = 0.03 * H, small = 0.032 * H;
    for (const c of comps) {
      const w = c.xb - c.xa + 1, h = c.yb - c.ya + 1;
      if (c === best || w > small || h > small || w < 2 || h < 2 || w / h > 1.7 || h / w > 1.7) continue;
      const dx = Math.max(best.xa - c.xb, c.xa - best.xb, 0), dy = Math.max(best.ya - c.yb, c.ya - best.yb, 0);
      if (dx > reach || dy > reach) continue;
      xa = Math.min(xa, c.xa); xb = Math.max(xb, c.xb); ya = Math.min(ya, c.ya); yb = Math.max(yb, c.yb);
    }
    const pad = 2 + 0.01 * Math.max(xb - xa, yb - ya);
    const x = Math.max(x0, x0 + xa - pad), y = Math.max(0, ya - pad);
    return { x, y, w: Math.min(W, x0 + xb + pad) - x, h: Math.min(y1, yb + pad) - y };
  }

  function detect(img, { cars = null } = {}) {
    const t = table(img, cars);
    if (!t) return null;
    return { table: t, tower: towerParts(t), rc: rcBox(t, img.height), map: mapBox(img, t.right + 0.01 * img.width), w: img.width, h: img.height };
  }

  // ---- the session bar ------------------------------------------------------------------------
  // Its strip (the top ~4.6% of the picture: 50 px at 1080p, given at the picture's own px):
  // flag, the session's name over its clock and lap count, the track status in a coloured box,
  // then the weather, item after item (a label over its value), then the app's icons. Cut into
  // pieces [x, y, w, h] (strip px) to be laid out as large as a panel allows (pack below): the
  // name and the clock line (each, and both as one: head), the status box, each weather item. The text's widths change as the
  // clock and laps run ("25:20 Lap: 58/58 (Chequered flag)"), so it is looked at every time.
  function bar(img) {
    const { data: d, width: W, height: H } = img, k = H / 50; // (thresholds in 1080p px)
    const peak = new Float32Array(W), col = new Uint16Array(W), top = new Float32Array(W), low = new Float32Array(W);
    const mid = Math.round(26 * k);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = 4 * (y * W + x), r = d[i], g = d[i + 1], b = d[i + 2];
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b), v = (r + g + b) / 3;
        if (v > peak[x]) peak[x] = v;
        if (y < mid) { if (v > top[x]) top[x] = v; } else if (v > low[x]) low[x] = v;
        if (y >= 5 * k && y < 45 * k && mx - mn >= 15 && mx >= 35) col[x]++;
      }
    }
    // the status box: the widest run of columns on a coloured ground, past the flag
    let box = null;
    for (let x = Math.round(100 * k), a = -1; x <= W; x++) {
      const on = x < W && col[x] >= 12 * k;
      if (on && a < 0) a = x;
      if (!on && a >= 0) { if (x - a >= 40 * k && (!box || x - a > box[1] - box[0])) box = [a, x]; a = -1; }
    }
    if (!box) return null;
    // the text: from the first lit column after the flag (and the dark gap after it)
    let x = 0;
    while (x < box[0] && peak[x] < 60) x++;
    let gap = 0;
    for (; x < box[0] && gap < 4 * k; x++) gap = peak[x] < 60 ? gap + 1 : 0;
    while (x < box[0] && peak[x] < 60) x++;
    const tx = x;
    // the box's own rows
    let by0 = H, by1 = 0;
    for (let y = 0; y < H; y++) {
      let n = 0;
      for (let i = box[0]; i < box[1]; i++) {
        const j = 4 * (y * W + i), mx = Math.max(d[j], d[j + 1], d[j + 2]), mn = Math.min(d[j], d[j + 1], d[j + 2]);
        if (mx - mn >= 15 && mx >= 35) n++;
      }
      if (n >= 0.5 * (box[1] - box[0])) { by0 = Math.min(by0, y); by1 = Math.max(by1, y + 1); }
    }
    if (by1 <= by0) { by0 = mid; by1 = H; }
    // the weather: items from the first lit column after the box, split at the gaps between them
    // (wider than the spaces inside a value), each a label over its value with a dark line between
    // them; the app's icons after them aren't (each one glyph down through that line): up to six
    let w0 = box[1];
    while (w0 < W && peak[w0] < 60) w0++;
    const lit = ([a, b], y0, y1) => {
      for (let y = Math.round(y0 * k); y < Math.min(H, Math.round(y1 * k)); y++) {
        for (let i = a; i < b; i++) { const j = 4 * (y * W + i); if ((d[j] + d[j + 1] + d[j + 2]) / 3 >= 60) return true; }
      }
      return false;
    };
    // (the two lines and the dark one between, from the weather's own rows: the strip may sit a few
    // px off the bar)
    const lines = { a: 14, b: 27, c: 29, e: 33, f: 34, g: 47 };
    {
      const on = [];
      for (let y = 0; y < H; y++) on.push(lit([w0, Math.min(W, Math.round(w0 + 300 * k))], y / k, (y + 1) / k));
      const y1 = on.indexOf(true), ya = y1 < 0 ? -1 : on.indexOf(false, y1), yb = ya < 0 ? -1 : on.indexOf(true, ya);
      if (y1 >= 0 && ya > y1 && yb > ya + 1) Object.assign(lines, { a: y1 / k, b: ya / k, c: (ya + 1) / k, e: (yb - 1) / k, f: yb / k, g: Math.min(H, yb + 10 * k) / k });
    }
    const items = [];
    for (let i = w0, a = -1, g = 0; i <= W && items.length < 6; i++) {
      const dark = i >= W || peak[i] < 60;
      if (!dark) { if (a < 0) a = i; g = 0; continue; }
      g++;
      if (a < 0 || (g < 9 * k && i < W)) continue;
      const it = [a, i - g + 1];
      a = -1;
      if (it[1] - it[0] < 12 * k) continue;
      if (lit(it, lines.c, lines.e) || !lit(it, lines.a, lines.b) || !lit(it, lines.f, lines.g)) break;
      items.push(it);
    }
    // the session's name: over the clock (in qualifying, where the clock is short, on over the box)
    let nameEnd = tx;
    for (let i = tx; i < w0; i++) if (top[i] >= 60) nameEnd = i;
    const pad = 2 * k, cut = ([a, b], y0, y1) => [Math.max(0, a - pad), y0, Math.min(W, b + pad) - Math.max(0, a - pad), y1 - y0];
    return {
      name: cut([tx, nameEnd + 1], Math.round(3 * k), mid),
      clock: cut([tx, box[0] - 2 * k], mid - Math.round(2 * k), H),
      // (the two together, as they stand: the name over the clock and laps; the box with them where
      // the name runs on over it)
      head: cut([tx, nameEnd + 1 > box[0] ? Math.max(nameEnd + 1, box[1]) : box[0] - 2 * k], Math.round(3 * k), H),
      box: [box[0], Math.max(0, by0 - 1), box[1] - box[0], Math.min(H, by1 + 1) - Math.max(0, by0 - 1)],
      boxInHead: nameEnd + 1 > box[0],
      items: items.map((it) => cut(it, Math.round(8 * k), H)),
    };
  }

  // Pieces ({w, h}) in reading order, laid out in rows as large as fits a W×H panel (flowing to
  // the next row when one is full), with gaps of `gap` px between them: [{i, x, y, w, h}] and the
  // scale, or null if nothing fits.
  function pack(pieces, W, H, { gap = 6, max = 3 } = {}) {
    const flow = (s) => {
      const rows = [];
      let row = null;
      for (let i = 0; i < pieces.length; i++) {
        const w = pieces[i].w * s, h = pieces[i].h * s;
        if (w > W) return null;
        if (!row || row.w + gap + w > W) { row = { items: [], w: -gap, h: 0 }; rows.push(row); }
        row.items.push({ i, w, h });
        row.w += gap + w;
        row.h = Math.max(row.h, h);
      }
      const total = rows.reduce((t, r) => t + r.h, 0) + gap * (rows.length - 1);
      return total <= H ? { rows, total } : null;
    };
    let lo = 0, hi = max;
    if (flow(hi)) lo = hi;
    else {
      for (let n = 0; n < 24; n++) { const s = (lo + hi) / 2; if (flow(s)) lo = s; else hi = s; }
    }
    const f = lo > 0 && flow(lo);
    if (!f) return null;
    const out = [];
    let y = (H - f.total) / 2;
    for (const r of f.rows) {
      let x = (W - r.w) / 2;
      for (const it of r.items) {
        out.push({ i: it.i, x, y: y + (r.h - it.h) / 2, w: it.w, h: it.h });
        x += it.w + gap;
      }
      y += r.h + gap;
    }
    return { scale: lo, placed: out };
  }

  // Two looks agree (the same table, within a few px): a new layout is taken once it holds.
  function same(a, b) {
    if (!a || !b) return false;
    const ta = a.table, tb = b.table, near = (x, y, e) => Math.abs(x - y) <= e;
    return ta.kind === tb.kind && ta.rows === tb.rows && ta.cols.length === tb.cols.length && near(ta.p, tb.p, 0.6)
      && near(ta.top, tb.top, 3) && ta.cols.every((c, i) => near(c.x, tb.cols[i].x, 3) && near(c.w, tb.cols[i].w, 0.5 * ta.p));
  }

  root.FoneShot = { brightMask, table, towerParts, rcBox, mapBox, detect, bar, pack, same };
})(typeof globalThis !== 'undefined' ? globalThis : this);
