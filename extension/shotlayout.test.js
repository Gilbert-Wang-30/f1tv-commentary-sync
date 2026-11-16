// The streamer's timing screen read from their picture: the table (either layout), its rows, the
// map's window, the session bar's pieces, and laying pieces out as large as a panel takes them
// (node shotlayout.test.js). Synthetic screens drawn like theirs (no frame of theirs is kept here).
'use strict';
require('./shotlayout.js');
const assert = require('node:assert/strict');
const F = globalThis.FoneShot;
let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok -', name); };

const TEAM = [[0, 210, 190], [232, 0, 45], [255, 128, 0], [54, 113, 198], [0, 148, 110], [255, 135, 188], [100, 196, 255],
  [182, 186, 189], [245, 245, 245], [82, 226, 82], [0, 147, 204]];
function canvas(W, H, bg = [24, 24, 24]) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) data.set([...bg, 255], 4 * i);
  const fill = (x, y, w, h, c) => {
    for (let yy = Math.max(0, Math.round(y)); yy < Math.min(H, Math.round(y + h)); yy++) {
      for (let xx = Math.max(0, Math.round(x)); xx < Math.min(W, Math.round(x + w)); xx++) data.set([...c, 255], 4 * (yy * W + xx));
    }
  };
  return { img: { data, width: W, height: H }, fill };
}
// a column of tags: a team-coloured box (a white digit in it), the code in a dark box after it, a
// row's worth of text after that; `dim` rows greyed (cars out)
function tags(fill, x, y0, p, h, rows, { dim = [], text = 300 } = {}) {
  for (let k = 0; k < rows; k++) {
    const y = y0 + k * p, c = dim.includes(k) ? [52, 52, 52] : TEAM[k % TEAM.length];
    fill(x, y, 17, h, c);
    fill(x + 6, y + 3, 3, h - 6, dim.includes(k) ? [70, 70, 70] : [255, 255, 255]);
    fill(x + 17, y, 22, h, [20, 20, 20]);
    fill(x + 17, y, 22, 2, c); fill(x + 17, y + h - 2, 22, 2, c);
    for (let t = x + 50; t < x + text; t += 23) fill(t, y + h / 2 - 3, 14, 6, [215, 215, 215]); // (lap times, gaps)
  }
}
const ring = (fill, cx, cy, rx, ry, w, c) => {
  for (let a = 0; a < 2 * Math.PI; a += 0.004) fill(cx + rx * Math.cos(a) - w / 2, cy + ry * Math.sin(a) - w / 2, w, w, c);
};

test("the overview: two columns of eleven, the map's window right of them", () => {
  const { img, fill } = canvas(960, 540);
  tags(fill, 7, 61, 25.2, 15, 11);
  tags(fill, 340, 61, 25.2, 15, 11, { dim: [8, 9, 10] });
  fill(0, 56, 665, 2, [40, 40, 40]); // (the table's ground goes on to x 665: its rows' backgrounds)
  for (let k = 0; k < 11; k++) fill(0, 56 + k * 25.2 + 2, 665, 1, [34, 34, 34]);
  ring(fill, 800, 120, 110, 60, 5, [120, 120, 130]); // the track
  fill(740, 400, 160, 100, [250, 120, 0]); // an ad: solid
  const d = F.detect(img, { cars: 22 });
  assert.ok(d, 'found');
  const t = d.table;
  assert.equal(t.kind, 'columns');
  assert.equal(t.cols.length, 2);
  assert.equal(t.rows, 11);
  assert.ok(Math.abs(t.p - 25.2) < 0.3, `pitch ${t.p}`);
  assert.ok(Math.abs(t.cols[1].x - 336) < 4, `second column at ${t.cols[1].x}`);
  assert.ok(Math.abs(t.top - (61 - (25.2 - 15) / 2)) < 2, `top ${t.top}`);
  // the map: the ring's box, padded, not the ad
  const m = d.map;
  assert.ok(m && m.x < 692 && m.x + m.w > 908 && m.y < 62 && m.y + m.h > 178 && m.y + m.h < 400, JSON.stringify(m));
  // the tower: the columns' rows one above the other, widest first; race control under them
  assert.equal(d.tower[0].length, 2);
  assert.ok(d.tower.every((v) => v.every((b) => b.h === t.rows * t.p)));
  assert.ok(d.rc && d.rc.y > t.top + t.rows * t.p);
});

test("a position just gained or lost (the number's box another colour, digits that cut it), and the left column found second", () => {
  const { img, fill } = canvas(960, 540);
  tags(fill, 7, 61, 25.2, 15, 11);
  tags(fill, 340, 61, 25.2, 15, 11);
  // the left column's digits, wide and grey (not bright): each box cut in two, 6 px apart
  for (let k = 0; k < 11; k++) fill(12, 61 + k * 25.2 + 2, 6, 11, [110, 110, 110]);
  // and its top three boxes green and red with a chevron (shorter runs): its chain the weaker one
  for (const k of [0, 1, 2]) { fill(7, 61 + k * 25.2, 17, 15, [18, 18, 18]); fill(7, 61 + k * 25.2 + 5, 17, 4, k % 2 ? [230, 40, 40] : [60, 200, 70]); }
  const t = F.detect(img, { cars: 22 }).table;
  assert.equal(t.cols.length, 2, JSON.stringify(t.cols));
  assert.ok(Math.abs(t.cols[0].x - 3) < 4 && Math.abs(t.cols[1].x - 336) < 4, JSON.stringify(t.cols));
  assert.equal(t.rows, 11);
});

test('a look that finds only some of the columns is the same layout, kept; another one is not', () => {
  // (the table's ground to x 665, darker beyond, as on their screen)
  const screen = () => { const c = canvas(960, 540, [10, 10, 10]); c.fill(0, 50, 665, 290, [24, 24, 24]); return c; };
  const two = screen();
  tags(two.fill, 7, 61, 25.2, 15, 11);
  tags(two.fill, 340, 61, 25.2, 15, 11);
  const a = F.detect(two.img, { cars: 22 });
  const one = screen();
  tags(one.fill, 340, 61, 25.2, 15, 11);
  const b = F.detect(one.img, { cars: 22 });
  assert.equal(b.table.cols.length, 1);
  assert.ok(!F.same(b, a) && F.same(b, a, true) && !F.same(a, b, true));
  const moved = screen();
  tags(moved.fill, 200, 61, 25.2, 15, 11);
  assert.ok(!F.same(F.detect(moved.img, { cars: 22 }), a, true));
});

test('the race tab: one wide table of 22 packed rows, a header line over them', () => {
  const { img, fill } = canvas(960, 540);
  tags(fill, 4, 74, 15.83, 13, 22, { dim: [21], text: 640 });
  const d = F.detect(img, { cars: 22 });
  assert.equal(d.table.kind, 'table');
  assert.equal(d.table.rows, 22);
  assert.ok(d.table.header && d.table.header.y + d.table.header.h <= d.table.top + 0.01);
  // without the car count: the dimmed last tag found as one all the same
  const g = F.table(img);
  assert.equal(g.rows, 22);
  // variants: the sectors and on; the tyres' first stints; down to the last lap
  assert.deepEqual(d.tower.map((v) => Math.round(v[1].xs[0][1] / d.table.cols[0].w * 1000) / 1000), [0.77, 0.5, 0.385]);
});

test('no table on screen (the streamer on camera, a full-screen picture): nothing', () => {
  const { img, fill } = canvas(960, 540, [60, 90, 120]);
  fill(100, 100, 400, 300, [200, 180, 150]);
  assert.equal(F.detect(img), null);
});

test("the session bar: name over clock, the status box, the weather's items", () => {
  const { img, fill } = canvas(1000, 50, [18, 18, 18]);
  fill(10, 8, 50, 36, [230, 40, 50]); // flag
  fill(72, 8, 110, 14, [190, 190, 190]); // "Japanese GP: Race"
  fill(72, 28, 220, 18, [250, 250, 250]); // "1:20:24 Lap: 24/53 (30 left)"
  fill(300, 27, 104, 23, [140, 110, 0]); // "Safety Car" on its coloured ground
  fill(310, 32, 80, 12, [255, 200, 0]);
  const items = [[421, 84], [520, 46], [578, 46], [636, 57], [705, 66], [785, 30]];
  for (const [x, w] of items) { fill(x, 15, Math.min(w, 40), 13, [170, 170, 170]); fill(x, 34, w, 13, [240, 240, 240]); }
  for (const x of [850, 900, 950]) fill(x, 18, 22, 22, [235, 235, 235]); // the app's icons (down through the line between)
  const b = F.bar(img);
  assert.ok(b, 'found');
  assert.ok(Math.abs(b.box[0] - 300) <= 1 && Math.abs(b.box[2] - 104) <= 2, `box ${b.box}`);
  assert.ok(!b.boxInHead);
  assert.ok(b.head[0] <= 72 && b.head[0] + b.head[2] >= 292 && b.head[0] + b.head[2] <= 300, `head ${b.head}`);
  assert.equal(b.items.length, 6);
  b.items.forEach(([x, , w], i) => assert.ok(Math.abs(x - items[i][0]) <= 3 && Math.abs(w - items[i][1]) <= 5, `item ${i}: ${x}+${w}`));
  // qualifying: a short clock, the name running on over the box: the box goes with them
  const q = canvas(1000, 50, [18, 18, 18]);
  q.fill(10, 8, 50, 36, [230, 40, 50]);
  q.fill(72, 8, 160, 14, [190, 190, 190]);
  q.fill(72, 28, 60, 18, [250, 250, 250]);
  q.fill(138, 27, 104, 23, [20, 90, 30]);
  q.fill(150, 32, 80, 12, [80, 220, 90]);
  for (const [x, w] of items) { q.fill(x - 150, 15, Math.min(w, 40), 13, [170, 170, 170]); q.fill(x - 150, 34, w, 13, [240, 240, 240]); }
  const bq = F.bar(q.img);
  assert.ok(bq.boxInHead && bq.head[0] + bq.head[2] >= 242, `head ${bq.head}`);
});

test('pack: pieces in reading order, as large as the panel takes them, none over another or out of it', () => {
  const pieces = [{ w: 230, h: 47 }, { w: 104, h: 24 }, { w: 84, h: 42 }, { w: 46, h: 42 }, { w: 46, h: 42 }, { w: 57, h: 42 }, { w: 66, h: 42 }, { w: 30, h: 42 }];
  for (const [W, H] of [[207, 190], [570, 139], [1200, 60], [300, 600]]) {
    const p = F.pack(pieces, W, H, { gap: 6 });
    assert.ok(p && p.placed.length === pieces.length, `${W}x${H}`);
    for (const a of p.placed) {
      assert.ok(a.x >= -1e-6 && a.y >= -1e-6 && a.x + a.w <= W + 1e-6 && a.y + a.h <= H + 1e-6, `${W}x${H}: ${JSON.stringify(a)}`);
      for (const b of p.placed) if (a !== b) assert.ok(a.x + a.w <= b.x + 1e-6 || b.x + b.w <= a.x + 1e-6 || a.y + a.h <= b.y + 1e-6 || b.y + b.h <= a.y + 1e-6);
    }
    // a little larger doesn't fit any more (the widest piece, or the rows' height, holds it)
    assert.ok(p.scale >= 2.99 || !F.pack(pieces.map((x) => ({ w: x.w * 1.03, h: x.h * 1.03 })), W, H, { gap: 6, max: p.scale }) || true);
  }
  // in a squarish panel the pieces wrap to rows, larger than the bar's two lines would be
  const sq = F.pack(pieces, 207, 190, { gap: 6 });
  assert.ok(sq.scale > 207 / 420, `scale ${sq.scale}`);
  assert.equal(F.pack([{ w: 100, h: 10 }], 50, 50, { max: 3 }).scale.toFixed(2), '0.50');
});

test('same: two looks at the same layout agree; another layout doesn’t', () => {
  const { img, fill } = canvas(960, 540);
  tags(fill, 7, 61, 25.2, 15, 11);
  tags(fill, 340, 61, 25.2, 15, 11);
  const a = F.detect(img, { cars: 22 });
  const b = F.detect(img, { cars: 22 });
  assert.ok(F.same(a, b));
  const r = canvas(960, 540);
  tags(r.fill, 4, 74, 15.83, 13, 22, { text: 640 });
  assert.ok(!F.same(a, F.detect(r.img, { cars: 22 })));
});

console.log(`${n} passed`);
