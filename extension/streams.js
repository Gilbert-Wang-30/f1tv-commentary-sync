// Where a commentary stream lives, for recording it in the browser (recorder.js): a live
// room's or channel's page URL on a platform fone knows (Bilibili, Twitch, YouTube, Douyin,
// Huya), or a stream URL as is (HTTP-FLV, HLS or AAC: whatever `streamlink --stream-url` or
// `yt-dlp -g` prints, for any other site). parse() reads the URL, resolve() asks the platform
// whether the stream is live and where to pull it from. Shared by the offscreen engine and the
// options page (its Test button); runs only in extension pages, whose fetch() isn't held to
// CORS. Requests carry no cookies (but Douyin's anonymous ttwid): what's recorded is what
// anyone can watch, signed in or not.
(function (root) {
  'use strict';

  const UA = { 'accept-language': 'en-US,en;q=0.9' };
  const get = async (url, opts = {}) => {
    const r = await fetch(url, { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(10000), ...opts, headers: { ...UA, ...opts.headers } });
    if (!r.ok) throw Object.assign(new Error(`${new URL(url).hostname} → HTTP ${r.status}`), { status: r.status });
    return r;
  };
  const json = async (url, opts) => (await get(url, opts)).json();
  const text = async (url, opts) => (await get(url, opts)).text();

  // ---- reading the URL -------------------------------------------------------------------

  const PLATFORMS = {
    bilibili: 'Bilibili', twitch: 'Twitch', youtube: 'YouTube', douyin: 'Douyin', huya: 'Huya', url: 'Stream URL',
  };

  // {platform, id, url, key, label} or {error}. `key` names the stream for saved settings (the
  // delay); `label` is for the panel until the platform has told us the streamer's name.
  function parse(input) {
    let s = String(input || '').trim();
    if (!s) return { error: 'No stream set' };
    if (/^\d{1,12}$/.test(s)) s = `https://live.bilibili.com/${s}`; // a bare number: a Bilibili room
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
    let u;
    try { u = new URL(s); } catch { return { error: `Not a URL: ${input}` }; }
    if (!/^https?:$/.test(u.protocol)) return { error: 'Only http(s) URLs' };
    const host = u.hostname.replace(/^(www|m)\./, '');
    const seg = u.pathname.split('/').filter(Boolean);
    const out = (platform, id, label) => ({ platform, id, url: u.href, key: `${platform}:${id}`, label: label || `${PLATFORMS[platform]} ${id}` });
    if (host === 'live.bilibili.com') {
      const id = seg.find((x) => /^\d+$/.test(x));
      return id ? out('bilibili', id) : { error: 'A Bilibili live URL has the room number in it (live.bilibili.com/123)' };
    }
    if (host === 'twitch.tv') {
      const login = (seg[0] || '').toLowerCase();
      return /^[a-z0-9_]{2,25}$/.test(login) && !['videos', 'directory', 'p', 'search'].includes(login)
        ? out('twitch', login) : { error: 'A Twitch URL is twitch.tv/<channel>' };
    }
    if (host === 'youtube.com' || host === 'youtu.be' || host === 'music.youtube.com') {
      const v = host === 'youtu.be' ? seg[0] : u.searchParams.get('v') || (seg[0] === 'live' && seg[1]) || null;
      if (v && /^[\w-]{11}$/.test(v)) return out('youtube', v, `YouTube ${v}`);
      if (seg[0]?.startsWith('@')) return out('youtube', seg[0], `YouTube ${seg[0]}`);
      if (seg[0] === 'channel' && /^UC[\w-]{22}$/.test(seg[1] || '')) return out('youtube', seg[1], `YouTube ${seg[1].slice(0, 8)}…`);
      if ((seg[0] === 'c' || seg[0] === 'user') && seg[1]) return out('youtube', `${seg[0]}/${seg[1]}`, `YouTube ${seg[1]}`);
      return { error: 'A YouTube URL is a video (watch?v=…) or a channel (@name)' };
    }
    if (host === 'live.douyin.com') {
      return /^\d+$/.test(seg[0] || '') ? out('douyin', seg[0]) : { error: 'A Douyin live URL is live.douyin.com/<number>' };
    }
    if (host === 'huya.com') {
      return seg[0] && /^[\w-]+$/.test(seg[0]) ? out('huya', seg[0]) : { error: 'A Huya URL is huya.com/<room>' };
    }
    return { platform: 'url', id: u.href, url: u.href, key: `url:${u.origin}${u.pathname}`, label: u.hostname };
  }

  // The stream's own page on its platform, where people watch it (fone's ↗), or null: a stream URL
  // given straight has none.
  function pageOf(input) {
    const s = typeof input === 'string' ? parse(input) : input;
    if (!s || s.error) return null;
    switch (s.platform) {
      case 'bilibili': return `https://live.bilibili.com/${s.id}`;
      case 'twitch': return `https://www.twitch.tv/${s.id}`;
      case 'youtube': return /^[\w-]{11}$/.test(s.id) ? `https://www.youtube.com/watch?v=${s.id}`
        : s.id.startsWith('@') ? `https://www.youtube.com/${s.id}/live`
          : s.id.startsWith('UC') ? `https://www.youtube.com/channel/${s.id}/live` : `https://www.youtube.com/${s.id}/live`;
      case 'douyin': return `https://live.douyin.com/${s.id}`;
      case 'huya': return `https://www.huya.com/${s.id}`;
      default: return null;
    }
  }

  // ---- asking the platform ---------------------------------------------------------------
  // Each answers {live, kind: 'flv' | 'hls' | 'auto', url, alt?, name?, title?, reason?}; alt:
  // other URLs for the same stream, tried in turn when one fails.

  // The headers each platform's servers want on the extension's requests. Its fetch() sends
  // Origin: chrome-extension://…, which Bilibili's API (412), Twitch's playlists and YouTube's
  // player API (403) refuse, and no Referer, which Bilibili's FLV CDN refuses. fetch() can't set
  // either, so background.js turns this into session rules for the extension's own requests to
  // these domains (and the Node test harness into request headers). YouTube's SOCS cookie
  // answers its consent page, which a cookie-less request in the EU gets instead of the video.
  const HEADERS = [
    { domains: ['bilibili.com', 'bilivideo.com', 'bilivideo.cn'], set: { Referer: 'https://live.bilibili.com/', Origin: 'https://live.bilibili.com' } },
    { domains: ['twitch.tv', 'ttvnw.net'], set: { Referer: 'https://www.twitch.tv/', Origin: 'https://www.twitch.tv' } },
    { domains: ['youtube.com'], set: { Referer: 'https://www.youtube.com/', Origin: 'https://www.youtube.com', Cookie: 'SOCS=CAI' } },
    { domains: ['douyin.com', 'douyincdn.com'], set: { Referer: 'https://live.douyin.com/' } },
    { domains: ['huya.com'], set: { Referer: 'https://www.huya.com/' } },
  ];

  // Bilibili: the room's own player API, no login (anonymous viewers get 超清, qn 250; the audio
  // is the same in every quality: AAC 48 kHz ~128 kbps). HTTP-FLV first: it arrives as it's
  // made, ~1.1 s before the same moment in the fMP4 HLS (measured 2026-10-23), and live plays
  // that much nearer the edge. fMP4 HLS next: its timeline is the stream's own (a reconnect lands
  // to the sample, where HTTP-FLV starts each connection at 0 and is placed by arrival).
  // HEVC first in each, about half the video bytes (H.264 first for a browser that can't decode
  // HEVC and wants the picture: spec.avc, recorder.js preferAvc).
  async function bilibili(spec) {
    const info = await json(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${spec.id}`);
    if (info.code !== 0 || !info.data) throw new Error(`Bilibili: ${info.message || info.msg || 'no such room'}`);
    const room = info.data.room_id;
    const title = info.data.title || null;
    let name = null;
    try {
      const m = await json(`https://api.live.bilibili.com/live_user/v1/Master/info?uid=${info.data.uid}`);
      name = m?.data?.info?.uname || null;
    } catch { /* the name is only for the panel */ }
    if (info.data.live_status !== 1) return { live: false, name, title, reason: info.data.live_status === 2 ? 'Showing replays (轮播), not live' : 'Not live right now' };
    const play = await json(`https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?room_id=${room}`
      + '&protocol=0,1&format=0,1,2&codec=0,1&qn=250&platform=web&ptype=8&dolby=5&panorama=1');
    const streams = play?.data?.playurl_info?.playurl?.stream || [];
    const urls = (proto, fmt) => {
      const f = streams.find((x) => x.protocol_name === proto)?.format?.find((x) => x.format_name === fmt);
      const first = spec.avc ? 'avc' : 'hevc';
      const cs = [...(f?.codec || [])].sort((a, b) => (b.codec_name === first) - (a.codec_name === first));
      return cs.flatMap((c) => (c.url_info || []).map((u) => u.host + c.base_url + u.extra));
    };
    const fmp4 = urls('http_hls', 'fmp4'), flv = urls('http_stream', 'flv'), ts = urls('http_hls', 'ts');
    const all = [...flv.map((u) => ['flv', u]), ...fmp4.map((u) => ['hls', u]), ...ts.map((u) => ['hls', u])];
    if (!all.length) throw new Error('Bilibili: the room gave no stream URL');
    return { live: true, kind: all[0][0], url: all[0][1], alt: all.slice(1).map(([kind, url]) => ({ kind, url })), name, title };
  }

  // Twitch: the web player's access token (public client id, no login), then its HLS master
  // playlist, which has an audio-only rendition (the channel's own AAC; MPEG-TS for h264 players).
  const TWITCH_CLIENT = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
  const TWITCH_TOKEN = 'query PlaybackAccessToken($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!, $platform: String!) {'
    + ' streamPlaybackAccessToken(channelName: $login, params: {platform: $platform, playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) { value signature authorization { isForbidden forbiddenReasonCode } __typename }'
    + ' videoPlaybackAccessToken(id: $vodID, params: {platform: $platform, playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) { value signature __typename } }';
  // (asked as Twitch's embedded player: as the site's player, logged out, every connection began
  // with a 30 s pre-roll ad stitched into the stream, 2026-10-26; embedded, none. A channel that
  // won't play embedded: as the site's.)
  async function twitch(spec) {
    const gql = (body) => json('https://gql.twitch.tv/gql', { method: 'POST', headers: { 'Client-ID': TWITCH_CLIENT }, body: JSON.stringify(body) });
    const token = (playerType) => gql({ operationName: 'PlaybackAccessToken', query: TWITCH_TOKEN,
      variables: { isLive: true, login: spec.id, isVod: false, vodID: '', playerType, platform: 'web' } });
    const [embed, who] = await Promise.all([
      token('embed').catch(() => null),
      gql({ query: `query { user(login: ${JSON.stringify(spec.id)}) { displayName stream { id type title } } }` }).catch(() => null),
    ]);
    const user = who?.data?.user;
    const name = user?.displayName || null, title = user?.stream?.title || null;
    if (who && !user) throw new Error(`Twitch: no channel ${spec.id}`);
    if (who && !user.stream) return { live: false, name, title, reason: 'Not live right now' };
    const e = embed?.data?.streamPlaybackAccessToken;
    const tok = e && !e.authorization?.isForbidden ? embed : await token('site');
    const t = tok?.data?.streamPlaybackAccessToken;
    if (!t) throw new Error(`Twitch: no access token for ${spec.id}`);
    if (t.authorization?.isForbidden) throw new Error(`Twitch: ${t.authorization.forbiddenReasonCode || 'not allowed'}`);
    const q = new URLSearchParams({
      sig: t.signature, token: t.value, allow_source: 'true', allow_audio_only: 'true', fast_bread: 'true',
      p: String(Math.floor(Math.random() * 1e7)), player_backend: 'mediaplayer', playlist_include_framerate: 'true',
      supported_codecs: 'h264', platform: 'web',
    });
    return { live: true, kind: 'hls', url: `https://usher.ttvnw.net/api/channel/hls/${spec.id}.m3u8?${q}`, name, title };
  }

  // YouTube: the watch page (a channel's /live page is its live video's) names the video and
  // has the visitor id; the player API, asked as YouTube's visionOS app (the client yt-dlp uses
  // when it can't run YouTube's JavaScript: no PO token, no signature), answers with an HLS
  // playlist whose audio comes on its own (AAC-LC 128 kbps, packed ADTS).
  async function youtube(spec) {
    const id = spec.id;
    const page = /^[\w-]{11}$/.test(id) ? `https://www.youtube.com/watch?v=${id}`
      : id.startsWith('UC') ? `https://www.youtube.com/channel/${id}/live` : `https://www.youtube.com/${id}/live`;
    const html = await text(page);
    const canon = /<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/.exec(html)?.[1];
    const vid = /^[\w-]{11}$/.test(id) ? id : canon;
    const pr = playerResponse(html);
    const d0 = pr?.videoDetails || {};
    if (!vid) return { live: false, name: d0.author || null, reason: 'No live video on that channel right now' };
    const visitor = /"VISITOR_DATA":"([^"]+)"/.exec(html)?.[1];
    if (!visitor) throw new Error('YouTube: no visitor id on the page (a consent page?)');
    const r = await json('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ videoId: vid, contentCheckOk: true, racyCheckOk: true, context: { client: {
        clientName: 'VISIONOS', clientVersion: '1.02', deviceMake: 'Apple', deviceModel: 'RealityDevice17,1',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
        osName: 'visionOS', osVersion: '26.5.23O471', hl: 'en', visitorData: visitor } } }),
    });
    const d = r.videoDetails || d0;
    const name = d.author || null, title = d.title || null;
    const hls = r.streamingData?.hlsManifestUrl;
    if (!hls) {
      if (d.isLive === false || !d.isLiveContent) return { live: false, name, title, reason: 'Not live right now' };
      const why = r.playabilityStatus?.reason || r.playabilityStatus?.status || 'no live stream to record';
      // (a video's stream that has ended: the channel's own URL follows whatever it streams next)
      if (/^[\w-]{11}$/.test(id) && /not available|ended|recording/i.test(why)) {
        return { live: false, name, title, reason: `${why} (that video's stream is over: its channel's URL, youtube.com/@name, follows what it streams next)` };
      }
      throw new Error(`YouTube: ${why}`);
    }
    return { live: true, kind: 'hls', url: hls, name, title };
  }

  function playerResponse(html) {
    const i = html.indexOf('ytInitialPlayerResponse = {');
    if (i < 0) return null;
    const s = html.indexOf('{', i);
    // the object's end: brace depth, minding strings
    let depth = 0, inStr = false, esc = false;
    for (let j = s; j < html.length; j++) {
      const ch = html[j];
      if (inStr) {
        if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        try { return JSON.parse(html.slice(s, j + 1)); } catch { return null; }
      }
    }
    return null;
  }

  // Douyin: the web player's room API. It answers only with Douyin's anonymous ttwid cookie,
  // which the service worker adds (background.js: read from the browser, or a fresh one, never
  // the user's other Douyin cookies). Its audio-only stream (ao) is what fone records: AAC
  // 48 kHz, on the stream's own timeline.
  async function douyin(spec) {
    const q = new URLSearchParams({ aid: '6383', app_name: 'douyin_web', live_id: '1', device_platform: 'web', language: 'zh-CN',
      enter_from: 'web_live', cookie_enabled: 'true', browser_language: 'zh-CN', browser_platform: 'Win32', browser_name: 'Chrome',
      browser_version: '141.0.0.0', web_rid: spec.id });
    let cookie = false;
    try { cookie = await root.chrome?.runtime?.sendMessage({ target: 'background', type: 'douyin-cookie' }); } catch { /* none */ }
    if (!cookie) throw new Error('Douyin: no anonymous ttwid cookie (open live.douyin.com once in this browser)');
    const body = (await text(`https://live.douyin.com/webcast/room/web/enter/?${q}`)).trim();
    if (!body) throw new Error('Douyin: no answer (its ttwid cookie was refused)');
    const d = JSON.parse(body).data || {};
    const room = d.data?.[0];
    if (!room) throw new Error(`Douyin: no room ${spec.id}`);
    const name = d.user?.nickname || room.owner?.nickname || null, title = room.title || null;
    if (room.status !== 2) return { live: false, name, title, reason: 'Not live right now' };
    let qs = {};
    try { qs = JSON.parse(room.stream_url.live_core_sdk_data.pull_data.stream_data).data || {}; } catch { /* the older map below */ }
    // (the picture wanted, the streamer window: the smallest with it, spec.video)
    const order = [...(spec.video ? [] : ['ao']), 'ld', 'sd', 'md', 'hd', 'origin', 'uhd'];
    const flvs = order.map((k) => qs[k]?.main?.flv).filter(Boolean);
    for (const k of ['SD2', 'SD1', 'HD1', 'FULL_HD1']) if (room.stream_url?.flv_pull_url?.[k]) flvs.push(room.stream_url.flv_pull_url[k]);
    if (spec.video && qs.ao?.main?.flv) flvs.push(qs.ao.main.flv); // (no picture to be had: the audio still)
    if (!flvs.length) throw new Error('Douyin: the room gave no stream URL');
    const https = flvs.map((u) => u.replace(/^http:/, 'https:'));
    return { live: true, kind: 'flv', url: https[0], alt: https.slice(1).map((url) => ({ kind: 'flv', url })), name, title };
  }

  // Huya: the mobile site's room API (a vanity name is looked up on the room's page first), the
  // lowest bitrate (流畅: only the audio is kept). Its CDN cuts a connection after the first
  // burst unless the URL is signed afresh the way Huya's web player signs it: the anticode's
  // template (fm) filled in with a viewer id and an MD5 of the request.
  async function huya(spec) {
    let rid = /^\d+$/.test(spec.id) ? spec.id : null;
    if (!rid) rid = /"profileRoom":(\d+)/.exec(await text(`https://www.huya.com/${encodeURIComponent(spec.id)}`))?.[1];
    if (!rid) throw new Error(`Huya: no room ${spec.id}`);
    const r = await json(`https://mp.huya.com/cache.php?m=Live&do=profileRoom&roomid=${rid}`);
    const d = r.data || {};
    if (r.status !== 200 && !d.liveData) throw new Error(`Huya: ${r.message || 'no such room'}`);
    const name = d.liveData?.nick || d.profileInfo?.nick || null, title = d.liveData?.introduction || null;
    if (d.liveStatus !== 'ON' || !d.stream) return { live: false, name, title, reason: d.liveStatus === 'REPLAY' ? 'Showing a replay, not live' : 'Not live right now' };
    const rank = { TX: 0, AL: 1 }; // over https; the others (HS) only answer plain http
    const lines = [...(d.stream.baseSteamInfoList || [])].filter((b) => b.sFlvUrl && b.sStreamName && b.sFlvAntiCode)
      .sort((a, b) => (rank[a.sCdnType] ?? 9) - (rank[b.sCdnType] ?? 9));
    const urls = lines.map((b) => `${b.sCdnType in rank ? b.sFlvUrl.replace(/^http:/, 'https:') : b.sFlvUrl}/${b.sStreamName}.${b.sFlvUrlSuffix || 'flv'}?${huyaSign(b.sFlvAntiCode, b.sStreamName)}`);
    if (!urls.length) throw new Error('Huya: the room gave no stream URL');
    return { live: true, kind: 'flv', url: urls[0], alt: urls.slice(1).map((url) => ({ kind: 'flv', url })), name, title };
  }

  function huyaSign(anti, stream) {
    const q = new URLSearchParams(anti);
    const uid = 1400000000000 + Math.floor(Math.random() * 1e7);
    const seq = uid + Date.now();
    const wsTime = q.get('wsTime'), ctype = 'huya_live', t = 100;
    const prefix = atob(q.get('fm') || '').split('_')[0];
    const secret = md5(`${prefix}_${uid}_${stream}_${md5(`${seq}|${ctype}|${t}`)}_${wsTime}`);
    return new URLSearchParams({ wsSecret: secret, wsTime, seqid: String(seq), ctype, ver: '1', fs: q.get('fs') || '', u: String(uid),
      t: String(t), sv: '2110211124', ratio: '500' }).toString();
  }

  // MD5 (RFC 1321), for Huya's signature only: SubtleCrypto has none.
  const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
  const MD5_R = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  function md5(str) {
    const b = new TextEncoder().encode(str);
    const n = ((b.length + 8) >> 6) + 1;
    const w = new Uint32Array(n * 16);
    for (let i = 0; i < b.length; i++) w[i >> 2] |= b[i] << ((i % 4) * 8);
    w[b.length >> 2] |= 0x80 << ((b.length % 4) * 8);
    w[n * 16 - 2] = b.length * 8;
    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    for (let o = 0; o < w.length; o += 16) {
      let A = a0, B = b0, C = c0, D0 = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D0); g = i; }
        else if (i < 32) { F = (D0 & B) | (~D0 & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D0; g = (3 * i + 5) % 16; }
        else { F = C ^ (B | ~D0); g = (7 * i) % 16; }
        const x = (A + F + MD5_K[i] + w[o + g]) | 0, sh = MD5_R[(i >> 4) * 4 + (i % 4)];
        A = D0; D0 = C; C = B;
        B = (B + ((x << sh) | (x >>> (32 - sh)))) | 0;
      }
      a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D0) | 0;
    }
    return [a0, b0, c0, d0].map((v) => [0, 8, 16, 24].map((k) => ((v >>> k) & 0xff).toString(16).padStart(2, '0')).join('')).join('');
  }

  async function direct(spec) {
    return { live: true, kind: 'auto', url: spec.url };
  }

  const RESOLVERS = { bilibili, twitch, youtube, douyin, huya, url: direct };

  async function resolve(spec) {
    if (spec.error) throw new Error(spec.error);
    return RESOLVERS[spec.platform](spec);
  }

  root.FoneStreams = { parse, pageOf, resolve, PLATFORMS, HEADERS, _playerResponse: playerResponse, _md5: md5 };
})(typeof globalThis !== 'undefined' ? globalThis : this);
