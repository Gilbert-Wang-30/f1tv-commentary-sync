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
| Sponsor clips muted | — | on the channel the reference clips were made for (the bundled ones: 胡闹P房's; your streamer's: build a set, `FONE_ADS_REFS`) |
| 弹幕, missed streams backfilled | — | Bilibili |

It was built for one streamer, **胡闹P房**, a Bilibili F1 watch-along, and works with yours:
nothing about them is in the sync, and where an example below needs a real streamer it's
theirs, labelled as such. Inside, the project is called **fone**: the server package, the
Docker containers and volume, the extension and the install paths all go by that name.

- [What it does](#what-it-does)
- [How it works](#how-it-works)
- [Install the extension](#install-the-extension)
- [Run a server](#run-a-server)
- [Configure your streamer](#configure-your-streamer)
- [Using it](#using-it)
- [Configuration](#configuration)
- [Other streamers and platforms](#other-streamers-and-platforms)
- [Server API](#server-api)
- [Development](#development)
- [Advanced: a self-hosted update channel](#advanced-a-self-hosted-update-channel)
- [Repository layout](#repository-layout)
- [Privacy and security](#privacy-and-security)
- [Limitations](#limitations)
- [Status, licence and trademarks](#status-licence-and-trademarks)

## What it does

**Commentary in sync**
- **Syncs itself by sound, live and on replays.** Streamers pass F1 TV's own sound through under their voice
  (its track sound, or the international feed). fone hears F1 TV's sound in its own player and
  finds it in the stream, so it knows which moment of the stream goes with which picture, to a
  few hundredths of a second, with no delay to tune: it looks again every 15 s and follows the
  streamer's latency as it moves (it moved 4.4 s over one race). It brings the commentary there
  by easing its speed up or down by 2 % at most, so you don't hear it correct. It jumps only when
  easing would leave it out of sync for minutes: the first time it finds the sound more than
  1.5 s from where the saved delay put it, or a step of more than 3 s (the streamer reloading).
  A nudge of yours is kept on top, as a preference. Live, from the stream pulled into the
  browser; on a replay, from the server's recording (at 1×: at 1.5×/2× it keeps the place it
  found, which is saved for the video). It needs the streamer to
  pass F1 TV's sound through (the panel says "by sound" when it has it; Details says what it
  hears, and "lost" after 10 minutes without it). The panel's **Sync** row switches between by sound and by hand, and the F1 TV row says when F1 TV's own sound is off because the stream's copy plays.
  When a look finds the sound somewhere else (the stream skipped or repeated a little), the next
  look comes 5 s later instead of 15, so the commentary is put back within ~20 s. **⟳ resync
  sound** (or `R`) looks again at once and puts the commentary where the first sure match says
  (by hand too: found once, then left to your nudges).
- **Old replays play the streamer's Bilibili replay.** A session your server has nothing for
  (its recordings are kept for weeks; or the recorder missed it) plays the streamer's own
  直播回放 from their Bilibili space, streamed as you watch: fone finds the replay of that
  session and this moment in it by the clock on the streamer's screen (your server reads their
  MultiViewer header off the replay's video, the session and its clock, and the session's timing
  says when it showed that: placed within ~10-20 s, F1 TV's sound then taking it the last second;
  without a clock to read (no MultiViewer on their screen, or the session's timing not there yet),
  by F1 TV's sound alone: its title only says which hour the stream started in,
  so the first look takes 10-60 s, F1 TV at 1× meanwhile; where the race sound is faint under the
  streamer's voice no one look is sure, so the likeliest places are checked against the sound F1
  TV plays on with, and the first found there again is taken), cuts Bilibili's ~4 s repeats
  every half hour and any other stretch Bilibili's recording has twice (a whole ~5 s segment now
  and then: found a minute ahead of what plays, so it's never heard twice and never puts the
  commentary 5 s late), turns F1 TV's own sound off and keeps it in sync by sound, with the replay's own
  弹幕 (the live chat on it), and the streamer window (📺) shows the replay's own picture, their
  timing tower and map with it. Where it was is kept for the video, a nudge for the replay; by
  hand, it's still found by sound and then left to your nudges. Needs a server that knows the
  channel's Bilibili room (`FONE_ROOMS`): the replays are found through it.
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
- **The streamer's delay is measured, not guessed**, where they show MultiViewer's "Track time"
  clock on screen: the server reads that clock off their stream (tesseract OCR) to measure how
  far behind real time they are, per recording. It reads FLV recordings, with the picture
  (录播姬's). A streamer without MultiViewer on screen is synced by sound, or by ear.
- **Seek, pause, 1.5×, 2×.** Speeds keep the commentary's pitch. F1 TV's player constantly nudges
  its real speed to stay in step with its own clock, by up to ±25%; fone tells those nudges apart
  from a real speed change, so the commentary doesn't click or jump.
- **F1 TV's own sound, two settings instead of F1 TV's menus.** fone picks F1 TV's sound on every
  video (F1 TV starts each one on its own default): its commentary-free *Track FX*, the circuit's
  sound under the commentary (the default), or *English Int.*, the international English
  commentary. And F1 TV's subtitles, on or off (kept, not switched in F1 TV's player yet). F1 TV's
  own mute button silences F1 TV: fone keeps that through every video, channel switch and page
  load until you unmute it there, and still hears F1 TV's sound for sync by sound. Live, it also
  switches F1 TV to INTERNATIONAL, the world feed the streamer watches (the settings page turns
  that off, or leaves F1 TV's sound to you).
- **Sponsor reels muted.** The streamer's pre-recorded sponsor clips are found in the recordings
  of the channel they were made for (live within ~4 s) and muted: the clips the server image
  carries are 胡闹P房's and matched on that channel only; your streamer's take a reference set of
  your own (`FONE_ADS_REFS`, [Configure your streamer](#configure-your-streamer)), and
  `FONE_ADS_CHANNELS` names the channels a set is matched on. Live, a break's clips are
  recognised one by one, a couple of seconds into each: the mute holds past each clip's end
  until the server knows whether another follows, so nothing slips out between them, and the
  commentary fades back in after the break.

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
- F1 TV shrinks to the top-left 77% of the tab. The timing tower runs down the right edge to the
  picture's bottom, in the streamer's order: places gained since the start, interval, gap, best
  and last lap (IN PIT / OUT in its place), the tyre history (the set on now and its age, then the
  ones before with their laps). Old sessions the server never captured have it too, rebuilt from
  OpenF1's history.
- Below it: session conditions (flag, clock, weather), a track map with every car and the corner
  numbers, and up to four **driver onboards**. These are F1 TV's own onboard feeds, drawn by F1
  TV's player in step with the main picture.
- The stats always show the moment on your screen, never later, so nothing gets spoiled. Live,
  the car positions on the map come from your own F1 TV login, read in the browser.
- A window much wider than tall has no room under the picture: the stats go in a column on the
  right instead. The **Onboards** switch (or O) shrinks the picture until onboards fit.
- **Their screen** (the switch in the map's top-right corner, or T): the streamer's own timing
  screen instead of fone's, cut up into the same panels, found on their screen whatever the
  session's layout. For a streamer who shows MultiViewer's timing screen: it's cut out of their
  picture.

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
- **Recording gate:** keeps the Bilibili recorder to F1 streams by their title. Game streams are
  stopped and their stubs deleted (`GATE_ACTION=stop`; until then it only logs what it would stop).
- **Backfill:** when the recorder missed part of an F1 stream (by the gate's titles), the server
  waits for the streamer's official replay (直播回放), downloads it and places it on the wall
  clock to fill the gap.
- **Video handoff:** the recording's own picture and sound as HLS, to keep watching the streamer
  after F1 TV ends (FLV recordings only).
- **Self-updating extension** for a self-hosted build, on Windows (loaded from a network share)
  and on a Mac (synced by a launchd job), never mid-viewing
  ([Advanced](#advanced-a-self-hosted-update-channel); a release install is updated by hand).
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

## Install the extension

1. Download `fone-extension-<version>.zip` from the repository's
   [latest release](https://github.com/Gilbert-Wang-30/f1tv-commentary-sync/releases/latest) and
   unzip it into a folder you keep (it holds one folder, `fone`). Releases are packaged from
   1.0.1 on (`SHA256SUMS` beside the zip); before that, load the `extension` folder of a clone
   (below).
2. In Chrome (or Edge, Brave), open `chrome://extensions`, turn on *Developer mode*, choose *Load
   unpacked* and pick that `fone` folder.
3. fone's settings open by themselves. Chrome tucks a new extension's icon under the puzzle piece
   in its toolbar: pin fone there to get back to them, or use **⚙** in fone's panel on F1 TV.

**Updating:** extract the new zip into the folder that holds your `fone` folder, so its `fone`
replaces the old one's files (Windows: *Extract All…* → *Browse* to that folder, not the
`fone-extension-…` one it offers → *Replace the files in the destination*; macOS, Linux:
`unzip -o fone-extension-<version>.zip -d <that folder>`), then click ↻ on fone's card in
`chrome://extensions`. The same folder keeps the same extension, and with it your settings (a
copy loaded from another folder is another extension, starting from scratch). A release
install doesn't update itself: the repository's releases page says when there's a new one.

From source, the `extension` folder of a clone loads the same way (with its tests in it).

Then either paste the streamer's live URL (just the extension, below) or [run a server](#run-a-server).

### Just the extension

1. In fone's settings, under **This computer (no server)**, paste the streamer's live page
   (`https://live.bilibili.com/<room>`, `https://www.twitch.tv/<name>`,
   `https://www.youtube.com/@<name>`, `https://live.douyin.com/<id>`, `https://www.huya.com/<room>`)
   or a stream URL. *Test stream* asks the platform whether it's live; *Save*.
2. Open the F1 TV live session. fone connects to the stream and the panel turns green with
   **Live** once the commentary is playing. Set the delay by ear once (`[` `]` for ½ s, `-` `=`
   for 0.1 s, `,` `.` for 0.02 s). It's remembered for that stream.

What works without a server: live sessions, edge to edge, rewinding as far as the buffer goes,
Go live, sync by sound, the streamer's picture (📺: Bilibili, Douyin, Huya) and their live page
(↗). Replays, the stats, 弹幕, sponsor muting and the measured delay need a server (the table at
the top).

F1 TV's own sound plays under the commentary (its Track FX: no commentary of its own). The
streamer's stream carries their F1 TV sound too; synced by sound, the two line up to a few
hundredths of a second. Hear an echo all the same (a nudge away from where the sound puts it, a
stream without F1 TV's sound to sync by): F1 TV's own mute button silences F1 TV, and fone keeps
it so. The extension records only while an F1 TV live video (or one it can't yet tell from a
replay) is open in a tab, and ten minutes after; on a replay it stops. The recording starts when
the live video is opened and keeps only the last *Keep the last … minutes* (15 by default), in
memory, never on disk: to rewind to the start of a session, open the live video before the
session starts and raise that setting to the session's length.

The buffer takes about 1–2 MB of memory a minute: it holds the streamer's own audio, typically
128–256 kbps. On the network that audio is all it takes on Twitch, YouTube and Douyin. Bilibili
and Huya have no audio-only stream, so it pulls their smallest video and keeps the audio:
Bilibili's anonymous 超清, the lowest it offers logged out, can be 0.5–1.3 Mbit/s.

## Run a server

The server records the streamer around the clock, so it runs on a machine that's on when they
are live: a home server, a NAS, a small VPS. It needs Docker with Compose v2 and a folder for the
recordings with room for a few weeks of them (fone's recorders' files are deleted 21 days after
they end). The image is `ghcr.io/gilbert-wang-30/fone` for amd64 and arm64, from 1.0.1 on:
`:<version>` for one release (`docker-compose.yml` names the one it came with), `:<major>.<minor>`
and `:latest` for the newest. How a release is made: [docs/releasing.md](docs/releasing.md).

### 1. The server

```bash
git clone https://github.com/Gilbert-Wang-30/f1tv-commentary-sync fone && cd fone   # or a release's source archive
cp .env.example .env                  # then edit it: FONE_RECORDINGS at least (below)
mkdir -p /srv/recordings/fone /srv/recordings/fone-import    # your FONE_RECORDINGS, and these two in it
docker compose up -d                  # the server alone, on port 8788
```

`.env` holds everything that's yours; `docker-compose.yml` reads it and has nothing of anyone's
setup in it. `FONE_RECORDINGS` is the folder every recorder writes under, a folder per streamer:
the server reads all of it (read-only), backfill writes into `fone-import/`, fone's own
recorders into `fone/`. A folder that doesn't exist stops the container with an error rather
than being created empty. `.env.example` says what each setting does; the
[Configuration](#configuration) tables list them all.

The status page is at `http://<host>:8788/`. The server keeps everything it computes in the
`fone-data` volume: audio HLS, analysis results, timing archives, danmaku and SQLite. What the
configuration leaves out (no Bilibili room, a missing folder) is said in its log at start
(`docker logs fone`), on the status page and in the settings' *Test connection*. A server built from source instead of pulled: `FONE_IMAGE=fone:dev` in `.env`,
then `docker compose build fone`.

### 2. A recorder: configure your streamer

The server needs the streamer recorded **before** they go live. See
[Configure your streamer](#configure-your-streamer): a Bilibili room (`FONE_ROOMS` and the
`recorder` profile), any other site (`FONE_STREAMS` and the `streamlink` profile), or a recorder
you already run.

### 3. The extension

In fone's settings choose **A fone server** and enter its address, `http://<host>:8788`
(`192.168.1.20` or `my-server:8788` is read as that), one per line, tried in order: an address
that works away from home first (a VPN name, say), the LAN one second. *Test connection* shows
which one answers, the server's version, its channels, whether it has the channel's Bilibili
room and what its setup leaves out. The page also sets the commentary channel, live auto-hold and whether live comes straight
from the streamer's Bilibili room (on by default). With a server line it can't use (`ftp://…`,
a `user:password@`), *Save* says which and why and keeps the server list as it was; the rest of
the page is saved.

## Configure your streamer

Everything about the streamer is in `.env` (server) and fone's settings (extension). One
setting per thing, wherever it's used.

**A Bilibili streamer** (录播姬, BililiveRecorder, records them). In `.env`, the room and the
name fone shows for it (room=channel: the number in `live.bilibili.com/<room>`), and the
`recorder` profile, so `docker compose up -d` starts the recorder too:

```ini
FONE_ROOMS=12345678=MyStreamer
COMPOSE_PROFILES=recorder
```

Then the credentials for the recorder's HTTP API, shared with the gate (gitignored), and up:

```bash
printf 'BREC_HTTP_BASIC_USER=fone\nBREC_HTTP_BASIC_PASS=%s\n' "$(openssl rand -hex 16)" > recorder/api.env
chmod 600 recorder/api.env
docker compose up -d
```

- **fone-recorder:** a dedicated 录播姬 for the rooms in `FONE_ROOMS`, in original quality, with
  millisecond file names, a folder per room number (which `FONE_ROOMS` names) and no webhook.
  Its `config.json` (in `<FONE_RECORDINGS>/fone/`) is written from `recorder/config.json` on its
  first start (`recorder/seed.sh`) and is 录播姬's own after that (rooms you add in it stay): to
  seed it again from `FONE_ROOMS`, stop fone-recorder, delete that file and start it. With no
  room in `FONE_ROOMS` it doesn't start (`docker logs fone-recorder` says so) rather than record
  nothing; a `config.json` with no room is written again once `FONE_ROOMS` names one. A room
  number alone (`FONE_ROOMS=12345678`) is a channel of that name.
- **fone-recorder-gate:** judges each stream by its title: F1 (`GATE_RECORD`; by default F1/F2/F3,
  Formula, Grand Prix, GP, FP1-3, Qualifying, Sprint, Race and the Chinese session names) or not
  (`GATE_SKIP` for titles never to record). Until `GATE_ACTION=stop` it only logs what it would
  stop (`docker logs fone-recorder-gate`); with it, it stops a recording whose title isn't F1
  (deleting the seconds-long stub that leaves) and starts it again if the title turns F1. A
  streamer who tags their F1 streams is best caught by the tag: `GATE_RECORD` replaces the
  default, so keep the words in it, e.g. `GATE_RECORD='【MyStreamer】|F1|Formula|大奖赛|排位赛|正赛'`.
  `python3 recorder/gate.py --check < titles.txt` tries a filter on titles. The server's backfill
  goes by the same filter: it fills by itself only a live with a title the gate keeps.
- **fone-janitor** (with the `recorder` or the `streamlink` profile): deletes what fone's
  recorders write (`<FONE_RECORDINGS>/fone/`) and backfill's imports 21 days after they end
  (`FONE_KEEP_DAYS`), hourly. It never touches another recorder's folders.

`FONE_ROOMS` also gives the server the room's live-status log and backfill, the 弹幕, and the
extension live straight from the room, the ↗ Live page and the streamer's Bilibili replays.
Without it the recordings still play; the server's log and *Test connection* say what's missing.

**A recorder you already run** (another 录播姬, blrec, …): point `FONE_RECORDINGS` at its output
root. Each folder in it is a channel, named after the folder (`FONE_CHANNEL_ALIASES=folder=channel`
renames one: 录播姬's own default template names folders after the account and room). Its file
names must start with the moment the recording started (`server/fone/recordings.py` reads
录播姬's `yyyyMMdd-HHmmss-fff`, streamlink's microseconds and coarser forms), in
`FONE_FILENAME_TZ`: 录播姬's default template writes Beijing time, the default here. A recorder
writing another zone puts its recordings hours off; the server's log warns when a file's name
and its last write disagree by whole hours.

**A streamer on another site** (YouTube, Twitch, Douyin, Huya, Kick, … anything streamlink plays):

In `.env`, channel=URL (several separated by spaces) and the `streamlink` profile, then build and
start it:

```ini
FONE_STREAMS=mystreamer=https://www.twitch.tv/mystreamer
COMPOSE_PROFILES=streamlink
```

```bash
docker compose --profile streamlink up -d --build fone-streamlink
```

Name the service: without it, `--build` also builds the fone server from the working tree. The
profile starts fone-janitor too, which deletes its recordings after `FONE_KEEP_DAYS` (21). Its
recordings are MPEG-TS, audio only by default, in the same layout; see
[Other streamers and platforms](#other-streamers-and-platforms) for what that leaves out.

**Their delay:** `FONE_DEFAULT_DELAY` is where a video nothing is known about starts (seconds
your streamer lags the race; 40 by default). Sync by sound and the measured delay replace it
where they can; a nudge of yours is kept per video.

**Their sponsor clips:** the clips the image carries are 胡闹P房's, matched on that channel only.
To mute your streamer's: cut each clip from a recording as an 8 kHz mono WAV, build `refs.npz`
with `server/fone/ads/build_refs.py` (see `server/fone/ads/ads.json`'s note), put it in a folder
the container sees (e.g. `/data/ads`, in the `fone-data` volume) and set `FONE_ADS_REFS` to that
path in `.env`. It's then matched on every channel, or on those `FONE_ADS_CHANNELS` names.

## Using it

Open any F1 TV video. The fone panel sits top-right:

| | |
|---|---|
| **delay −5 … +5** | nudge the commentary, in steps of 5, ½, 0.1 and 0.02 s. Hear the reaction **after** the action? `+`. Before it (spoilers)? `−`. Saved per video on the server; live from the stream pulled into the browser (without a server, or a server's Bilibili channel live), per stream in this browser. The fine steps are for nulling an echo against F1 TV's own sound by ear, where the engine then holds the alignment to a millisecond for hours. |
| the panel's head | click: open or close the panel; drag: put it anywhere on the page (kept for this browser); double-click: back to its corner |
| **⚙** (in the head) | fone's settings page (highlighted while there's nothing to play from: no stream or server set) |
| 🔊 and the slider | mute and volume of the commentary |
| **0.5× 1× 1.5× 2×** and **◂ ▸** | replay speed (live stays 1×); ◂ ▸ pause F1 TV and step it a frame back / on, to watch a move frame by frame (the frame's length measured from the picture) |
| **📊 Stats** and **⧉** | the stats beside the video, or in a window of their own: the timing tower in the streamer's order (places gained since the start, interval, gap, best and last lap, the tyre history newest first; a car in the pits or out says so in its last lap's cell), the conditions, the track map, onboards with `O`. **Their screen** (in the map's corner, or `T`) shows the streamer's own timing screen instead, cut up into the same panels: fone finds each part on their screen whatever the session's layout (the overview's two columns of drivers or the race tab's one wide table, at whatever size and place, the map's window wherever it is), so their table fills the tower (slimmed when narrow; race control under it where there's room), their session bar the conditions (cut into its pieces and laid out as large as the panel takes them) and their map the map. A session fone has no timing for at all shows their screen either way |
| **📺 Streamer** and **⧉** | the streamer's picture in step with the commentary: a window over F1 TV (move it by its bar, size it by its corner), or in a window of its own |
| **↗ Live page** | the streamer's live page on their platform, in a new tab (on a Bilibili replay: that replay, at the moment playing) |
| **弹 弹幕** and **⚙** | danmaku on/off and their settings |
| **F1 TV: Track FX / English Int.** | F1 TV's own sound under the commentary, picked on every video (F1 TV starts each one on its own default). *Track FX* (default): its commentary-free track, the circuit's sound (team radio isn't filled in yet). *English Int.*: its international English commentary (the world feed's), not F1 TV's own *English F1 Live*. A track you pick in F1 TV's own menu is kept for that video. To silence F1 TV, use its own mute button: fone holds that through every video, channel switch and page load until you unmute it there, with the button or by dragging F1 TV's volume up (fone turns F1 TV's sound down itself rather than muting F1 TV's player, so sync by sound goes on hearing it; the panel says "muted with F1 TV's button"). Live, a mute F1 TV makes itself is held the same way until F1 TV sets up its player afresh (the next video), the panel saying "muted in F1 TV" |
| **Own sound: auto off / on** | F1 TV's own sound while fone plays the stream's copy of it (a Bilibili replay, or locked by sound). *auto off* (default): off, so it isn't heard twice. *on*: kept on under the commentary, for when the stream's copy isn't right (an F1 TV replay without Track FX, say) |
| **Subtitles: on / off** | F1 TV's own subtitles (default off; kept and handed to F1 TV's page, not switched in the player yet) |
| **Picture: auto / best** | how sharp F1 TV's picture is (what its player is playing, e.g. 1080p50, and the feed's sharpest); *best* pins its sharpest quality, *auto* leaves it to F1 TV, which adapts to your connection. In Chrome F1 TV's sharpest is 1080p: it streams 4K only to its Apple TV and Roku apps. fone also turns on the Quality list in F1 TV's own ⚙ menu |
| *Anticipate reactions* | with a measured delay: play the commentary 0.9 s early, so reactions land on the action instead of after it (off by default: with it on, the streamer's pass-through F1 TV sound runs 0.9 s ahead of the picture) |
| *Pause video when ahead of live commentary* | live auto-hold. Without a server, when the stream stops arriving (the streamer offline, or nothing for 30 s) the panel says so and F1 TV is let go rather than held |
| **⏭ Go live** | F1 TV and the commentary to the freshest moment both have (also `L`, or F1 TV's LIVE badge) |
| **⟲ Re-sync** | lock the commentary to the live edge again at the delay set |
| Details | the sync's internals: clock, anchor, delay source, drift; without a server, what the recording holds and how fast it comes in |

The settings page (⚙ in the panel, or fone's toolbar icon) has F1 TV's sound and subtitles too, and under
*Advanced*: **Let fone pick F1 TV's sound track** (on by default; off, F1 TV's sound is left as
you set it in F1 TV's own menu) and **Live: switch F1 TV to INTERNATIONAL** (on by default: the
world feed the streamer watches, with its graphics and replays, instead of F1 LIVE, once per
video, by F1 TV's own channel switcher; go back to F1 LIVE yourself and it's left there; replays
are left as they are).

| Key | |
|---|---|
| `]` / `[` | commentary 0.5 s sooner / later |
| `}` / `{` | 5 s sooner / later |
| `=` / `-` | 0.1 s sooner / later |
| `.` / `,` | 0.02 s sooner / later; while F1 TV is paused on a replay, a frame on / back |
| `\` | mute the commentary |
| `\|` | collapse the panel |
| `L` | go live |
| `>` / `<` | replay speed up / down |
| `S` | stats beside the video |
| `O` | stats ↔ onboards layout |
| `T` | the stats' timing: fone's own ↔ the streamer's screen, cut up |
| `R` | resync by sound now |
| `D` | danmaku on / off |
| `V` | the streamer's picture on / off |

**By sound:** with sync by sound locked (the panel says "· by sound"), there's no delay to
set: fone keeps it, and keeps the last one it measured for the stream (live) or the video (a
replay, on the server) to start from next time.
A nudge then is a preference on top ("I like it half a second earlier"), kept per stream; one
while it's still easing a correction in counts toward that correction first. Without the
streamer passing F1 TV's sound through, it's the delay as below.

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

`docker-compose.yml` reads `.env` (copy `.env.example`, which says the same as these tables):

| In `.env` | Default | |
|---|---|---|
| `FONE_RECORDINGS` | (required) | the recordings' folder on the host, a folder per streamer: mounted read-only at `/rec`, except `fone-import/` (backfill's); fone's recorders write into `fone/`. Both must exist |
| `FONE_IMAGE` | `ghcr.io/gilbert-wang-30/fone:1.0.1` | the server image (`docker compose build fone` builds `./server` under this name) |
| `FONE_PORT` | `8788` | the server's port on the host |
| `FONE_CPUS` | `0` | a cap on the server's CPUs (0: none) |
| `COMPOSE_PROFILES` | | optional services `docker compose up -d` starts too: `recorder` (fone-recorder, its gate, the janitor), `streamlink` (fone-streamlink, the janitor), `ext-update` (fone-ext, [Advanced](#advanced-a-self-hosted-update-channel)) |
| `FONE_UID`, `FONE_GID` | `1000` | the user the recorders write as |
| `GATE_RECORD`, `GATE_SKIP` | F1 words | the gate's title regexes (Python, case-insensitive): titles to record, titles never to; backfill's too |
| `FONE_BACKFILL_RECORD`, `FONE_BACKFILL_SKIP` | the gate's | the titles of the lives backfill fills by itself, if not the gate's (one imported by hand is any) |
| `GATE_ACTION` | `log` | `stop`: the gate stops a recording whose title isn't F1; `log`: it only says so |
| `FONE_STREAMS` | | fone-streamlink's `channel=URL …` |
| `FONE_STREAMS_QUALITY`, `FONE_STREAMS_RECORD` | audio only; any | its stream names, first available wins; a title regex (`grep -E`) to wait for |
| `FONE_KEEP_DAYS` | `21` | the janitor: days fone's recordings and backfill's imports are kept |
| `FONE_EXT_DIST` | `./fone-dist` | fone-ext: the folder `tools/publish_ext.sh` fills |

`FONE_FILENAME_TZ` in `.env` is both the server's and the recorders' (their `TZ`). The server
reads environment variables; `docker-compose.yml` passes these through from `.env` (another
one: add it under the fone service's `environment:`):

| Variable | Default | |
|---|---|---|
| `FONE_REC_DIR` | `/rec` | recordings root, scanned recursively (a folder per channel) |
| `FONE_DATA_DIR` | `/data` | everything the server writes |
| `FONE_FILENAME_TZ` | `Asia/Shanghai` | the time zone of the recordings' file names (录播姬's default template writes Beijing time); fone's recorders write theirs in it |
| `FONE_ROOMS` | | `room=channel,…` Bilibili rooms: fone-recorder's rooms (on its first start), the live-status log and backfill, 弹幕, and in the extension live straight from the room, ↗ Live page and Bilibili replays. A folder named after a room's number is that channel; a room number alone is a channel of that name; anything else is skipped, and the log says so |
| `FONE_CHANNEL_ALIASES` | | `folder=channel,…`, for a recorder folder that isn't the name you want (录播姬's default names folders after the account and room) |
| `FONE_IMPORT_DIR` | | where backfill writes the replays it imports (compose: `/rec/fone-import`) |
| `FONE_DEFAULT_DELAY` | `40` | streamer delay (s) before anything is known: your streamer's typical lag |
| `FONE_REACTION_SECONDS` | `0.9` | the streamer's reaction time, added to the measured screen delay when the panel's *Anticipate reactions* is on |
| `FONE_ADS_REFS` | the bundled set | a folder with sponsor clips' `refs.npz` (or their WAVs): your streamer's |
| `FONE_ADS_CHANNELS` | the set's own | channels the clips are matched on, `a,b` or `*`: the bundled set (胡闹P房's) on its own channel, a set of yours on every channel |
| `FONE_SCREENCLOCK_TZ` | | UTC offsets (`+08:00,…`) the streamer's MultiViewer clock may show besides the circuit's and `FONE_FILENAME_TZ`'s |
| `FONE_SEGMENT_SECONDS` | `2` | HLS segment length |
| `FONE_VERSION` | the image's | what `/api/health` says the server is (a release's image carries its version, a local build `dev`) |
| `FONE_TIMING`, `FONE_ADS`, `FONE_SCREENCLOCK`, `FONE_VIDEO`, `FONE_BACKFILL`, `FONE_DANMAKU`, `FONE_VODCLOCK` | `1` | each optional service; `0` turns it off (`/api/health` lists the running ones) |
| `FONE_TIMING_RECORD` | `1` | capture live sessions' timing from 15 min before the start (while F1's archive refuses, since 2026-10-18, the stats' best source: the rest is rebuilt from OpenF1) |
| `FONE_TIMING_OPENF1` | `1` | rebuild the timing of a session the server didn't capture from OpenF1's history (any past session, any year; half an hour after it ends) |
| `FONE_TIMING_KEEP_DAYS` | `30` | stored timing older than this is deleted: OpenF1's rebuilds always (made again when asked for), live captures and archives only while F1's archive answers (it could give them back) |
| `FONE_DANMAKU_CAPTURE`, `FONE_DANMAKU_ARCHIVE` | `1` | the two danmaku sources: our own listening, and danmakus.com for the rest |
| `FONE_DANMAKU_KEEP_DAYS` | `30` | how long danmaku are kept |
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

**With a server**, nothing about a streamer is hard-coded in the sync; it lives in these
settings ([Configure your streamer](#configure-your-streamer) walks through them). The last
column is the one this was built for, 胡闹P房 (room 23954427, an older 录播姬 seed that named
its folder after the account, 马莎拉车), as an example:

| knob | where | e.g. 胡闹P房 |
|---|---|---|
| The room to record | `FONE_ROOMS` in `.env` (seeded into fone-recorder on its first start; after that the recorder's own `config.json` in `<FONE_RECORDINGS>/fone/`) | `23954427` |
| Room ↔ channel: backfill, 弹幕, live straight from the room, ↗ Live page, Bilibili replays | `FONE_ROOMS=room=channel,…` | `23954427=胡闹P房` |
| Recorder folder ↔ channel name | a room-number folder is named by `FONE_ROOMS`; any other by `FONE_CHANNEL_ALIASES=folder=channel,…` (only if the folder isn't the name you want) | `马莎拉车=胡闹P房` |
| Which streams the gate keeps | `GATE_RECORD` / `GATE_SKIP`, regexes on the stream title, and `GATE_ACTION=stop` to act on them (`recorder/gate.py`; the default matches F1 session words in English and Chinese) | `胡闹P房\|F1\|F2\|…\|排位赛\|正赛\|…` (their `【胡闹P房】` tag, then the words) |
| Their sponsor clips, so they can be muted | a reference set: cut WAVs of the clips from a recording and build `refs.npz` with `server/fone/ads/build_refs.py` (its notes in `server/fone/ads/ads.json`), then `FONE_ADS_REFS`; a changed set re-analyses every recording | three clips, the set in the image |
| The measured delay | needs **MultiViewer's "Track time"** clock visible on the streamer's screen, in an FLV recording with the picture (录播姬's): the screenclock service reads FLV only, so `fone-streamlink`'s MPEG-TS recordings get none. Without it, every video starts from `FONE_DEFAULT_DELAY` or your last tweak, and you tune by ear once per video | on screen |
| The starting delay | `FONE_DEFAULT_DELAY` (seconds the stream lags real time) and `FONE_REACTION_SECONDS` | `40`, `0.9` |
| The channel the extension plays | the options page's *Commentary channel* (empty = whichever was recorded most recently: on a server with several streamers, pick one) | empty |
| The server | the options page's *Server URLs*; `FONE_SERVERS` in `tools/publish.env` for the defaults of a self-hosted build | — |

The commentary must be a **live** stream recorded as it airs, by 录播姬, `fone-streamlink` or any
recorder that names files with the moment they start (`server/fone/recordings.py` reads
`yyyyMMdd-HHmmss-fff`, streamlink's microseconds and the coarser forms): the sync maps each
second of audio to the wall-clock time it aired, which only a live recording has. A streamer
recorded by `fone-streamlink` gets the sync, the stats and, once their clips are in the
reference set, sponsor-clip muting. They get no measured delay and no video handoff: both read
FLV recordings only, and `fone-streamlink` writes MPEG-TS, by default audio only. Backfill and
弹幕 are Bilibili's (`FONE_ROOMS`).

## Server API

Open to anything that can reach the port: the status page (`/`), `/api/health`,
`/api/channels`, the commentary audio (`/api/playlist.m3u8`, `/hls/…`), 弹幕 (`/api/danmaku`),
sponsor clips (`/api/ads/…`), the screen clock (`/api/screenclock/…`) and the services' status
(`/api/timing/status`, `/api/danmaku/status`, `/api/backfill/status`). Everything else, the
writes and the reads that start work or hand out what viewers played (`/api/timeline`,
`/api/f1tv`, `/api/sync`, `/api/timing/session/…`, `/api/timing/content/…`, `/api/video/…`,
`/api/vod/…`, `GET /api/diag`), answers only the extension (its `chrome-extension://` origin,
or no origin and the header `X-Fone: 1`, which it sends on every request) or a script that sends
no origin and `X-Fone: 1` (`curl -H 'X-Fone: 1' …`; `tools/diag.py` sends it). Anything else
gets 403, a web page included ([Privacy and security](#privacy-and-security)).

| | |
|---|---|
| `GET /api/health` | the server's version, services running, recordings seen, what the setup leaves out (`notes`) |
| `GET /api/channels` | channels and whether they're live |
| `GET /api/timeline?channel=&from=&to=` | the commentary's pieces (wall clock ↔ playlist), files, sponsor mutes |
| `GET /api/playlist.m3u8`, `/hls/{file}/{segment}` | the commentary audio |
| `GET /api/f1tv/{contentId}` | an F1 TV video: session, anchor `p0`, onboard streams |
| `GET /api/vod/clock?bvid=&key=` | where the streamer's Bilibili replay runs on the session's clock, read off their screen |
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
# server: 250+ tests (8 skip without the real recordings, below); -rs lists the skipped ones
docker build -t fone:dev server
docker run --rm -v $PWD/server:/app -w /app -e PYTHONDONTWRITEBYTECODE=1 \
  fone:dev sh -c 'pip install -q pytest && python -m pytest -q -rs -p no:cacheprovider tests'

# extension unit tests: sync maths, dashboard layout, danmaku, self-update, live positions,
# the in-browser recorder (demuxers, buffer, playlists), sync by sound, F1 TV's settings, the
# settings page, team radio, Bilibili replays, the streamer's screen
# (from the repository root: livepos.test.js reads server/tests/fixtures)
docker run --rm -v $PWD:/r -w /r/extension node:22-alpine \
  sh -c 'for t in *.test.js; do echo "== $t"; node "$t" || exit 1; done'

# the recorder gate's title filter and actions (stdlib only; in the whole checkout: one test
# reads the server's backfill words)
docker run --rm -v $PWD:/r:ro -w /r/recorder python:3.12-alpine python -m unittest -v

# lint (its rules in ruff.toml), and the release checks CI runs
docker run --rm -v $PWD:/w -w /w python:3.12-alpine sh -c 'pip install -q ruff==0.17.5 && ruff check server recorder tools'
python3 tools/check_version.py && tools/check_public.sh

# a live stream recorded for 30 s by the extension's own code, in Node (checks a platform works)
docker run --rm -v $PWD:/r -w /r node:22-alpine node tools/stream_probe.js https://live.bilibili.com/<room>

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

The server tests that need a real recording (the 2026-10-03 KL qualifying, 胡闹P房's, not in the
repository) skip without it. They find it under a recordings folder mounted at `/rec`
(`-v <recordings>:/rec:ro`), or `FONE_TEST_KL_FLV=<path>` (ads, video, backfill's start) and
`FONE_KL_FLV=<path>` (screen clock) point them at a copy mounted into the container;
`FONE_TEST_KL_REPLAY=<folder>` is that session's Bilibili replay download (`p1`/`p2_audio.m4a`,
backfill). `FONE_LIVE_TEST=1` lets one test connect to the real live-timing feed. `e2e/livepos/run.sh` runs on an internal Docker network (no traffic to F1 or Bilibili);
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
(`.github/workflows/ci.yml`) runs the unit and server tests, ruff and the release checks
(`tools/check_version.py`: one version everywhere; `tools/check_public.sh`: nothing of one
install's own setup in the tracked files) on every push; the offline e2e suites run on GitHub
by hand (`.github/workflows/e2e.yml`). `CONTRIBUTING.md` has the same commands.

- **Release:** a `v*` tag on main builds the extension's zip (`tools/build_ext.sh`) and the
  server image and publishes them as a GitHub Release with that version's `CHANGELOG.md`
  section ([docs/releasing.md](docs/releasing.md)). A self-hosted build: `tools/publish_ext.sh`
  ([Advanced](#advanced-a-self-hosted-update-channel)).
- **Read a browser's playback diagnostics:** `tools/diag.py --minutes 30 [--client …]`.
- **How the parts fit together:** `docs/architecture.md` (routes, data shapes, the messages
  between the extension's parts, the time-domain rules).
- **F1's data sources:** `docs/f1-data-sources.md` (F1 TV content API, MultiViewer, live timing,
  OpenF1: the endpoints and fields fone uses).
- **Contributing:** `CONTRIBUTING.md`.

## Advanced: a self-hosted update channel

How fone runs at home for its author, and a way to have every browser in a house on the same
build without unzipping releases: Chrome loads the extension unpacked from a network share, a
Mac keeps a synced copy, and installed copies reload themselves into a new build when one is
published and nothing is playing. Release installs don't use any of this.

1. Copy `tools/publish.env.example` to `tools/publish.env` (gitignored) and fill it in:
   `FONE_SERVERS`, the default servers written into the build's `local.js` (an address that
   works away from home first, the LAN one second); `FONE_EXT_DEST`, the share Chrome loads it
   from; `FONE_EXT_DIST`, what the update channel serves; `FONE_DIST_URL`, where a Mac reaches it.
2. In `.env`: `FONE_EXT_DIST` (the same folder) and `ext-update` in `COMPOSE_PROFILES`, then
   `docker compose up -d`: **fone-ext** serves that folder on port 8789.
3. `tools/publish_ext.sh` publishes a build: the extension with those defaults, `build.js` (which
   turns on the self-update) and `build.json`, the build installed copies poll on
   `<server>:8789`. Bump `extension/manifest.json`'s version first.

**Windows (or any machine on the LAN):** in `chrome://extensions`, turn on Developer mode,
choose *Load unpacked*, and pick the share's folder. Installed copies poll the update channel
and reload themselves when a new build is out and nothing is playing.

**Mac** (over the LAN, or a VPN such as Tailscale away from home):

```bash
curl -fsSL http://<host>:8789/install-mac.sh | sh
```

This installs `~/fone/extension` and a launchd job (`fone.sync`) that keeps it up to date every
minute. Load `~/fone/extension` unpacked once.

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
recorder/              the 录播姬 config template (seed.sh fills in FONE_ROOMS) and the F1-only gate
                       (test_gate.py); streamlink/: the any-site recorder
docker-compose.yml     the server and the recorders, settings from .env (.env.example)
e2e/                   end-to-end suites (Playwright in Docker)
tools/                 the release's packager and checks (build_ext.sh, check_version.py,
                       check_public.sh), publish, diagnostics, Mac install, replay import, stream_probe.js
docs/                  architecture, F1 data sources, releasing, README images
.github/workflows/     CI (tests, lint, release checks), the release, the offline e2e suites
CHANGELOG.md           what changed in each version (a release's notes)
```

## Privacy and security

- **The server has no login.** Anything that can reach port 8788 can read its open routes, so
  keep it on your LAN or a private network (a VPN such as Tailscale), never open to the
  internet. A web page you visit is refused everything but the open reads
  ([Server API](#server-api)): the writes (`PUT /api/sync`, the `POST` routes) and the reads
  that start work (a Bilibili replay's frames downloaded and read, an OpenF1 rebuild, old
  recordings extracted, F1 TV looked up) or hand out every viewer's playback history
  (`GET /api/diag`), whether it asks by `fetch` or with an `<img>`, a `<script>`, a link or a
  form. Those answer only the extension (its `chrome-extension://` origin, or no origin and the
  header `X-Fone: 1`) or a script that sends `X-Fone: 1` (`curl -H 'X-Fone: 1' …`;
  `tools/diag.py` sends it). A page's fetch carries its own origin, its `<img>`, link or form
  can't carry a header, and a fetch adding one needs a CORS preflight, which is refused: a page
  can't re-tune delays, start downloads or read what you watched. CORS allows the extension's
  origins only, so a page's script can't read the open routes' answers either.
- **Your F1 TV login stays in the browser.** The extension reads it there to connect to F1's live
  timing for car positions; only the positions go to the fone server.
- **Bilibili is listened to logged out.** Bilibili masks nicknames for that; the overlay never
  shows names anyway. Levels, medals, colours and stickers are all there. The server keeps
  danmaku for 30 days with the sender as a crc32 hash of their uid (what Bilibili's own replay
  files carry), not the uid.
- **Diagnostics are playback state** (positions, speeds, drift, seeks, the player's SDK calls and
  errors) and the engine's status text, plus a random client id, the build and the OS name, so
  two browsers can be told apart. No tokens, no cookies, no URLs. The extension and scripts on
  the network that send `X-Fone: 1` can read them (`GET /api/diag`; `tools/diag.py` sends it);
  web pages can't. Each day's file stops at 64 MB.
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
  VPN address you give it, the streaming platform you point it at, F1 TV's content API
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
  session the server didn't capture live (`FONE_TIMING_RECORD`) gets its stats from OpenF1's
  history instead (half an hour after it ends; a minute or so to build on first ask: a few
  seconds' lag on tyres after a pit stop, and in practice and qualifying "in the pits" from the
  in-lap's end). What was captured live is then the only copy and is kept; OpenF1's rebuilds are
  deleted after `FONE_TIMING_KEEP_DAYS` (30) and rebuilt when asked for again.
- An old replay from the streamer's Bilibili replays is placed by the clock on their screen only
  where the session's clock runs (before the session or in a break, by the nearest reading:
  their delay may have moved since, which sync by sound then corrects) and only if the session's
  timing is there (your server's, or OpenF1's half an hour after it). Without a clock to read it
  needs F1 TV's sound to be in the stream at the moment you're at: until fone hears it there (the
  streamer talking over a muted F1 TV, or before their stream began), it says it's still looking
  and plays nothing. F1 TV's sound should be what the streamer had on (Track FX or English Int.).
- Pre- and post-race shows and other non-session videos have no anchor: they play in *manual* mode
  and you line them up by ear.
- Danmaku from before fone listened (the danmakus.com archive) have no levels, colours or
  stickers, so the level filters can't apply to them.
- The commentary follows the main feed's timing. Switch F1 TV's main picture to an onboard and it
  runs ~7 s behind the main feed (MultiViewer's channel offsets), so nudge the delay to match.
- F1 TV's player can die on an audio-track switch (its own menu included); it then rebuilds
  itself from a position saved up to five minutes earlier. Turning off *Let fone pick F1 TV's
  sound track* in the settings avoids fone's track switches altogether; the diagnostics record the
  player's fatal errors when it happens.
- While fone holds F1 TV muted, F1 TV's button can show it unmuted for a moment (up to a quarter
  of a second): whenever F1 TV sets its player up afresh (a page load, the next video, a rebuild
  after a crash) it reads the player, which fone leaves unmuted for sync by sound, until fone
  tells F1 TV's controls again. The panel says when fone holds F1 TV muted.

## Status, licence and trademarks

A personal project, built for one streamer's watch-alongs and one living room, and released for
anyone to run with their own streamer, server and setup, as is. It is not affiliated with,
endorsed by or supported by Formula 1, F1 TV, Bilibili, Twitch, YouTube, Douyin, Huya,
MultiViewer or any streamer. It plays nothing it isn't entitled to: it works only with your own
F1 TV subscription (the extension runs in your browser, on your login) and with recordings you
make of a public live stream for yourself; nothing is redistributed. The APIs it reads are undocumented and may change or close at any time.

MIT licence, see `LICENSE`; the licences of what it bundles and runs are in `THIRD_PARTY.md`.
Formula 1, F1 TV, Bilibili, Twitch, YouTube, Douyin, Huya and MultiViewer are trademarks of
their owners.
