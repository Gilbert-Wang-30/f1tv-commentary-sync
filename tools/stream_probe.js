// Records a live stream for a while with the extension's own resolver, demuxer, buffer and
// recorder (extension/streams.js, demux.js, localcore.js, recorder.js), in Node 22, and says
// what it got: for checking a platform still works, or one you're adding.
//
//   node tools/stream_probe.js <stream URL> [seconds=30] [out.aac]
//   docker run --rm -v "$PWD":/r -w /r node:22-alpine node tools/stream_probe.js https://live.bilibili.com/23954427
//
// The browser's session rules (background.js: FoneStreams.HEADERS, and Douyin's anonymous ttwid
// cookie, here a fresh one from live.douyin.com) become request headers. out.aac gets the audio
// kept, as ADTS (play it with ffplay, or check it with `ffmpeg -i out.aac -f null -`).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ext = path.join(__dirname, '..', 'extension');
for (const f of ['demux.js', 'localcore.js', 'streams.js', 'recorder.js']) require(path.join(ext, f));
const { FoneStreams: ST, FoneRecorder: REC, FoneLocal: L, FoneDemux: D } = globalThis;

const [url, secs = '30', out] = process.argv.slice(2);
if (!url) { console.error('usage: node tools/stream_probe.js <stream URL> [seconds] [out.aac]'); process.exit(2); }

const extra = []; // [{domains, set}]: rules added at run time (Douyin's cookie)
const fetch0 = globalThis.fetch;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
globalThis.fetch = async (u, opts = {}) => {
  const host = new URL(u).hostname;
  const headers = { 'user-agent': UA, ...(opts.headers || {}) };
  for (const h of [...ST.HEADERS, ...extra]) if (h.domains.some((d) => host === d || host.endsWith(`.${d}`))) Object.assign(headers, h.set);
  return fetch0(u, { ...opts, headers });
};
// the service worker's answers the extension's code asks for
globalThis.chrome = { runtime: { sendMessage: async (msg) => {
  if (msg?.type !== 'douyin-cookie') return undefined;
  const r = await fetch0('https://live.douyin.com/', { headers: { 'user-agent': UA } });
  const c = (r.headers.getSetCookie?.() || []).find((x) => x.startsWith('ttwid='));
  if (!c) return false;
  extra.push({ domains: ['douyin.com'], set: { Cookie: c.split(';')[0] } });
  return true;
} } };

(async () => {
  const spec = ST.parse(url);
  if (spec.error) throw new Error(spec.error);
  console.log('stream  ', JSON.stringify(spec));
  const t0 = Date.now();
  const r = await ST.resolve(spec);
  console.log('resolved', `${Date.now() - t0} ms`, JSON.stringify({ ...r, url: r.url?.slice(0, 120), alt: r.alt?.length }));
  if (!r.live) return;
  REC.want(url, 30);
  const end = Date.now() + Number(secs) * 1000;
  while (Date.now() < end) {
    await new Promise((res) => setTimeout(res, 5000));
    REC.want(url, 30);
    const s = REC.status(), B = REC.buffer();
    const now = Date.now() / 1000;
    const edge = L.liveEdge(B, now), pe = L.playableEnd(B);
    console.log(`${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s`, s.state, s.text || '', `kept ${s.kept}s`, s.fmt || '',
      `audio ${s.kbps ?? '-'} kbps`, `net ${s.net ?? '-'} kbps`, `edge-end ${edge != null && pe != null ? (edge - pe).toFixed(2) : '-'}s`,
      `filled ${s.filled}s dropped ${B.dropped}`, s.err ? `err: ${s.err}` : '');
  }
  REC.stop();
  const B = REC.buffer();
  if (out && B.chunks.length) {
    fs.writeFileSync(out, D.concat(...B.chunks.map((c) => c.data)));
    console.log('wrote', out);
  }
  const s = REC.status();
  console.log(s.kept > 0 ? `OK: ${s.kept}s of ${s.fmt} recorded` : `NOTHING RECORDED (${s.state}: ${s.err || s.text})`);
  process.exit(s.kept > 0 ? 0 : 1);
})().catch((e) => { console.error('FAILED:', e.message || e); process.exit(1); });
