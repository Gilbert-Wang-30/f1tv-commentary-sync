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
video, backfill, danmaku, vodclock) is a class with `start()`/`stop()` plus a `make_router(svc)`, switched
off with `FONE_<NAME>=0`, and one that fails to build or start is left out rather than taking
the commentary sync down (`/api/health` lists the running ones).

Configuration is environment variables only (`server/fone/config.py`; the README's
Configuration table lists them). An empty one is its default (`docker-compose.yml` passes the
optional ones through from `.env`, empty where `.env` leaves them so). Nothing names a streamer
by default: with no `FONE_ROOMS` no Bilibili room is watched, and `config.notes()` (logged as
the configuration loads) says what that, or a missing recordings or import folder, leaves out.
`FONE_ROOMS` entries are `room=channel` or a room number alone (its channel is the number);
anything else is skipped with a warning (`config.room_entries`, which backfill reads too, and
`recorder/seed.sh` the same way). `/api/health` carries `version` (`FONE_VERSION`, stamped into
a release's image; `dev` otherwise).

The compose file reads everything that's one setup's from `.env` (`.env.example`):
`FONE_RECORDINGS` is mounted at `/rec` (read-only) with `fone-import/` in it writable for
backfill, and fone's recorders (profiles `recorder` and `streamlink`) write into its `fone/`;
`FONE_FILENAME_TZ` is the server's zone for file names and the recorders' `TZ`.
`recorder/seed.sh` writes fone-recorder's 录播姬 `config.json` on its first start from the
template `recorder/config.json`, with `FONE_ROOMS`'s rooms and that zone, and again only when
the file has no room (no `RoomId`) and `FONE_ROOMS` names one (the old file kept as
`config.json.bak`); with no file and no room it exits 1 with what to set, so the recorder
restarts saying so instead of recording nothing. The gate (`recorder/gate.py`) only logs the
streams it would stop until `GATE_ACTION=stop`. `fone-janitor` comes with either recorder
profile (`recorder`, `streamlink`) and deletes files under `<FONE_RECORDINGS>/fone/` and
`fone-import/` `FONE_KEEP_DAYS` (21) after their last write. The server image is
`ghcr.io/gilbert-wang-30/fone:<version>` from 1.0.1 on (`.github/workflows/release.yml`,
`docs/releasing.md`); `build: ./server` builds it locally under a name of your own.

### Recordings and the data directory

`FONE_REC_DIR` (`/rec`) is scanned recursively every `FONE_SCAN_INTERVAL` s. A recording's
**channel is its parent folder** (fone-recorder's `{{ roomId }}/` template, which `FONE_ROOMS`
names; BililiveRecorder's `{{ name }}/` or a streamlink channel's; `FONE_CHANNEL_ALIASES`
renames folders, and wins over `FONE_ROOMS`), its start time is parsed from the file name
(`yyyyMMdd-HHmmss-fff-title.flv` and the coarser variants in `recordings.py`) in
`FONE_FILENAME_TZ`, and its `source` is `recorder`, or `import` for files under
`FONE_IMPORT_DIR` (backfill's replays, which only ever fill gaps). A finished file whose name and
last write disagree by whole quarter-hours, an hour or more, is placed by its name and logged as
a likely `FONE_FILENAME_TZ` mismatch (`extractor.zone_offset`), when the zone that would make
them agree exists (UTC−12 to UTC+14: a file touched days later isn't). A file still being
written (mtime younger than `FONE_GROWING_IDLE_SECONDS`) is tailed into ffmpeg so its audio is
playable seconds after it was recorded.

`FONE_DATA_DIR` (`/data`, the `fone-data` volume) holds everything computed:

```
fone.sqlite3                 F1 TV content cache, delays (content_delay, channel_delay), backfill's tables
hls/<fid>/                   one directory per recording (fid = sha1 of its path, 16 hex chars)
  index.m3u8, seg_NNNNN.ts     audio-only HLS, copied, not re-encoded (FONE_SEGMENT_SECONDS each)
  run.json                     how the audio was mapped to the wall clock (live lag / end lag)
  ads.json                     sponsor clips found (ads service)
  screenclock.json             the measured screen delay (screenclock service)
timing/<session_key>/        live-timing streams, archive and own capture in the same format
  <Topic>.jsonStream, meta.json  meta.source: live | relay | archive | openf1
timing/schedule.json         the OpenF1 calendar; timing/tracks/<meeting>.json (+ .corners.json)
video/<fid>.json             FLV keyframe index (video handoff)
vodclock/<bvid>.<key>.json   what a Bilibili replay's frames showed (vodclock)
danmaku/                     capture/<room>-<yyyymmdd>.jsonl and danmaku.sqlite3
diag/<day>.jsonl             playback diagnostics, 7 days, at most 64 MB a day
backfill/                    downloads in progress
```

### Routes

**Everything but a few reads is the extension's and scripts' alone** (`RefuseWebPages`): writes,
and the GETs that start work or hand out what viewers did (`/api/f1tv`, `/api/sync`,
`/api/timeline`, `/api/timing/session/*`, `/api/timing/content/*`, `/api/vod`, `/api/video`,
`/api/diag`, anything not listed as open). Those need an `Origin` of `chrome-extension://` or
`moz-extension://`, or no `Origin` and the header `X-Fone: 1` (the extension sends it on all its
requests; curl and scripts add it: `curl -H 'X-Fone: 1' …`, as `tools/diag.py` does), else 403.
A web page can send neither: its fetch() carries its own Origin, its `<img>`, `<script>`, links
and forms can't carry a header, and a fetch() adding one needs a CORS preflight, which is refused.
CORS allows the extension's origins only (with private-network access), so no page reads the
server's answers either. Open to anyone: `/`, `/api/health`, `/api/channels`, the playlist and
audio segments, `/api/danmaku` and the services' status and per-file results (`/api/timing/status`,
`/api/danmaku/status`, `/api/backfill/status`, `/api/ads/{fid}`, `/api/screenclock/{fid}`).

**Core**

| | |
|---|---|
| `GET /` | status page (HTML): every recording, its extraction status and analysis notes |
| `GET /api/health` | `{ok, version, recDir, files, now, services: [...], notes: [...]}`; `version`: `FONE_VERSION`, else `dev`; `notes`: what the setup leaves out (no `FONE_ROOMS`, no ffmpeg/tesseract for the replays' clock), for the options page's Test connection |

| `GET /api/channels` | `[{name, files, latest, live}]`, newest first; `live` = a file is still growing |
| `GET /api/f1tv/{cid}[?refresh=1]` | an F1 TV video (`f1.py`): `{contentId, title, subtype: "LIVE"\|"REPLAY"\|…, duration, meetingKey, sessionKey, meetingName, sessionName, kind: "practice"\|"sprint_qualifying"\|"qualifying"\|"sprint"\|"race"\|null, scheduledStart, scheduledEnd, isSessionFeed, anchor: "multiviewer"\|"preroll"\|null, p0, startedUtc, sessionStartVideo, channelOffsets: {channelId: seconds}, streams: [{channelId, type: "obc"\|"additional", title, number, name, team, color}]}` or `{…, error}`. Cached in SQLite; an anchored replay never changes, everything else is re-checked after 10 min, and a re-check that can't make the exact anchor again (the archive refusing) keeps the cached one |
| `GET /api/sync/{cid}?channel=&clock=` | the delay to start from: `{delay, source: "content"\|"measured"\|"channel"\|"default"}`; `measured` adds `{screen, reaction, confidence, file}` |
| `PUT /api/sync/{cid}` `{channel, clock, delay}` | save a tweak for that video (and clock); `delay` a finite number within ±86400 s (422 otherwise) |
| `GET /api/timeline?channel=&from=&to=` | the commentary between two wall times, below |
| `GET /api/playlist.m3u8?files=a,b,…` | the files stitched into one HLS EVENT playlist (`#EXT-X-DISCONTINUITY` between files, `#EXT-X-ENDLIST` once all are finished) |
| `GET /hls/{fid}/seg_NNNNN.ts` | an audio segment |
| `POST /api/diag` `{client, build, platform, events: [{t, type, …}]}` · `GET /api/diag?client=&type=&since=&limit=` | playback diagnostics from the extension's engine; `tools/diag.py` reads them as a timeline. `t` is kept a finite number or null, `type` at most 40 characters; an event with a non-finite number is cut down like an oversized one; a day's file stops at 64 MB (later events stay in memory) |

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
| `GET /api/vod/clock?bvid=&key=[&slot=][&E=]` | where the streamer's Bilibili replay `bvid` runs on the event clock of session `key`, read off their screen: `{status: "working"\|"ok"\|"none"\|"error", readings: [{page, at, wall, text}], more, why}` (`wall`: the event time their screen showed `at` s into page `page`); `E` asks for a reading near that event time. `none`: no timing for the session, no clock in it, frames that don't agree, or no ffmpeg/tesseract on the server; `error`: asked again later (vodclock below) |

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
403 until then). Since 2026-10-18 the archive answers 401 to everyone, so a session the server
didn't capture live (`FONE_TIMING_RECORD`) is rebuilt from OpenF1's historical API instead
(`timing_openf1.py`, meta `source: "openf1"`; `FONE_TIMING_OPENF1=0` turns it off): asked for by
the dashboard (any past session, any year: `/v1/sessions?session_key=` for one outside the
cached calendar) or by the plan for one that just ended uncaptured, once it has been over for
30 min; never over a capture or the archive (a complete archive, should F1 serve it again,
still replaces a rebuild). OpenF1's tables (drivers, laps, intervals, position, stints, pit,
race_control, weather, session_result, and each car's location within the session's window:
~35 requests, one at a time 0.5 s apart, backing off on 429/5xx; a race ~100 MB down, ~12 MB
stored, ~70 s) are turned into the topics the state reads, each message at the moment the live
feed would have shown it (a lap's time when the lap ends, a stint's tyre at the pit exit, the
deleted laps after race control's message, Retired once the car has stopped), so the state at
`t` never shows the future. Checked against the server's real archives of the 2026 Singapore
practice, qualifying and race at 20 s steps: positions 100 %, qualifying and practice bests,
gaps and last laps 100 %; what differs are the feed's own lags (the compound UNKNOWN for a few
seconds after a pit exit, tyre ages batched a little late). A finished capture with no car
positions (nobody relayed them from F1 TV) gets OpenF1's when the map asks. Car positions
relayed for a session the server isn't capturing (`FONE_TIMING_RECORD=0`, or the capture
failed) are stored as meta `source: "relay"`: no timing of its own, so it never stands in the
way of the archive or an OpenF1 rebuild (either replaces it, its writer closed first), the
vodclock treats it as no timing, `state()` asks for a fetch once the session is over, and a
capture's first message turns it into `live` on the relay's `t0`. Pruning (hourly,
`maybe_prune`): sessions stored more than `FONE_TIMING_KEEP_DAYS` (30) days ago are deleted and
fetched again on demand, OpenF1's rebuilds always, captures and archives only while F1's archive
answers (it asks the year index first: while it refuses, a capture is the only copy left). All
are stored in the archive's format, one `<Topic>.jsonStream` per topic
(`HH:MM:SS.mmm<json>` lines, offsets from the session's `t0`), so one loader serves them all.
Each row also carries `grid` (its `GridPos`, races) and `stints` (the car's tyre sets, oldest
first: `{compound, laps, new}`; a pass through the pit lane on the same tyres folded into the
set it continues), for the tower's places gained and tyre history.
Anonymous access has everything except car positions; those come from the viewer's own F1 TV
login through `POST /positions` (the server never sees the token). `docs/f1-data-sources.md`
has the endpoints and formats.

**ads**: sponsor-reel detection per recording, on the channels the clips were made for,
against the reference clips in `server/fone/ads/` (`refs.npz`: fingerprints of the clips, built by `fone/ads/build_refs.py` from 8 kHz mono WAVs, plus `ads.json`, the manifest). The clips are one streamer's, so only
their channel's recordings are matched: the bundled set's on its own channel
(`ads.BUNDLED_CHANNELS`, 胡闹P房), a set in `FONE_ADS_REFS` on every channel, or on those
`FONE_ADS_CHANNELS` names (`*`: all). Another channel's files aren't decoded and have no ad state
(`adsAnalyzedTo` null, no mutes). Growing files are analysed segment by
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

**vodclock**: where a streamer's Bilibili replay (直播回放) runs on the event clock, read off
their screen. A 直播回放 says nothing exact about when it was recorded: Bilibili gives the Beijing
hour the live began (its title's `21点场`) and when it was published, the media no timestamp, and
danmakus.com merges a restarted live into the one before (胡闹P房's 2026 Italian GP qualifying:
"started 20:10", which was the F2 sprint's stream). Every replay of theirs shows MultiViewer's
header, though: the session and its clock (`Italian GP: Qualifying 2` over `13:04`; a race's
`1:58:31 Lap: 2/53`). The session's timing says when its clock showed that (the stored
`ExtrapolatedClock`, real or OpenF1's rebuild; a race's, where neither has one, from its
`SessionStatus`: 2 h from the start, stopped while red-flagged), so a frame gives the event time
on the streamer's screen there. Frames come from the replay's 1080p video, one fragment each by
its sidx; the header is found by OCR of the whole frame (the `GP:` line, the clock-like word under
the event's name, a race's `N/M` after `Lap:`), its clock read again closely at three sizes (the
most of them wins), the lap only when two agree (it only rules readings out). Frames go first
where the clock runs whenever in the slot's hour the live began, three at a time, until two
near each other (25 min of content) agree on where the replay's content starts (±2 s); only near:
the streamer's own delay moves now and then (Q1 of that qualifying drifted up to 36 s against
Q2: their F1 TV buffering, a pause), so frames an hour apart may both be right and still
disagree. Then, asked with `E` (the moment the extension plays) and no reading within 4 min of
it, three frames there (once per moment; none where the clock doesn't run: before the session, a
break). What each frame showed is kept per replay and session in `<data>/vodclock/` (with the
OCR's version and the timing it was worked out from, `[source, t0]`); the event times are worked
out afresh from the session's timing as it is, so a capture since replaced by the archive, say,
is placed again from the frames already read, with no new download. The wait for the timing (up
to 7 min: an OpenF1 rebuild) holds no frame slot (two replays read at once). `none` is for no
timing at all, no clock in it or frames that don't agree (asked again after 6 h); timing that may
still come (a rebuild queued, the archive yet to publish) and failed downloads are `error`, asked
again after 60 s, doubling up to 6 h. A frame that can't be decoded or read is left unread alone;
a fragment is streamed, at most the bytes asked for, within 120 s, and a mirror answering without
`206` is refused. No ffmpeg or tesseract on the server: `none`, saying which. The latest 500
replays are kept in memory, the rest read back from disk. The 2026 Italian GP
race: a place 1.7 s from where its sound had put it, read in 11-80 s (Bilibili's mirrors);
qualifying in 10 s, a moment's own reading in 4 s.

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
didn't hear (no levels, colours or stickers there). Served by send time. The capture file's
`open` and `beat` lines say when it was listening (the spans the archive's items are checked
against): a `beat` is written when Bilibili answers a heartbeat (op 3), not when one is sent,
and 70 s with nothing received ends the connection (a half-open one still takes heartbeats) so
the capture loop reconnects. An archive import runs in a thread, its items checked against the
spans by bisection.

## Extension

### Parts

| where | files | role |
|---|---|---|
| content scripts on `https://f1tv.formula1.com/*`, isolated world | `settings.js`, `core.js`, `player.js`, `dmcore.js`, `danmaku.js`, `content.js`, `layout.js`, `streamerbox.js` | `player.js` finds the main `<video>` and its true position; `content.js` draws the panel, binds the keys and reports the player to the engine; `settings.js` F1 TV's settings and their migration from older builds (shared with the options page); `layout.js` the split view with the stats iframe; `danmaku.js` the 弹幕 overlay; `streamerbox.js` the streamer window (a box with `streamer.html` in an iframe, moved by its bar, sized by its corner, `chrome.storage.local` `streamerBox`/`streamerOn`) |
| streamer window | `streamer.html`: `vendor/hls.light.min.js`, `streamer.js` (in the box's iframe, or a popup window of its own) | the streamer's picture at the commentary's moment, muted. Follows the engine's clock (`fone-clock`): the stream recorded here, from the recorder's video (`fone-video`) decoded with WebCodecs (H.264, HEVC where the browser decodes it) and drawn on a canvas at `m`, the last 3 min kept for rewinds; a server's recording, its video handoff with hls.js at the file's position (`media − mOffset`), its requests made by the engine (`fone-fetch`: an iframe in F1 TV's https page can't reach an http server) |
| content scripts, **main** world | `page.js`, `layout_page.js`; `audiotap.js` at `document_start` | the only place the Tiledmedia player's objects are reachable: position, speed, audio tracks, F1 TV's mute button, onboard views; fullscreen redirection for the split view; F1 TV's sound through fone's gain, copied for sync by sound |
| service worker | `background.js` (+ `dashproxy.js`, `f1token.js`, `streams.js`) | relays messages between tabs and the engine, opens the offscreen document, fetches for pages that can't (mixed content, CSP), hands the F1 TV token to the engine, sets the streaming platforms' header rules, self-update |
| offscreen document | `offscreen.html`: `vendor/hls.light.min.js`, `core.js`, `demux.js`, `localcore.js`, `streams.js`, `recorder.js`, `localplayer.js`, `livepos.js`, `sound.js`, `teamradio.js`, `vod.js`, `offscreen.js` | **the audio engine**: picks the source (a server, the stream recorded here, or the streamer's Bilibili replay), clock and delay, plays `m` (a server's recordings with hls.js, its own recording through MSE) and keeps it on target (at 1× by tiny rate changes, otherwise by rare seeks); relays live car positions |
| extension pages | `dashboard.html` (`dashcore.js`, `dashboard.js`, `dashboard.css`), `options.html` (`settings.js`, `options.js`) | the stats (as an iframe behind the shrunken player, or a window of its own); the settings |

`core.js`, `dashcore.js`, `dmcore.js`, `demux.js`, `localcore.js`, `settings.js`, `sound.js`,
`teamradio.js` and `vod.js`'s parsing are pure functions shared with the Node unit tests.

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
commentary's aim stays where it is. (The stream recorded here: its aim is behind its live edge,
as its lock's is, not behind what can be played yet, which trails it by a segment on HLS.) While
F1 TV's clock is re-proving (`clockLost`) Go live waits.
Without F1 TV's clock: `GOLIVE.F1` s behind the edge it will report just before its next step, or
back to its most live this session (a pause, a rewind), whichever is further.

### Sync by sound

The streamer passes F1 TV's own sound through (its track sound, or the international feed)
under their voice, so where that sound sits in their stream says which moment of the stream goes
with which picture: the delay, measured, and followed as it moves (the streamer's player stalls,
their latency grows: 4.4 s over the 2026-11-01 race, tuned by ear).

- **Hearing F1 TV** (`audiotap.js`, MAIN world, `document_start`): F1 TV's player plays through
  Web Audio (an AudioWorklet its WASM core feeds). `AudioNode.prototype.connect` is patched so
  whatever connects to the speakers goes through fone's gain instead (sound sent into a
  MediaStream instead, for an `<audio>` element to play, is copied as well, fone's gain not on
  it; and what connected to what is counted by kind, `seen()`, which the audio report and the
  diagnostics carry: on 2026-11-11 the user's F1 TV routed nothing through the speakers' path:
  its player now plays its sound from a `<video>` whose `srcObject` is a MediaStream, with no Web
  Audio graph in the page's sight; so every second the audio tracks of any playing element's
  stream are copied too, in an AudioContext of fone's own, left playing where they are; elements
  never put in the page, an `Audio()`, are found as they start playing or get a stream, by
  wrapping `HTMLMediaElement.prototype.play` and the `srcObject` setter; that video's own audio
  track, a `MediaSourceHandle`'s, measured silent: a placeholder; 0.3.14's diagnostics then showed
  F1 TV's sound played by a second `<video>`, never in the page, fed by a MediaSource in a worker:
  a playing element that isn't playing a MediaStream is captured, `captureStream()`, a copy that
  leaves it playing; Chrome's capture is taken before the element's volume, so fone can turn
  F1 TV's own sound down and still hear it: ducking, below),
  with a ScriptProcessor
  copy, box-resampled to 8 kHz mono, each chunk stamped with the wall time it's heard. Chrome
  takes `playbackTime` at the event's dispatch, late by render bursts and main-thread work and
  now and then a render quantum early (measured against a step at a known context time: the
  input's first sample two buffers before it at the earliest dispatches, two and a render quantum
  at the median, up to 2500 frames more with 60 ms tasks on the page): so buffers are counted in
  samples from an anchor, a low tenth of where the last 64 buffers put buffer 0 (exactly two
  buffers at every load measured; the minimum dips a quantum early under load), anchored again
  when two in a row come half a buffer late by the same amount (buffers were lost; a backlog
  after a busy spell comes late by a buffer less each time and stays out of the low tenth). In
  the e2e page its stamps land within a few ms of the sound actually played. The context's
  `getOutputTimestamp` maps render time to the performance clock, and `Date.now() -
  performance.now()` at that moment to the wall clock the video reports use (the two clocks
  drift apart, and the performance clock stops while the computer sleeps). fone never mutes F1
  TV itself: its sound plays under the commentary. F1 TV's own mute button is how it's silenced
  (page.js, "F1 TV's mute button"): a press is seen by wrapping the player's `setAudioIsMuted` (a
  call made inside a trusted click or key event, or an unmute inside any trusted event, as F1
  TV's volume slider makes from the document's `mousemove` while it's dragged; F1 TV's own calls,
  on a load, aren't), and with the tap carrying F1 TV's sound it's carried out by fone's gain at
  0, the call not passed on, so the player keeps playing and the copy isn't silence. F1 TV's
  button flips its own look on a click and asks to unmute next time, but its UI (`ui` on
  `tiledmedia-ui-view`) goes back to the player's mute whenever its view is added to a player
  (`Player.addView` → the view's `viewAddedCallback` → `initialize` → `getAudioIsMuted` →
  `muteStateChanged`: a page or content load, a rebuild) and with the player's mute listener;
  while the mute is held, page.js tells it muted again (`ui.muteStateChanged(true)`, on its 250 ms
  poll, no SDK call), else its next press would mute rather than unmute. The mute is held
  through content loads, channel switches and player rebuilds, and in the page's localStorage
  (`fone.f1Muted`, which `audiotap.js` reads to start at gain 0) through page loads, until F1 TV's
  unmute is pressed. Live with sync by sound, the player is asked once per video
  (`getAudioIsMuted`): a mute of F1 TV's own (a first playback can start muted), no press held,
  is held the same way for that player only (the gain to 0, not stored, let go when the player
  changes: as audible as F1 TV makes a new one), and a mute behind the gain (a press's, or that
  one a poll later, the gain down by then) is undone so the copy isn't silence; a mute is never
  undone where it would be heard. Without the tap (F1 TV's sound not through Web Audio) F1 TV's
  button works as it always has, fone out of it. page.js hands the copy over every second
  (`fone-f1audio`, Int16 base64) while content.js asks (`tap`: live, `soundSync` on), content.js
  passes it to the engine (`f1audio`).
- **Ducking** (setting `soundDuck`, on; the panel's *Own sound: auto off / on*, and the
  settings page): while sync by sound is locked (or a Bilibili replay plays), the streamer's stream
  carries F1 TV's sound in step with the commentary, so F1 TV's own copy would only double it
  (two copies a few ms apart sound like a flanger). content.js asks page.js (`duck` in the
  'audio' command; off again 10 s after the lock is lost) and audiotap.js turns the captured
  elements' volume to 0, F1 TV's own volume put back after. If the level fone copies falls away
  within 3 s of that, the copy goes with the volume: undone, and not tried again on that page.
- **Where it was** (`offscreen.js` `sndHeard`, `vAt`): each chunk's wall time is put on F1 TV's
  position by the video reports kept for 90 s (`S.vhist`: both reports either side playing at 1×,
  nothing between them but time), chunks that follow on joined into runs (75 s kept), a run's
  place the running average of where its pieces put it. F1 TV trims its player's speed by a few %
  for seconds at a time to keep its sound and picture together: each piece is put back on the
  picture's own time (resampled to the stretch of picture it went with, `vAt` interpolating
  between reports at the pace the picture really went), so a run's samples are picture time. A piece that jumps by 20 ms to 1 s (F1
  TV's sound skipping or repeating a little) is spliced in where it belongs (silence for what was
  skipped, what came again cut) rather than starting a new run: a look needs 15 s in one run.
- **The match** (`sound.js` `locate`, every `SND.EVERY` s): the newest `SND.WIN` s of F1 TV's
  sound is looked for in the stream's, decoded from what this browser records (the buffer's AAC
  frames as an ADTS file through `OfflineAudioContext.decodeAudioData` at 8 kHz), around where
  the sound was last (or the lock has it): ±25 s until it's found, every 5 min, after two looks
  that missed, and after a sure match more than 1 s from where it was (till that's confirmed);
  ±4 s otherwise. The stretch looked for is the newest; after a look that missed, every other
  look an older one of the run (not a silent one), so the look reaches past where it was within
  what's recorded (the streamer's latency grown past the commentary's lead).
  Nothing new heard since the last look: no look (old sound would only confirm old news). GCC-PHAT (both
  spectra whitened, 150–3600 Hz) gives one sharp peak where a quiet copy lines up; its height in
  standard deviations is how sure (`score`: ~4-5 with no copy, 10-30 for one 10-20 dB under the
  voice in the unit tests). A match counts at score ≥ 8, 1.6× the runner-up, not at the window's
  edge, and is taken when two of the last four agree within 80 ms. A sure match more than 1 s
  from where it was brings the next look forward to `SND.SOON` (5) s instead of 15, so a stream
  that skipped or repeated a few seconds is followed within ~20 s (2026-11-16: a repeated
  segment of a Bilibili replay, followed only ~50 s later). **⟳ resync sound** (the Sync row,
  `R`: `{type: 'resync'}`) looks again at once, widely, every `SND.QUICK` (3) s for up to
  `SND.RESYNC_MAX` (90) s, and takes the first sure match (jumped to unless it's within 50 ms);
  by hand too (found once, then the delay it set is the user's to nudge). A Bilibili replay not
  placed yet is looked for again. The panel says resyncing / resynced (`sound.resync`).
- **Getting there unheard** (`sndSteer`): the lock's offset is brought to the match plus your
  bias by a speed eased off 1× and back: `v` heads for `sign(err)·min(2 %, √(2·0.001·|err|))`,
  changing by at most 0.1 % a second (so it stops right there: 0.6 s took 78 s in the e2e). The
  lock moves `v·dt` a tick and `drive` hands the steering the slew apart from the rate
  (`FoneCore.steer`'s `slew`): it predicts the target at `rate·(1 + v)`, keeps its 1× bounds and
  goes on correcting at 1× around it (a nudge or a seek that landed a little off isn't left
  waiting for the easing to end); the audio plays at `(1 + v)·(1 + k)` through the resampler
  (nominal 1, no `preservesPitch` flip, no click; the pitch moves a third of a semitone at most).
  A seek (a re-sync, a nudge, a jump: `drive` sees it) or a new lock takes `v` to 0 under cover
  of it; a correction cut short otherwise (lost, reset) is let down at the same 0.1 % a second.
  Only the steering's own corrections count as rate tweaks, not the easing's speed. Jumped
  instead: the first match (since the start, or since it was lost) more than 1.5 s off (the
  delay it started from was a guess), and a step of more than 3 s (easing that is minutes out
  of sync). Each match sets the delay to the one that places it (`delaySource 'sound'`), kept for
  the stream (what the next session starts from); a nudge then is a bias on top
  (`soundBias|<stream>`), except what of it goes the way a correction of more than 50 ms still
  easing in was going (you heard what it's fixing). No sure match for 10 min of playing: `lost`
  (no target: no easing, nudges plain, the delay holds) and it looks widely again; nothing heard
  for 30 s of playing: `deaf`. The status says what each look came to (`why`), and how often the
  run of F1 TV's sound broke (`breaks`, `gap`). Re-bases of
  F1 TV's position, a new recording here or a switch of source start it over.
- **A server's recording, on a replay**: its sound is read from the HLS segments hls.js plays
  (`serverSound`: fetched, the last 24 kept, the AAC frames out of the MPEG-TS by
  `FoneDemux.tsAudio`, each segment's frames at that segment's start on hls.js's media time, a
  hole before it filled with silent frames, an overlap skipped), decoded the same way. On a
  replay's clock a match is kept as the delay that maps the look's own picture (`pa`) onto the
  moment found (`C.wallOf` of it minus the picture's event time), so it holds across seeks and the
  server's file boundaries, which the wall-clock mapping already handles; the look's window is
  centred by the delay's mapping at that picture (`mAtDelay`). Easing moves the delay, a jump
  changes it at once, and it's saved for the video on the server (`saveServerDelay`, as a nudge
  is, every 2 min at most). A replay is measured at 1× only (the reports' positions, `vAt`, and
  F1 TV's sound are only taken at 1×; time at other speeds counts toward neither `deaf` nor
  `lost`). page.js hands F1 TV's sound over live, and on a replay only with a fone server.
  Live from a server's recording (not straight from the stream) isn't measured yet: its lock is
  re-placed by wall time across the server's files, which an offset on the lock doesn't follow.
  A clock change (a live item becoming a replay) starts sync by sound over.

### The streamer's Bilibili replays: replays no recording covers

A fone server keeps its recordings for weeks (the janitor's 21 days, in the author's setup); the
streamer's Bilibili replays (直播回放) stay on their space for years. A replay whose session no
piece of the server's timeline covers (`vodWanted`: a replay clock, the content anchored, the
channel's Bilibili room known from `/api/danmaku/status`) plays the room's own replay of it,
streamed from Bilibili (`vod.js`, pure parts in `vod.test.js`; the engine's "Bilibili replays"
section):

- **Which.** The room's streamer (`room/v1/Room/get_info`), their '直播回放' series
  (`x/polymer/web-space/seasons_series_list`), its archives (`x/series/archives`, 100 a page,
  kept in the offscreen document's localStorage and read again from the newest when stale). A
  replay's title is `【直播回放】<room title> YYYY年MM月DD日HH点场`: the Beijing hour the streamer
  went live in, so its content starts somewhere in that hour. The candidates are the replays whose
  `[slot, slot + 1 h + duration]` meets the session's events plus −2…+10 min of delay.
- **Its sound.** `x/player/pagelist` and `x/player/playurl` (`fnval=16`, `try_look=1`, no login)
  give each page's DASH audio (AAC-LC ~72 kbps, id 30232): one fMP4 per page with a sidx of ~5 s
  segments, its URLs signed for this IP for ~2 h (`deadline`) and served the same by every
  `upos-sz-mirror*` host, at very different speeds (0.2-1.2 MB/s a connection here, ~4 MB/s
  with six at once). `FoneVod.range` fetches byte ranges, moving to the next mirror on a failure;
  `urlOf` asks again 10 min before the deadline. The `bilibili.com`/`bilivideo.com` session rule
  adds the Referer the CDN wants (and the Akamai mirror's host is in it). hls.js plays a playlist
  built from the sidx (`FoneVod.playlist`: each page's init segment by `EXT-X-MAP`, its segments by
  `EXT-X-BYTERANGE`, a discontinuity between pages) from a blob URL, its placeholder URLs
  (`https://vod.fone.invalid/<bvid>/<page>`) opened on the page's URL now by `xhrSetup`.
- **The repeats.** Bilibili builds a replay from ~30-min fragments, each starting with the last
  ~4.2 s of the one before (a page boundary too); the repeat is the same AAC packets byte for byte
  after a few (`server/fone/backfill_dedup.py`). `FoneVod.findCuts` looks ±20 s around where each
  join is due (every 1804.2 s after the last, from each page's start, and across each page
  boundary), hashes the packets and takes the lag most packets-with-sound that occur exactly twice
  share (`findRepeat`); the cut is that many packets after the earlier copy's last match (the
  backfill's bit-exact splice). One not heard (both copies the same silence) is assumed where it
  was due. On the 2025 British GP replay (2 pages, 4 h 15 min) it found the backfill's 8 joins to
  1-2 packets, reading 3 MB. The cuts are kept per replay. `FoneVod.timeline` puts the replay on
  the wall clock from its first sample's time `T0`, the cuts as gaps in `m` (pieces, files: what a
  server's `/api/timeline` gives), so the replay's own `m` plays and the repeats are skipped by
  the usual wall-time mapping. Bilibili's recording also has a whole ~5 s segment twice now and
  then, anywhere (the 2026 Japanese GP race's replay, page 1 at 1:25:42: the same 235 packets
  again, 5.013 s; the commentary was heard twice and then ran 5 s late until sync by sound moved
  it, ~50 s on): `vodScan` reads the replay `VOD.SCAN` (60) s at a time ahead of the moment
  playing (`VOD.AHEAD`, 75 s; windows overlapping by 15 s; from where it plays after a seek) and
  `FoneVod.scanRepeat` looks for any repeat of 40-640 packets there that isn't a known cut; one
  found is added (`ahead: true`, kept with the joins': `vodCuts|<bvid>`, `joins: false` until the
  joins' search is done) and the replay put on its timeline again with the moment playing where it
  was, before the repeat is heard.
- **Where this moment is, by the clock on the streamer's screen.** With a fone server (its
  vodclock above) the replay is placed by its readings, as soon as the first come (`vodClockStep`
  asks each tick, every 3 s while the server reads, with the event time playing; again with a new
  one after a seek, every 20 s at most, for a reading near it): the reading nearest the moment
  playing (`vodClockAt`) gives `T0 = wall + 50 − content(m) − 1.5` (`VOD.SCREEN`: their screen's
  clock runs ~1.5 s ahead of the sound they pass on; 1.2 and 1.7 s on the 2026 Italian GP race),
  the delay at 50 s, and sync by sound then finds the last second near there itself (no looks
  over the hour). A reading within 4 min of the moment rules: a place off it by more than 15 s
  (`VOD.TRUST`; sync by sound's own window is ±25 s) is moved there, whatever put it there (a
  sound match, the place kept from last time); a further one only bounds: off by more than 2 min
  (`VOD.BOUND`), moved. Sound's own placements must agree with it the same way, and while the
  server still reads (up to 5 min) sound places only when sure at once: on 2026-11-17 a lap
  replayed after qualifying matched F1 TV's sound at 13.9 (1.8× anything else) 28 min from
  where the clock put that moment. Without a server, or a clock on the streamer's screen, by
  sound alone as follows.
- **Where this moment is.** Found by sound: the newest 25 s of F1 TV's sound heard (sync by
  sound's runs, on the picture's time) looked for by `FoneSound.locate` at 4 kHz in 227 s
  stretches of every candidate (`FoneVod.searchPlan`: over the hour the replay may start in plus
  −2…+3 min of delay, nearest a guess of half an hour in and 50 s of delay first; three fetched at once,
  kept as 16-bit while it looks, the matching a stretch at a time so the rest of fone runs
  between; after five misses, all of each replay, then every eighth look: its stretches past the
  hour's aren't kept, so the hour's stay). Taken when sure (score ≥ 9.5 and 1.5× anything else
  anywhere; ≥ 14 and twice: at once): real sync-by-sound matches scored a median of 14
  (2026-11-11). A look that isn't sure keeps its likeliest places (`FoneVod.keepLikely`: its top
  three ≥ 7, the eight strongest kept), and each is checked (`FoneVod.checkLikely`) against F1
  TV's sound heard after it, at least 12 s of it past the sound that found it (that sound would
  find the same place again, right or not), looked for ±3 s around where the place says it now
  is: found there again (within 0.3 s, ≥ 6.5) is where this moment is; checked ten times without,
  let go. Checks run with every 8 s more of F1 TV's sound, between looks too. (The 2026 Italian
  GP, F1 TV's Track FX against 胡闹P房's replay: the formation lap's look found the place at 11.8
  but not sure, a broadcast replay of the start or the like scoring 10 elsewhere; the next minute
  under 7, then 10.9, 13.6, 23.6 at the same place; 6½ min to a place when only two looks in a
  row agreeing counted, and each look after the fifth fetched all 6 h of the replay again.) The
  replay is then placed so that the delay reads 50 s (`VOD.D0`, plus the
  stream's nudge bias), `T0 = E + 50 − content(m)`, and sync by sound runs on it as on any replay,
  reading its sound from Bilibili (`vodRead`: segments by one range request, `FoneDemux.mp4Audio`
  to ADTS, decoded at 8 kHz). Where it was put (`T0`, delay) is kept per video and replay
  (`vodPlace|<cid>|<bvid>`): the next time it starts there at once. Sync by sound not confirming a
  place in 8 looks of its own (2 min) while hearing F1 TV: looked for again, playing on (then
  every 10 min). Off the end (or start) of the replay playing: the streamer's next (previous)
  one, kept or looked for. Placed by sound, the replay carries F1 TV's sound: F1 TV's own is
  turned off at once (`sound.carries`), not only once sync by sound locks (on the 2025 British GP
  its looks scored 5-6 for long stretches against Track FX, then 17-108). A nudge on a replay is
  kept for that replay (`soundBias|vod:<bvid>`), not the channel's: the streamer's setup then may
  not be theirs now.
- **By hand, its page, its picture.** By hand (the Sync row, switched without restarting the
  engine) the replay is still found by F1 TV's sound (there's no other way to place it) and F1
  TV's own sound turned off; nothing corrects it after, a nudge moves it and is kept for the
  replay. While it listens, the plan for the picture now is fetched and decoded ahead (stretches on
  a grid from each page's start, so a later look's are the same; 30 kept, ~2 MB each), and a look
  starts at 15 s of F1 TV's sound, again every 8 s more of it, up to 30 s: about 20 s to a place.
  ↗ opens the replay's own page at the moment playing (`?p=<page>&t=<s>`). The streamer window
  plays the replay's own picture (720p H.264, `FoneVod.loadVideo`, the same byte-range playlist,
  hls.js in `streamer.js`) at the commentary's `m`: their screen has their timing tower and map,
  which fone has no other source for so old (F1's archive refuses).
- **Their screen, cut up.** The dashboard can show the streamer's own timing screen instead of
  fone's timing, in its own panels: where fone has no timing for the video (no timing session, or
  `available: false`), and whenever asked for (the switch in the map's top-right corner, or `T`:
  `chrome.storage.local.statsSource` 'theirs' / 'ours'). Their stream is their timing screen, a
  live-timing app whose layout changes from one session to the next (16 replays of 2025-26
  checked: the overview tab's two columns of driver rows, 10 a column in 2025 and 11 in 2026, at
  50 px pitch on a 1080p screen; the race tab's one wide table of 22 at 31.6 px, with a header
  line; the map's window anywhere right of it and of any size, sometimes a lap counter instead;
  the whole screen a few px lower and 1% larger in one), so nothing is cut at a fixed place.
  `streamer.html?mode=box` plays the picture in a frame of the dashboard's own (under F1 TV's
  player box, on screen so it's decoded); every 1.5 s the picture is drawn at 960×540 and read by
  `shotlayout.js` (`FoneShot.detect`): every row starts with the driver's tag, a box in the team's
  colour (white and grey for some teams), so columns of tag-tall runs of bright pixels repeating
  at a steady pitch are the table's tag columns (a column of timing pills is all one colour; a
  tyre's ring or a gauge's arc isn't solid; the mini-sectors' bars are too short; a tag's digits
  cut it into strips, joined again up to a third of a row apart: a position just gained or lost
  turns the number's box green or red with an arrow for a while, and its digits then cut 5 px,
  which lost the left column on the 2026 Italian GP; the other column is looked for either side
  of the first one found); the rows' own
  ground gives its right edge (it drops to the black or darker grey around the app's panels); the
  season's car count (22 from 2026, 20 before, from the clock) how many rows there are, dimmed
  tags of cars out included; the map's window is the largest connected line drawing right of
  the table in the upper part of the screen (ads there are solid pictures: a drawing filling more
  than half its box isn't the map), padded for the corner numbers. A new layout is taken once two
  looks agree (a look that finds only some of its columns keeps it as it was), a moved map window
  likewise. Each animation frame `drawShot` draws into canvases
  over the tower, conditions and map panels: the table's rows (both columns one above the other;
  of the variants, the whole row, then without the race tab's rpm/speed/gear/pedals or the
  overview's gauges and mini-sectors, then the least, a narrower one only where it comes out 25%
  larger), race control under them where there's room; the session bar, its strip found above the
  table and read at the picture's own px (`FoneShot.bar`: the name over the clock and lap count,
  the track-status box, the widest run of columns on a coloured ground past the flag, each weather
  item, a label over its value with a dark line between them that the app's icons after them go
  through), its pieces laid out in rows as large as the panel takes them (`FoneShot.pack`: in
  the user's onboards layout 1.8× the old two lines); the map's window, as large as it fits. In
  the column arrangement the tower takes all but the bar and up to a third of the height for the
  map (its window's shape). The engine sends the dashboard its clock for such videos too.
- **Its danmaku.** The live chat Bilibili put on the replay (`x/v1/dm/list.so?oid=<cid>`, XML,
  each `<d p="progress,mode,size,colour,…,uid hash,…">`, `FoneVod.parseDanmaku`), each put on the
  replay's wall clock by its page and progress (`vodDanmaku`): the 弹幕 overlay asks the engine
  (`{target: 'engine', type: 'vod-dm', from, to}`, answered through the service worker) instead
  of the server while a replay plays, and shows them as the server's (no levels or medals).
- **Status.** `vod: {state, text, bvid, title, how, tries, reps, cuts}` (states `finding`,
  `listening`, `searching`, `placed`, `none`, `error`); until placed the engine reports `syncing`
  (or `none`/`error`) with its text, plays nothing, and leaves F1 TV's own sound on. Details:
  "recording: Bilibili 直播回放 <bvid> · <title> · found by sound · N repeats cut". Delays and
  nudges on it are kept in the browser, not on the server. Only with a server (the replay's
  anchor is the server's) and sync by sound on. `e2e/vod/run.sh` plays a stretch of the real
  British GP replay as F1 TV's sound against a mock server with nothing recorded: found in
  30-40 s, locked within 30 ms, the 8 repeats cut, opened again where it was.

### Team radio, filled in

F1 TV's Track FX plays the team-radio sting but not the message since about 2026-11-03.
`teamradio.js` (pure, `teamradio.test.js`) detects the sting (three pure tones, G5 D6 B5 at
783.8, 1174.7 and 987.6 Hz, onsets 0, 0.092, 0.189 s: measured on the streamer's recordings of
the 2026-11-01 and 11-08 races) per 5 ms step by each tone's power against its neighbours 40-250
Hz away (voices have harmonics on all three), and reads a message's recording time from its file
name and its speech onset from its level. The engine (`offscreen.js`, team radio) fetches the
session's messages from OpenF1 (`/v1/team_radio`, `/v1/sessions` for the circuit's UTC offset),
prefetches those within 2 min of the picture's time, listens for stings in F1 TV's copied sound
(sync by sound's runs, on the picture's time), and on a sting plays the message whose time (plus
the clock offset the matches so far agree on: a replay's start is an estimate) is nearest, its
speech `STING_TO_SPEECH` (1.1 s) after the sting, kept on the picture (pauses, seeks, speed).
Only with Track FX (setting `teamRadio`, on). Live needs F1 TV's own clock and OpenF1's list,
which only has a live session's messages after the fact on the free tier: live is to come.

### Messages

`chrome.runtime` messages, routed by `target`:

| from → to | message | notes |
|---|---|---|
| content → background → engine | `{target: 'engine', type: 'video', cid, channel, video: {p, paused, seeking, waiting, rate, ready, live, seekEnd, src, at, dx}, settings: {servers, volume, muted, anticipate, source, stream, bufferMin, liveDirect}}` | the player's state, at most every 200 ms; the background forwards it as `target: 'offscreen'` with `tab` added. A new `tab|cid|channel|servers|source|stream` key (`liveDirect` off counts as a different stream) (re)attaches the engine; each report of a live video (or one whose clock isn't decided yet) also keeps the recorder wanted |
| content → engine | `{type: 'nudge', delta}` · `{type: 'relive'}` · `{type: 'detach'}` | the delay buttons/keys; "Re-sync"; the video went away |
| content → background → engine | `{target: 'engine', type: 'golive', holding, chase, pMax}` → `{handled, by, more, limit, took, wait}` | Go live (⏭, `L`, F1 TV's LIVE badge): the engine answers how far to move F1 TV now (`by` s, `limit` `'f1'` or `'commentary'`: whichever is reached first) and how much further once F1 TV's reported edge has stepped on (`more`), and the content script seeks by that much (`fone-cmd` `seek`, answered by `fone-seek`), asking again every 0.5 s while there's `more` (`chase`, with `pMax`, the furthest F1 TV has been since: `took` when it's gone back from there; `wait` while F1 TV's clock is re-proving). `holding`: auto-hold's, the only time (with a lead under 1 s) Go live steps F1 TV back. `handled: false` (not live, not locked yet), or a seek F1 TV didn't take: the badge's own click goes through |
| background → engine | `{target: 'offscreen', type: 'detach', tab}` | the tab closed |
| engine → background → tab | `{target: 'background', type: 'status', tab, status}` → the tab receives `{type: 'fone-status', status}` | ≤ 4 times a second. `status`: `{state, text, channel, channels, server, source, direct, onAir, rec, clock, delay, delaySource, cid, title, session, anchor, playing, E, W, m, p, at, lead, leadAim, drift, file, ad, error, fixes, diag, livepos, dm}`; `state` is one of `loading`, `error`, `syncing`, `sync`, `waiting`, `before`, `gap`, `after`, `none`, `paused`, `buffering`; `dm = {w, at, rate, run}` is the danmaku clock; `source` is `'server'` or `'local'`; `direct` is true with a server, live from the stream recorded here; `onAir` is whether the streamer is on air as the commentary's source knows it (the stream recorded here: its platform says live and audio comes in, and a Bilibili room showing replays, 轮播, is off air; a server's recording: its timeline is live, i.e. its file is still growing, up to `FONE_GROWING_IDLE_SECONDS` after the streamer stopped; null when not known), which the 弹幕 panel's 直播中 follows; `ad` names the sponsor clip being muted; `p` and `at` are F1 TV's position and the engine's clock at that report; `f1Lat` (live, with F1 TV's clock) how far behind that clock its picture plays; `page` is the streamer's live page on their platform (`FoneStreams.pageOf`: the stream recorded here's, else the channel's Bilibili room's; null for a stream URL given straight), for the panel's ↗ Live page; `leadAim` is the lead Go live brings the commentary to (`liveAllow`, or the delay set's lag if nearer, less the slack), and auto-hold lets F1 TV go again at `min(4, leadAim − 0.5)`, at least 1.5; while the commentary plays from the stream recorded here (without a server, or `direct`), `rec` is the recorder's `{state, text, err, url, platform, label, name, title, kept, kbps, net, filled, end, edge, fmt, player}` (null otherwise, also while rewound into the server's recording with the stream still recorded for the way back) |
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
| `page.js` → `player.js` | `fone-tm`: the Tiledmedia sample (`eventType`, `currentPosition`, `contentDuration`, `seekLowerBound`, `seekUpperBound`, `bufferLowerBound`, `bufferUpperBound`, `isAtLiveEdge`, `isWallclockTimeSourceBased`), plus `r` (speed), `a` (audio tracks; `mode`, the sound fone picks; `muted`, F1 TV silenced with its own button, held by fone's gain; `own`, a mute of F1 TV's own held so) and `subs` (`{want}`: F1 TV's subtitles as asked) |
| `content.js`, `layout.js` → `page.js` | `fone-cmd`: `{cmd: 'rate', value}` (replays only), `{cmd: 'audio', prefer: 'fx' \| 'eng' \| 'none', subs, feed: 'intl' \| 'none', live, cid, tap}` (`fx`: F1 TV's commentary-free Track FX, `eng`: its international English commentary, picked on every video; `none`: left alone; `subs`: F1 TV's subtitles on or off, kept and reported, not steered yet; `tap`: F1 TV's sound handed on for sync by sound; `feed: 'intl'`: live, F1 TV's INTERNATIONAL channel picked in its own channel switcher, `[data-tao="tm_channel_switcher_item"][data-channel-id="1025"]`, once per video), `{cmd: 'onboards', slots}`; each re-sent every 2 s and dropped by `page.js` after 10 s without it (extension reloaded or removed). `{cmd: 'seek', by}`, once: a relative seek of F1 TV's player (`TimingConfig` `RELATIVE_TIME`, `PRECISE`), answered with `fone-seek` `{ok, by, err}` |

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
`volume`, `muted`, `autoHold`, `collapsed`, `speed`, F1 TV's own (`settings.js`): `f1Sound` (`fx`, the
default, or `eng`), `f1Subs` (default false), `f1Pick` (fone picks F1 TV's track at all; default
true) and `f1Feed` (`intl`, the default, or `off`), then `anticipate`, and `danmaku` (the 弹幕
settings object). The panel has the first two; the options page all four. 0.3.10's `f1Audio`
(`mute`, `fx`, `eng`, `off`; before it `autoFx`) is migrated once where `f1Sound` isn't set:
`eng` stays English Int., `fx` and `mute` become Track FX, `off` becomes `f1Pick` false; the old
keys are left in storage for an older build (another computer sharing the sync storage, a
rollback). `chrome.storage.local` (per machine): `layout`
(`'split'` | `'off'`), `onboards` (the two picked drivers), and the self-update's `updateSeen`,
`lastReload`, `refreshF1tv`.

First run: the service worker opens the options page on install (`onInstalled`, reason
`install`; not on an update or a self-reload), which with nothing set shows how to start; later
the panel's ⚙ asks it to (`{target: 'background', type: 'open-options'}`: a content script
can't open it), highlighted while there's nothing to play from. The options page's logic is
`FoneOptions` (`options.js`, tested by `options.test.js`): a server as typed gets `http://`
where no scheme was typed and `:8788` where no port either, anything but http(s) is refused,
and a save keeps the source that has something in it (a first run's server saved with "This
computer" still checked is the server). A server line it can't use costs only the server
list: that and `source` stay as saved (the box keeps what was typed, the message says which
line and why), everything else on the page is saved. *Test connection* reads `/api/health` (the
version, where the server has one), `/api/channels` and `/api/danmaku/status` (whether the
channel has a Bilibili room).

Self-update: a published build (`tools/publish_ext.sh`) carries `build.js` (read once at load),
`build.json`, which installed copies poll from the update channel (`fone-ext`, port 8789; the
`ext-update` compose profile) and reload into once it has been up for 75 s and no tab is
playing, and `local.js` with that install's default servers (`self.FONE_LOCAL.servers`; the
repository's copy is an empty placeholder, so a release's zip or a copy loaded straight from the
repository asks for the server in its options page and never updates itself).
