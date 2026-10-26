# fone — F1 TV with a live streamer's commentary

Watch **F1 TV** with a streamer's live commentary instead of the official broadcast: a
watch-along on Bilibili, Twitch, YouTube, Douyin or Huya, or any stream you have a URL for.
fone keeps it in step with F1 TV's picture to the millisecond. Pause, rewind or jump back to
live, and the commentary follows.

There are two ways to run it:

- **Just the extension.** Install it, paste the streamer's live URL, open F1 TV. The extension
  records the stream's audio in your browser while an F1 TV live video is open and keeps the
  last minutes, so rewinding F1 TV finds the commentary that went with it. No server, no
  account, nothing to host. Live sessions only.
- **With a fone server** (Python, Docker, on a home server or NAS). It records the streamer
  around the clock, so **replays** work from any moment, and puts a live timing tower, a track
  map and driver onboards beside the video. On Bilibili it also measures the streamer's delay
  off their screen and scrolls the live room's **弹幕** over the picture.

<p align="center">
  <img src="docs/images/stats-onboards.jpg" alt="F1 TV shrunk to the top-left, with the timing tower on the right and conditions, track map and three driver onboards underneath" width="900">
</p>

| | extension only | with a server |
|---|---|---|
| Live sessions, edge to edge, rewind and back to live | ✅ (rewind as far as the buffer, 15 min by default) | ✅ |
| Replays from any moment, at 1×, 1.5×, 2× | — | ✅ |
| Platforms | Bilibili, Twitch, YouTube, Douyin, Huya, any HLS / FLV / AAC URL | Bilibili (录播姬), anything [streamlink](https://streamlink.github.io/) plays |
| Delay | by ear once, remembered per stream | measured off the streamer's screen in an FLV recording (录播姬's), else by ear |
| Stats, track map, onboards | with a server listed in the settings | ✅ |
| Sponsor clips muted | — | any recording, once that streamer's reference clips are built |
| 弹幕, missed streams backfilled | — | Bilibili |

The worked example throughout is the one this was built for: **胡闹P房**, a Bilibili F1
watch-along (room 23954427). Every server setting below is theirs, and
[Other streamers and platforms](#other-streamers-and-platforms) lists what to change. Inside,
the project is called **fone**: the server package, the Docker containers and volume, the
extension and the install paths all go by that name.

- [What it does](#what-it-does)
- [How it works](#how-it-works)
- [Quick start: just the extension](#quick-start-just-the-extension)
- [Setup with a server](#setup-with-a-server)
- [Using it](#using-it)
- [Configuration](#configuration)
- [Other streamers and platforms](#other-streamers-and-platforms)
- [Server API](#server-api)
- [Development](#development)
- [Repository layout](#repository-layout)
- [Privacy and security](#privacy-and-security)
- [Limitations](#limitations)
- [Status, licence and trademarks](#status-licence-and-trademarks)

## What it does

**Commentary in sync**
- **Live works edge to edge, with or without a server.** fone locks the commentary's live edge
  to F1 TV's, by F1 TV's own clock (the time its player puts on the picture: how far behind live
  its picture really is, which differs by a few seconds every time the page loads), then follows
  F1 TV's playhead: rewind 30 s and the commentary goes back 30 s. If F1
  TV is ahead of the commentary it pauses the video until the commentary catches up, then keeps
  you just behind the streamer. Without a server the extension records the stream itself (audio
  only where the platform has it) into a rolling buffer in memory; a dropped connection is joined
  back on the stream's own timeline, to the sample where the platform allows it. With a server
  and a Bilibili channel, live does the same: the browser pulls the room's stream, about 3 s
  fresher than the server's recording (which grows a few seconds at a time), and the server gives
  everything else (replays, stats, 弹幕, the sponsor clips to mute: from a few seconds into each,
  as the server recognises them). Rewind F1 TV past what the browser has recorded and the
  server's recording plays it; come back within it (Go live) and the stream does again. If this
  browser can't get the stream, it plays the server's recording instead.
- **Go live** (the panel's ⏭, `L`, or F1 TV's own LIVE badge): F1 TV and the commentary jump to
  the most recent moment both have. F1 TV goes as near live as its player lets it (where its live
  edge is at its freshest; what the edge doesn't reach yet follows within seconds, as it steps
  on), and the commentary as near what's recorded as auto-hold allows. A pause, a rewind, holds:
  all undone. F1 TV's ±10 s buttons step from wherever they are.
- **Off air is off air.** When the streamer stops (on Bilibili the room then shows replays, 轮播),
  the panel says they're off air instead of waiting on commentary that isn't coming, F1 TV isn't
  held, and the 弹幕 panel's 直播中 goes. Live from the stream itself this is known in seconds;
  from a server's recording, once its file stops growing (90 s).
- **Replays sync themselves** (with a server). MultiViewer publishes where the official `SessionStatus: Started`
  moment falls in each F1 TV replay, and F1's live-timing archive gives its UTC time. Every 2026
  session anchored this way checks out to under 0.5 s. Until MultiViewer publishes (live, or just
  after a session), fone uses the replay's fixed pre-roll (307 s for qualifying and races, 250 s
  for sprints, ~1165 s for practice). The archive has answered 401 to everyone since 2026-10-18:
  replays the server anchored before then stay exact, and newer ones use the pre-roll estimate
  while it refuses.
- **The streamer's delay is measured, not guessed.** The streamer watches with MultiViewer's
  "Track time" on screen; the server reads that clock off their stream (tesseract OCR) to
  measure how far behind real time they are, per recording. It reads FLV recordings, with the
  picture (录播姬's).
- **Seek, pause, 1.5×, 2×.** Speeds keep the commentary's pitch. F1 TV's player constantly nudges
  its real speed to stay in step with its own clock, by up to ±25%; fone tells those nudges apart
  from a real speed change, so the commentary doesn't click or jump.
- **F1 TV's own commentary out of the way.** By default fone mutes F1 TV's player: the recording
  already carries the streamer's F1 TV sound, and two copies of the same audio at any offset are an
  echo. Or it switches F1 TV to its commentary-free *Track FX* track on every video, if you prefer
  F1 TV's clean track sound.
- **Sponsor reels muted.** The streamer's pre-recorded sponsor clips are found in every recording
  (live within ~4 s) and muted. Live, a break's clips are recognised one by one, a couple of
  seconds into each: the mute holds past each clip's end until the server knows whether another
  follows, so nothing slips out between them, and the commentary fades back in after the break.

**The streamer's picture** (📺 Streamer or the V key)
- A window over F1 TV with the streamer's own picture (their facecam, their screen), in step with
  the commentary you hear: move it by its bar, size it by its corner, it stays where you left it;
  ⧉ puts it in a window of its own (a second screen, say). Muted: the sound is fone's commentary.
- Live from the stream pulled into the browser (HTTP-FLV with its video: Bilibili, Huya, and
  Douyin, which switches from its audio-only stream to its smallest with the picture when the
  window opens), the picture is that same stream's video, put on the commentary's own timeline:
  lip-sync to the frame, rewinds included (the last 3 minutes since the window opened). From a
  server's recording (replays, or rewound into it), the recording's own picture (its video
  handoff), at the commentary's position in it. Twitch and YouTube give fone only their audio: no
  picture from them yet. Bilibili's HEVC stream where the browser decodes HEVC (Chrome does with
  most graphics hardware), else its H.264.
- **↗ Live page** (beside 📺, and ↗ on the window's bar): the streamer's own live page on their
  platform (their Bilibili room, Twitch channel, YouTube live, Douyin or Huya room) in a new tab.

**Stats beside the video** (📊 Stats or the S key; needs a server)
- F1 TV shrinks to the top-left 77% of the tab. The timing tower (gaps, intervals, last and best
  laps, tyres and their age, pit stops) runs down the right edge to the picture's bottom.
- Below it: session conditions (flag, clock, weather), a track map with every car and the corner
  numbers, and up to four **driver onboards**. These are F1 TV's own onboard feeds, drawn by F1
  TV's player in step with the main picture.
- The stats always show the moment on your screen, never later, so nothing gets spoiled. Live,
  the car positions on the map come from your own F1 TV login, read in the browser.
- A window much wider than tall has no room under the picture: the stats go in a column on the
  right instead. The **Onboards** switch (or O) shrinks the picture until onboards fit.

<p align="center">
  <img src="docs/images/stats-wide.jpg" alt="A wide window: the stats stacked in a column on the right" width="700">
</p>

**弹幕 over the picture** (D toggles, ⚙ for settings; a server and a Bilibili room)
- The live room's danmaku scroll over F1 TV's picture, also in the stats layout and fullscreen.
  Each appears when the commentary reaches the moment it was sent, so they pause, jump and speed
  up with what you hear.
- Bilibili's settings, by the same names: 显示区域, 不透明度, 字号, 速度, 粗体, 描边类型, 允许重叠,
  屏蔽类型 (滚动 / 顶部 / 底部 / 彩色 / 表情 / 醒目留言), 等级屏蔽 (用户等级, 荣耀等级, 粉丝牌) and
  关键词屏蔽 (plain text or `/regex/`).
- Stickers and inline emoji ([dog], [笑哭]) are drawn as Bilibili draws them.

<p align="center">
  <img src="docs/images/danmaku.jpg" alt="Danmaku scrolling over a placeholder player, including a sticker" width="430">
  <img src="docs/images/danmaku-settings.jpg" alt="The 弹幕设置 panel" width="430">
</p>

**Around it** (the server)
- **Recording gate:** the recorder only keeps F1 streams. Game streams are stopped and their stubs
  deleted.
- **Backfill:** when the recorder missed part of a stream, the server waits for the streamer's
  official replay (直播回放), downloads it and places it on the wall clock to fill the gap.
- **Video handoff:** the recording's own picture and sound as HLS, to keep watching the streamer
  after F1 TV ends (FLV recordings only).
- **Self-updating extension**, on Windows (loaded from a network share) and on a Mac (synced by a
  launchd job), never mid-viewing.
- **Playback diagnostics:** each browser reports what playback looked like (positions, speeds,
  drift, seeks, stalls), so problems on a machine nobody is watching can be read afterwards.

## How it works

Without a server, the left half of this is the extension itself: its offscreen document asks
the platform for the stream (`streams.js`), pulls it (`recorder.js`), keeps only the audio
(`demux.js`: AAC out of HTTP-FLV, MPEG-TS, fMP4 or packed ADTS) on one continuous timeline
(`localcore.js`) and plays it through Media Source Extensions (`localplayer.js`), steered by the
same engine as a server's recordings.

```
 Bilibili live room                    server (Docker)                        Chrome on F1 TV
 ─────────────────                     ───────────────                        ───────────────
 stream ──▶ 录播姬 (fone-recorder) ──FLV──▶ fone server :8788 ◀──── HTTP ────── fone extension
            + gate (F1 titles only)         • tails recordings → audio HLS       • reads F1 TV's player
                                            • maps every second of audio           (position, speed, live edge)
                                              to the wall-clock time it aired    • picks the commentary for
 danmaku ws ───────────────────────────▶    • measures the streamer's delay        the moment on screen
                                            • finds sponsor clips                 • stats dashboard, onboards
 danmakus.com archive ─────────────────▶    • danmaku by send time               • 弹幕 overlay
 F1 TV API · MultiViewer · F1 live timing ▶ • anchors replays, live timing
```

Four clocks, converted in this order:

| | | |
|---|---|---|
| `p` | F1 TV player position | from the player (Tiledmedia SDK, read in the page) |
| `E` | the real-world moment on screen | `p0 + p` on a replay (`p0` from MultiViewer); from the live edge when live |
| `W` | when the commentary about `E` aired | `E + delay` (the streamer's delay, measured or calibrated) |
| `m` | position in the commentary audio | `W` mapped through the recordings' arrival times |

The extension's audio engine (an offscreen document) plays `m` and keeps the audio on target. At
1× it does this with tiny inaudible rate changes, at other speeds with rare seeks. The dashboard
shows data for `E`, and the danmaku appear at their send time on the `W` clock.

## Quick start: just the extension

1. Get the code (*Code → Download ZIP* on GitHub, or `git clone`) and unpack it.
2. In Chrome (or Edge, Brave), open `chrome://extensions`, turn on *Developer mode*, choose *Load
   unpacked* and pick the `extension` folder.
3. Click fone's toolbar icon. Under **This computer (no server)**, paste the streamer's live
   page (`https://live.bilibili.com/23954427`, `https://www.twitch.tv/<name>`,
   `https://www.youtube.com/@<name>`, `https://live.douyin.com/<id>`, `https://www.huya.com/<room>`)
   or a stream URL. *Test stream* asks the platform whether it's live; *Save*.
4. Open the F1 TV live session. fone connects to the stream and the panel turns green with
   **Live** once the commentary is playing. Set the delay by ear once (`[` `]` for ½ s, `-` `=`
   for 0.1 s, `,` `.` for 0.02 s). It's remembered for that stream.

F1 TV's own sound is muted by default: the streamer's stream carries their F1 TV sound, and two
copies of it at any offset are an echo. The extension records only while an F1 TV live video (or
one it can't yet tell from a replay) is open in a tab, and ten minutes after; on a replay it
stops. The recording starts when the live video is opened and keeps only the last *Keep the
last … minutes* (15 by default), in memory, never on disk: to rewind to the start of a session,
open the live video before the session starts and raise that setting to the session's length.

The buffer takes about 1–2 MB of memory a minute: it holds the streamer's own audio, typically
128–256 kbps. On the network that audio is all it takes on Twitch, YouTube and Douyin. Bilibili
and Huya have no audio-only stream, so it pulls their smallest video and keeps the audio:
Bilibili's anonymous 超清, the lowest it offers logged out, can be 0.5–1.3 Mbit/s.

## Setup with a server

fone runs on a home server with the recordings on a NAS, and is reached over the LAN or
Tailscale. The paths in `docker-compose.yml` are this setup's: change them for yours. The
extension's default servers and where it is published are yours to set in `tools/publish.env`
(copy `tools/publish.env.example`; it's gitignored).

### 1. Server

```bash
mkdir -p /mnt/nas/media/library/recordings/fone-import   # backfill writes here; create it first
docker compose up -d                                     # fone (:8788) + fone-ext (:8789)
```

The status page is at `http://<host>:8788/`. The server reads the recordings directory read-only
(except `fone-import`) and keeps everything it computes in the `fone-data` volume: audio HLS,
analysis results, timing archives, danmaku and SQLite.

### 2. Recording

The server needs the streamer recorded **before** they go live. For a Bilibili room:

```bash
# credentials for the recorder's HTTP API, shared with the gate (gitignored)
printf 'BREC_HTTP_BASIC_USER=fone\nBREC_HTTP_BASIC_PASS=%s\n' "$(openssl rand -hex 16)" > recorder/api.env
chmod 600 recorder/api.env
docker compose --profile recorder up -d
```

- **fone-recorder:** a dedicated 录播姬 (BililiveRecorder) for room 23954427, in original
  quality, with millisecond file names and no webhook.
- **fone-recorder-gate:** stops any recording whose title isn't F1 and starts it again if the
  title turns F1. Override the patterns with `GATE_RECORD` / `GATE_SKIP`.
- **fone-janitor:** deletes recordings and backfill imports 21 days after they end
  (`KEEP_DAYS`).

A recording made by another 录播姬 works too: it becomes a channel named after its folder
(`FONE_CHANNEL_ALIASES` renames it). For a streamer on another site, `fone-streamlink` records
any stream streamlink can play into the same layout:

```bash
# in docker-compose.yml: STREAMS=channel=URL ... (and TZ = the server's FONE_FILENAME_TZ)
docker compose --profile streamlink up -d --build fone-streamlink
```

Name the service: without it, `--build` also rebuilds and restarts the fone server from the
working tree. Its recordings are MPEG-TS, audio only by default, so the delay is set by ear; see
[Other streamers and platforms](#other-streamers-and-platforms).

### 3. Extension

**Windows (or any machine on the LAN):** `tools/publish_ext.sh` publishes the extension to a
network share. In `chrome://extensions`, turn on Developer mode, choose *Load unpacked*, and pick
that folder. Installed copies poll the update channel (`fone-ext`, port 8789) and reload
themselves when a new build is out and nothing is playing.

**Mac (over Tailscale):**

```bash
curl -fsSL http://<host>:8789/install-mac.sh | sh
```

This installs `~/fone/extension` and a launchd job (`fone.sync`) that keeps it up to date every
minute. Load `~/fone/extension` unpacked once.

The toolbar icon opens the options page. Choose **A fone server** there and enter the server
URLs, one per line, tried in order (a Tailscale name first so it works away from home, the LAN address second). The
repository ships none; a build you publish with `tools/publish_ext.sh` carries the ones from
`tools/publish.env` as its defaults. *Test connection* shows which one answers. The page also
sets the commentary channel, live auto-hold and whether live comes straight from the streamer's
Bilibili room (on by default).

## Using it

Open any F1 TV video. The fone panel sits top-right:

| | |
|---|---|
| **delay −5 … +5** | nudge the commentary, in steps of 5, ½, 0.1 and 0.02 s. Hear the reaction **after** the action? `+`. Before it (spoilers)? `−`. Saved per video on the server; live from the stream pulled into the browser (without a server, or a server's Bilibili channel live), per stream in this browser. The fine steps are for nulling an echo against F1 TV's own sound by ear, where the engine then holds the alignment to a millisecond for hours. |
| 🔊 and the slider | mute and volume of the commentary |
| **1× 1.5× 2×** | replay speed (live stays 1×) |
| **📊 Stats** and **⧉** | the stats beside the video, or in a window of their own |
| **📺 Streamer** and **⧉** | the streamer's picture in step with the commentary: a window over F1 TV (move it by its bar, size it by its corner), or in a window of its own |
| **↗ Live page** | the streamer's live page on their platform, in a new tab |
| **弹 弹幕** and **⚙** | danmaku on/off and their settings |
| **F1 TV: muted / track sound / English Int. / as is** | what to do with F1 TV's own sound. *Muted* (default): F1 TV silent, the commentary carries the streamer's F1 TV sound, so no echo and no track switching. *Track sound*: F1 TV switched to its commentary-free Track FX track on every video (a track switch, which F1 TV's player sometimes crashes on). *English Int.*: its international English commentary (the world feed's), not F1 TV's own *English F1 Live*. *As is*: left alone. |
| **Picture: International / as is** | live, F1 TV switched to its INTERNATIONAL channel (the world feed the streamer watches: its graphics, its replays) instead of F1 LIVE, once per video, by F1 TV's own channel switcher (default *International*; go back to F1 LIVE and it's left there). Replays are left as they are |
| *Anticipate reactions* | with a measured delay: play the commentary 0.9 s early, so reactions land on the action instead of after it (off by default: with it on, the streamer's pass-through F1 TV sound runs 0.9 s ahead of the picture) |
| *Pause video when ahead of live commentary* | live auto-hold. Without a server, when the stream stops arriving (the streamer offline, or nothing for 30 s) the panel says so and F1 TV is let go rather than held |
| **⏭ Go live** | F1 TV and the commentary to the freshest moment both have (also `L`, or F1 TV's LIVE badge) |
| **⟲ Re-sync** | lock the commentary to the live edge again at the delay set |
| Details | the sync's internals: clock, anchor, delay source, drift; without a server, what the recording holds and how fast it comes in |

| Key | |
|---|---|
| `]` / `[` | commentary 0.5 s sooner / later |
| `}` / `{` | 5 s sooner / later |
| `=` / `-` | 0.1 s sooner / later |
| `.` / `,` | 0.02 s sooner / later |
| `\` | mute the commentary |
| `\|` | collapse the panel |
| `L` | go live |
| `>` / `<` | replay speed up / down |
| `S` | stats beside the video |
| `O` | stats ↔ onboards layout |
| `D` | danmaku on / off |
| `V` | the streamer's picture on / off |

**First session (server):** the delay starts from the one measured off the streamer's screen. Without a
measurement, it starts from your last tweak on the same kind of clock (replays from replays: a
live tweak never carries over to a replay). After that, tune by ear once; it's remembered for that
video. Live from the stream pulled into the browser (without a server, or a server's Bilibili
channel), the commentary starts 4 s behind the stream's live edge on HTTP-FLV platforms
(Bilibili, Douyin, Huya), where the Bilibili web player plays it, and 7 s behind it on HLS
(Twitch, YouTube), when F1 TV starts where it usually does (32 s behind its own clock; further
behind, the commentary as much further), until you set it, and what you set is kept per stream
in this browser. With the server's own recording it starts 11 s behind the time now (its newest
audio can be 8 s old). Live, a delay you set
holds through reloads, pauses, rewinds and Go live: it's measured against F1 TV's own clock, not
where its player happened to start.

## Configuration

The server reads environment variables (see `docker-compose.yml`):

| Variable | Default | |
|---|---|---|
| `FONE_REC_DIR` | `/rec` | recordings root, scanned recursively (a folder per channel) |
| `FONE_DATA_DIR` | `/data` | everything the server writes |
| `FONE_FILENAME_TZ` | `Asia/Shanghai` | time zone of the recorder's file names |
| `FONE_CHANNEL_ALIASES` | | `folder=channel,…` (录播姬 names folders after the account: `马莎拉车=胡闹P房`) |
| `FONE_ROOMS` | | `room=channel,…` Bilibili rooms, for backfill and danmaku |
| `FONE_IMPORT_DIR` | | where backfill writes the replays it imports |
| `FONE_DEFAULT_DELAY` | `40` | streamer delay (s) before anything is known |
| `FONE_REACTION_SECONDS` | `0.9` | the streamer's reaction time, added to the measured screen delay when the panel's *Anticipate reactions* is on |
| `FONE_SEGMENT_SECONDS` | `2` | HLS segment length |
| `FONE_TIMING`, `FONE_ADS`, `FONE_SCREENCLOCK`, `FONE_VIDEO`, `FONE_BACKFILL`, `FONE_DANMAKU` | `1` | each optional service; `0` turns it off (`/api/health` lists the running ones) |
| `FONE_TIMING_RECORD` | `1` | capture live sessions' timing from 15 min before the start (while F1's archive refuses, since 2026-10-18, the only source of a session's stats) |
| `FONE_DANMAKU_CAPTURE`, `FONE_DANMAKU_ARCHIVE` | `1` | the two danmaku sources: our own listening, and danmakus.com for the rest |
| `FONE_BACKFILL_DANMAKUS` | `1` | backfill may ask danmakus.com when a stream started |

More tuning knobs live next to the code that reads them (`FONE_TIMING_*`, `FONE_SCREENCLOCK_*`,
`FONE_BACKFILL_*`, `FONE_SCAN_INTERVAL`, …).

## Other streamers and platforms

**Without a server** it's one setting: the streamer's live URL in the options page. What the
extension does with each platform (`extension/streams.js`; logged out and without your cookies,
except Douyin's anonymous `ttwid`):

| | what fone asks | what it records |
|---|---|---|
| Bilibili | the room's player API | the anonymous 超清 stream (the lowest offered logged out, 0.5–1.3 Mbit/s with its video) as HTTP-FLV (it arrives as it's made, ~1 s before the same moment in the fMP4 HLS), else fMP4 HLS (its own timeline: reconnects land to the sample); only its AAC 48 kHz audio is kept |
| Twitch | the embedded player's access token (the site player's gave every logged-out connection a 30 s pre-roll ad, 2026-10-26; the embedded one's none), then its HLS | the audio-only rendition (the channel's own AAC). A stitched ad isn't fetched (its segments are the full picture, ~6 Mbit/s, whatever rendition was asked for): silence for as long |
| YouTube | the watch page, then the player API as YouTube's visionOS app (no JavaScript, no PO token) | its own audio rendition, AAC-LC 128 kbps |
| Douyin | the web room API, with Douyin's anonymous `ttwid` cookie and no other: the one in your browser, or a fresh one from live.douyin.com if there is none | the audio-only FLV; with the streamer window open, its smallest FLV with the picture |
| Huya | the mobile room API, the stream URL signed as Huya's web player signs it | the lowest-bitrate FLV (only its audio is kept) |
| any other site | nothing: the URL is the stream | HTTP-FLV, HLS (TS, fMP4, packed AAC) or an AAC stream, with AAC audio. `streamlink --stream-url <page> worst` (`audio_only` where the site has it) or `yt-dlp -g <page>` prints one. Such URLs are usually signed and expire within hours: get a fresh one for each session |

Platforms change their players without notice. `node tools/stream_probe.js <URL>` records 30 s
with the extension's own code and says what it got.

**With a server**, nothing about 胡闹P房 is hard-coded in the sync itself; it lives in these
settings. Taking 胡闹P房 (room 23954427, whose 录播姬 folder is named after the account, 马莎拉车)
as the worked example:

| knob | where | 胡闹P房 |
|---|---|---|
| The room to record | `recorder/config.json`, `rooms[].RoomId` (seeded into the recorder on first start; after that edit the recorder's own `config.json` in its folder) | `23954427` |
| Room ↔ channel, for backfill and danmaku | `FONE_ROOMS=room=channel,…` in `docker-compose.yml` | `23954427=胡闹P房` |
| Recorder folder ↔ channel name | `FONE_CHANNEL_ALIASES=folder=channel,…` (only if the folder isn't the name you want) | `马莎拉车=胡闹P房` |
| Which streams the gate keeps | `GATE_RECORD` / `GATE_SKIP`, regexes on the stream title (`recorder/gate.py`; the default matches the `【胡闹P房】` tag and F1 session words) | `胡闹P房\|F1\|F2\|…\|排位赛\|正赛\|…` |
| Their sponsor clips, so they can be muted | the reference set in `server/fone/ads/`: cut WAVs of the clips from a recording and build `refs.npz` with the tools in `server/fone/ads/` (the notes there say how); a changed set re-analyses every recording | three clips, see `server/fone/ads/ads.json` |
| The measured delay | needs **MultiViewer's "Track time"** clock visible on the streamer's screen, in an FLV recording with the picture (录播姬's): the screenclock service reads FLV only, so `fone-streamlink`'s MPEG-TS recordings get none. Without it, every video starts from `FONE_DEFAULT_DELAY` or your last tweak, and you tune by ear once per video | on screen |
| The starting delay | `FONE_DEFAULT_DELAY` (seconds the stream lags real time) and `FONE_REACTION_SECONDS` | `40`, `0.9` |
| The channel the extension plays | the options page's *Commentary channel* (empty = whichever was recorded most recently) | empty |
| The server | the options page's *Server URLs*; `FONE_SERVERS` in `tools/publish.env` for the defaults of a published build | — |

The commentary must be a **live** stream recorded as it airs, by 录播姬, `fone-streamlink` or any
recorder that names files with the moment they start (`server/fone/recordings.py` reads
`yyyyMMdd-HHmmss-fff`, streamlink's microseconds and the coarser forms): the sync maps each
second of audio to the wall-clock time it aired, which only a live recording has. A streamer
recorded by `fone-streamlink` gets the sync, the stats and, once their clips are in the
reference set, sponsor-clip muting. They get no measured delay and no video handoff: both read
FLV recordings only, and `fone-streamlink` writes MPEG-TS, by default audio only. Backfill and
弹幕 are Bilibili's (`FONE_ROOMS`).

## Server API

All read endpoints are open on the LAN. Writes are refused from web pages (see below).

| | |
|---|---|
| `GET /api/health` | services running, recordings seen |
| `GET /api/channels` | channels and whether they're live |
| `GET /api/timeline?channel=&from=&to=` | the commentary's pieces (wall clock ↔ playlist), files, sponsor mutes |
| `GET /api/playlist.m3u8`, `/hls/{file}/{segment}` | the commentary audio |
| `GET /api/f1tv/{contentId}` | an F1 TV video: session, anchor `p0`, onboard streams |
| `GET` / `PUT /api/sync/{contentId}?channel=&clock=` | the delay for a video, its source; save a tweak |
| `GET /api/timing/session/{key}/state?t=` · `/track` · `/positions` | the dashboard's data at moment `t` |
| `POST /api/timing/session/{key}/positions` | live car positions, relayed by the extension from the viewer's own F1 live-timing connection |
| `GET /api/timing/content/{contentId}` · `/api/timing/status` | which session a video is; what the timing service holds |
| `GET /api/danmaku?channel=&from=&to=` · `/api/danmaku/status` | danmaku by send time |
| `GET /api/ads/{file}` · `/api/screenclock/{file}` | sponsor clips found · measured screen delay |
| `GET /api/video/{file}/index.m3u8` · `/info` · `/seg/{name}` | the recording's own picture (video handoff) |
| `GET /` | the status page |
| `GET /api/backfill/status` · `POST /api/backfill/import {"bvid"}` | backfill |
| `POST` / `GET /api/diag` | playback diagnostics (read them with `tools/diag.py`) |

## Development

```bash
# server: 190+ tests (8 skip without the NAS recordings); -rs lists the skipped ones
docker build -t fone:dev server
docker run --rm -v $PWD/server:/app -w /app -e PYTHONDONTWRITEBYTECODE=1 \
  -v /mnt/nas/media/library/recordings:/mnt/nas/media/library/recordings:ro \
  fone:dev sh -c 'pip install -q pytest && python -m pytest -q -rs -p no:cacheprovider tests'

# extension unit tests: sync maths, dashboard layout, danmaku, self-update, live positions,
# the in-browser recorder (demuxers, buffer, playlists)
# (from the repository root: livepos.test.js reads server/tests/fixtures)
for t in core dashcore dmcore background livepos demux localcore recorder; do
  docker run --rm -v $PWD:/r -w /r/extension node:22-alpine node $t.test.js
done

# a live stream recorded for 30 s by the extension's own code, in Node (checks a platform works)
docker run --rm -v $PWD:/r -w /r node:22-alpine node tools/stream_probe.js https://live.bilibili.com/23954427

# end to end, headless Chrome with the real extension
./e2e/run.sh                  # real server + mock F1 TV player: replay, Tiledmedia, 2x, live, danmaku, onboards
./e2e/local/run.sh            # no server: the stream recorded in the browser (mock Bilibili, HLS) with a live F1 TV
./tools/platform_check.sh     # any day, no F1 session needed: a stream live right now on each platform (Bilibili,
                              # Twitch, YouTube, Douyin, Huya, plain HLS) against the mock live F1 TV: in step,
                              # where the commentary sits, Go live after a pause, 20 s back and Go live again,
                              # its live page, the streamer window's picture
./e2e/livepos/run.sh          # the live car-position relay (livepos.js + f1token.js) against a mock F1 feed
DASH=real ./e2e/layout_run.sh # the split view on a mock F1 TV page
./e2e/dash_shots.sh           # the dashboard in 20+ window sizes and race states, as screenshots
```

The server tests that need a real recording look for the 2026-10-03 KL qualifying file at its
NAS path; `FONE_TEST_KL_FLV=<path>` (ads, video) and `FONE_KL_FLV=<path>` (screen clock) point
them at a copy elsewhere, and `FONE_LIVE_TEST=1` lets one test connect to the real live-timing
feed. `e2e/livepos/run.sh` runs on an internal Docker network (no traffic to F1 or Bilibili);
`LIVEPOS_ONLY=node|chrome|ext` runs one of its three phases. `e2e/run.sh` looks up real F1 TV
and MultiViewer data, so it needs internet access. F1's live-timing archive, where the exact
replay anchor and the timing come from, has refused everyone (401) since 2026-10-18, so run it
as `E2E_CONTENT_SEED=<file.json> E2E_NO_TIMING=1 ./e2e/run.sh`. The seed is a JSON object
`{content id: the server's /api/f1tv answer}` for both fixtures, e.g. taken from a server's
content cache: `1000011024` (the replay, for its `p0`) and `1000011022` (the race, which
`run.sh` seeds as LIVE; its `anchor` must be `multiviewer`). `E2E_NO_TIMING=1` skips the one
check that needs the archive's timing data (the dashboard's tower). `e2e/local/run.sh` talks to
no real platform: its platforms are mocks under the real host names. `tools/platform_check.sh`
does talk to them (logged out, public streams): what only the real ones show (their APIs as
they are today, their CDNs' rules, Twitch's stitched ads, Douyin's cookie); `e2e/local/run.sh
real <live URLs>` runs the same on streams you name. CI
(`.github/workflows/ci.yml`) runs the unit and server tests on every push.

- **Ship the extension:** bump `extension/manifest.json`'s version, then run
  `tools/publish_ext.sh`. Installed copies update themselves.
- **Read a browser's playback diagnostics:** `tools/diag.py --minutes 30 [--client …]`.
- **How the parts fit together:** `docs/architecture.md` (routes, data shapes, the messages
  between the extension's parts, the time-domain rules).
- **F1's data sources:** `docs/f1-data-sources.md` (F1 TV content API, MultiViewer, live timing,
  OpenF1: the endpoints and fields fone uses).
- **Contributing:** `CONTRIBUTING.md`.

## Repository layout

```
server/                FastAPI server (Docker image fone)
  fone/app.py            routes, the recordings scanner, service wiring
  fone/extractor.py      recordings → audio HLS + wall-clock pieces
  fone/store.py …        delays and content (SQLite), recordings, timeline maths
  fone/f1.py             F1 TV content → session, replay anchor, onboard streams
  fone/timing*.py        F1 live timing (livefeed.py: the SignalR client), state at any moment
  fone/screenclock*.py   the streamer's delay, read off their screen
  fone/ads*.py           sponsor clip detection (references in fone/ads/)
  fone/video*.py         video handoff
  fone/backfill*.py      missed streams from the official replay
  fone/danmaku*.py       danmaku capture, archive import, API
  fone/diag.py           playback diagnostics
  tests/                 pytest, with fixtures
extension/             Chrome extension (Manifest V3)
  content.js             the panel, key bindings, the bridge to the engine
  player.js page.js      F1 TV's player: position, speed, audio track, onboard views
  offscreen.js core.js   the audio engine and its sync maths (hls.js in vendor/)
  layout.js              the split view; dashboard.* + dashcore.js the stats
  danmaku.js dmcore.js   the 弹幕 overlay
  livepos.js f1token.js  live car positions with the user's F1 TV login
  streams.js             no server: the platforms (live URL → stream URL, their headers)
  recorder.js demux.js   …the stream pulled and its AAC taken out (FLV, TS, fMP4, ADTS)
  localcore.js           …the rolling buffer on one timeline; localplayer.js plays it (MSE)
  background.js          relay, self-update, the platforms' header rules; dashproxy.js reads the server for pages
  options.*              the settings page
  testdata/              synthetic streams for the demuxer tests
recorder/              the 录播姬 seed config and the F1-only gate; streamlink/: the any-site recorder
e2e/                   end-to-end suites (Playwright in Docker)
tools/                 publish, diagnostics, Mac install, replay import, stream_probe.js
docs/                  architecture, F1 data sources, README images
.github/workflows/     CI: the unit and server tests
```

## Privacy and security

- **The server has no login.** Anything that can reach port 8788 can read from it, so keep it on
  the LAN or Tailscale. Changes (`PUT /api/sync`, the `POST` routes) are refused when they come from
  a web page, so a site you visit can't re-tune delays or start downloads. Only the extension's
  pages and scripts without an `Origin` (curl) can make them.
- **Your F1 TV login stays in the browser.** The extension reads it there to connect to F1's live
  timing for car positions; only the positions go to the fone server.
- **Bilibili is listened to logged out.** Bilibili masks nicknames for that; the overlay never
  shows names anyway. Levels, medals, colours and stickers are all there. The server keeps
  danmaku for 30 days with the sender as a crc32 hash of their uid (what Bilibili's own replay
  files carry), not the uid.
- **Diagnostics are playback state** (positions, speeds, drift, seeks, the player's SDK calls and
  errors) and the engine's status text, plus a random client id, the build and the OS name, so
  two browsers can be told apart. No tokens, no cookies, no URLs. Anyone who can reach the server
  can read them (`GET /api/diag`).
- **The stream recorded in the browser** stays in the offscreen document's memory and is gone
  when Chrome closes. The audio goes nowhere. With a server listed in the settings, that server
  is asked about the F1 TV video (`/api/f1tv`), gets the live car positions (above) and the
  diagnostics, and those carry the engine's status text, which can include the streamer's
  name. The platforms are asked logged out, without your cookies, with one exception: Douyin
  answers nothing without its anonymous `ttwid` cookie, so the service worker reads the one your
  browser has for douyin.com and sends only that to Douyin's room API. If there is none, it
  visits live.douyin.com once or twice for a fresh one, as a browser would, with whatever other
  Douyin cookies the browser has, unless those include a login's (it looks at their names): then
  it makes no visit and Douyin streams need a `ttwid` from opening live.douyin.com yourself. The
  fresh `ttwid` stays in your browser's cookies.
- **Extension permissions:** `cookies`, `declarativeNetRequestWithHostAccess` and access to all
  hosts. The cookie reads are confined in code to F1 TV's own `login-session`
  (`extension/f1token.js`), Douyin's `ttwid`, and the names of the browser's douyin.com cookies
  (to tell whether one is a login's). `declarativeNetRequestWithHostAccess` sets, by
  session rules, the headers the platforms' servers want (Origin, Referer, YouTube's consent
  cookie, Douyin's `ttwid`) on the extension's own requests to those domains only, never on a
  page's. The host access is what lets the extension reach your fone server at whatever LAN or
  Tailscale address you give it, the streaming platform you point it at, F1 TV's content API
  (without a server, the engine reads it directly for whether a video is live), F1's live timing
  (the car positions, above) and Bilibili's sticker images for the danmaku. Nothing else is
  fetched.

## Limitations

- Desktop Chrome (or Edge/Brave) only: the F1 TV TV and phone apps can't be hooked.
- Without a server: live sessions only, and only as far back as the recording goes. It starts once
  an F1 TV live video is open, and only the last *Keep the last … minutes* are kept (15 by
  default): to rewind to the start of a session, open the live video before it starts and raise
  that setting to the session's length (about 1–2 MB of memory a minute). The platforms' web APIs
  aren't documented and change; Douyin's and Huya's especially.
- F1's live-timing archive has answered 401 to everyone since 2026-10-18. While it refuses,
  replays the server anchored before then stay exact and newer ones use the pre-roll estimate, a
  session has stats only if the server captured it live (`FONE_TIMING_RECORD`), and nothing
  stored is pruned.
- Pre- and post-race shows and other non-session videos have no anchor: they play in *manual* mode
  and you line them up by ear.
- Danmaku from before fone listened (the danmakus.com archive) have no levels, colours or
  stickers, so the level filters can't apply to them.
- The commentary follows the main feed's timing. Switch F1 TV's main picture to an onboard and it
  runs ~7 s behind the main feed (MultiViewer's channel offsets), so nudge the delay to match.
- F1 TV's player can die on an audio-track switch (its own menu included); it then rebuilds
  itself from a position saved up to five minutes earlier. The *muted* F1 TV audio mode avoids
  track switches altogether; the diagnostics record the player's fatal errors when it happens.

## Status, licence and trademarks

A personal project, built for one living room and shared as is. It is not affiliated with,
endorsed by or supported by Formula 1, F1 TV, Bilibili, Twitch, YouTube, Douyin, Huya,
MultiViewer or any streamer. It plays nothing it isn't entitled to: it works only with your own
F1 TV subscription (the extension runs in your browser, on your login) and with recordings you
make of a public live stream for yourself; nothing is redistributed. The APIs it reads are undocumented and may change or close at any time.

MIT licence, see `LICENSE`; the licences of what it bundles and runs are in `THIRD_PARTY.md`.
Formula 1, F1 TV, Bilibili, Twitch, YouTube, Douyin, Huya and MultiViewer are trademarks of
their owners.
