# Changelog

What changed in each version of fone. The extension and the server ship together under one
version, the extension's (`extension/manifest.json`); a release's section here becomes its
notes on GitHub ([docs/releasing.md](docs/releasing.md)). The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions are
`major.minor.patch`.

Before 1.0.1 fone was built and installed by its author alone (tools/publish_ext.sh, to his own
machines); those versions are summarised here from the git history.

<!-- Release checklist for a section: say what changed for someone running fone, not which
     file moved; give it its date when the tag is cut (tools/check_version.py insists). -->

## [1.0.1] - unreleased

The first release for other people: the extension as a zip to load in Chrome, the server as an
image to run with your own streamer, recorder and storage.

### Added
- GitHub Releases: `fone-extension-<version>.zip` holds one folder, `fone/`, to load unpacked
  (chrome://extensions → Developer mode → Load unpacked). To update, extract the next zip into
  the same place, so it replaces the files of that same `fone` folder (Windows: Extract All →
  the folder that holds `fone` → replace the files), and click ↻: Chrome keeps the extension
  and its settings while the folder's path stays the same. `SHA256SUMS` beside it.
- The server image on GitHub's registry, `ghcr.io/gilbert-wang-30/fone:<version>` (and
  `:latest`), for linux/amd64 and linux/arm64. It knows its version (`FONE_VERSION`, shown by
  `/api/health`) and has a Docker health check on `/api/health`.
- A release pipeline (`.github/workflows/release.yml`): a `v*` tag on main is checked against
  the manifest and this file, tested, packaged, smoke-run and published; run by hand it is a
  dry run that builds both architectures and publishes nothing.
- Checks on every push: each extension script parsed, every file the manifest and the pages
  load present in the zip, the recorder gate's tests, ruff on the server, the recorder and the
  tools, the version and this file in step, and no personal configuration committed
  (`tools/check_public.sh`: Tailscale names and NAS paths anywhere, home-network addresses
  outside the docs and `*.example` files, a filled-in `extension/local.js`, a `.env`).

### Changed
- Your own setup, not the author's: `docker-compose.yml` reads your recordings folder, rooms
  and channel aliases from a `.env` (start from `.env.example`) and runs the released image;
  the author's extension update server (fone-ext) only starts under its own profile.
- The README installs from a release; building and self-hosting the extension's updates
  (`tools/publish_ext.sh`, fone-ext, the Mac sync) is described as an advanced setup.
- `tools/publish_ext.sh` packages through `tools/build_ext.sh`, the release's packager, and
  publishes what it always did. A release zip has no `build.js`, so it never polls an update
  server.

### Fixed
- Bilibili replays: the clock on the streamer's screen and sync by sound no longer pull the
  commentary back and forth when the streamer's delay steps; no tight loop in the gap where a
  streamer restarted; a backward seek no longer confirms a wrong likely place; one replay that
  won't load no longer stops all of them; failing repeat scans back off; F1 Academy, F2 and F3
  replays are placed by sound without waiting five minutes for a clock that is never read; a
  replay published since the list was fetched is found.
- Server: pages you visit can no longer start downloads, OpenF1 rebuilds or extractions through
  GET requests; the screen clock retries a temporary failure, doesn't hold its two slots while
  waiting for timing, recomputes cached readings and survives one bad frame; the danmaku
  capture only counts time as heard once Bilibili answers; a browser's car-position upload no
  longer blocks that session's OpenF1 rebuild.

## [0.5.4] - 2026-11-17

### Added
- The panel moves by dragging its head (a click still opens or closes it, a double-click puts
  it back in its corner); its place is kept per browser.

### Changed
- F1 Academy, F2 and F3 replays on F1 TV, whose start is only a guess, are looked for ±4 min by
  sound until first found (was ±25 s).

## [0.5.3] - 2026-11-17

### Added
- The panel's F1 TV box: "Own sound: auto off / on", for replays without real Track FX, where
  the stream's copy can't match and the commentary is placed by the clock alone.

## [0.5.2] - 2026-11-17

### Added
- Bilibili replays placed by the clock on the streamer's screen: the server reads MultiViewer's
  header off the replay's video (`/api/vod/clock`), the session's timing says when it showed
  that, and sound matches far from that clock are refused. The sound search's range drops from
  10 to 3 minutes.

## [0.5.1] - 2026-11-16

### Changed
- A faint sound match is checked again against the sound heard after it instead of waiting for
  two looks in a row to agree (the 2026 Italian GP replay took 6.5 minutes to place); looks over
  the whole replay are rarer and no longer freeze the engine.

### Fixed
- The streamer's timing tower no longer loses its first column when a position changes colour.

## [0.5.0] - 2026-11-16

### Added
- Timing for sessions the server never captured, rebuilt from OpenF1's history.
- "Their screen" (T): the streamer's timing screen cut into the stats panels, its layout found
  in their picture.
- Resync sound (R).

### Changed
- The stats tower in the streamer's order, with places gained, intervals and tyre history.

### Fixed
- Bilibili's occasional repeated ~5 s segment is found ahead and cut, so the commentary isn't
  heard twice or 5 s late.
- F1 TV's best picture quality is asked for once (it was re-sent every second or two).

## [0.4.5] - 2026-11-16

### Changed
- Stats without timing keep the usual layout, each panel showing its part of the streamer's
  timing screen.

## [0.4.4] - 2026-11-16

### Added
- Stats for a session without timing show the streamer's own screen beside F1 TV; their
  picture at 1080p.

## [0.4.3] - 2026-11-16

### Added
- 0.5× speed, frame by frame (◂ ▸), and F1 TV's picture quality in the panel, with the
  sharpest pinned on demand.

## [0.4.2] - 2026-11-16

### Added
- The streamer window plays the Bilibili replay's own picture.

## [0.4.1] - 2026-11-16

### Changed
- A Bilibili replay is found in about 20 s (was 36-40); by hand works on it too; ↗ opens the
  replay's page at the moment playing.

## [0.4.0] - 2026-11-16

### Added
- The danmaku Bilibili kept with a replay, on the overlay in step with it; a nudge on a replay
  is kept for that replay.

### Fixed
- Server: a finished recording no longer reads as still growing while it is being indexed.

## [0.3.24] - 2026-11-16

### Fixed
- F1 TV not taking the chosen speed is asked again every 4 s until it does.

## [0.3.23] - 2026-11-16

### Fixed
- The diagnostics snapshot stays under the server's 4 kB on a Bilibili replay.

## [0.3.22] - 2026-11-16

### Changed
- A placed Bilibili replay turns F1 TV's own sound off at once; a replay's delay is shown
  against the streamer's usual 50 s.

## [0.3.21] - 2026-11-16

### Added
- Old replays the server has no recording for play the streamer's Bilibili 直播回放 of the
  session, found by F1 TV's sound, Bilibili's repeated seconds cut.

## [0.3.20] - 2026-11-12

### Changed
- Syncing by sound hides the nudge buttons; a stream once locked by sound has F1 TV's own sound
  turned down from the start; a first lock is quicker.

### Fixed
- Team radio starts on time by the clock instead of a second late after its sting.

## [0.3.19] - 2026-11-11

### Added
- A Sync row in the panel (by sound / by hand) that says when F1 TV's own sound is off.

### Changed
- Longer looks and a lock that holds for 10 minutes without a sure match.

## [0.3.18] - 2026-11-11

### Added
- Team radio filled in on Track FX replays, from OpenF1's copies of the messages, timed by the
  radio sting heard in F1 TV's sound.

## [0.3.17] - 2026-11-11

### Added
- F1 TV's own sound turned down while the stream carries it in step (no flanging).

## [0.3.16] - 2026-11-11

### Fixed
- F1 TV's sound is put back on the picture's own time, for its small speed trims.

## [0.3.15] - 2026-11-11

### Fixed
- F1 TV's sound captured from the video it plays outside the page (0.3.12-0.3.15 followed it
  through Web Audio, MediaStreams and detached media elements).

## [0.3.14] - 2026-11-11

### Fixed
- F1 TV's sound looked for in media elements never put in the page.

## [0.3.13] - 2026-11-11

### Fixed
- F1 TV's sound heard off its video's MediaStream.

## [0.3.12] - 2026-11-11

### Added
- The copy of F1 TV's sound reports what it sees in the diagnostics.

## [0.3.11] - 2026-11-11

### Added
- Sync by sound on replays from a fone server.

### Changed
- F1 TV's settings in the panel cut to two, sound track and subtitles; older settings migrate.

## [0.3.10] - 2026-11-11

### Added
- Live syncs itself by F1 TV's own sound in the stream: no more tuning the delay by ear, and the
  streamer's latency is followed as it moves.

## [0.3.9] - 2026-10-26

### Added
- The streamer's live page (↗) from the panel and the streamer window.
- `tools/platform_check.sh`: each platform checked against a stream live right now.

### Fixed
- Twitch without its pre-roll and stitched ads; Douyin's picture in the streamer window;
  YouTube says when a stream has ended.

## [0.3.8] - 2026-10-26

### Added
- Direct live from a server (the channel's room pulled into the browser), Go live, off-air
  shown as off air, and the streamer window (V): the stream's picture in step with the
  commentary (0.3.1-0.3.7).

### Changed
- The live lock measured by F1 TV's own player clock, the PC's clock corrected against the
  server's; new default delays.
- Sponsor clips muted through whole breaks.

## [0.3.0] - 2026-10-18

### Added
- Any streamer's commentary without a server: the extension records the live stream itself
  (Bilibili, Twitch, YouTube, Douyin, Huya, or any HLS/FLV/AAC URL) and plays it in step with
  F1 TV live.
- An optional streamlink recorder for any site streamlink plays.

## [0.2.27] - 2026-10-13

### Added
- The first version in this repository: the server (recordings as wall-clock-mapped audio,
  replay anchors, the streamer's delay read off their screen, sponsor muting, live timing,
  danmaku) and the extension (commentary in sync with F1 TV, the stats split view, the danmaku
  overlay, self-update), with a Bilibili recorder.
