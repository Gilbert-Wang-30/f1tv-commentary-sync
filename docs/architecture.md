# fone architecture

How the two parts fit together: the **server** (`server/fone`, FastAPI, one Docker image) and
the **Chrome extension** (`extension/`, Manifest V3). This page is the reference for the routes,
the data shapes and the messages between the extension's parts; the README says what it all
does for the viewer. Times are unix seconds (float, UTC) unless stated.

- [The four clocks](#the-four-clocks)
- [Server](#server)
  - [Recordings and the data directory](#recordings-and-the-data-directory)
  - [Routes](#routes)
  - [The timeline and the delay](#the-timeline-and-the-delay)
  - [The optional services](#the-optional-services)
- [Extension](#extension)
  - [Parts](#parts)
  - [Without a server: the stream recorded in the browser](#without-a-server-the-stream-recorded-in-the-browser)
  - [Messages](#messages)
  - [Settings](#settings)

## The four clocks

Everything the extension does is a conversion between these (`extension/core.js`):

| | | |
|---|---|---|
| `p` | F1 TV player position | `<video>.currentTime` on the legacy Bitmovin player; on Tiledmedia (the current one) the content position that `page.js` reads from the player's own objects |
| `E` | the real-world moment the frame at `p` shows | depends on the *clock* chosen for the video, below |
| `W` | when the commentary about `E` aired | `E + delay`; the delay is the streamer's lag behind real time |
| `m` | position in the stitched commentary playlist | `W` mapped through the timeline's pieces (wall clock ↔ playlist) |

The clock (`FoneCore.chooseClock`) is one of:

| clock | `E` from | when |
|---|---|---|
| `multiviewer` | `p0 + p`, `p0` exact from MultiViewer's `session_start` and the live-timing archive's `SessionStatus: Started` | a session feed whose anchor MultiViewer has published and the archive has dated. The archive has answered 401 to everyone since 2026-10-18, so that is a replay anchored before then (a cached exact anchor is kept) |
| `preroll` | `p0 + p`, `p0 = scheduledStart + PREROLL[kind]` (the replay's fixed pre-roll per session type) | a session feed before MultiViewer publishes, or one the archive refuses to date (every replay not anchored before 2026-10-18, while it refuses) |
| `epoch` | `p` itself: the player hands out unix time | a replay player that exposes UTC directly |
| `edge` | measured back from the live edge | the video is live: after one alignment the commentary follows F1 TV's playhead (`m0 + (p − p0)`) and only moves on a seek or a nudge |
| `manual` | your own alignment | not a session feed (pre-/post-shows), or F1 TV doesn't know the content |

Two rules follow from this:

- **The dashboard shows the state at `E` and never later.** The server computes
  `/api/timing/.../state?t=E` from the messages that had arrived by `E`, and car positions are
  only interpolated up to `E`. Live, where `E` is a guess, the engine holds the dashboard a
  few seconds further back (2 s behind a measured delay, 5 s behind a calibrated one).
- **Danmaku are shown at their send time on the `W` clock**: the wall time of the audio
  playing right now, so they pause, jump and speed up with what you hear.

The streamer's delay is per channel and per clock family: only `multiviewer` and `preroll`
put the video on true UTC, `epoch` is a player clock that reads ~40 s late on live streams,
and `edge`/`manual` have no family. A calibration made on one clock is only reused on a
comparable one (`server/fone/store.py`, `CLOCK_FAMILY`).

## Server

`server/fone/app.py` builds everything at import (so the routers can be mounted) and starts the
services in FastAPI's lifespan. The core (recordings scanner, audio extractor, F1 TV mapper,
sync store, playback diagnostics) is always on; each optional service (timing, ads, screenclock,
video, backfill, danmaku) is a class with `start()`/`stop()` plus a `make_router(svc)`, switched
off with `FONE_<NAME>=0`, and one that fails to build or start is left out rather than taking
the commentary sync down (`/api/health` lists the running ones).

Configuration is environment variables only (`server/fone/config.py`; the README's
Configuration table lists them).

### Recordings and the data directory

`FONE_REC_DIR` (`/rec`) is scanned recursively every `FONE_SCAN_INTERVAL` s. A recording's
**channel is its parent folder** (BililiveRecorder's `{{ name }}/` template; `FONE_CHANNEL_ALIASES`
renames folders), its start time is parsed from the file name (`yyyyMMdd-HHmmss-fff-title.flv`
and the coarser variants in `recordings.py`) in `FONE_FILENAME_TZ`, and its `source` is
`recorder`, or `import` for files under `FONE_IMPORT_DIR` (backfill's replays, which only ever
fill gaps). A file still being written (mtime younger than `FONE_GROWING_IDLE_SECONDS`) is
tailed into ffmpeg so its audio is playable seconds after it was recorded.

`FONE_DATA_DIR` (`/data`, the `fone-data` volume) holds everything computed:

```
fone.sqlite3                 F1 TV content cache, delays (content_delay, channel_delay), backfill's tables
hls/<fid>/                   one directory per recording (fid = sha1 of its path, 16 hex chars)
  index.m3u8, seg_NNNNN.ts     audio-only HLS, copied, not re-encoded (FONE_SEGMENT_SECONDS each)
  run.json                     how the audio was mapped to the wall clock (live lag / end lag)
  ads.json                     sponsor clips found (ads service)
  screenclock.json             the measured screen delay (screenclock service)
timing/<session_key>/        live-timing streams, archive and own capture in the same format
  <Topic>.jsonStream, meta.json
timing/schedule.json         the OpenF1 calendar; timing/tracks/<meeting>.json (+ .corners.json)
video/<fid>.json             FLV keyframe index (video handoff)
danmaku/                     capture/<room>-<yyyymmdd>.jsonl and danmaku.sqlite3
diag/<day>.jsonl             playback diagnostics, 7 days
backfill/                    downloads in progress
```

### Routes

All reads are open to anyone who can reach the port. **Writes (anything but GET/HEAD/OPTIONS)
are refused with 403 when the request carries an `Origin` that isn't `chrome-extension://` or
`moz-extension://`** (`RefuseWebPageWrites`): the extension's own pages and scripts without an
Origin (curl) can write, a web page you visit cannot. CORS is `*` with private-network access
allowed, so a page on https://f1tv.formula1.com can read from a server on the LAN.

**Core**

| | |
|---|---|
| `GET /` | status page (HTML): every recording, its extraction status and analysis notes |
| `GET /api/health` | `{ok, recDir, files, now, services: [...]}` |
| `GET /api/channels` | `[{name, files, latest, live}]`, newest first; `live` = a file is still growing |
| `GET /api/f1tv/{cid}[?refresh=1]` | an F1 TV video (`f1.py`): `{contentId, title, subtype: "LIVE"\|"REPLAY"\|…, duration, meetingKey, sessionKey, meetingName, sessionName, kind: "practice"\|"sprint_qualifying"\|"qualifying"\|"sprint"\|"race"\|null, scheduledStart, scheduledEnd, isSessionFeed, anchor: "multiviewer"\|"preroll"\|null, p0, startedUtc, sessionStartVideo, channelOffsets: {channelId: seconds}, streams: [{channelId, type: "obc"\|"additional", title, number, name, team, color}]}` or `{…, error}`. Cached in SQLite; an anchored replay never changes, everything else is re-checked after 10 min, and a re-check that can't make the exact anchor again (the archive refusing) keeps the cached one |
| `GET /api/sync/{cid}?channel=&clock=` | the delay to start from: `{delay, source: "content"\|"measured"\|"channel"\|"default"}`; `measured` adds `{screen, reaction, confidence, file}` |
| `PUT /api/sync/{cid}` `{channel, clock, delay}` | save a tweak for that video (and clock) |
| `GET /api/timeline?channel=&from=&to=` | the commentary between two wall times, below |
| `GET /api/playlist.m3u8?files=a,b,…` | the files stitched into one HLS EVENT playlist (`#EXT-X-DISCONTINUITY` between files, `#EXT-X-ENDLIST` once all are finished) |
| `GET /hls/{fid}/seg_NNNNN.ts` | an audio segment |
| `POST /api/diag` `{client, build, platform, events: [{t, type, …}]}` · `GET /api/diag?client=&type=&since=&limit=` | playback diagnostics from the extension's engine; `tools/diag.py` reads them as a timeline |

**Timing** (`timing.py`, `timing_state.py`, `livefeed.py`), prefix `/api/timing`

| | |
|---|---|
| `GET /session/{key}/state?t=` | `{t, available: true, session: {key, name, type, meeting}, status: "Inactive"\|"Started"\|"Aborted"\|"Finished"\|"Finalised"\|"Ends", clock: {remaining: "MM:SS"\|null, lap, laps}, part: 1\|2\|3\|null, track: {status, flag: "GREEN"\|"YELLOW"\|"DOUBLE YELLOW"\|"SC"\|"VSC"\|"RED"\|"CHEQUERED", message}, weather: {air, track, humidity, rain, windSpeed, windDir}, tower: [{pos, num, code, name, team, color: "#RRGGBB", gap, interval, last, lastFlag: "overall"\|"personal"\|"none", best, tyre: "SOFT"\|"MEDIUM"\|"HARD"\|"INTERMEDIATE"\|"WET"\|"UNKNOWN", tyreAge, newTyre, pits, inPit, pitOut, retired, knockedOut}]}`; `{available: false, reason}` (HTTP 200) while there is no data |
| `GET /session/{key}/positions?from=&to=` | `{cars: {"<num>": [[t, x, y], …]}}`: on-track samples with their sensor time in the window (at most 120 s), plus the one just before `from`; F1's X/Y units |
| `GET /session/{key}/track` | `{available: true, outline: [[x, y], …], rotation, bounds: [x0, y0, x1, y1], source, corners: [{n, l, x, y, a}]}`: the outline from the fastest clean lap of the weekend, corner numbers from MultiViewer's circuit data (`[]` until fetched) |
| `POST /session/{key}/positions` `{messages: [{Timestamp, Entries: {num: {X, Y, Z, Status}}}]}` | decoded live `Position.z` from the browser (≤ 5000 per call; stored 0 once the session is archived) |
| `GET /content/{cid}` | the F1 TV mapping, as `/api/f1tv/{cid}` |
| `GET /status` | what is being captured, fetched and loaded |

**Other services**

| | |
|---|---|
| `GET /api/ads/{fid}` | `{spans: [{start, end, name}], analyzedTo}` in the file's own media seconds (its audio HLS timebase) |
| `GET /api/screenclock/{fid}` | `{delayScreen, n, confidence: "high"\|"medium"\|"low"\|"none", updated, basis, status, …}`; `delayScreen` = file wall time − the F1 feed UTC shown on screen |
| `GET /api/video/{fid}/info` | `{id, name, growing, t0, a0, mOffset, duration, edge, width, height, codec, wallStart}`; `m = v + mOffset` converts this playlist's time `v` into the file's audio-HLS time |
| `GET /api/video/{fid}/index.m3u8[?start=]` · `/seg/{a}_{b}.ts` | the recording's own picture and sound, cut at keyframes, no re-encode (VOD when finished, EVENT while growing); `202` + `Retry-After` while the FLV is being indexed |
| `GET /api/backfill/status` | `{enabled, importDir, rooms, periods, jobs}` |
| `POST /api/backfill/import` `{"bvid"}` or `{"from", "to", "channel"}` | import a replay by hand (409 unless `FONE_ROOMS` and `FONE_IMPORT_DIR` are set) |
| `GET /api/danmaku?channel=&from=&to=[&limit=]` | `{items: [{t, x, m: 1\|4\|5, s, c, u, ul?, ml?, wl?, g?, e?, em?, k?, p?}], live, room}`, oldest first, at most 6000 (see `danmaku.py` for the fields) |
| `GET /api/danmaku/status` | rooms listened to, capture and archive state |

### The timeline and the delay

`GET /api/timeline` answers

```
{channel, now,
 files: [{id, name, title, source, status, growing, provisional, inPlaylist,
          wallStart, wallEnd, duration, offset, error, adsAnalyzedTo}],
 pieces: [{w, m, d, f}],        wall time w ↔ playlist position m, for d seconds, in file index f
 mutes:  [{w, d, m, name}],     sponsor clips, on both clocks
 playlist, live, edge, complete}
```

- Files join the playlist in wall order up to and including the first one still growing or
  being extracted, so the playlist is append-only. An import (`source: "import"`) joins only
  once fully extracted and never holds the others back.
- Where two files cover the same wall time the recorder wins; imports only fill what nothing
  else covers; no two pieces overlap (`timeline.py`). A clipped remainder shorter than 2 s of
  an import (0.1 s of a recording) is dropped.
- `mutes` are the ads service's spans mapped through the pieces actually played; clips of one
  reel less than 3 s apart are merged.
- `complete` is false while any eligible file is still being written: the extension then
  refreshes the timeline often, otherwise once a minute.

`GET /api/sync/{cid}` picks the delay in this order: the video's own saved tweak (`content`),
then on a true-UTC clock the screen-clock measurement of the recording that covers the video
(`measured`: `delayScreen + FONE_REACTION_SECONDS`, only with high or medium confidence and
after the display zone was checked), then the channel's latest tweak on a comparable clock
(`channel`), then `FONE_DEFAULT_DELAY` (`default`).

### The optional services

**timing**: per-session live-timing state at any UTC. Sessions come from the OpenF1 calendar.
Each one is captured live over SignalR Core (`livefeed.py`, anonymous SSE transport) from
15 min before the scheduled start until `SessionStatus: Ends` (safety stop 4 h after the
start), and replaced by the static archive once F1 publishes it (~20 min after the session;
403 until then). Since 2026-10-18 the archive answers 401 to everyone: a session has timing
only if the server captured it live (`FONE_TIMING_RECORD`), and nothing stored is pruned while
the archive refuses (`maybe_prune` asks the year index first; when it answers, sessions stored
more than `FONE_TIMING_KEEP_DAYS` (30) days ago are deleted and fetched again on demand). Both
are stored in the archive's format, one `<Topic>.jsonStream` per topic (`HH:MM:SS.mmm<json>`
lines, offsets from the session's `t0`), so one loader serves both.
Anonymous access has everything except car positions; those come from the viewer's own F1 TV
login through `POST /positions` (the server never sees the token). `docs/f1-data-sources.md`
has the endpoints and formats.

**ads**: sponsor-reel detection per recording against the reference clips in
`server/fone/ads/` (`refs.npz`: fingerprints of the clips, built by `fone/ads/build_refs.py` from 8 kHz mono WAVs, plus `ads.json`, the manifest). Growing files are analysed segment by
segment as the extractor lists them (a clip is known 2–3 s into its audio); finished files
once. The extension mutes while the target `m` is inside a `mutes` span (live from the stream
itself, while the wall time of the target is inside one's `w` span, padded by 1 s). Live, each
clip of a break is recognised on its own, a few seconds into it, so the mute holds past a span's
end until the file's `adsAnalyzedTo` is 3 s past it (when a following clip would have been
recognised; at most 12 s), and the commentary then fades back in over 1.2 s.

**screenclock**: the streamer's delay measured off their stream, from FLV recordings only
(any other file is marked `unsupported`: `fone-streamlink`'s MPEG-TS gets no measurement). The
streamer shows MultiViewer's "Track time" (the feed's UTC in some display zone) on screen;
keyframes are OCRed with tesseract, the readings checked against a running clock, and the
sub-second part timed from the frame where the seconds digit ticks. Finished files once;
growing files every few minutes, incrementally. The raw readings are kept with the result, so
a restart resumes.

**video**: the recording's own picture and sound as HLS, for keeping on watching the streamer
after F1 TV ends, from FLV recordings only (`video_flv.py` indexes the FLV's keyframes;
segments are the FLV bytes between two keyframes, remuxed by ffmpeg with timestamps kept).

**backfill**: a live-status log per configured room (`FONE_ROOMS`, polled every 60 s); when a
stream ends and the channel's recordings leave a gap over 60 s, the streamer's official
replay (直播回放) is polled for up to 36 h, downloaded, de-duplicated, placed on the wall
clock (aligned against what was recorded, else from the room's live time) and written as a
recorder-style FLV into `FONE_IMPORT_DIR/<channel>/`.

**danmaku**: an anonymous connection to each room's danmaku feed (`danmaku_feed.py`), written
as JSON lines and indexed into SQLite, plus danmakus.com's archive for what the capture
didn't hear (no levels, colours or stickers there). Served by send time.

## Extension

### Parts

| where | files | role |
|---|---|---|
| content scripts on `https://f1tv.formula1.com/*`, isolated world | `core.js`, `player.js`, `dmcore.js`, `danmaku.js`, `content.js`, `layout.js`, `streamerbox.js` | `player.js` finds the main `<video>` and its true position; `content.js` draws the panel, binds the keys and reports the player to the engine; `layout.js` the split view with the stats iframe; `danmaku.js` the 弹幕 overlay; `streamerbox.js` the streamer window (a box with `streamer.html` in an iframe, moved by its bar, sized by its corner, `chrome.storage.local` `streamerBox`/`streamerOn`) |
| streamer window | `streamer.html`: `vendor/hls.light.min.js`, `streamer.js` (in the box's iframe, or a popup window of its own) | the streamer's picture at the commentary's moment, muted. Follows the engine's clock (`fone-clock`): the stream recorded here, from the recorder's video (`fone-video`) decoded with WebCodecs (H.264, HEVC where the browser decodes it) and drawn on a canvas at `m`, the last 3 min kept for rewinds; a server's recording, its video handoff with hls.js at the file's position (`media − mOffset`), its requests made by the engine (`fone-fetch`: an iframe in F1 TV's https page can't reach an http server) |
| content scripts, **main** world | `page.js`, `layout_page.js` | the only place the Tiledmedia player's objects are reachable: position, speed, audio tracks, onboard views; fullscreen redirection for the split view |
| service worker | `background.js` (+ `dashproxy.js`, `f1token.js`, `streams.js`) | relays messages between tabs and the engine, opens the offscreen document, fetches for pages that can't (mixed content, CSP), hands the F1 TV token to the engine, sets the streaming platforms' header rules, self-update |
| offscreen document | `offscreen.html`: `vendor/hls.light.min.js`, `core.js`, `demux.js`, `localcore.js`, `streams.js`, `recorder.js`, `localplayer.js`, `livepos.js`, `offscreen.js` | **the audio engine**: picks the source (a server, or the stream recorded here), clock and delay, plays `m` (a server's recordings with hls.js, its own recording through MSE) and keeps it on target (at 1× by tiny rate changes, otherwise by rare seeks); relays live car positions |
| extension pages | `dashboard.html` (`dashcore.js`, `dashboard.js`, `dashboard.css`), `options.html`/`options.js` | the stats (as an iframe behind the shrunken player, or a window of its own); the settings |

`core.js`, `dashcore.js`, `dmcore.js`, `demux.js` and `localcore.js` are pure functions shared
with the Node unit tests.

### Without a server: the stream recorded in the browser

With `source: 'local'` the commentary is the streamer's live stream, recorded by the offscreen
document itself, and the engine runs the same edge-to-edge lock on it as on a server's growing
recording. Live only: there is no wall-clock archive to place a replay on.

| | |
|---|---|
| `streams.js` | `parse(url)` → `{platform, id, key, label}` for Bilibili, Twitch, YouTube, Douyin, Huya or a stream URL as is; `resolve(spec)` asks the platform's web player API (logged out, without credentials) → `{live, kind: 'flv' \| 'hls' \| 'auto', url, alt, name, title, reason}`. `HEADERS`: the Origin/Referer each platform's servers want (the extension's own `Origin` is refused by Bilibili's API, Twitch's playlists and YouTube's player API, a missing Referer by Bilibili's CDN); `background.js` makes them session rules (`declarativeNetRequest`, `initiatorDomains` = the extension). Douyin answers nothing without its anonymous `ttwid` cookie: the service worker reads the browser's and a session rule adds `Cookie: ttwid=…` to the extension's own requests to douyin.com (requests are otherwise credential-less). With no `ttwid`, it visits live.douyin.com (up to twice, 10 s each, with the browser's other Douyin cookies) for a fresh one, unless the browser's douyin.com cookies include a login's (by name): then it makes no visit. YouTube's `SOCS` consent cookie is a fixed value in `HEADERS` |
| `recorder.js` | one recorder per browser, wanted by the engine with every report of an F1 TV live video (or one whose clock isn't decided yet) and kept going 10 min after the last (`LINGER`); on a replay it stops. It resolves, pulls (HTTP-FLV/ADTS as one streaming `fetch`; HLS by polling the media playlist, from a master: the audio rendition, else the audio-only variant, else the smallest ≥ 360p), reconnects (the resolver's `alt` URLs in turn while they fail), and says what it's doing (`status()`) |
| `demux.js` | AAC out of FLV tags, MPEG-TS PES, fMP4 (`moof`/`trun` of the init's sound track) and packed ADTS (ID3 timestamp), as ADTS frames with the stream's own timestamps; silent frames for the gaps |
| `localcore.js` | the buffer: frames on one position axis `m` (s since the recording started), in 0.5 s chunks, the last `bufferMin` kept. Same connection: by timestamps (jitter under 0.1 s ignored, holes filled with silence). A reconnect: by its timestamps when they continue the old ones (repeats dropped, to half a frame), else by arrival: after 1.5 s (out of the CDN's burst) its freshest audio is put exactly as fresh as the old connection's was. The live edge is `now − min(arrival − m end)` over the last minute's arrivals, steady for FLV's stream and HLS's steps alike |
| `localplayer.js` | the engine's `<audio>` through Media Source Extensions: ADTS (`audio/aac`, `sequence` mode) appended 5 s at a time at its `m` (`timestampOffset`), 20 s ahead of the playhead, 15 s kept behind; a seek outside what's appended starts over there |

In the engine (`offscreen.js`) the recording stands in for the server: the timeline is
`localcore.timeline()` (one piece over what's kept), the content comes from the listed server's
`/api/f1tv` if one answers, else from F1 TV's content API directly, and the delay is the
stream's own, kept in the offscreen document's
`localStorage` (`delay|<stream key>`; `delaySource: 'stream'`). The live default is
`LOCAL_EDGE_DELAY` (28: 4 s behind the edge where F1 TV usually starts, 32 s behind its clock)
for the HTTP-FLV platforms, whose audio arrives continuously, and `LIVE_EDGE_DELAY` (25: 7 s) for
HLS. The live lock takes the recorder's live edge, and follows it forward for the
lock's first 90 s while the edge estimate firms up (HLS: the first playlist can't say how long
its newest segment has been out). While a reconnected connection waits to be placed (`SETTLE`),
the lead counts its audio as in hand, so that wait doesn't hold F1 TV; the time before the new
connection's first audio still counts (more than about 2 s of it at the 4 s default, or a
connection gone quiet until the recorder's 12 s `STALL`, and auto-hold holds F1 TV briefly). When the stream stops arriving (the streamer offline, or
nothing for 30 s) the panel says so and auto-hold lets F1 TV play instead of holding it. A
server listed in the settings is still used if it answers: for the content, the stats (held
back by the long fixed guess of F1 TV's latency: there is no measured delay for a stream recorded
here), the live car positions and the diagnostics, which carry the engine's status text (it can
include the streamer's name).
`e2e/local/run.sh` tests all of it against mock platforms.

**With a server, live (`liveDirect`, on by default).** The server's recording of a live stream
grows a recorder keyframe group at a time (4–6 s every ~5 s, measured on 胡闹P房's room), so its
commentary must stay 7 s behind its edge, and late groups made auto-hold pause F1 TV. When the
clock becomes `edge` and the channel has a Bilibili room (the room whose danmaku the server
captures, from `/api/danmaku/status`), the engine switches to the stream recorded here as
described above (`goDirect`: `S.local` set, `S.source` still `'server'`, status `direct: true`),
with that stream's own delay (per stream in this browser; nudges are saved there too). The
server still gives the content, the stats, the danmaku and the diagnostics, and the sponsor clips
it found are muted by wall time (`/api/timeline`'s `mutes`, looked at every 3 s as the server's
timeline is live; the server knows a clip only 2–3 s into it, so its first seconds are heard).
The engine goes back to the server's recording (`goServer`, with the server's delay again) when
the clock leaves `edge`, when the stream hasn't come in for 22 s while its platform still says
it's live (`DIRECT_GIVEUP`, from 2 s after its last audio; off air doesn't count, the server's
recording is off air too; until the engine attaches again: another video or tab, a settings
change), and, with `back`, when F1 TV is rewound past what this browser has recorded (or, the
stream off air since the page opened, rewound into what the server recorded): the stream goes on
being recorded, and once F1 TV
is back within it by `DIRECT_BACK` s and the stream is coming in, the engine switches to it again
(Go live then aims at the stream's edge; the way back needs no server, should its timeline fetch
fail meanwhile). Once this browser's recorder says the stream is off air, the server's recording
doesn't count as live either, even while its file is still in its 90 s growing idle, until the
server has audio from after that answer that is still coming in (within 15 s); while the
recorder keeps saying off air, that audio counts only while it keeps coming in (a false start
doesn't hold F1 TV). The server's recording growing meanwhile wakes the recorder's off-air check. Going into the server's recording with `back` carries the moment playing over by its
wall time whatever F1 TV's distance from its edge (`carryLock(true)`); coming back carries it
when the server's lock is still that carried one (not after a Re-sync), or takes a carry still
pending; any other switch carries it only while F1 TV is rewound by two edge steps or more. A
carried moment is placed by `momentAt`, also where the new timeline has no audio, so the
commentary stays in step with the picture; otherwise the new source locks from its own edge, at
its own delay.

A live lock on a server's recording is `m0 + (p − p0)` within one file; the server's `m` runs on
across files without the time between them (a streamer's reconnect: a gap; an overlap, clipped),
so the lock also keeps its wall time and the file that falls in (`newLock`; one made at the edge
takes the edge's wall time, so a newest file still shorter than the lag doesn't anchor it in an
older one). The linear `m` stands while it's in that file, or past its end while that file is the
newest (waiting at the live edge); anywhere else the moment is placed by its wall time (`lockM`):
a gap plays as one (state `gap`, silence, F1 TV not held), an overlap is skipped, and the
commentary stays in step with the picture. Within its file an edge lock's wall time follows the
server's mapping as it firms up; a lock whose moment came from a wall time (carried, or placed
across files) keeps that wall time, its `m` following the mapping instead. When the file set
changes (a backfill import joins, an old file leaves the 30 h window), positions and offsets can
move, so the lock is placed again by its wall time (keeping its kind when it lands back in its
own file). With no live edge (the streamer off air, F1 TV still live) the lock is made once as if
the edge were now, not re-derived every tick, and replaced by an edge lock once the server has an
edge again, unless it's playing an older file.

How live F1 TV is comes from F1 TV's own clock. Its live player stamps the picture with the
time F1's packager put on it (`utc0 + p`: `utc0` is the wall-clock bound minus the content bound,
exact and the same across page loads; player.js passes it as `video.utc0`), and its picture plays
some 31–34 s behind that clock where the player starts a live stream: a different place every
load (measured 2026-10-25 over six loads), more by any pause or rewind. That is `f1Lat`; the
commentary goes `f1Lat − delay` behind its own edge. So the live delay is the commentary's clock
(when it came in) minus F1 TV's on the picture it goes with, the same whatever F1 TV's player
did. Before 0.3.8 the lock took wherever F1 TV happened to be when it was made as F1 TV's live
position (30 s, by assumption): a few seconds' error, different every load, while the panel
showed the engine in step with that to the millisecond. The lock keeps the clock time at `p0`
(`L.u0`), so when F1 TV's player rebuilds and re-bases its content position (a new MSE handle,
the position and its edge jumping together, the picture where it was: its clock with it) the
lock keeps to the picture; a lock made before the clock was known is made again once it is.
Without the clock (another player), F1 TV is taken to start `DEFAULT_LIVE_LATENCY` (32 s) behind,
and its rewind is measured by wall time: how far it is behind where it played most live this
session (its content position runs with the clock while it plays; its reported edge steps by
5.76 s, a little late each time, and drifts by seconds between double steps), with re-bases
recognised from the jump.

F1 TV's clock is learned again (player.js) whenever the timeline may have changed (another MSE
handle or player, a gap in the reports, bounds not settled), from a sample whose wall-clock and
content bounds agree, and handed on only while such a sample is recent (2.5 s): never a cached
one for a timeline that may have moved. While a lock that keeps to the clock is without it, the
commentary waits (`clockLost`, up to 3 s, no source switch carried over meanwhile) rather than
follow a position that may be minutes off; past that, the re-base is followed the old way. A lock
made before the clock was known is made again once it is, unless it was carried over from the
other source's moment. The wall-time rewind (`minLagW`) is kept in step with the clock's
(`flBest`), so it's right on the timeline playing should the clock go.

On a server's recording the lock is placed by wall time: the moment recorded `f1Lat − delay`
before now (`SERVER_LIVE_DELAY`, 21: 11 s at F1 TV's usual latency, as the recording's newest
audio is up to ~8 s old), not behind its edge, which is only as fresh as the recorder's last
keyframe group and so 0–8 s stale at a different point for every lock. A delay set on the server
since 0.3.8 is kept as clock `edge2`; an older `edge` one is read 2 s less (`serverSync`).

"The time now" is the server's clock where there is a server (`trueNow`: this PC's plus `S.skew`,
measured over `/api/health`, the quickest of 3 round trips, every 10 min): F1 TV's clock on the
picture is compared with it, so a PC clock a second off (the user's Windows one ran ~1.1 s slow
by its diagnostics' receive times) would otherwise put the stream recorded here that far off. A
server's recording, placed by its own wall times, needs no correction (the time now cancels). A
moment carried between the two (`carryLock`), and the stream's walls compared with the server's
(its sponsor clips, off air, the way back to the stream), go by the server's clock too.

Go live takes F1 TV to the most recent moment it can play, by its clock: where its reported edge
is at its freshest of the last 3 min (`upFreshest`, one sample per step, the second freshest; ~30 s
behind the clock 2026-10-25; started over when the clock changes, another feed's edge may be
staler). F1 TV plays on past its reported edge between steps (after a 2 s pause it was still 1.1 s
ahead of it), and `Player.seek` stops at that edge, so what's out of reach now (`more`, from
0.6 s) is asked for every 0.5 s for 14 s (a seek past where F1 TV is becomes possible for a few
seconds after each step), up to 3 more seeks, none for more than was left; page.js makes each
forward seek no further than the edge F1 TV reports when it's made (`did`), as the playhead runs
on past that edge between steps and a seek beyond it, which the player stops there, would go back. F1 TV going a second
or more back from the furthest it has been since (a rewind or seek of yours: ours only go
forward; content.js, and the engine's own check, `pMax`), a pause of yours (not the player's own
around a seek of ours: 2 s after one) or auto-hold holding ends that. The commentary goes as near
its edge as `liveAllow` (3 s for HTTP-FLV pulled into the browser, 7 s for HLS) or, on a server's
recording, as near the time now as its lock (`SERVER_LIVE_LAG`, 11 s): F1 TV goes no further than
that, and back to it only when the commentary needs it (auto-hold holding, which content.js says
with the request, or a lead under 1 s by its edge now): F1 TV merely nearer live than the
commentary's aim stays where it is. While F1 TV's clock is re-proving (`clockLost`) Go live waits.
Without F1 TV's clock: `GOLIVE.F1` s behind the edge it will report just before its next step, or
back to its most live this session (a pause, a rewind), whichever is further.

### Messages

`chrome.runtime` messages, routed by `target`:

| from → to | message | notes |
|---|---|---|
| content → background → engine | `{target: 'engine', type: 'video', cid, channel, video: {p, paused, seeking, waiting, rate, ready, live, seekEnd, src, at, dx}, settings: {servers, volume, muted, anticipate, source, stream, bufferMin, liveDirect}}` | the player's state, at most every 200 ms; the background forwards it as `target: 'offscreen'` with `tab` added. A new `tab|cid|channel|servers|source|stream` key (`liveDirect` off counts as a different stream) (re)attaches the engine; each report of a live video (or one whose clock isn't decided yet) also keeps the recorder wanted |
| content → engine | `{type: 'nudge', delta}` · `{type: 'relive'}` · `{type: 'detach'}` | the delay buttons/keys; "Re-sync"; the video went away |
| content → background → engine | `{target: 'engine', type: 'golive', holding, chase, pMax}` → `{handled, by, more, limit, took, wait}` | Go live (⏭, `L`, F1 TV's LIVE badge): the engine answers how far to move F1 TV now (`by` s, `limit` `'f1'` or `'commentary'`: whichever is reached first) and how much further once F1 TV's reported edge has stepped on (`more`), and the content script seeks by that much (`fone-cmd` `seek`, answered by `fone-seek`), asking again every 0.5 s while there's `more` (`chase`, with `pMax`, the furthest F1 TV has been since: `took` when it's gone back from there; `wait` while F1 TV's clock is re-proving). `holding`: auto-hold's, the only time (with a lead under 1 s) Go live steps F1 TV back. `handled: false` (not live, not locked yet), or a seek F1 TV didn't take: the badge's own click goes through |
| background → engine | `{target: 'offscreen', type: 'detach', tab}` | the tab closed |
| engine → background → tab | `{target: 'background', type: 'status', tab, status}` → the tab receives `{type: 'fone-status', status}` | ≤ 4 times a second. `status`: `{state, text, channel, channels, server, source, direct, onAir, rec, clock, delay, delaySource, cid, title, session, anchor, playing, E, W, m, p, at, lead, leadAim, drift, file, ad, error, fixes, diag, livepos, dm}`; `state` is one of `loading`, `error`, `syncing`, `sync`, `waiting`, `before`, `gap`, `after`, `none`, `paused`, `buffering`; `dm = {w, at, rate, run}` is the danmaku clock; `source` is `'server'` or `'local'`; `direct` is true with a server, live from the stream recorded here; `onAir` is whether the streamer is on air as the commentary's source knows it (the stream recorded here: its platform says live and audio comes in, and a Bilibili room showing replays, 轮播, is off air; a server's recording: its timeline is live, i.e. its file is still growing, up to `FONE_GROWING_IDLE_SECONDS` after the streamer stopped; null when not known), which the 弹幕 panel's 直播中 follows; `ad` names the sponsor clip being muted; `p` and `at` are F1 TV's position and the engine's clock at that report; `f1Lat` (live, with F1 TV's clock) how far behind that clock its picture plays; `leadAim` is the lead Go live brings the commentary to (`liveAllow`, or the delay set's lag if nearer, less the slack), and auto-hold lets F1 TV go again at `min(4, leadAim − 0.5)`, at least 1.5; while the commentary plays from the stream recorded here (without a server, or `direct`), `rec` is the recorder's `{state, text, err, url, platform, label, name, title, kept, kbps, net, filled, end, edge, fmt, player}` (null otherwise, also while rewound into the server's recording with the stream still recorded for the way back) |
| engine → dashboards (broadcast) | `{target: 'dashboard', type: 'clock', tab, E, playing, rate, at, sessionKey, cid, server, live}` | 5 times a second; dashboards run their own clock and ease onto each report |
| engine → background | `{target: 'background', type: 'f1-token'}` → the token or `null` | answered only to `offscreen.html` (never to a content script or any page); the token goes to `livetiming.formula1.com` and nowhere else |
| dashboard, danmaku → background | `{target: 'dash-fetch', url}` → `{ok, json}` or `{ok: false, error}`; `{target: 'dash-fetch', ping: true}` → `{pong: true}` | GETs the iframe can't make itself (https page, http server); only `/api/timing/…`, `/api/f1tv/<id>` and `/api/danmaku` |
| danmaku → background | `{target: 'dm-image', url}` → `{ok, data: 'data:image/…'}` | Bilibili stickers and emoji as data URLs (F1 TV's CSP); only `*.hdslb.com` |
| layout → background | `{target: 'background', type: 'popout-dashboard'}` | the stats in a window of their own |

`window.postMessage` between `layout.js` (the F1 TV tab) and the dashboard iframe:

| | |
|---|---|
| layout → dashboard | `{type: 'fone-layout', rect: {x, y, w, h}, vw, vh, fullscreen}` on load and every change (CSS px, viewport-relative) |
| dashboard → layout | `{type: 'fone-layout-cmd', cmd: 'off' \| 'popout' \| 'fullscreen' \| 'rect'}`; `{cmd: 'player', box}`; `{cmd: 'onboards', slots: [{x, y, w, h, channelId}, …]}` (at most two onboard rectangles, re-sent every 2 s, `[]` = none) |

`BroadcastChannel`s between the offscreen document and the streamer window (both extension pages; structured clone, so the video goes as bytes):

| | |
|---|---|
| `fone-clock` | window → engine `{type: 'hello', fresh, avc, since}` every 2 s while open (`fresh`: it has no video yet; `avc`: it can't decode the stream's HEVC, so the recorder takes the platform's H.264 from a new connection: `preferAvc`); engine → window `{type: 'clock', at, state, text, channel, m, src, rate, playing}` with every tick, and `src: 'stream'` with `stream` (the recorded stream's URL) and `gen`, `src: 'server'` with `server`, `file` (the timeline file's id) and `media` (the position in that file); `m: null` when there's no commentary to show a picture for |
| `fone-video` | recorder → window `{type: 'cfg', url, gen, codec, desc, avc}` (the decoder configuration record; `avc`: the platform has H.264 too), `{type: 'chunks', url, gen, list: [{m, key, data, seq}]}` and `{type: 'novideo', url, gen}` (an HLS or audio-only stream); `gen` counts the recorder's fresh buffers (each a recording of its own, `m` from 0), `seq` numbers the chunks (a window asks again for what it missed with `since`): the stream's FLV video on the audio's `m` axis (`localcore.tOffset`: the same connection's timestamps; a reconnect's once its audio is placed), only while a window has asked in the last 10 s, the last 20 s again for a `fresh` one |
| `fone-fetch` | window → engine `{type: 'get', id, url, text}`, engine → window `{type: 'got', id, ok, status, body, error}`: GETs of the server's `/api/video/` only |

DOM `CustomEvent`s between the isolated and the main world (JSON string `detail`):

| | |
|---|---|
| `page.js` → `player.js` | `fone-tm`: the Tiledmedia sample (`eventType`, `currentPosition`, `contentDuration`, `seekLowerBound`, `seekUpperBound`, `bufferLowerBound`, `bufferUpperBound`, `isAtLiveEdge`, `isWallclockTimeSourceBased`), plus `r` (speed) and `a` (audio tracks) |
| `content.js`, `layout.js` → `page.js` | `fone-cmd`: `{cmd: 'rate', value}` (replays only), `{cmd: 'audio', prefer: 'fx' \| 'mute' \| 'eng' \| 'none', feed: 'intl' \| 'none', live, cid}` (`eng`: F1 TV's international English commentary; `feed: 'intl'`: live, F1 TV's INTERNATIONAL channel picked in its own channel switcher, `[data-tao="tm_channel_switcher_item"][data-channel-id="1025"]`, once per video), `{cmd: 'onboards', slots}`; each re-sent every 2 s and dropped by `page.js` after 10 s without it (extension reloaded or removed). `{cmd: 'seek', by}`, once: a relative seek of F1 TV's player (`TimingConfig` `RELATIVE_TIME`, `PRECISE`), answered with `fone-seek` `{ok, by, err}` |

Recording a stream itself, the engine talks to the streaming platform (`streams.js`,
`recorder.js`) and to F1 TV's content API instead. With a server, it talks to the server directly: `/api/health` to pick the first reachable
server, `/api/channels`, `/api/f1tv/{cid}`, `/api/sync/{cid}` (and `PUT` 800 ms after the last
nudge), `/api/timeline`, the playlist and segments, `POST /api/diag`, and, live,
`POST /api/timing/session/{key}/positions` from `livepos.js`.

### Settings

`chrome.storage.sync` (the options page and the panel): `source` (`'server'` or `'local'`; unset:
a server if one is listed, else local), `stream` (the live URL to record) for `'local'`,
`bufferMin` (minutes kept, 1-180) for `'local'` and live from the stream with a server, `servers` (tried in order), `channel` (`''` = the most
recently recorded) and `liveDirect` (live from the stream itself; default true) for `'server'`,
`volume`, `muted`, `autoHold`, `collapsed`, `speed`, `f1Audio` (`mute`, `fx`, `eng`, `off`), `f1Feed` (`intl`, `off`), `anticipate`, and `danmaku` (the 弹幕 settings object). `chrome.storage.local` (per machine): `layout`
(`'split'` | `'off'`), `onboards` (the two picked drivers), and the self-update's `updateSeen`,
`lastReload`, `refreshF1tv`.

Self-update: a published build (`tools/publish_ext.sh`) carries `build.js` (read once at load),
`build.json`, which installed copies poll from the update channel (`fone-ext`, port 8789) and
reload into once it has been up for 75 s and no tab is playing, and `local.js` with that
install's default servers (`self.FONE_LOCAL.servers`; the repository's copy is an empty
placeholder, so a copy loaded straight from the repository asks for the server in its options
page and never updates itself).
