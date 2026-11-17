// The streamer's screen's layout kept look by look (FoneShot.follow, the dashboard's): a new one
// once two looks agree, a look missing some columns not taken for one, unless it holds
// (node shotfollow.test.js).
'use strict';
require('./shotlayout.js');
const assert = require('node:assert/strict');
const F = globalThis.FoneShot;
let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok -', name); };

// a look's layout as detect() gives it (what same() compares): the table's kind, rows, pitch, top, columns
const look = (xs, o = {}) => ({ table: { kind: 'columns', rows: 11, p: 25.2, top: 56, cols: xs.map((x) => ({ x, w: 230 })), ...o } });
const TWO = [20, 260], ONE = [260];
const run = (st, looks, o) => looks.reduce((s, d) => F.follow(s, d, o), st);

test('a new layout taken once two looks agree; one look of another scene, not', () => {
  let st = F.follow({ lay: null, cand: null }, look(TWO));
  assert.equal(st.lay.table.cols.length, 2); // (the first: taken)
  st = F.follow(st, look(TWO, { top: 140, rows: 10 })); // (a frame of something else)
  assert.ok(st.lay.table.top === 56 && st.cand);
  st = F.follow(st, look(TWO));
  assert.ok(st.lay.table.top === 56 && !st.cand);
  st = run(st, [look(TWO, { top: 140, rows: 10 }), look(TWO, { top: 141, rows: 10 })]); // (the streamer changed it)
  assert.equal(st.lay.table.top, 141);
});

test('a look missing a column keeps the layout; the same column gone look after look: closed', () => {
  const st0 = run({ lay: null, cand: null }, [look(TWO), look(TWO)]);
  // a position just gained: the box green, one column not read this time, then read again
  let st = run(st0, [look(ONE), look(ONE), look(TWO), look(ONE)]);
  assert.equal(st.lay.table.cols.length, 2);
  // misses that aren't the same column each time: never a layout
  st = run(st0, Array.from({ length: 12 }, (_, i) => look(i % 2 ? ONE : [20])));
  assert.equal(st.lay.table.cols.length, 2);
  // the streamer closed the first column: 8 looks (~12 s at one a 1.5 s) and it's the one column
  st = run(st0, Array.from({ length: 7 }, () => look(ONE)));
  assert.equal(st.lay.table.cols.length, 2);
  st = F.follow(st, look(ONE));
  assert.deepEqual(st.lay.table.cols.map((c) => c.x), [260]);
  // ...and opened again: taken once two looks agree
  st = run(st, [look(TWO), look(TWO)]);
  assert.equal(st.lay.table.cols.length, 2);
});

console.log(`${n} passed`);
