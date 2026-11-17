// node extension/options.test.js
// The settings page (options.js): server URLs as typed, and a first run's save, against a fake page.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let n = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---- FoneOptions ---------------------------------------------------------------------------

const plain = (x) => JSON.parse(JSON.stringify(x)); // (out of the vm's realm, for deepEqual)

function pure() {
  const ctx = vm.createContext({ URL, console });
  const [head] = fs.readFileSync(path.join(__dirname, 'options.js'), 'utf8').split('\nconst SERVERS');
  vm.runInContext(head, ctx); // (its first part: no page needed)
  const O = ctx.FoneOptions;
  return { server: (s) => plain(O.server(s)), servers: (t) => plain(O.servers(t)), source: O.source, versions: O.versions };
}

test('a server as typed: scheme and port filled in only where none was typed', () => {
  const O = pure();
  assert.deepEqual(O.server('192.0.2.10'), { url: 'http://192.0.2.10:8788' });
  assert.deepEqual(O.server(' my-server:8788 '), { url: 'http://my-server:8788' });
  assert.deepEqual(O.server('localhost:9000/'), { url: 'http://localhost:9000' });
  assert.deepEqual(O.server('[fd00::5]'), { url: 'http://[fd00::5]:8788' });
  assert.deepEqual(O.server('http://fone.lan:8788/'), { url: 'http://fone.lan:8788' });
  assert.deepEqual(O.server('https://fone.example.com'), { url: 'https://fone.example.com' }); // (a proxy: its own port)
  assert.deepEqual(O.server('HTTP://Fone.LAN'), { url: 'http://fone.lan' });
  assert.deepEqual(O.server('https://example.com/fone/'), { url: 'https://example.com/fone' });
  assert.equal(O.server('   '), null);
});

test('a server that can\'t be fetched is refused, saying why', () => {
  const O = pure();
  assert.match(O.server('ftp://nas/x').error, /only http:\/\/ or https:\/\//);
  assert.match(O.server('chrome-extension://abc').error, /only http/);
  assert.match(O.server('http://user:pw@nas:8788').error, /no user:password@/);
  assert.match(O.server('http://exa mple').error, /not a server address/);
});

test('the server box: normalised, duplicates once, what changed said', () => {
  const O = pure();
  const r = O.servers('192.0.2.10\n\nhttp://192.0.2.10:8788/\nhttps://fone.example.com\nftp://x\n');
  assert.deepEqual([...r.servers], ['http://192.0.2.10:8788', 'https://fone.example.com']);
  assert.deepEqual(r.changed.map((x) => [...x]), [['192.0.2.10', 'http://192.0.2.10:8788']]);
  assert.equal(r.errors.length, 1);
});

test('the source kept: the chosen one, unless it is empty and the other is filled in', () => {
  const O = pure();
  assert.equal(O.source('local', '', ['http://s:8788']), 'server'); // the first-run slip
  assert.equal(O.source('server', 'https://www.twitch.tv/x', []), 'local');
  assert.equal(O.source('local', 'https://www.twitch.tv/x', ['http://s:8788']), 'local'); // local + the server's stats
  assert.equal(O.source('server', 'https://www.twitch.tv/x', ['http://s:8788']), 'server');
  assert.equal(O.source('local', '', []), 'local');
});

test('versions: a line when the extension and the server are different releases, saying which to update', () => {
  const O = pure();
  assert.equal(O.versions('1.0.1', '1.0.1'), null);
  assert.equal(O.versions('1.0.1', '1.0.3'), null); // (patches of one release work together)
  assert.equal(O.versions('1.0.1-rc.1', '1.0.1'), null); // (a pre-release: its manifest's version_name)
  assert.match(O.versions('1.0.1', '1.1.0'), /^⚠ The server is fone 1\.1\.0, this extension 1\.0\.1: update the extension/);
  assert.match(O.versions('0.5.4', '1.0.1'), /update the extension/);
  assert.match(O.versions('1.2.0', '1.0.1'), /^⚠ This extension is fone 1\.2\.0, the server 1\.0\.1: update the server/);
  assert.match(O.versions('2.0.0', '1.9.9'), /update the server/);
  assert.match(O.versions('1.10.0', '1.9.0'), /update the server/); // (numbers, not text)
  for (const srv of ['dev', undefined, null, '', 'x.y']) assert.equal(O.versions('1.0.1', srv), null, String(srv));
});

// ---- the page --------------------------------------------------------------------------------

const IDS = ['welcome', 'srcLocal', 'srcServer', 'localBox', 'serverBox', 'stream', 'bufferMin', 'testStream', 'outStream',
  'servers', 'channel', 'liveDirect', 'test', 'out', 'autoHold', 'soundSync', 'soundDuck', 'f1SoundFx', 'f1SoundEng',
  'f1Subs', 'f1Pick', 'f1Intl', 'save', 'saved', 'versions'];

function element(id) {
  const on = {};
  const cls = new Set();
  return {
    id, value: '', checked: false, textContent: '', hidden: false, options: [],
    classList: { toggle: (c, v) => (v ? cls.add(c) : cls.delete(c)), contains: (c) => cls.has(c) },
    addEventListener: (t, f) => { (on[t] ||= []).push(f); },
    fire: async (t) => { for (const f of on[t] || []) await f({}); },
    add(o) { this.options.push(o); },
    get length() { return this.options.length; },
    set length(k) { this.options.length = k; },
  };
}

async function page(stored = {}, answers = {}, manifest = { version: '1.0.1' }) {
  const els = Object.fromEntries(IDS.map((id) => [id, element(id)]));
  els.channel.add({ text: '(most recent)', value: '' });
  const sync = { ...stored };
  const fetched = [];
  const ctx = vm.createContext({
    console, URL, AbortSignal, Promise,
    setTimeout: () => 0,
    self: {},
    Option: function Option(text, value) { return { text, value }; },
    document: {
      getElementById: (id) => els[id],
      querySelectorAll: (sel) => (sel === 'input[name=source]' ? [els.srcLocal, els.srcServer] : []),
    },
    fetch: async (url) => {
      fetched.push(url);
      const hit = Object.keys(answers).find((k) => url.endsWith(k));
      if (!hit) throw new Error('unreachable');
      return { json: async () => answers[hit] };
    },
    chrome: {
      runtime: { getManifest: () => manifest },
      storage: {
        sync: {
          get: async (d) => ({ ...d, ...sync }),
          set: async (o) => { Object.assign(sync, o); },
        },
      },
    },
  });
  for (const f of ['settings.js', 'options.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, f), 'utf8'), ctx);
  await vm.runInContext('loaded', ctx);
  return { els, sync, fetched, type: async (id, v) => { els[id].value = v; await els[id].fire('input'); } };
}

test('first run: the welcome shows, "This computer" checked', async () => {
  const p = await page();
  assert.equal(p.els.welcome.hidden, false);
  assert.equal(p.els.srcLocal.checked, true);
  assert.equal(p.els.srcServer.checked, false);
});

test('first run, only a server typed in: saved as the source, not "This computer" (the panel said "No stream set")', async () => {
  const p = await page();
  await p.type('servers', '192.0.2.10');
  assert.equal(p.els.srcServer.checked, true); // picked as it was typed
  await p.els.save.fire('click');
  assert.equal(p.sync.source, 'server');
  assert.deepEqual([...p.sync.servers], ['http://192.0.2.10:8788']);
  assert.equal(p.els.servers.value, 'http://192.0.2.10:8788');
  assert.match(p.els.saved.textContent, /192\.0\.2\.10 → http:\/\/192\.0\.2\.10:8788/);
  assert.equal(p.els.welcome.hidden, true);
});

test('…and with the radio put back on "This computer" before saving, the server still wins', async () => {
  const p = await page();
  await p.type('servers', 'http://fone.lan:8788');
  p.els.srcLocal.checked = true; p.els.srcServer.checked = false;
  await p.els.save.fire('click');
  assert.equal(p.sync.source, 'server');
  assert.match(p.els.saved.textContent, /Using the server/);
  assert.equal(p.els.srcServer.checked, true);
});

test('a stream with a server for the stats keeps "This computer"', async () => {
  const p = await page({ servers: ['http://fone.lan:8788'], source: 'local' });
  await p.type('stream', 'https://www.twitch.tv/name');
  await p.els.save.fire('click');
  assert.equal(p.sync.source, 'local');
  assert.equal(p.sync.stream, 'https://www.twitch.tv/name');
});

test('a server that can\'t be fetched isn\'t saved, nor the source; the rest is (F1 TV\'s sound)', async () => {
  const p = await page({ servers: ['http://fone.lan:8788'], source: 'server' });
  await p.type('servers', 'http://fone.lan:8788\nftp://nas');
  p.els.f1SoundFx.checked = false; p.els.f1SoundEng.checked = true;
  p.els.f1Subs.checked = true;
  p.els.srcLocal.checked = true; p.els.srcServer.checked = false; // (a source switched too: kept as saved)
  await p.els.save.fire('click');
  assert.deepEqual([...p.sync.servers], ['http://fone.lan:8788']); // as it was
  assert.equal(p.sync.source, 'server');
  assert.equal(p.sync.f1Sound, 'eng');
  assert.equal(p.sync.f1Subs, true);
  assert.equal(p.els.servers.value, 'http://fone.lan:8788\nftp://nas'); // left to be fixed
  assert.match(p.els.saved.textContent,
    /^Saved, except the server list and which source to use, both kept as they were: ftp:\/\/nas: only http.*Fix that line first/);

  const q = await page(); // a first run: nothing to keep
  await q.type('servers', 'ftp://nas');
  await q.els.save.fire('click');
  assert.equal(q.sync.servers, undefined);
  assert.equal(q.sync.source, undefined);
  assert.equal(q.sync.f1Sound, 'fx');
});

test('Test connection: the server\'s version, its channels, and whether it has the channel\'s Bilibili room', async () => {
  const health = { ok: true, files: 3, version: '1.0.1', services: ['ads', 'danmaku'] };
  let p = await page({ servers: ['http://s:8788'] }, {
    '/api/health': health,
    '/api/channels': [{ name: 'MyStreamer', files: 3, live: false }],
    '/api/danmaku/status': { rooms: {} },
  });
  await p.els.test.fire('click');
  assert.match(p.els.out.textContent, /✅ http:\/\/s:8788 — fone 1\.0\.1, 3 recordings/);
  assert.match(p.els.out.textContent, /No Bilibili room set on the server \(FONE_ROOMS\)/);
  assert.deepEqual(p.els.channel.options.map((o) => o.value), ['', 'MyStreamer']);

  p = await page({ servers: ['http://s:8788'] }, {
    '/api/health': health,
    '/api/channels': [{ name: 'A', files: 2 }, { name: 'B', files: 1 }],
    '/api/danmaku/status': { rooms: { 12345678: { channel: 'A' } } },
  });
  await p.els.test.fire('click');
  assert.match(p.els.out.textContent, /2 channels: pick one/);
  assert.match(p.els.out.textContent, /A: Bilibili room 12345678/);

  p = await page({ servers: ['http://s:8788'] }, { '/api/health': { ...health, services: [] }, '/api/channels': [] });
  await p.els.test.fire('click');
  assert.match(p.els.out.textContent, /No recordings on it yet/);

  // a server that says what its setup leaves out (health's notes): its words, once
  const room = 'FONE_ROOMS names no Bilibili room: none is watched';
  p = await page({ servers: ['http://s:8788'] }, {
    '/api/health': { ...health, notes: [room, 'No tesseract on the server'] },
    '/api/channels': [{ name: 'MyStreamer', files: 3, live: false }],
    '/api/danmaku/status': { rooms: {} },
  });
  await p.els.test.fire('click');
  const text = p.els.out.textContent;
  assert.equal(text.split(room).length, 2);
  assert.match(text, /⚠ No tesseract on the server/);
  assert.doesNotMatch(text, /No Bilibili room set on the server/);
});

test('the versions line: this extension\'s, the server\'s once Test connection reads it, and a different release said', async () => {
  const answers = (version) => ({
    '/api/health': { ok: true, files: 3, version, services: [] },
    '/api/channels': [{ name: 'MyStreamer', files: 3, live: false }],
  });
  let p = await page({}, {}, { version: '1.0.1' });
  assert.equal(p.els.versions.textContent, 'This extension: fone 1.0.1');
  p = await page({}, {}, { version: '1.0.1', version_name: '1.0.1-rc.1' });
  assert.equal(p.els.versions.textContent, 'This extension: fone 1.0.1-rc.1');

  p = await page({ servers: ['http://s:8788'] }, answers('1.0.1'));
  await p.els.test.fire('click');
  assert.equal(p.els.versions.textContent, 'This extension: fone 1.0.1 · the server: fone 1.0.1');
  assert.doesNotMatch(p.els.out.textContent, /⚠ .*update the/);

  p = await page({ servers: ['http://s:8788'] }, answers('1.1.0'));
  await p.els.test.fire('click');
  assert.equal(p.els.versions.textContent, 'This extension: fone 1.0.1 · the server: fone 1.1.0');
  assert.match(p.els.out.textContent, /⚠ The server is fone 1\.1\.0, this extension 1\.0\.1: update the extension/);

  p = await page({ servers: ['http://s:8788'] }, answers('dev'), { version: '1.2.0' });
  await p.els.test.fire('click');
  assert.equal(p.els.versions.textContent, 'This extension: fone 1.2.0 · the server: fone dev');
  assert.doesNotMatch(p.els.out.textContent, /⚠ .*update the/);

  p = await page({ servers: ['http://s:8788'] }, {}); // nothing answers: no server version
  await p.els.test.fire('click');
  assert.equal(p.els.versions.textContent, 'This extension: fone 1.0.1');
});

test('the page links the releases', () => {
  const html = fs.readFileSync(path.join(__dirname, 'options.html'), 'utf8');
  assert.match(html, /<a href="https:\/\/github\.com\/Gilbert-Wang-30\/f1tv-commentary-sync\/releases"[^>]*>Releases<\/a>/);
  assert.match(html, /id="versions"/);
});

(async () => {
  for (const [name, fn] of tests) {
    await fn();
    n++;
    console.log('ok -', name);
  }
  console.log(`${n} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
