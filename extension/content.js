// Runs on f1tv.formula1.com: watches the player, shows the sync panel, handles hotkeys.
(() => {
  'use strict';
  if (window.__foneContent) return;
  window.__foneContent = true;

  const DEFAULTS = {
    // Where the commentary comes from: 'server' (a fone server's recordings: replays too) or
    // 'local' (no server: this browser records the stream itself, for live sessions). Until
    // it's chosen in the settings: a server if one is set (local.js or the settings), else local.
    source: null,
    stream: '', // 'local': the streamer's live URL (streams.js)
    bufferMin: 15, // 'local': minutes of the stream kept, for rewinding F1 TV
    liveDirect: true, // 'server', live: the streamer's stream straight into this browser (fresher than the server's)
    servers: self.FONE_LOCAL?.servers || [], // local.js: this install's, or none (then the settings page)
    channel: '',
    volume: 1,
    muted: false,
    autoHold: true,
    collapsed: false,
    speed: 1, // replays only; live always plays at 1×
    // F1 TV's own sound: 'mute' (off: the commentary carries the streamer's F1 TV sound), 'fx'
    // (switched to its commentary-free "Track FX" track: a track switch, which F1 TV's player
    // has crashed on), 'off' (left alone). Was autoFx: true/false (migrated in load()).
    f1Audio: 'mute',
    // F1 TV's picture, live: 'intl' (switched to INTERNATIONAL, the world feed streamers watch) or 'off'
    f1Feed: 'intl',
    anticipate: false, // measured delay + 0.9 s: commentary a little before the picture
  };
  const F1_AUDIO = ['mute', 'fx', 'eng', 'off'];
  const sourceOf = (s) => (s.source === 'local' || s.source === 'server' ? s.source : s.servers?.length ? 'server' : 'local');
  const SPEEDS = [1, 1.5, 2];
  let settings = { ...DEFAULTS };
  let speedStallSince = 0;
  let video = null;
  let cid = null;
  let status = null;
  let holding = false;
  let alive = true;
  let lastPush = 0;

  // ---- F1 TV page ----------------------------------------------------------------

  function idFrom(loc) {
    const m =
      loc.pathname.match(/\/detail\/(\d{6,})/) ||
      loc.search.match(/[?&]contentId=(\d{6,})/) ||
      loc.pathname.match(/\/(\d{9,})(?:[/?#]|$)/);
    return m ? m[1] : null;
  }

  function contentId() {
    let id = idFrom(location);
    if (!id && window.top !== window) {
      try { id = idFrom(window.top.location); } catch { /* cross-origin parent */ }
    }
    return id;
  }

  const EVENTS = ['play', 'pause', 'seeking', 'seeked', 'ratechange', 'waiting', 'playing', 'loadedmetadata', 'emptied'];
  const onVideoEvent = () => push(true);

  // Tiledmedia steers <video>.playbackRate on its own (SDK: element rate = chosen speed ×
  // syncMultiplier, the output of the core's view-sync PID). Details shows how often:
  // copied to the commentary, each trim was one of its pops.
  const rateLog = [];
  const rateChangesPerMin = () => {
    while (rateLog.length && Date.now() - rateLog[0] > 60000) rateLog.shift();
    return rateLog.length;
  };
  const onRateChange = () => { rateLog.push(Date.now()); rateChangesPerMin(); }; // bounded even while the panel is collapsed

  function bind(v) {
    if (video === v) return;
    if (video) {
      EVENTS.forEach((e) => video.removeEventListener(e, onVideoEvent));
      video.removeEventListener('ratechange', onRateChange);
    }
    video = v;
    rateLog.length = 0;
    FonePlayer.setVideo(v);
    if (holding && v) v.play().catch(() => {}); // don't leave F1 TV paused after a handle swap
    holding = false;
    if (v) {
      EVENTS.forEach((e) => v.addEventListener(e, onVideoEvent));
      v.addEventListener('ratechange', onRateChange);
    }
  }

  function diagOf() {
    const tm = FonePlayer.isTiledmedia() ? FonePlayer.tm() : null;
    const dm = window.FoneDanmaku?.diag(); // the danmaku overlay (danmaku.js)
    if (!tm) return dm ? { dm } : null;
    // sdk: page.js's log of the player's SDK calls (ours and F1 TV's), the core's fatal errors
    // a: F1 TV's audio track as page.js sees it (which, who chose it, the switch's error), h: the
    // MSE handle (a new one = the player rebuilt its pipeline), nv: tiledmedia-views in the page
    const a = tm.audio ? { v: tm.audio.v, cur: tm.audio.cur, kind: tm.audio.kind, auto: tm.audio.auto, manual: tm.audio.manual,
      on: tm.audio.on, fx: tm.audio.fx, err: tm.audio.err } : null;
    return { ev: tm.eventType, r: tm.r, ob: tm.ob, obErr: tm.obErr, dm, a, h: tm.h, nv: tm.nViews, sdk: tm.sdk };
  }

  function videoState() {
    const v = video;
    const pos = FonePlayer.position(); // see player.js: <video>.currentTime is not the position on F1 TV
    if (!pos) return null;
    return {
      p: pos.p,
      paused: v.paused,
      seeking: v.seeking,
      waiting: !v.paused && v.readyState < 3,
      rate: FonePlayer.rate(), // the chosen speed, without Tiledmedia's clock trims
      ready: v.readyState >= 1,
      live: pos.live,
      seekEnd: pos.seekEnd,
      utc0: pos.utc0 ?? null, // F1 TV's own clock (live): utc0 + p is the time on the picture
      src: pos.src,
      at: Date.now() / 1000,
      dx: diagOf(), // F1 TV's side of the speed, for the engine's diagnostics
    };
  }

  function send(msg) {
    if (!alive) return;
    try {
      chrome.runtime.sendMessage({ target: 'engine', ...msg }).catch(() => {});
    } catch {
      alive = false; // extension reloaded; this script is orphaned
      host.remove();
    }
  }

  function push(force) {
    const t = performance.now();
    if (!force && t - lastPush < 200) return;
    const state = videoState();
    if (!state) return; // position not known yet (player still starting)
    lastPush = t;
    send({
      type: 'video',
      cid,
      channel: settings.channel,
      video: state,
      settings: { servers: settings.servers, volume: settings.volume, muted: settings.muted, anticipate: !!settings.anticipate,
        source: settings.source, stream: settings.stream, bufferMin: settings.bufferMin, liveDirect: settings.liveDirect !== false },
    });
  }

  function poll() {
    const id = contentId();
    const v = id ? FonePlayer.pickVideo() : null;
    if (id !== cid || v !== video) {
      if (cid && (!id || !v)) send({ type: 'detach' });
      cid = id;
      status = null;
      bind(v);
    }
    host.hidden = !(cid && video);
    if (cid && video) push(false);
    syncPage(false);
    render();
  }

  // ---- F1 TV player (page.js, main world): speed and audio track ------------------

  const pageCmd = (m) => document.dispatchEvent(new CustomEvent('fone-cmd', { detail: JSON.stringify(m) }));
  let lastCmd = '';
  let lastCmdAt = 0;

  // Desired state, re-sent every 2 s: page.js stops steering when we go quiet.
  function syncPage(force) {
    if (!alive || !cid || !video || !FonePlayer.isTiledmedia()) return;
    const speed = SPEEDS.includes(Number(settings.speed)) ? Number(settings.speed) : 1;
    // (live and playing: not while auto-hold holds it)
    const live = playKind() === 'live' && !holding;
    const key = `${speed}|${settings.f1Audio}|${settings.f1Feed}|${live}|${cid}`;
    const t = Date.now();
    if (!force && key === lastCmd && t - lastCmdAt < 2000) return;
    lastCmd = key;
    lastCmdAt = t;
    pageCmd({ cmd: 'rate', value: speed });
    pageCmd({ cmd: 'audio', prefer: ['fx', 'mute', 'eng'].includes(settings.f1Audio) ? settings.f1Audio : 'none',
      feed: settings.f1Feed === 'intl' ? 'intl' : 'none', live, cid });
  }

  // Speed only for replays (Tiledmedia eventType vod); page.js keeps live at 1× regardless.
  function playKind() {
    const tm = FonePlayer.tm();
    if (!tm || !tm.eventType || tm.eventType === 'unknown') return null;
    return tm.eventType === 'vod' ? 'replay' : 'live';
  }

  function setSpeed(x) {
    // the speed already chosen, pressed again: page.js asks the player afresh (force), for
    // when the player isn't taking it
    if (x === (Number(settings.speed) || 1)) pageCmd({ cmd: 'rate', value: x, force: true });
    save({ speed: x });
    syncPage(true);
    toast(`Speed ${x}×`);
  }

  function stepSpeed(dir) {
    const kind = playKind();
    if (kind !== 'replay') { toast(kind === 'live' ? 'Live plays at 1× only' : 'Speed works on F1 TV replays'); return; }
    const cur = Number(settings.speed) || 1;
    const next = dir > 0 ? SPEEDS.find((s) => s > cur + 1e-9) ?? SPEEDS[SPEEDS.length - 1]
      : [...SPEEDS].reverse().find((s) => s < cur - 1e-9) ?? SPEEDS[0];
    setSpeed(next);
  }

  // Live: if you're ahead of the commentary, pause the video until it catches up.
  // Held, F1 TV goes again once the lead is back near the one the engine aims for (leadAim: 2 s
  // live from an HTTP-FLV stream recorded here, 4.5 s on a server's recording), at most 4 s.
  const holdRelease = () => Math.max(1.5, Math.min(4, (status?.leadAim ?? 4.5) - 0.5));
  function autoHold() {
    if (!video || !status) return;
    const lead = status.lead;
    if (!settings.autoHold || lead == null) {
      if (holding) { holding = false; video.play().catch(() => {}); }
      return;
    }
    if (!holding && !video.paused && lead < 0.5) {
      holding = true;
      video.pause();
    } else if (holding && lead > holdRelease()) {
      holding = false;
      video.play().catch(() => {});
    }
  }

  // ---- UI ------------------------------------------------------------------------

  const host = document.createElement('div');
  host.id = 'fone-overlay';
  host.hidden = true;
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
<style>
  :host { all: initial; }
  :host([hidden]), [hidden] { display: none !important; }
  .wrap { position: fixed; top: 14px; right: 14px; z-index: 2147483647; font: 13px/1.35 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; color: #f2f2f2; }
  .card { background: rgba(16,16,20,.88); backdrop-filter: blur(8px); border: 1px solid rgba(255,255,255,.12); border-radius: 12px; padding: 10px 12px; width: 300px; box-shadow: 0 6px 24px rgba(0,0,0,.4); }
  .head { display: flex; align-items: center; gap: 8px; cursor: pointer; user-select: none; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: #888; flex: none; }
  .dot.sync { background: #3ddc84; } .dot.syncing, .dot.loading, .dot.buffering { background: #f5c542; }
  .dot.waiting { background: #f5c542; animation: pulse 1s infinite; } .dot.paused { background: #8ab4f8; }
  .dot.error, .dot.none, .dot.after { background: #ff5f57; } .dot.before, .dot.gap { background: #b388ff; }
  @keyframes pulse { 50% { opacity: .3; } }
  .name { font-weight: 600; } .text { color: #bbb; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .chev { color: #888; }
  .body { margin-top: 8px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; } /* nothing widens the card */
  .row { display: flex; align-items: center; gap: 6px; min-width: 0; flex-wrap: wrap; }
  .delay { font-variant-numeric: tabular-nums; }
  .nudge { display: grid; grid-template-columns: repeat(8, minmax(0, 1fr)); gap: 3px; margin-top: -3px; }
  .nudge button { padding: 3px 0; text-align: center; font-variant-numeric: tabular-nums; }
  button { all: unset; cursor: pointer; padding: 3px 7px; border-radius: 6px; background: rgba(255,255,255,.1); font: 12px system-ui; color: #eee; }
  button:hover { background: rgba(255,255,255,.2); }
  button.on { background: #e10600; color: #fff; }
  .lbl { color: #999; min-width: 42px; }
  .hint { color: #999; font-size: 11.5px; }
  .hint.warn { color: #f5c542; }
  input[type=range] { flex: 1; min-width: 0; accent-color: #e10600; }
  select { flex: 1; background: #222; color: #eee; border: 1px solid #444; border-radius: 6px; padding: 2px 4px; font: 12px system-ui; }
  .hold { background: rgba(245,197,66,.15); border: 1px solid rgba(245,197,66,.4); color: #f5c542; border-radius: 8px; padding: 5px 8px; }
  details { color: #aaa; font-size: 11.5px; } summary { cursor: pointer; color: #888; }
  .kv { display: grid; grid-template-columns: 88px 1fr; gap: 2px 8px; margin-top: 6px; word-break: break-all; }
  .kv b { font-weight: 500; color: #888; }
  .badge { font-size: 10.5px; padding: 1px 5px; border-radius: 4px; background: rgba(61,220,132,.18); color: #3ddc84; }
  .badge.est { background: rgba(245,197,66,.18); color: #f5c542; }
  .collapsed .body { display: none; } .collapsed .card { width: auto; padding: 6px 10px; }
  .toast { position: absolute; top: 100%; right: 0; margin-top: 6px; background: rgba(16,16,20,.92); padding: 5px 10px; border-radius: 8px; opacity: 0; transition: opacity .2s; white-space: nowrap; }
  .toast.on { opacity: 1; }
</style>
<div class="wrap">
  <div class="card">
    <div class="head" id="head"><span class="dot" id="dot"></span><span class="name" id="name">解说</span><span class="text" id="text"></span><span class="chev" id="chev">▾</span></div>
    <div class="body">
      <div class="hold" id="hold" hidden></div>
      <div class="row"><span class="delay" id="delay">delay –</span></div>
      <div class="nudge">
        <button data-d="-5" title="{">−5</button><button data-d="-0.5" title="[">−½</button><button data-d="-0.1" title="-">−.1</button><button data-d="-0.02" title=",">−.02</button>
        <button data-d="0.02" title=".">+.02</button><button data-d="0.1" title="=">+.1</button><button data-d="0.5" title="]">+½</button><button data-d="5" title="}">+5</button>
      </div>
      <div class="row" id="liveRow" hidden><button id="golive" title="F1 TV and the commentary to the freshest moment both have (L, or F1 TV's LIVE)">⏭ Go live</button><button id="relive" title="Re-anchor the commentary to its live edge, F1 TV where it is">⟲ Re-sync</button><span class="hint">L · or F1 TV's LIVE</span></div>
      <div class="hint">Reactions come <b>after</b> the action → <b>+</b> &nbsp;·&nbsp; spoilers → <b>−</b> &nbsp;·&nbsp; keys <b>{ [ − , . = ] }</b></div>
      <div class="row"><button id="mute">🔊</button><input type="range" id="vol" min="0" max="1" step="0.05"></div>
      <div class="row" id="speedRow" hidden><span class="lbl">Speed</span><button data-s="1">1×</button><button data-s="1.5">1.5×</button><button data-s="2">2×</button><span class="hint" id="speedInfo">keys <b>&lt; &gt;</b></span></div>
      <div class="row" id="statsRow"><button id="stats" title="Timing, track map and conditions beside the video (key S)">📊 Stats</button><button id="statsPop" title="Open the stats in a window of their own">⧉</button>
        <button id="dm" title="The live room's 弹幕 over the picture, in step with the commentary (key D)">弹 弹幕</button><button id="dmSet" title="弹幕设置">⚙</button><span class="hint" id="dmInfo"></span></div>
      <div class="row" id="picRow"><button id="pic" title="The streamer's picture, in step with the commentary: a window over F1 TV you can move and size (key V)">📺 Streamer</button><button id="picPop" title="The streamer's picture in a window of its own">⧉</button><button id="picPage" hidden title="The streamer's live page on their platform, in a new tab">↗ Live page</button></div>
      <div class="row" id="fxRow" hidden><span class="lbl">F1 TV</span><button data-fa="mute" title="F1 TV's own sound off: the commentary carries the streamer's F1 TV sound (no track switch, no echo)">muted</button><button data-fa="fx" title="F1 TV switched to its commentary-free track (a track switch, which F1 TV's player sometimes crashes on)">track sound</button><button data-fa="eng" title="F1 TV's international English commentary (English Int.), not F1 TV's own (English F1 Live)">English Int.</button><button data-fa="off" title="F1 TV's sound left as it is">as is</button><span class="hint" id="faInfo"></span></div>
      <div class="row" id="ffRow" hidden><span class="lbl">Picture</span><button data-ff="intl" title="Live: F1 TV switched to INTERNATIONAL, the world feed the streamer watches (its graphics, its replays), once per video">International</button><button data-ff="off" title="F1 TV's channel left as it is">as is</button><span class="hint" id="ffInfo"></span></div>
      <label class="row hint" id="antRow" hidden><input type="checkbox" id="anticipate"> Anticipate reactions: commentary 0.9 s early</label>
      <label class="row hint" id="holdRow"><input type="checkbox" id="autohold"> Pause video when ahead of live commentary</label>
      <details id="details"><summary>Details</summary>
        <div class="row" style="margin-top:6px"><select id="channel"></select></div>
        <div class="kv" id="kv"></div>
      </details>
    </div>
  </div>
  <div class="toast" id="toast"></div>
</div>`;
  const $ = (id) => root.getElementById(id);
  const wrap = root.querySelector('.wrap');

  function mount() {
    const fs = document.fullscreenElement;
    const parent = fs && fs.tagName !== 'VIDEO' ? fs : document.documentElement;
    if (host.parentNode !== parent) parent.appendChild(host);
  }
  document.addEventListener('fullscreenchange', mount);
  mount();

  const fmtTime = (t) => (t ? new Date(t * 1000).toISOString().slice(11, 21) + 'Z' : '–');
  const CLOCKS = {
    multiviewer: ['exact (MultiViewer)', ''],
    preroll: ['estimated', 'est'],
    epoch: ['player clock', ''],
    edge: ['live: edge to edge', ''],
    manual: ['manual — line it up', 'est'],
  };

  function render() {
    if (host.hidden) return;
    wrap.classList.toggle('collapsed', settings.collapsed);
    // Nothing to play from (no server listed, or no stream to record): say so up front rather
    // than letting the engine report every server as unreachable.
    const local = settings.source === 'local';
    const s = !local && !settings.servers?.length
      ? { state: 'error', text: "No server set — open fone's settings (toolbar icon) and enter its URL" }
      : local && !String(settings.stream || '').trim()
        ? { state: 'error', text: "No stream set — open fone's settings (toolbar icon) and paste the streamer's live URL" }
        : status || { state: 'loading', text: 'Connecting…' };
    $('dot').className = `dot ${s.state}`;
    $('name').textContent = s.channel || '解说';
    let text = s.text || '';
    if (s.state === 'sync' && s.drift != null) text += ` ±${Math.round(Math.abs(s.drift) * 1000)}ms`;
    if (settings.muted) text += ' · muted';
    else if (s.ad) text += ' · sponsor clip muted';
    $('text').textContent = text;
    $('chev').textContent = settings.collapsed ? '▸' : '▾';
    if (settings.collapsed) return;

    $('liveRow').hidden = s.clock !== 'edge';
    $('delay').textContent = s.delay != null ? `delay ${s.delay.toFixed(2)} s` : 'delay –';
    $('mute').textContent = settings.muted ? '🔇' : '🔊';
    if (document.activeElement !== host) $('vol').value = settings.volume;
    $('autohold').checked = settings.autoHold;
    const dm = window.FoneDanmaku?.state();
    $('dm').classList.toggle('on', !!dm?.on);
    $('dmInfo').textContent = !dm?.on ? '' : dm.err ? '弹幕 unavailable' : dm.live ? 'live' : '';
    const tm = FonePlayer.isTiledmedia() ? FonePlayer.tm() : null;
    const kind = playKind();
    $('speedRow').hidden = kind !== 'replay';
    root.querySelectorAll('button[data-s]').forEach((b) => b.classList.toggle('on', Number(b.dataset.s) === (Number(settings.speed) || 1)));
    $('fxRow').hidden = !FonePlayer.isTiledmedia();
    $('stats').classList.toggle('on', !!window.FoneLayout?.isOn());
    $('pic').classList.toggle('on', !!window.FoneStreamer?.isOn());
    $('picPage').hidden = !s.page;
    // the stats need a fone server (its timing service), the 弹幕 its capture of the room
    $('statsRow').hidden = serverless();
    $('dm').hidden = $('dmSet').hidden = $('dmInfo').hidden = local;
    root.querySelectorAll('button[data-fa]').forEach((b) => b.classList.toggle('on', b.dataset.fa === settings.f1Audio));
    $('ffRow').hidden = !FonePlayer.isTiledmedia();
    root.querySelectorAll('button[data-ff]').forEach((b) => b.classList.toggle('on', b.dataset.ff === settings.f1Feed));
    const fd = tm?.feed;
    $('ffInfo').textContent = settings.f1Feed !== 'intl' || !fd ? '' : String(fd.ch) === '1025' ? 'INTERNATIONAL'
      : fd.err ? fd.err : playKind() !== 'live' ? 'live sessions only' : '';
    const au = tm?.audio;
    $('faInfo').textContent = !au ? '' : settings.f1Audio === 'mute' ? (au.muted ? 'off' : au.err ? 'not muted: ' + au.err : '')
      : settings.f1Audio === 'fx' ? (au.auto || au.kind === 'fx' ? 'Track FX' : au.manual ? 'your pick' : au.err ? au.err : au.due > 20000 ? 'waiting for the player…' : '')
        : settings.f1Audio === 'eng' ? (au.manual ? 'your pick' : au.err ? au.err : au.due > 20000 ? 'waiting for the player…' : au.cur || '') : '';
    $('antRow').hidden = s.delaySource !== 'measured';
    $('anticipate').checked = !!settings.anticipate;
    // the player not taking the speed for a while (2026-10-11: 7 minutes at 1x, silently)
    const r = tm?.r;
    const stalled = kind === 'replay' && r && r.want > 0 && r.sdk > 0 && Math.abs(r.sdk - r.want) > 0.05;
    if (!stalled) speedStallSince = 0;
    else speedStallSince ||= Date.now();
    const stall = speedStallSince && Date.now() - speedStallSince > 20000;
    $('speedInfo').innerHTML = stall ? '<b>F1 TV isn\'t taking the speed</b> — press it again' : 'keys <b>&lt; &gt;</b>';
    $('speedInfo').classList.toggle('warn', !!stall);
    $('holdRow').hidden = s.lead == null;
    $('hold').hidden = !holding;
    if (holding) $('hold').textContent = `⏸ Holding video — commentary is ${Math.max(1, Math.ceil(holdRelease() - s.lead))}s behind`;

    const chans = s.channels || [];
    const sel = $('channel');
    sel.parentNode.hidden = local;
    if (sel.dataset.v !== chans.join('|')) {
      sel.innerHTML = '';
      for (const c of chans) sel.add(new Option(c, c));
      sel.dataset.v = chans.join('|');
    }
    sel.value = s.channel || '';
    const [clockText, est] = CLOCKS[s.clock] || ['–', 'est'];
    $('kv').innerHTML = '';
    const rows = [
      ['F1 TV', s.title || cid],
      ['sync', `<span class="badge ${est}">${clockText}</span>`],
      ['delay from', { content: 'this video', channel: 'your last calibration', default: 'default guess', live: 'live default (edge to edge)',
        measured: 'measured from the stream', stream: 'your last setting for this stream' }[s.delaySource] || '–'],
      ['on screen', fmtTime(s.E)],
      ['commentary', fmtTime(s.W)],
    ];
    // live: how far behind live F1 TV plays, by its own clock (the commentary goes as much behind its edge, less the delay)
    if (s.f1Lat != null) rows.push(['behind live', `F1 TV ${s.f1Lat.toFixed(1)} s behind its own clock · the commentary ${(s.f1Lat - s.delay).toFixed(1)} s behind its edge`]);
    const rec = s.rec;
    if (rec) { // recorded here: without a server, or live with one (s.direct)
      const pf = { bilibili: 'Bilibili', twitch: 'Twitch', youtube: 'YouTube', douyin: 'Douyin', huya: 'Huya', url: 'stream URL' }[rec.platform] || rec.platform;
      rows.push(['recording', `${s.direct ? 'live, straight from the stream: ' : ''}this computer · ${pf}${rec.name ? ` · ${rec.name}` : ''} · ${rec.state}${rec.text && rec.state !== 'recording' ? ` (${rec.text})` : ''}`]);
      rows.push(['kept', `${fmtDur(rec.kept)} of ${settings.bufferMin} min${rec.kbps ? ` · audio ${rec.kbps} kbps` : ''}${rec.fmt ? ` · ${rec.fmt}` : ''}${rec.net ? ` · stream ${rec.net} kbps` : ''}${rec.filled ? ` · ${rec.filled}s of gaps` : ''}`]);
      if (rec.title) rows.push(['stream', rec.title]);
      if (s.server) rows.push(['server', `${s.server} (${s.direct ? 'replays, stats, sponsor clips' : 'stats'})`]);
    } else {
      rows.push(['recording', s.file || '–'], ['server', s.server || '–']);
    }
    if (video) rows.push(['player', `${FonePlayer.diag()} · id ${cid} · v${chrome.runtime.getManifest().version}`]);
    const nRate = video ? rateChangesPerMin() : 0;
    if (video && (nRate || video.playbackRate !== 1)) {
      const r = video.playbackRate;
      rows.push(['video rate', `×${r.toFixed(4)} · ${nRate} changes/min`]);
    }
    const speed = video ? FonePlayer.rate() : 1; // what the commentary follows
    if (tm?.r && ((tm.r.want != null && tm.r.want !== 1) || (tm.r.exact && tm.r.sdk !== 1) || speed !== 1 || tm.r.err)) {
      const r = tm.r;
      const f = (x, k) => (Number.isFinite(x) ? x.toFixed(k) : '–');
      // ≈: page.js couldn't read the SDK's speed and guessed it from the (trimmed) element
      rows.push(['speed', `×${f(speed, 2)}${kind === 'live' ? ' (live)' : ''} · F1 TV ${r.exact ? '' : '≈'}×${f(r.sdk, 2)} · element ×${f(r.el, 3)}${r.err ? ` · ${r.err}` : ''}`]);
    }
    const a = tm?.audio;
    if (a && a.cur != null) {
      let txt = a.cur;
      if (a.auto) txt += ' (auto)';
      else if (a.manual) txt += ' (your pick — kept for this video)';
      else if (a.on && a.kind === 'commentary' && !a.fx) txt += ' (no track sound on this feed)';
      if (a.err) txt += ` · ${a.err}`;
      rows.push(['audio', txt]);
    }
    if (tm?.tracks?.length) rows.push(['tracks', tm.tracks.map(([n, l]) => (l && l !== n ? `${n} (${l})` : n)).join(', ')]);
    if (s.fixes) {
      const f = s.fixes;
      rows.push(['corrections', `${f.seeks} seeks · ${f.rates} rate tweaks · ${f.speeds ?? 0} speed changes in the last min (×${f.rate.toFixed(3)}${f.pp ? ', pitch kept' : ''})`]);
    }
    if (s.error) rows.push(['error', s.error]);
    for (const [k, v] of rows) {
      const b = document.createElement('b');
      b.textContent = k;
      const d = document.createElement('span');
      if (k === 'sync') d.innerHTML = v; else d.textContent = v;
      $('kv').append(b, d);
    }
  }

  const fmtDur = (x) => {
    x = Math.max(0, Math.round(x || 0));
    const m = Math.floor(x / 60), ss = String(x % 60).padStart(2, '0');
    return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  };
  // no fone server at all: the commentary recorded here, nothing for the stats to ask
  const serverless = () => settings.source === 'local' && !settings.servers?.length;
  // for layout.js and danmaku.js (same content-script world): what needs a server stays off
  window.FoneContent = Object.freeze({ serverless, local: () => settings.source === 'local' });

  let toastTimer;
  function toast(msg) {
    $('toast').textContent = msg;
    $('toast').classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $('toast').classList.remove('on'), 1400);
  }

  function save(patch) {
    Object.assign(settings, patch);
    chrome.storage.sync.set(patch).catch(() => {});
    push(true);
    render();
  }

  function nudge(d) {
    send({ type: 'nudge', delta: d });
    const next = status?.delay != null ? status.delay + d : null;
    toast(`${d > 0 ? '+' : '−'}${Math.abs(d)} s → commentary ${d > 0 ? 'sooner' : 'later'}${next != null ? ` (delay ${next.toFixed(1)} s)` : ''}`);
  }

  $('head').addEventListener('click', () => save({ collapsed: !settings.collapsed }));
  root.querySelectorAll('button[data-d]').forEach((b) => b.addEventListener('click', () => nudge(Number(b.dataset.d))));
  $('mute').addEventListener('click', () => save({ muted: !settings.muted }));
  $('relive').addEventListener('click', () => { send({ type: 'relive' }); toast('Re-synced to live'); });
  $('golive').addEventListener('click', () => goLive());
  $('vol').addEventListener('input', (e) => save({ volume: Number(e.target.value), muted: false }));
  $('autohold').addEventListener('change', (e) => save({ autoHold: e.target.checked }));
  root.querySelectorAll('button[data-s]').forEach((b) => b.addEventListener('click', () => setSpeed(Number(b.dataset.s))));
  root.querySelectorAll('button[data-fa]').forEach((b) => b.addEventListener('click', () => { save({ f1Audio: b.dataset.fa }); syncPage(true); }));
  root.querySelectorAll('button[data-ff]').forEach((b) => b.addEventListener('click', () => { save({ f1Feed: b.dataset.ff }); syncPage(true); }));
  $('anticipate').addEventListener('change', (e) => { save({ anticipate: e.target.checked }); push(true); });
  // layout.js (same content-script world) owns the split view; it may load after us.
  $('stats').addEventListener('click', () => { window.FoneLayout?.toggle(); render(); });
  $('statsPop').addEventListener('click', () => window.FoneLayout?.popOut());
  // streamerbox.js (same content-script world) owns the streamer window
  $('pic').addEventListener('click', () => { window.FoneStreamer?.toggle(); render(); });
  $('picPop').addEventListener('click', () => window.FoneStreamer?.popOut());
  $('picPage').addEventListener('click', () => { if (status?.page) window.open(status.page, '_blank', 'noopener'); });
  // danmaku.js (same content-script world) owns the danmaku and their settings panel
  $('dm').addEventListener('click', () => { window.FoneDanmaku?.toggle(); render(); });
  $('dmSet').addEventListener('click', () => window.FoneDanmaku?.openSettings());
  $('channel').addEventListener('change', (e) => save({ channel: e.target.value }));

  // ±0.5 / ±5 s for the rough alignment; ±0.1 / ±0.02 s to null an echo against F1 TV's own
  // sound by ear (the live delay is set by ear alone, and the engine then holds it to ±1 ms)
  const KEYS = { ']': 0.5, '[': -0.5, '}': 5, '{': -5, '=': 0.1, '-': -0.1, '.': 0.02, ',': -0.02 };
  window.addEventListener(
    'keydown',
    (e) => {
      if (host.hidden || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.composedPath()[0];
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.key in KEYS) nudge(KEYS[e.key]);
      else if (e.key === '\\') { save({ muted: !settings.muted }); toast(settings.muted ? 'Commentary muted' : 'Commentary on'); }
      else if (e.key === '|') save({ collapsed: !settings.collapsed });
      else if ((e.key === 'l' || e.key === 'L') && status?.clock === 'edge') goLive();
      else if (e.key === '>' || e.key === '<') stepSpeed(e.key === '>' ? 1 : -1);
      else return;
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );

  // ---- Go live --------------------------------------------------------------------
  // F1 TV to the most recent moment it can play, the commentary with it as far as it keeps up
  // (offscreen.js goLive): the engine says how far to move F1 TV, page.js seeks it (Player.seek,
  // relative), and the commentary follows through its live lock. What F1 TV's reported edge
  // doesn't reach yet (`more`) is asked for again as the edge steps on (every 5.76 s, a seek past
  // it possible for a few seconds after each step): every GOLIVE_CHASE.EVERY ms for FOR ms, up to
  // TRIES more seeks, none for more than was left. F1 TV going back a second or more (a rewind or
  // seek of yours: ours only go forward), pausing or auto-hold holding (not the player's own pause
  // around a seek of ours) ends it. F1 TV's own LIVE badge goes the same way while fone is live: F1
  // TV's jump to its edge would only be held by auto-hold until the commentary caught up. One at a
  // time (a second press or click while one is under way gets its answer), and none while the
  // engine hasn't seen the last seek land yet (it would go by F1 TV's old position): goLiveSeek
  // {to, by, until}, cleared by the first status nearer where it lands than where it began (or,
  // with no position in the status, by the time). True: done; false: not (the badge then does F1
  // TV's own jump).
  const GOLIVE_CHASE = { TRIES: 3, EVERY: 500, FOR: 14000, MIN: 0.4, SEEK_PAUSE: 2000 };
  let goLivePending = null, goLiveSeek = null, goLiveChase = null;
  let feedRelived = null; // (the feed switch the commentary was re-synced after)
  let feedLanded = null, feedKeep = 0, preSwitchRewound = 0; // (how far behind live F1 TV was before it)
  // (holding: auto-hold's, so the engine steps F1 TV back only for a held commentary; extension
  // reloaded: null)
  const golive = (chase = null) => chrome.runtime.sendMessage({ target: 'engine', type: 'golive', holding, chase: !!chase, pMax: chase?.pMax ?? null })
    .catch(() => null);
  function goLive(fromBadge = false) {
    if (goLivePending) return goLivePending;
    if (goLiveSeek && Date.now() < goLiveSeek.until) return Promise.resolve(true);
    goLiveChase = null;
    goLivePending = (async () => {
      const r = await golive();
      if (!r?.handled) {
        if (!fromBadge) toast('Not locked to live yet');
        return false;
      }
      if (r.wait) { toast('F1 TV is re-syncing: a moment'); return true; }
      if (r.by) {
        const done = await liveSeek(r.by);
        if (done.ok === false) {
          if (!fromBadge) toast(`F1 TV didn't take the seek${done.err ? ` (${done.err})` : ''}`);
          return false;
        }
        // (page.js went only as far as F1 TV's edge then: the rest after it steps on, if worth it)
        if (r.by > 0 && done.did < r.by) {
          const more = r.more + r.by - done.did;
          Object.assign(r, { more: r.more > 0 || more >= 0.6 ? Math.round(more * 100) / 100 : 0, by: done.did });
        }
      }
      if (r.more) {
        goLiveChase = { moved: r.by || 0, left: r.more, seeks: 0, until: Date.now() + GOLIVE_CHASE.FOR, at: Date.now(), seekAt: Date.now(),
          pMax: status?.p ?? null, limit: r.limit };
        toast(`⏭ ${r.by ? `${r.by.toFixed(1)} s forward, ` : ''}${r.more.toFixed(1)} s more as F1 TV's edge moves on…`);
      } else {
        toast(!r.by ? (r.limit === 'commentary' ? 'As live as the commentary is' : 'Live')
          : r.by > 0 ? `⏭ ${r.by.toFixed(1)} s forward${r.limit === 'commentary' ? ' (as far as the commentary goes)' : ''}`
            : `⏮ ${(-r.by).toFixed(1)} s back, where the commentary is`);
      }
      return true;
    })().finally(() => { goLivePending = null; });
    return goLivePending;
  }

  // The rest of a Go live (the status handler, while one is under way). `said`: tell how it went
  // (not when you took over: then its wait for a seek to land goes too).
  function endChase(c, said = true) {
    if (goLiveChase === c) goLiveChase = null;
    if (!said) { goLiveSeek = null; return; }
    const lim = c.limit === 'commentary' ? ' (as far as the commentary goes)' : '';
    toast(c.left < GOLIVE_CHASE.MIN || c.done ? (c.moved > 0 ? `⏭ Live: ${c.moved.toFixed(1)} s forward in all${lim}` : 'Live')
      : c.moved > 0 ? `⏭ ${c.moved.toFixed(1)} s forward: as live as F1 TV's edge got` : 'As live as F1 TV goes right now');
  }
  function chaseLive() {
    const c = goLiveChase;
    if (!c) return;
    // F1 TV back a second or more from the furthest it has been since: yours, not ours (ours only
    // go forward; also while one of ours is landing)
    if (status?.p != null) {
      if (c.pMax == null || status.p > c.pMax) c.pMax = status.p;
      else if (status.p < c.pMax - 1) { endChase(c, false); return; }
    }
    if (goLivePending || (goLiveSeek && Date.now() < goLiveSeek.until)) return;
    // (the player pauses around a seek of its own accord: a pause of yours only once that's past)
    if (holding || (video?.paused && Date.now() - c.seekAt > GOLIVE_CHASE.SEEK_PAUSE)) { endChase(c, false); return; }
    if (Date.now() > c.until) { endChase(c); return; }
    if (Date.now() - c.at < GOLIVE_CHASE.EVERY) return;
    c.at = Date.now();
    goLivePending = (async () => {
      const r = await golive(c);
      if (goLiveChase !== c) return true; // (taken over meanwhile)
      if (!r?.handled || r.wait) return true; // (between sources, or F1 TV's clock re-proving: ask again)
      if (r.by < 0 || r.took) { endChase(c, false); return true; }
      c.limit = r.limit;
      if (r.by > 0) {
        const done = await liveSeek(Math.round(Math.min(r.by, c.left + 0.5) * 100) / 100);
        if (goLiveChase !== c) { goLiveSeek = null; return true; } // (taken over while it went: not ours to wait for)
        if (done.ok === false) { endChase(c, false); return false; }
        if (!done.did) return true; // (F1 TV's edge moved no further meanwhile: ask again)
        Object.assign(c, { moved: c.moved + done.did, left: c.left - done.did, seeks: c.seeks + 1, seekAt: Date.now() });
        if (!r.more || c.left < GOLIVE_CHASE.MIN || c.seeks >= GOLIVE_CHASE.TRIES) { c.done = !r.more || c.left < GOLIVE_CHASE.MIN; endChase(c); }
      } else if (!r.more) { c.done = true; endChase(c); } // (nothing left to go: there already)
      return true;
    })().finally(() => { goLivePending = null; });
  }

  // One of Go live's seeks, and the engine's wait for it to land (goLiveSeek).
  // (`did`: what page.js sought, no further than F1 TV's edge then; 0: nothing)
  async function liveSeek(by) {
    const from = status?.p;
    const done = await seekF1(by);
    const did = done.did ?? by;
    if (done.ok !== false && did) goLiveSeek = from != null ? { to: from + did, by: did, until: Date.now() + 3000 } : { to: null, until: Date.now() + 1500 };
    return { ...done, did };
  }

  // A relative seek of F1 TV's player (page.js), answered with its outcome ('fone-seek'): ok null
  // when no answer came (a slow seek: taken as done).
  function seekF1(by) {
    return new Promise((resolve) => {
      const done = (r) => { document.removeEventListener('fone-seek', on); clearTimeout(timer); resolve(r); };
      const on = (e) => {
        let r = null;
        try { r = JSON.parse(e.detail); } catch { return; }
        if (r?.by === by) done(r);
      };
      const timer = setTimeout(() => done({ ok: null, by }), 4000);
      document.addEventListener('fone-seek', on);
      pageCmd({ cmd: 'seek', by });
    });
  }

  let liveClick = false; // F1 TV's LIVE clicked again by us: let it through
  window.addEventListener('click', (e) => {
    if (liveClick || !alive || status?.clock !== 'edge') return;
    const badge = e.composedPath().find((el) => el.classList?.contains('tm-ui-playbacktimelabel-live'));
    if (!badge) return;
    e.preventDefault();
    e.stopPropagation();
    goLive(true).then((ok) => { // the engine can't (no lock yet, or the seek failed): F1 TV's own jump after all
      if (ok) return;
      liveClick = true;
      try { badge.click(); } finally { liveClick = false; }
    });
  }, true);

  // ---- wiring --------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== 'fone-status') return;
    status = msg.status;
    // fone switched F1 TV to INTERNATIONAL (page.js, a switch seen to land): once it plays, the
    // commentary locked again to its edge (the two feeds' live delays differ by a second or two),
    // keeping how far F1 TV was behind live before the switch (your rewind, a pause, a hold: the
    // last status before the landing). Paused or held then, the lock already follows the picture.
    const fd = FonePlayer.tm()?.feed;
    if (!fd?.landedAt || fd.landedAt !== feedLanded) {
      if (fd?.landedAt) { feedLanded = fd.landedAt; feedKeep = preSwitchRewound; }
      else preSwitchRewound = status.rewound ?? 0;
    }
    if (fd?.landedAt && fd.landedAt !== feedRelived && Date.now() - fd.landedAt > 3000 && status.clock === 'edge') {
      feedRelived = fd.landedAt;
      if (status.state === 'sync' && !holding && !video?.paused) send({ type: 'relive', keep: feedKeep });
    }
    if (goLiveSeek?.to != null && Math.abs(status.p - goLiveSeek.to) < Math.min(2, Math.abs(goLiveSeek.by) / 2)) goLiveSeek = null; // landed
    if (goLiveChase) chaseLive();
    host.dataset.status = JSON.stringify({ ...status, holding }); // readable by the e2e test
    autoHold();
    render();
  });

  chrome.storage.sync.get({ ...DEFAULTS, autoFx: null }).then((s) => {
    // 0.2.26 and before had a track-sound checkbox (autoFx); off stays off, on becomes the
    // new default, muted (no track switch, no echo against the recording's F1 TV sound)
    if (!F1_AUDIO.includes(s.f1Audio)) s.f1Audio = s.autoFx === false ? 'off' : DEFAULTS.f1Audio;
    if (s.f1Feed !== 'intl' && s.f1Feed !== 'off') s.f1Feed = DEFAULTS.f1Feed;
    delete s.autoFx;
    s.source = sourceOf(s);
    settings = s;
    setInterval(poll, 250);
    poll();
  });
  chrome.storage.onChanged.addListener((changes) => {
    for (const [k, { newValue }] of Object.entries(changes)) settings[k] = newValue;
    settings.source = sourceOf(settings);
    push(true);
    syncPage(true);
  });

})();
