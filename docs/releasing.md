# Releasing fone

A release is a `v*` tag on main. `.github/workflows/release.yml` turns it into a GitHub
Release with:

- `fone-extension-<version>.zip`: the extension, one folder `fone/` to load unpacked, and
  `SHA256SUMS` beside it;
- the server image `ghcr.io/gilbert-wang-30/fone:<version>` (also `:<major>.<minor>` and
  `:latest`), for linux/amd64 and linux/arm64;
- notes: the version's section of [CHANGELOG.md](../CHANGELOG.md), then how to install and
  update (the extension before the server).

It needs no secrets: the workflow's own `GITHUB_TOKEN`, with `packages: write` for the image
job and `contents: write` for the release job only.

## One version

fone's version is `version` in `extension/manifest.json`; the extension and the server ship
under it together. The server takes it from the tag at build time (`FONE_VERSION`, which
`/api/health` reports). The one other place it is written is the server image a checkout runs
by default, `ghcr.io/gilbert-wang-30/fone:X.Y.Z` in `docker-compose.yml` (and, as its default,
in `.env.example` and the README's Configuration table), so a checkout of a release runs that
release's server. `tools/check_version.py` keeps the manifest, CHANGELOG.md, the tag and those
image names in step (an image name may run ahead of the manifest, never behind it). CI runs it
on every push, and the release runs it against the tag.

A release tag is `vX.Y.Z`, or `vX.Y.Z-rc.N` for a pre-release, and nothing else: the image's
tags are read from it as semver, and a fourth number, a leading zero or another suffix would
leave the image with no tag halfway through the release, so `check_version.py --tag` refuses
them up front. The manifest's `version` is therefore exactly `X.Y.Z` when a release is cut
(Chrome's `version` takes only numbers; `1.0.1.0`, the same version to Chrome, is refused for
`v1.0.1`). A pre-release tag, `v1.0.1-rc.1`, keeps the manifest at
`1.0.1`. The zip's manifest then gets `"version_name": "1.0.1-rc.1"`, the image is tagged
`1.0.1-rc.1` only (no `X.Y`, no `latest`), and the GitHub Release is marked as a pre-release.

## Cutting a release

1. **On a branch**, bump `version` in `extension/manifest.json`, and the image's version in
   `docker-compose.yml`, `.env.example` and the README's `FONE_IMAGE` row. In CHANGELOG.md, the top
   section becomes `## [X.Y.Z] - YYYY-MM-DD`: what changed for someone running fone, grouped
   under Added / Changed / Fixed / Security. Check it locally:

   ```bash
   python3 tools/check_version.py --tag vX.Y.Z
   tools/check_public.sh
   tools/build_ext.sh dist          # dist/fone-extension-X.Y.Z.zip, from the committed files
   ```

2. **Dry run.** Push the branch, then Actions → Release → Run workflow, with the branch chosen
   under "Use workflow from" (or `gh workflow run release.yml --ref <branch>`). It runs every
   check, the tests and the packaging, and builds the image for both architectures (the only
   way to know arm64 still builds). It pushes and releases nothing. The run's `extension`
   artifact is the zip: unzip it and load it in Chrome to try the real thing. GitHub offers
   Run workflow only for a workflow that is on main, the default branch, whichever branch it
   then runs on: before the first release there is none there, and that release goes in
   another order ([The first release](#the-first-release)).

3. **Merge** the branch into main (a pull request; CI must pass). Optionally run the dry run
   once more, on main: that is the one run that leaves both architectures' layers in the build
   cache (see below), so the tag's arm64 build starts warm instead of taking its full time.

4. **Tag main**, and push only the tag:

   ```bash
   git switch main && git pull --ff-only
   git tag -a vX.Y.Z -m "fone X.Y.Z"
   git push origin vX.Y.Z
   ```

   Never `git push --all`, `--mirror` or `--tags`: a local branch may hold things that must
   not go public.

5. **Watch the run** (Actions → Release). Once it finishes, the release page has the zip and
   the notes.

The first release only: the image package starts private. Open it (the repository → Packages
→ fone → Package settings) and change its visibility to public, so `docker pull` works
without a login. The image's `org.opencontainers.image.source` label links the package to the
repository.

## The first release

`workflow_dispatch` (Run workflow) runs only a workflow that is on the default branch, and
before 1.0.1 main has no `release.yml`, so the dry run can't come before the merge. The order:

1. **The branch**, as step 1 above: the version, the dated CHANGELOG section, the local checks.
2. **Push the branch** (that branch alone: `git push origin <branch>`) and open a pull request
   into main. CI (`ci.yml`) runs on it and must pass.
3. **Merge** it into main.
4. **Dry run on main**: Actions → Release → Run workflow, from main. Everything but the push
   and the release (step 2 above), and it leaves both architectures' layers in the build cache
   for the tag's run.
5. **Try the zip**: the run's `extension` artifact, unzipped, loaded in Chrome
   (`chrome://extensions` → Developer mode → Load unpacked → the `fone` folder), against a
   server: *Test connection*, then a session played.
6. **Tag main** and push only the tag (step 4 above), watch the run (step 5), and make the
   image package public.

A fault the dry run or the zip shows is fixed on a branch and merged (a pull request, CI) before
the tag; nothing has been published until then.

## What the workflow does

| job | what | fails when |
|---|---|---|
| verify | `check_version.py --tag`, `check_public.sh`, the tag is on main | the tag isn't `vX.Y.Z` or `vX.Y.Z-rc.N` with the manifest's version; its CHANGELOG section is empty or undated; `docker-compose.yml` (or `.env.example`, the README) names an older server image; personal config is committed; the tag isn't on main |
| tests | all of `ci.yml`: syntax of every extension script, the packaging check, the extension, server and recorder tests, ruff, the release-tool tests | any of them |
| extension zip | `tools/build_ext.sh dist <version>`, `SHA256SUMS`, kept as the run's artifact | a file the manifest or a page loads is missing; `local.js` isn't the placeholder |
| server image (after the zip) | an amd64 build started as a stranger would (no recordings; F1 timing, backfill and danmaku off), which must answer `/api/health` with its version and turn healthy; then amd64 + arm64 built, and only then pushed | the smoke run fails; arm64 doesn't build; the push fails |
| GitHub release | notes from CHANGELOG.md, `gh release create` with the zip and `SHA256SUMS` | the release already exists |

The jobs run in that order, and only the last two publish anything: the image job's final build
pushes `X.Y.Z`, `X.Y` and `latest` (a pre-release: only `X.Y.Z-rc.N`), and the release job makes
the GitHub Release. A dry run (Run workflow) does all but the push and the release. It tags the
image `dry-run` and does not push it.

The build cache: GitHub lets a run read only the caches of its own ref and of main, so a cache
written by one tag could never be read by the next. Tags therefore only read: the amd64 layers
`ci.yml` caches on main (`scope=server`; tags don't write it), and both architectures' layers
from the last dry run on main (`scope=server-multiarch`, written by that run alone). Neither
is needed: without them the build is slower, not different.

## The server image's pinned versions

`server/Dockerfile` starts from an exact Python image (`python:3.12.16-alpine3.24`) and installs
the Python packages at the versions in `server/constraints.txt`
(`pip install -c constraints.txt -r requirements.txt`): `requirements.txt` says what fone needs,
`constraints.txt` what the image is built with. A rebuild of the same commit gets the same
Python and packages; only Alpine's own packages (ffmpeg, tesseract) follow Alpine 3.24's fixes.
A package added to `requirements.txt` installs unpinned until the pins are refreshed.

To move them on (a Python patch release, a fix in a dependency), on a branch:

1. **The base.** The newest `python:3.12.X-alpine3.Y` tag on Docker Hub, on `FROM`. It must be
   built for both architectures: `docker manifest inspect python:3.12.X-alpine3.Y` lists
   `amd64` and `arm64`.
2. **The packages.** Build with no pins and keep what pip chose:

   ```bash
   cp server/constraints.txt /tmp/pins && grep '^#' /tmp/pins > server/constraints.txt  # its header alone
   docker build --pull --no-cache -t fone:pins server
   { grep '^#' /tmp/pins; docker run --rm fone:pins pip freeze; } > server/constraints.txt
   ```

3. **arm64 finds a wheel for each** (the image has no compiler, and arm64 builds under QEMU):

   ```bash
   docker run --rm -v "$PWD/server":/s:ro python:3.12.X-alpine3.Y pip download -q -d /tmp/w \
     --only-binary=:all: --platform musllinux_1_2_aarch64 --platform musllinux_1_1_aarch64 \
     --python-version 3.12 --implementation cp --abi cp312 -c /s/constraints.txt -r /s/requirements.txt
   ```

   A package with no aarch64 wheel at the chosen version fails it by name: pin the last version
   that has one.
4. **Test** the image the new pins build (the server tests in CONTRIBUTING.md), and the dry run
   (step 2 of Cutting a release) builds both architectures.

## The other images

`docker-compose.yml` also runs images fone doesn't build, pinned to exact versions so a
release runs what it was tested with and a `docker compose pull` changes nothing behind your
back: `python:3.12.16-alpine3.24` (fone-ext, fone-recorder-gate; the same base as
`server/Dockerfile`, and `recorder/streamlink/Dockerfile`'s), `alpine:3.24.4` (fone-janitor)
and `bililive/recorder:2.18.0` (fone-recorder, 录播姬). To move one on, on a branch:

1. **The tag.** The new exact tag on Docker Hub, built for both architectures:
   `docker manifest inspect <image>:<tag>` lists `amd64` and `arm64`. For `bililive/recorder`,
   read its release notes (BililiveRecorder's releases on GitHub) first: it is what records the
   streamer. The Python base moves with `server/Dockerfile`'s (the server image's pinned
   versions, above).
2. **Try it** on a test setup: `docker compose --profile recorder --profile streamlink up -d`,
   then each one's `docker logs` (the recorder records a room, the gate sees its streams, the
   janitor sweeps).
3. **Say it** in CHANGELOG.md's next section, a new 录播姬 above all.

`docker image inspect <image> --format '{{json .Config.Labels}}'` shows what an image already
on a host is (`org.opencontainers.image.version` for 录播姬), without pulling anything.

## When it goes wrong

What has been published depends on the job that failed:

- **verify, tests, the extension zip, or the image job before its push** (the smoke run, the
  arm64 build): nothing was pushed or released. ghcr.io, `latest` included, is as it was. A
  fluke (a runner or network hiccup): re-run the failed jobs. Code to fix: fix it on a branch,
  merge, then move the tag to the fixed commit on main
  (`git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z`, tag main again, push the tag).
- **The image's push itself** (a network error midway): some of `X.Y.Z`, `X.Y`, `latest` may
  point at the new image and others not; there is no GitHub Release yet. Re-run the failed jobs
  (Actions → the run → Re-run failed jobs): the image is built from the same commit and pushed
  under every tag again.
- **The GitHub release job** (or the "what was pushed" step): the image is on ghcr.io under
  `X.Y.Z`, `X.Y` and `latest`, which now point at this version, but there is no Release and so
  no zip for anyone. Re-run the failed jobs; the release job takes the zip this run already
  built. If the release itself must change, `gh release delete vX.Y.Z` and re-run.
  If the code must change instead, it is a new version: don't move the tag (the image is
  already public under it); release the next patch.
- **A release went out broken**: don't move its tag, since people have the zip and the image.
  Fix it and release the next patch version.

## The zip and the author's self-updating installs

`tools/build_ext.sh` makes the release zip from the files committed at HEAD. It leaves out
the tests, `testdata/` and `build.js`, and keeps the placeholder `local.js`, so an install asks
for its server in fone's settings. It refuses a missing file and a filled-in `local.js`. The
same commit always gives the same zip.

`tools/publish_ext.sh` is a separate channel for one household's machines. It runs the same
packager on the working tree as it is (uncommitted changes too), then adds what a release
leaves out:

- the default servers, written into `local.js` (FONE_SERVERS);
- `build.js` and `build.json`, stamped `X.Y.Z+<time>.<hash>`;
- the Mac scripts' update server (FONE_DIST_URL).

It copies all that to the folder Chrome loads unpacked (FONE_EXT_DEST, e.g. a NAS share) and to
the folder the `fone-ext` update server serves (FONE_EXT_DIST). These settings come from
`tools/publish.env` (gitignored; start from `tools/publish.env.example`). Installs loaded from
there poll `<server>:8789/build.json` and reload themselves when it changes. A release zip
has no `build.js`, so it never polls anything. Releases and publish_ext.sh don't touch each
other:

- To put a release on the share, check out its tag and run `tools/publish_ext.sh` from a clean
  tree.
- An install keeps its ID and settings only while Chrome loads it from the same folder. Moving
  a machine from the share to a release zip, or back, starts its settings over.

## Updating an install from a zip

The release notes say it for each system; the rule behind it: Chrome tells an unpacked
extension, and keeps its settings, by its folder's path. An update is the new zip extracted into
the same place, so its `fone` folder replaces the old one's files at the same path (Windows:
Extract All, browse to the folder that holds `fone`, and replace the files; elsewhere
`unzip -o … -d <that folder>`), then ↻ on fone's card. Extracted anywhere else, `fone` is a new
extension with fresh settings. Files an older release had and this one doesn't stay behind,
unused.

## Repository settings (once, by the owner)

- Settings → Actions → General → Workflow permissions: read repository contents. Each
  workflow asks for what it needs.
- Settings → Code security: secret scanning and push protection on. A custom pattern for
  `*.ts.net` names also blocks pushes, not only CI.
- Settings → Rules → a tag ruleset on `v*`: only the owner may create, move or delete them.
- Packages → fone: public (see above).
