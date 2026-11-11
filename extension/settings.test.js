// node extension/settings.test.js
require('./settings.js');
const assert = require('node:assert/strict');
const S = globalThis.FoneSettings;
let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok -', name); };

test('a fresh install: Track FX, subtitles off, fone picks the track, INTERNATIONAL live (and that stored)', () => {
  const r = S.f1({});
  assert.deepEqual(r, { f1Sound: 'fx', f1Subs: false, f1Pick: true, f1Feed: 'intl', write: { f1Sound: 'fx', f1Pick: true } });
  assert.deepEqual(S.f1({ f1Sound: null, f1Pick: null, f1Audio: null, autoFx: null }), r); // (chrome.storage.sync.get's defaults)
});

test("0.3.10's 'mute' (its default): Track FX, fone picking it; F1 TV no longer muted", () => {
  const r = S.f1({ f1Audio: 'mute' });
  assert.equal(r.f1Sound, 'fx');
  assert.equal(r.f1Pick, true);
  assert.deepEqual(r.write, { f1Sound: 'fx', f1Pick: true });
  assert.equal(S.prefer(r), 'fx');
});

test("'fx' stays Track FX", () => {
  const r = S.f1({ f1Audio: 'fx', f1Feed: 'intl' });
  assert.deepEqual([r.f1Sound, r.f1Pick, S.prefer(r)], ['fx', true, 'fx']);
});

test("'eng' stays English Int.", () => {
  const r = S.f1({ f1Audio: 'eng' });
  assert.deepEqual([r.f1Sound, r.f1Pick, S.prefer(r)], ['eng', true, 'eng']);
  assert.deepEqual(r.write, { f1Sound: 'eng', f1Pick: true });
});

test("'off' (left alone) stays hands off: Track FX for when it's picked again, fone not picking", () => {
  const r = S.f1({ f1Audio: 'off' });
  assert.deepEqual([r.f1Sound, r.f1Pick, S.prefer(r)], ['fx', false, 'none']);
  assert.deepEqual(r.write, { f1Sound: 'fx', f1Pick: false });
});

test('0.2.26 and before: autoFx false is hands off, true the default', () => {
  assert.deepEqual([S.f1({ autoFx: false }).f1Pick, S.f1({ autoFx: true }).f1Pick, S.f1({ autoFx: true }).f1Sound], [false, true, 'fx']);
  assert.equal(S.f1({ autoFx: false, f1Audio: 'eng' }).f1Sound, 'eng'); // (f1Audio is the newer of the two)
});

test('once migrated, nothing more is written, and the old keys no longer count', () => {
  const r = S.f1({ f1Sound: 'eng', f1Pick: true, f1Audio: 'off' });
  assert.deepEqual([r.f1Sound, r.f1Pick, r.write], ['eng', true, {}]);
  // (another computer still on 0.3.10 changing f1Audio later doesn't move this one)
  assert.deepEqual(S.f1({ f1Sound: 'fx', f1Pick: false, f1Audio: 'eng' }).write, {});
  assert.equal(S.f1({ f1Sound: 'fx', f1Pick: false }).f1Pick, false);
  // f1Sound set but f1Pick never stored (a hand edit): fone picks, nothing written
  assert.deepEqual([S.f1({ f1Sound: 'fx' }).f1Pick, S.f1({ f1Sound: 'fx' }).write], [true, {}]);
});

test("a stored f1Pick is kept over the old setting's say", () => {
  assert.equal(S.f1({ f1Audio: 'off', f1Pick: true }).f1Pick, true);
  assert.deepEqual(S.f1({ f1Audio: 'off', f1Pick: true }).write, { f1Sound: 'fx' });
});

test('anything unknown falls back to the defaults', () => {
  const r = S.f1({ f1Sound: 'mute', f1Subs: 'yes', f1Pick: 'no', f1Feed: 'world' });
  assert.deepEqual([r.f1Sound, r.f1Subs, r.f1Pick, r.f1Feed], ['fx', false, true, 'intl']);
  assert.deepEqual([S.f1({ f1Sound: 'fx', f1Subs: true, f1Feed: 'off' }).f1Subs, S.f1({ f1Feed: 'off' }).f1Feed], [true, 'off']);
});

console.log(`${n} passed`);
