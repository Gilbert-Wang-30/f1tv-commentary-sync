// The streamer window over F1 TV (V, or the panel's 📺): the streamer's picture in step with the
// commentary (streamer.html in an iframe, an extension page: its BroadcastChannels reach the
// engine's), moved by its bar and sized by its corner, where it was last left
// (chrome.storage.local streamerBox {x, y, w, h}, and streamerOn); ⧉ puts it in a window of its
// own instead (background.js popout-streamer). In F1 TV's fullscreen it goes along, as the panel.
(() => {
  'use strict';
  if (window.__foneStreamerBox) return;
  window.__foneStreamerBox = true;

  const MIN_W = 200, MIN_H = 130, BAR = 24;
  const host = document.createElement('div');
  host.id = 'fone-streamer';
  host.hidden = true;
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
<style>
  :host { all: initial; }
  :host([hidden]), [hidden] { display: none !important; }
  .box { position: fixed; z-index: 2147483646; display: flex; flex-direction: column; background: #000; border-radius: 10px;
    overflow: hidden; border: 1px solid rgba(255,255,255,.16); box-shadow: 0 8px 28px rgba(0,0,0,.5);
    font: 12px/1 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; color: #eee; }
  .bar { height: ${BAR}px; flex: none; display: flex; align-items: center; gap: 6px; padding: 0 4px 0 10px;
    background: rgba(24,24,28,.94); cursor: move; user-select: none; touch-action: none; }
  .ttl { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .85; }
  button { all: unset; cursor: pointer; padding: 3px 6px; border-radius: 5px; opacity: .8; }
  button:hover { background: rgba(255,255,255,.12); opacity: 1; }
  iframe { flex: 1; width: 100%; border: 0; background: #000; }
  .box.moving iframe { pointer-events: none; }
  .grip { position: absolute; right: 0; bottom: 0; width: 16px; height: 16px; cursor: nwse-resize; touch-action: none;
    background: linear-gradient(135deg, transparent 50%, rgba(255,255,255,.35) 50% 60%, transparent 60% 70%, rgba(255,255,255,.35) 70% 80%, transparent 80%); }
</style>
<div class="box" id="box">
  <div class="bar" id="bar"><span class="ttl" id="ttl">The streamer</span>
    <button id="page" hidden title="Their live page, in a new tab">↗</button><button id="pop" title="In a window of its own">⧉</button><button id="close" title="Close (V)">✕</button></div>
  <iframe id="frame" allow="autoplay" title="The streamer's picture"></iframe>
  <div class="grip" id="grip" title="Drag to resize"></div>
</div>`;
  const $ = (id) => root.getElementById(id);
  const box = $('box'), frame = $('frame');

  let on = false;
  let geo = null; // {x, y, w, h} in CSS px, the box's top-left and size

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  function place() {
    const vw = window.innerWidth, vh = window.innerHeight;
    if (!geo) { const w = Math.min(480, Math.round(vw * 0.3)); geo = { w, h: Math.round(w * 9 / 16) + BAR, x: 16, y: vh - Math.round(w * 9 / 16) - BAR - 80 }; }
    geo.w = clamp(geo.w, MIN_W, vw);
    geo.h = clamp(geo.h, MIN_H, vh);
    geo.x = clamp(geo.x, 0, vw - geo.w);
    geo.y = clamp(geo.y, 0, vh - BAR);
    Object.assign(box.style, { left: `${geo.x}px`, top: `${geo.y}px`, width: `${geo.w}px`, height: `${geo.h}px` });
  }
  const save = () => chrome.storage.local.set({ streamerBox: geo, streamerOn: on }).catch(() => {});

  // (moveBefore keeps the iframe's page, its picture and what it keeps, where Chrome has it; an
  // append reloads it)
  function mount() {
    const fs = document.fullscreenElement;
    const parent = fs && fs.tagName !== 'VIDEO' ? fs : document.documentElement;
    if (host.parentNode === parent) return;
    if (host.isConnected && typeof parent.moveBefore === 'function') {
      try { parent.moveBefore(host, null); return; } catch { /* not movable here: appended */ }
    }
    parent.appendChild(host);
  }
  document.addEventListener('fullscreenchange', mount);
  window.addEventListener('resize', () => { if (on) place(); });

  function show(v, keep = true) {
    on = v;
    host.hidden = !on;
    if (on) {
      mount();
      place();
      if (!frame.src) frame.src = chrome.runtime.getURL('streamer.html?mode=box');
    } else {
      frame.removeAttribute('src'); // (closed: its player and its share of the stream stop)
    }
    if (keep) save();
  }

  // dragging the bar moves it, the corner sizes it
  function drag(e, kind) {
    if (e.button !== 0 || e.target.closest?.('button')) return;
    e.preventDefault();
    const x0 = e.clientX, y0 = e.clientY, g0 = { ...geo };
    box.classList.add('moving');
    e.target.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const dx = ev.clientX - x0, dy = ev.clientY - y0;
      if (kind === 'move') Object.assign(geo, { x: g0.x + dx, y: g0.y + dy });
      else Object.assign(geo, { w: g0.w + dx, h: g0.h + dy });
      place();
    };
    const up = () => {
      box.classList.remove('moving');
      e.target.removeEventListener('pointermove', move);
      e.target.removeEventListener('pointerup', up);
      e.target.removeEventListener('pointercancel', up);
      save();
    };
    e.target.addEventListener('pointermove', move);
    e.target.addEventListener('pointerup', up);
    e.target.addEventListener('pointercancel', up);
  }
  $('bar').addEventListener('pointerdown', (e) => drag(e, 'move'));
  $('grip').addEventListener('pointerdown', (e) => drag(e, 'size'));
  $('close').addEventListener('click', () => show(false));
  $('pop').addEventListener('click', () => popOut());

  function popOut() {
    show(false);
    chrome.runtime.sendMessage({ target: 'background', type: 'popout-streamer' }).catch(() => {});
  }

  // the channel's name and its live page (↗), from the engine's status (it reaches every content
  // script of the tab)
  let page = null;
  chrome.runtime.onMessage.addListener((m) => {
    if (m?.type !== 'fone-status') return;
    if (m.status?.channel) $('ttl').textContent = `${m.status.channel} · the streamer`;
    page = m.status?.page || null;
    $('page').hidden = !page;
  });
  $('page').addEventListener('click', () => { if (page) window.open(page, '_blank', 'noopener'); });

  window.FoneStreamer = Object.freeze({ toggle: () => show(!on), isOn: () => on, popOut });
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyV' || e.altKey || e.shiftKey || e.ctrlKey || e.metaKey || e.repeat) return;
    const t = e.composedPath()[0];
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (!on && !panelShown()) return; // (fone's panel isn't up: not a player page)
    e.preventDefault();
    e.stopPropagation();
    show(!on);
  }, true);

  // fone's panel up: an F1 TV video playing (content.js shows it then)
  const panelShown = () => { const o = document.getElementById('fone-overlay'); return !!o && !o.hidden; };

  // Left open last time: open again once there's a video (and the panel with it).
  chrome.storage.local.get({ streamerBox: null, streamerOn: false }).then(({ streamerBox, streamerOn }) => {
    if (streamerBox && Number.isFinite(streamerBox.w)) geo = streamerBox;
    if (!streamerOn) return;
    const reopen = () => { if (!on && panelShown()) { show(true, false); return true; } return false; };
    if (reopen()) return;
    const watch = new MutationObserver(() => { if (reopen()) watch.disconnect(); });
    const attach = () => {
      const o = document.getElementById('fone-overlay');
      if (o) watch.observe(o, { attributes: true, attributeFilter: ['hidden'] });
      else setTimeout(attach, 1000);
    };
    attach();
  }).catch(() => {});
})();
