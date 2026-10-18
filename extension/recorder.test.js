// node extension/recorder.test.js
// The recorder's playlist reading: which rendition it records from a master playlist, and what
// it makes of a media playlist (fMP4 init, ads, discontinuities). Playlists shaped like the
// platforms' real ones (2026-10), with made-up URLs.
for (const f of ['demux.js', 'localcore.js', 'streams.js', 'recorder.js']) require(`./${f}`);
const assert = require('node:assert/strict');
const R = globalThis.FoneRecorder;
let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok -', name); };

test('YouTube: its own audio rendition, AAC-LC (234) before HE-AAC (233)', () => {
  const m = `#EXTM3U
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MEDIA:URI="https://manifest.example/itag/233/index.m3u8",TYPE=AUDIO,GROUP-ID="233",NAME="Default",DEFAULT=YES,AUTOSELECT=YES
#EXT-X-MEDIA:URI="https://manifest.example/itag/234/index.m3u8",TYPE=AUDIO,GROUP-ID="234",NAME="Default",DEFAULT=YES,AUTOSELECT=YES
#EXT-X-STREAM-INF:BANDWIDTH=290288,CODECS="avc1.42C00B,mp4a.40.5",RESOLUTION=256x144,FRAME-RATE=15,AUDIO="233"
https://manifest.example/itag/160/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1209862,CODECS="avc1.4D401E,mp4a.40.2",RESOLUTION=640x360,FRAME-RATE=30,AUDIO="234"
https://manifest.example/itag/134/index.m3u8
`;
  assert.equal(R.pickVariant(m, 'https://manifest.example/master.m3u8'), 'https://manifest.example/itag/234/index.m3u8');
});

test('Twitch: the audio-only variant', () => {
  const m = `#EXTM3U
#EXT-X-TWITCH-INFO:NODE="video-edge-x",SERVING-ID="y"
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="audio_only",NAME="audio_only",AUTOSELECT=NO,DEFAULT=NO
#EXT-X-STREAM-INF:BANDWIDTH=160000,CODECS="mp4a.40.2",VIDEO="audio_only"
https://edge.example/v1/playlist/audio.m3u8
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="160p30",NAME="160p30",AUTOSELECT=YES,DEFAULT=YES
#EXT-X-STREAM-INF:BANDWIDTH=216299,RESOLUTION=284x160,CODECS="avc1.4D401F,mp4a.40.2",VIDEO="160p30",FRAME-RATE=30.000
https://edge.example/v1/playlist/160p.m3u8
`;
  assert.equal(R.pickVariant(m, 'https://usher.example/x.m3u8'), 'https://edge.example/v1/playlist/audio.m3u8');
});

test('video variants only: the smallest of at least 360p, else the smallest', () => {
  const v = (bw, res, u) => `#EXT-X-STREAM-INF:BANDWIDTH=${bw},RESOLUTION=${res},CODECS="avc1.4D401F,mp4a.40.2"\n${u}\n`;
  const m = `#EXTM3U\n${v(3000000, '1280x720', '720.m3u8')}${v(290000, '256x144', '144.m3u8')}${v(700000, '640x360', '360.m3u8')}`;
  assert.equal(R.pickVariant(m, 'https://cdn.example/live/master.m3u8'), 'https://cdn.example/live/360.m3u8');
  assert.equal(R.pickVariant(`#EXTM3U\n${v(290000, '256x144', '144.m3u8')}${v(200000, '200x100', 'tiny.m3u8')}`, 'https://cdn.example/m.m3u8'), 'https://cdn.example/tiny.m3u8');
  assert.equal(R.pickVariant('#EXTM3U\n#EXTINF:2,\nseg.ts\n', 'https://cdn.example/m.m3u8'), null);
});

test('a media playlist: sequence numbers, the init segment, ads, discontinuities', () => {
  const pl = R.parseMedia(`#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:22229
#EXT-X-MAP:URI="init-0.mp4"
#EXT-X-PROGRAM-DATE-TIME:2026-10-18T04:36:03.276Z
#EXTINF:2.000,live
seg-22229.mp4
#EXT-X-DATERANGE:ID="stitched-ad-1",CLASS="twitch-stitched-ad",START-DATE="2026-10-18T04:36:05Z",DURATION=30.2
#EXTINF:2.000,Amazon|2474283100494
seg-ad-1.mp4
#EXTINF:2.000,Amazon|2474283100494
seg-ad-2.mp4
#EXT-X-DISCONTINUITY
#EXT-X-MAP:URI="init-1.mp4"
#EXTINF:1.500,live
seg-22232.mp4
#EXT-X-TWITCH-PREFETCH:https://edge.example/prefetch.mp4
`, 'https://edge.example/v1/playlist/audio.m3u8');
  assert.equal(pl.target, 2);
  assert.equal(pl.end, false);
  assert.deepEqual(pl.segs.map((s) => [s.seq, s.url.split('/').pop(), s.dur, s.ad, s.disc, s.map.split('/').pop()]), [
    [22229, 'seg-22229.mp4', 2, false, false, 'init-0.mp4'],
    [22230, 'seg-ad-1.mp4', 2, true, false, 'init-0.mp4'],
    [22231, 'seg-ad-2.mp4', 2, true, false, 'init-0.mp4'],
    [22232, 'seg-22232.mp4', 1.5, false, true, 'init-1.mp4'],
  ]);
  const ts = R.parseMedia('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:7\n#EXTINF:5.0,\nhttps://x.example/a.ts\n#EXT-X-ENDLIST\n', 'https://x.example/p.m3u8');
  assert.equal(ts.end, true);
  assert.equal(ts.segs[0].map, null);
  assert.equal(ts.segs[0].seq, 7);
});

test('which segments to take: newer ones; none from a stale answer; the newest minute after a real restart', () => {
  const pl = (first, n) => ({ segs: Array.from({ length: n }, (_, i) => ({ seq: first + i })) });
  const seqs = (r) => [r.segs.map((s) => s.seq), r.restart];
  assert.deepEqual(seqs(R.pickSegments(pl(100, 720), null, null, 12)), [Array.from({ length: 12 }, (_, i) => 808 + i), false]);
  assert.deepEqual(seqs(R.pickSegments(pl(101, 720), 819, 100, 12)), [[820], false]);
  // a lagging edge: newest one behind the last taken, the window still overlapping what was seen
  assert.deepEqual(seqs(R.pickSegments(pl(99, 720), 819, 100, 12)), [[], false]);
  // the sequence started over (an encoder restart): newest below the old oldest
  assert.deepEqual(seqs(R.pickSegments(pl(0, 10), 819, 100, 3)), [[7, 8, 9], true]);
  assert.deepEqual(seqs(R.pickSegments({ segs: [] }, 819, 100, 3)), [[], false]);
});

test('discontinuity sequence numbers name each segment\'s timeline', () => {
  const pl = R.parseMedia(`#EXTM3U
#EXT-X-MEDIA-SEQUENCE:284206
#EXT-X-DISCONTINUITY-SEQUENCE:56
#EXTINF:5.0,
a.aac
#EXT-X-DISCONTINUITY
#EXTINF:5.0,
b.aac
`, 'https://x.example/p.m3u8');
  assert.deepEqual(pl.segs.map((s) => [s.seq, s.dseq]), [[284206, 56], [284207, 57]]);
});

console.log(`${n} tests passed`);
