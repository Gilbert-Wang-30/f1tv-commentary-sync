// F1 TV's own settings, as fone keeps them (content.js's panel and the options page). Two in the
// panel: F1 TV's sound, f1Sound 'fx' (its commentary-free Track FX: the default) or 'eng' (its
// international English commentary, English Int.), and its subtitles, f1Subs on or off (off by
// default). Two more on the options page only: f1Pick, whether fone picks F1 TV's sound track at all
// (off: left to F1 TV, as you set it there), and f1Feed, live videos switched to INTERNATIONAL
// ('intl', the default) or not ('off'). fone no longer mutes F1 TV: its sound plays under the
// commentary, and F1 TV's own mute button silences it.
//
// Until 0.3.10 the sound was f1Audio: 'mute' (the default: F1 TV's player muted), 'fx', 'eng' or
// 'off' (left alone); before 0.2.27 a checkbox, autoFx. Migrated once, where f1Sound isn't set yet:
// 'eng' stays English Int., 'fx' and 'mute' become Track FX (F1 TV's sound is wanted now), 'off'
// becomes Track FX with f1Pick off (still left alone). The old keys stay in storage as they were,
// so a build from before (the other computer, until it updates; a rollback) goes on with them.
(function (root) {
  'use strict';

  const SOUNDS = ['fx', 'eng'];
  const OLD = ['mute', 'fx', 'eng', 'off'];
  const DEFAULTS = { f1Sound: 'fx', f1Subs: false, f1Pick: true, f1Feed: 'intl' };

  // stored: chrome.storage.sync's values (a key never set: absent or null)
  // -> {f1Sound, f1Subs, f1Pick, f1Feed, write}: write, what the migration settled, to store
  function f1(stored) {
    const s = stored || {};
    const write = {};
    let sound = s.f1Sound, pick = s.f1Pick;
    if (!SOUNDS.includes(sound)) {
      const old = OLD.includes(s.f1Audio) ? s.f1Audio : s.autoFx === false ? 'off' : null;
      sound = write.f1Sound = old === 'eng' ? 'eng' : 'fx';
      if (typeof pick !== 'boolean') pick = write.f1Pick = old !== 'off';
    }
    return {
      f1Sound: sound,
      f1Subs: s.f1Subs === true,
      f1Pick: typeof pick === 'boolean' ? pick : DEFAULTS.f1Pick,
      f1Feed: s.f1Feed === 'off' ? 'off' : 'intl',
      write,
    };
  }

  // What page.js is asked to pick ('fx', 'eng', or 'none': F1 TV's sound left alone).
  const prefer = (s) => (s.f1Pick === false ? 'none' : s.f1Sound === 'eng' ? 'eng' : 'fx');

  root.FoneSettings = Object.freeze({ f1, prefer, SOUNDS, DEFAULTS });
})(typeof globalThis !== 'undefined' ? globalThis : this);
