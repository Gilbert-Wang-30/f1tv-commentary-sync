'use strict';
// The settings page. FoneOptions is its logic without the page (options.test.js): server URLs as
// typed, and which source a save keeps.
(function (root) {
  const PORT = 8788; // the fone server's (docker-compose.yml)

  // One server as typed -> {url} or {error} (null: a blank line). http:// is added where no scheme
  // was typed, and :8788 where no port either ("192.168.1.5", "myserver:8788"); a trailing slash
  // goes. Only http(s): any other would be fetched relative to this page, or not at all.
  function server(typed) {
    const raw = String(typed ?? '').trim();
    if (!raw) return null;
    const bare = !/^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
    let u;
    try { u = new URL(bare ? `http://${raw}` : raw); } catch { return { error: `${raw}: not a server address` }; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: `${raw}: only http:// or https://` };
    if (!u.hostname) return { error: `${raw}: no host` };
    if (u.username || u.password) return { error: `${raw}: no user:password@ (the server has no login)` };
    if (bare && !u.port) u.port = String(PORT);
    return { url: `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}` };
  }

  // The server box's lines -> {servers, changed: [[typed, url]], errors: [text]} (duplicates once).
  function servers(text) {
    const out = { servers: [], changed: [], errors: [] };
    for (const line of String(text ?? '').split('\n')) {
      const s = server(line);
      if (!s) continue;
      if (s.error) { out.errors.push(s.error); continue; }
      if (s.url !== line.trim().replace(/\/+$/, '')) out.changed.push([line.trim(), s.url]);
      if (!out.servers.includes(s.url)) out.servers.push(s.url);
    }
    return out;
  }

  // The source a save keeps: the one chosen, unless that one is empty and the other is filled in
  // (a first run's slip: a server entered with "This computer" still checked, or the reverse).
  function source(chosen, stream, list) {
    if (chosen === 'local' && !stream && list.length) return 'server';
    if (chosen === 'server' && !list.length && stream) return 'local';
    return chosen === 'server' ? 'server' : 'local';
  }

  root.FoneOptions = Object.freeze({ server, servers, source, PORT });
})(globalThis);

const SERVERS = self.FONE_LOCAL?.servers || []; // local.js: this install's, or none
const DEFAULTS = {
  source: null, // not chosen yet: a server if one is set, else this computer (as content.js)
  stream: '',
  bufferMin: 15,
  servers: SERVERS,
  channel: '',
  liveDirect: true,
  autoHold: true,
  soundSync: true,
  soundDuck: true,
  // F1 TV's sound, subtitles, track picking, INTERNATIONAL live (settings.js; unset: null, for its migration)
  f1Sound: null, f1Subs: null, f1Pick: null, f1Feed: null, f1Audio: null, autoFx: null,
};
const $ = (id) => document.getElementById(id);

const readServers = () => FoneOptions.servers($('servers').value);
const source = () => ($('srcLocal').checked ? 'local' : 'server');
const bufferMin = () => Math.min(180, Math.max(1, Math.round(Number($('bufferMin').value) || DEFAULTS.bufferMin)));

function pick(src) {
  $('srcLocal').checked = src === 'local';
  $('srcServer').checked = src === 'server';
  showSource();
}

function showSource() {
  $('localBox').classList.toggle('off', source() !== 'local');
  $('serverBox').classList.toggle('off', source() !== 'server');
}

// What the server says about the commentary channel: nothing recorded yet, several to pick from,
// and whether it has the channel's Bilibili room (FONE_ROOMS: live straight from the room, the
// ↗ Live page, 弹幕 and the streamer's Bilibili replays all come from it).
async function serverNotes(base, health, chans) {
  const out = [];
  if (!chans.length) out.push('No recordings on it yet: is a recorder writing into its recordings folder (FONE_RECORDINGS)?');
  else if (chans.length > 1 && !$('channel').value) out.push(`${chans.length} channels: pick one below, or it plays whichever recorded last.`);
  const chan = $('channel').value || chans[0]?.name;
  if (!chan) return out;
  if (!health.services?.includes('danmaku')) {
    out.push('Its danmaku service is off (FONE_DANMAKU=0): no live straight from a Bilibili room, ↗ Live page, 弹幕 or Bilibili replays.');
    return out;
  }
  try {
    const st = await (await fetch(`${base}/api/danmaku/status`, { signal: AbortSignal.timeout(3000) })).json();
    const rooms = Object.entries(st.rooms || {});
    const room = rooms.find(([, r]) => r?.channel === chan)?.[0];
    if (room) out.push(`${chan}: Bilibili room ${room}.`);
    else if (!rooms.length) out.push('No Bilibili room set on the server (FONE_ROOMS): fine for a streamer elsewhere; for a Bilibili one, '
      + 'live plays its recording, and no 弹幕, ↗ Live page or Bilibili replays.');
    else out.push(`${chan}: no Bilibili room for it on the server (FONE_ROOMS has ${rooms.map(([id, r]) => `${id}=${r.channel}`).join(', ')}).`);
  } catch { /* an older server: nothing to add */ }
  return out;
}

async function test() {
  const { servers: list, changed, errors } = readServers();
  $('out').textContent = 'Testing…';
  const lines = [...errors.map((e) => `❌ ${e}`), ...changed.map(([a, b]) => `${a} → ${b}`)];
  for (const base of list) {
    try {
      const h = await (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(3000) })).json();
      const chans = await (await fetch(`${base}/api/channels`, { signal: AbortSignal.timeout(5000) })).json();
      lines.push(`✅ ${base} — ${h.version ? `fone ${h.version}, ` : ''}${h.files} recordings`);
      const sel = $('channel');
      const keep = sel.value;
      sel.length = 1;
      for (const c of chans) sel.add(new Option(`${c.name} (${c.files} files${c.live ? ', LIVE now' : ''})`, c.name));
      sel.value = keep;
      lines.push(...await serverNotes(base, h, chans));
      break;
    } catch (e) {
      lines.push(`❌ ${base} — ${e.message}`);
    }
  }
  $('out').textContent = lines.join('\n') || 'No server listed.';
}

// Asks the platform about the stream, as the recorder will: live or not, and what it pulls.
async function testStream() {
  const spec = FoneStreams.parse($('stream').value);
  if (spec.error) { $('outStream').textContent = `❌ ${spec.error}`; return; }
  $('outStream').textContent = `Asking ${FoneStreams.PLATFORMS[spec.platform]}…`;
  try {
    const r = await FoneStreams.resolve(spec);
    const who = [r.name, r.title].filter(Boolean).join(' — ');
    if (!r.live) {
      $('outStream').textContent = `⏸ ${FoneStreams.PLATFORMS[spec.platform]} ${spec.id}${who ? ` (${who})` : ''}: ${r.reason || 'not live right now'}.\n`
        + 'That\'s fine: fone records it once it goes live and F1 TV is open.';
      return;
    }
    $('outStream').textContent = `✅ live: ${who || spec.label}\n${r.kind === 'auto' ? 'stream URL' : r.kind.toUpperCase()} · ${new URL(r.url).hostname}`;
  } catch (e) {
    $('outStream').textContent = `❌ ${e.message || e}`;
  }
}

const loaded = chrome.storage.sync.get(DEFAULTS).then((s) => { // (options.test.js waits for it)
  const src = s.source === 'local' || s.source === 'server' ? s.source : s.servers.length ? 'server' : 'local';
  pick(src);
  $('stream').value = s.stream;
  $('bufferMin').value = s.bufferMin;
  $('servers').value = s.servers.join('\n');
  $('autoHold').checked = s.autoHold;
  $('liveDirect').checked = s.liveDirect !== false;
  $('soundSync').checked = s.soundSync !== false;
  $('soundDuck').checked = s.soundDuck !== false;
  const f1 = FoneSettings.f1(s);
  $(f1.f1Sound === 'eng' ? 'f1SoundEng' : 'f1SoundFx').checked = true;
  $('f1Subs').checked = f1.f1Subs;
  $('f1Pick').checked = f1.f1Pick;
  $('f1Intl').checked = f1.f1Feed === 'intl';
  if (s.channel) $('channel').add(new Option(s.channel, s.channel));
  $('channel').value = s.channel;
  $('welcome').hidden = !!(s.servers.length || String(s.stream || '').trim()); // (a first run: nothing set yet)
  if (s.servers.length) test();
});

for (const r of document.querySelectorAll('input[name=source]')) r.addEventListener('change', showSource);
// Typing into one box while the other is empty picks it: a first run's server goes with "A fone server".
$('servers').addEventListener('input', () => { if ($('servers').value.trim() && !$('stream').value.trim()) pick('server'); });
$('stream').addEventListener('input', () => { if ($('stream').value.trim() && !$('servers').value.trim()) pick('local'); });

$('save').addEventListener('click', async () => {
  const { servers: list, changed, errors } = readServers();
  if (errors.length) {
    $('saved').textContent = `Not saved: ${errors.join('; ')}`;
    return;
  }
  const stream = $('stream').value.trim();
  const src = FoneOptions.source(source(), stream, list);
  const notes = changed.map(([a, b]) => `${a} → ${b}`);
  if (src !== source()) {
    notes.push(src === 'server' ? 'Using the server: no live URL for "This computer".' : 'Using this computer: no server listed.');
    pick(src);
  }
  await chrome.storage.sync.set({
    source: src, stream, bufferMin: bufferMin(),
    servers: list, channel: $('channel').value, autoHold: $('autoHold').checked, liveDirect: $('liveDirect').checked, soundSync: $('soundSync').checked, soundDuck: $('soundDuck').checked,
    f1Sound: $('f1SoundEng').checked ? 'eng' : 'fx', f1Subs: $('f1Subs').checked, f1Pick: $('f1Pick').checked, f1Feed: $('f1Intl').checked ? 'intl' : 'off',
  });
  $('servers').value = list.join('\n');
  $('bufferMin').value = bufferMin();
  $('welcome').hidden = !!(list.length || stream);
  $('saved').textContent = ['Saved.', ...notes].join(' ');
  setTimeout(() => { $('saved').textContent = ''; }, notes.length ? 8000 : 2500);
});
$('test').addEventListener('click', test);
$('testStream').addEventListener('click', testStream);
