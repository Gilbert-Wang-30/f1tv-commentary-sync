# Contributing

fone is a personal project: it is built around one streamer's room and one person's home
server, and it changes when that setup does. Pull requests are welcome all the same,
especially ones that make it work for another streamer, platform or recorder. Please open an
issue first for anything larger than a fix, so the work isn't wasted on something that is
being rewritten.

## Before you open a PR

- Keep the change small and the comments in the style around it (the code explains *why*,
  not what the next line does).
- Run the tests that touch what you changed (below). CI runs the first two layers and the
  checks on every push and pull request; the third only runs on a machine with Docker and
  internet access.
- Don't commit anything from your own setup: server names, IPs, Tailscale hosts, NAS paths,
  credentials (`recorder/api.env` and `tools/publish.env` are gitignored for that reason).
  `tools/check_public.sh` fails CI on them.
- A change someone running fone would notice gets a line in the top section of
  [CHANGELOG.md](CHANGELOG.md); releases are cut from it ([docs/releasing.md](docs/releasing.md)).

## The three test layers

**1. Extension unit tests** (Node, no browser): the sync maths, the dashboard's layout and
clock, the danmaku filters and lanes, the self-update logic, the live car-position relay, the
in-browser recorder (the demuxers against `extension/testdata/`, the buffer, the playlist
reading), sync by sound's matching, team radio's sting, Bilibili replays, the streamer's
screen layout, and F1 TV's settings with their migration from older builds. One file per
module, `extension/<module>.test.js`, run inside the whole checkout so `livepos.test.js` can
read `server/tests/fixtures`:

```bash
docker run --rm -v "$PWD":/r -w /r/extension node:22-alpine \
  sh -c 'for t in *.test.js; do echo "== $t"; node "$t" || exit 1; done'
```

**2. Server tests** (pytest, in the server's Docker image, which has ffmpeg and tesseract):

```bash
docker build -t fone:dev server
docker run --rm -v "$PWD/server":/app -w /app -e PYTHONDONTWRITEBYTECODE=1 \
  fone:dev sh -c 'pip install -q pytest==9.2.0 && python -m pytest -q -rs -p no:cacheprovider tests'
```

240+ tests; the ones that need a real recording (`-rs` lists them as skipped) run only
when one is mounted, see the README's Development section for the `FONE_*` switches.

**Checks** (CI's "release checks" and the extension job; seconds each):

```bash
docker run --rm -v "$PWD":/r -w /r node:22-alpine \
  sh -c 'for f in extension/*.js extension/vendor/*.min.js tools/*.js; do node --check "$f" || exit 1; done'
tools/build_ext.sh "$(mktemp -d)"   # the release zip: fails on a file the extension loads that's missing
python3 tools/check_version.py      # the manifest's version has its CHANGELOG.md section
tools/check_public.sh               # nothing from one install's own setup
python3 tools/test_release.py       # the release tools themselves
docker run --rm -v "$PWD":/w:ro -w /w python:3.12-alpine \
  sh -c 'pip install -q ruff==0.17.5 && ruff check --no-cache server'   # errors and pyflakes; no formatter
```

Most of the extension (`offscreen.js`, `content.js`, `page.js`, `dashboard.js`) runs only in
Chrome, so CI can only parse it; the end-to-end suites below are what exercise it.

**3. End to end** (`e2e/`): the real server and the real extension in headless Chromium,
all in Docker. These need Docker and a few GB for the Playwright image. They are slow
(minutes) and run nowhere automatically. `e2e/local`, `e2e/livepos` and `e2e/layout_run.sh`
work offline against mocks; `e2e/run.sh`, `e2e/vod`, `tools/platform_check.sh` and
`e2e/dash_shots.sh` need the internet, live streams or a running server.

`e2e/run.sh` looks up real F1 TV content and MultiViewer sessions for its fixtures (the
commentary audio is synthetic). The exact replay anchor came from F1's live-timing archive,
which has answered 401 to everyone since 2026-10-18, so run it with a seed and without the
timing check:

```bash
E2E_CONTENT_SEED=seed.json E2E_NO_TIMING=1 ./e2e/run.sh
```

`seed.json` is a JSON object `{content id: the server's /api/f1tv answer}` for both fixtures,
e.g. taken from a server's content cache: `1000011024` (the replay, for its `p0`) and
`1000011022` (the race, which `run.sh` seeds as LIVE; its `anchor` must be `multiviewer`).
`E2E_NO_TIMING=1` skips the one check that needs the archive's timing data (the dashboard's
tower).

```bash
./e2e/run.sh                  # replay, Tiledmedia, 2x, live, danmaku, onboards (with the seed above)
./e2e/local/run.sh            # no server: a live stream recorded in the browser (mock platforms, offline)
./e2e/livepos/run.sh          # the live car-position relay against a mock F1 feed
DASH=real ./e2e/layout_run.sh # the split view on a mock F1 TV page
./e2e/dash_shots.sh           # dashboard screenshots in 20+ window sizes
```

## Adding a streaming platform

Without a server, a platform is a resolver in `extension/streams.js`: `parse()` learns its URLs,
a function asks its web player's API (logged out) whether the stream is live and returns the
stream's URL (HTTP-FLV or HLS with AAC audio: `demux.js` reads FLV, MPEG-TS, fMP4 and packed
ADTS), and `HEADERS` lists the Origin/Referer its servers insist on (`background.js` turns those
into session rules). Prefer what the site's own player gets: an audio-only stream if there is
one, and a stream whose timestamps run on across connections (`localcore.js` then joins a
reconnect to the sample; otherwise it's placed by arrival).

Check it against a real stream with `tools/stream_probe.js`, which runs the extension's own
resolver, demuxer and buffer in Node and reports what came in:

```bash
docker run --rm -v "$PWD":/r -w /r node:22-alpine node tools/stream_probe.js <live URL> 30 /r/probe.aac
```

With a server, a platform is a recorder that writes `<channel>/<yyyyMMdd-HHmmss-fff>-<title>.<ext>`
files as the stream airs (`recorder/streamlink/` does that for anything streamlink plays).

## What a change usually touches

- Sync behaviour: `extension/core.js` (pure maths, tested in `core.test.js`) and
  `extension/offscreen.js` (the engine around it, covered by `e2e/run.sh` and, without a
  server, `e2e/local/run.sh`).
- The server's routes and data shapes: `docs/architecture.md` describes them; keep it true.
- A new F1 data source or format: note it in `docs/f1-data-sources.md`.
