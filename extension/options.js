'use strict';
const SERVERS = self.FONE_LOCAL?.servers || []; // local.js: this install's, or none
const DEFAULTS = {
  source: null, // not chosen yet: a server if one is set, else this computer (as content.js)
  stream: '',
  bufferMin: 15,
  servers: SERVERS,
  channel: '',
  liveDirect: true,
  autoHold: true,
};
const $ = (id) => document.getElementById(id);

function servers() {
  return $('servers').value.split('\n').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
}
const source = () => ($('srcLocal').checked ? 'local' : 'server');
const bufferMin = () => Math.min(180, Math.max(1, Math.round(Number($('bufferMin').value) || DEFAULTS.bufferMin)));

function showSource() {
  $('localBox').classList.toggle('off', source() !== 'local');
  $('serverBox').classList.toggle('off', source() !== 'server');
}

async function test() {
  $('out').textContent = 'Testing…';
  const lines = [];
  for (const base of servers()) {
    try {
      const h = await (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(3000) })).json();
      const chans = await (await fetch(`${base}/api/channels`)).json();
      lines.push(`✅ ${base} — ${h.files} recordings`);
      const sel = $('channel');
      const keep = sel.value;
      sel.length = 1;
      for (const c of chans) sel.add(new Option(`${c.name} (${c.files} files${c.live ? ', LIVE now' : ''})`, c.name));
      sel.value = keep;
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

chrome.storage.sync.get(DEFAULTS).then((s) => {
  const src = s.source === 'local' || s.source === 'server' ? s.source : s.servers.length ? 'server' : 'local';
  $(src === 'local' ? 'srcLocal' : 'srcServer').checked = true;
  $('stream').value = s.stream;
  $('bufferMin').value = s.bufferMin;
  $('servers').value = s.servers.join('\n');
  $('autoHold').checked = s.autoHold;
  $('liveDirect').checked = s.liveDirect !== false;
  if (s.channel) $('channel').add(new Option(s.channel, s.channel));
  $('channel').value = s.channel;
  showSource();
  if (s.servers.length) test();
});

for (const r of document.querySelectorAll('input[name=source]')) r.addEventListener('change', showSource);

$('save').addEventListener('click', async () => {
  await chrome.storage.sync.set({
    source: source(), stream: $('stream').value.trim(), bufferMin: bufferMin(),
    servers: servers(), channel: $('channel').value, autoHold: $('autoHold').checked, liveDirect: $('liveDirect').checked,
  });
  $('bufferMin').value = bufferMin();
  $('saved').textContent = 'Saved.';
  setTimeout(() => { $('saved').textContent = ''; }, 2500);
});
$('test').addEventListener('click', test);
$('testStream').addEventListener('click', testStream);
