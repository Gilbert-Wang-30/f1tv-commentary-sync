# Releasing fone

A release is a `v*` tag on main. `.github/workflows/release.yml` turns it into a GitHub
Release with:

- `fone-extension-<version>.zip`: the extension, one folder `fone/` to load unpacked, and
  `SHA256SUMS` beside it;
- the server image `ghcr.io/gilbert-wang-30/fone:<version>` (also `:<major>.<minor>` and
  `:latest`), for linux/amd64 and linux/arm64;
- notes: the version's section of [CHANGELOG.md](../CHANGELOG.md), then how to install.

It needs no secrets: the workflow's own `GITHUB_TOKEN`, with `packages: write` for the image
job and `contents: write` for the release job only.

## One version

fone's version is `version` in `extension/manifest.json`; the extension and the server ship
under it together. The server takes it from the tag at build time (`FONE_VERSION`, which
`/api/health` reports), so there is no second place to bump. `tools/check_version.py` keeps
the manifest, CHANGELOG.md and the tag in step. CI runs it on every push, and the release runs
it against the tag.

Chrome's `version` takes only 1-4 numbers. A pre-release tag, `v1.0.1-rc.1`, keeps the
manifest at `1.0.1`. The zip's manifest then gets `"version_name": "1.0.1-rc.1"`, the image
is tagged `1.0.1-rc.1` only (no `latest`), and the GitHub Release is marked as a pre-release.

## Cutting a release

1. **On a branch**, bump `version` in `extension/manifest.json`. In CHANGELOG.md, the top
   section becomes `## [X.Y.Z] - YYYY-MM-DD`: what changed for someone running fone, grouped
   under Added / Changed / Fixed. Check it locally:

   ```bash
   python3 tools/check_version.py --tag vX.Y.Z
   tools/check_public.sh
   tools/build_ext.sh dist          # dist/fone-extension-X.Y.Z.zip, from the committed files
   ```

2. **Dry run.** Push the branch, then Actions → Release → Run workflow on it. It runs every
   check, the tests and the packaging, and builds the image for both architectures (the only
   way to know arm64 still builds). It pushes and releases nothing. The run's `extension`
   artifact is the zip: unzip it and load it in Chrome to try the real thing.

3. **Merge** the branch into main (a pull request; CI must pass).

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

## What the workflow does

| job | what | fails when |
|---|---|---|
| verify | `check_version.py --tag`, `check_public.sh`, the tag is on main | the tag isn't `v` + the manifest's version; its CHANGELOG section is empty or undated; personal config is committed; the tag isn't on main |
| tests | all of `ci.yml`: syntax of every extension script, the packaging check, unit tests, server tests, ruff, the release-tool tests | any of them |
| extension zip | `tools/build_ext.sh dist <version>`, `SHA256SUMS` | a file the manifest or a page loads is missing; `local.js` isn't the placeholder |
| server image | an amd64 build started as a stranger would (no recordings; F1 timing, backfill and danmaku off), which must answer `/api/health` with its version and turn healthy; then amd64 + arm64 built and pushed | the smoke run fails; arm64 doesn't build |
| GitHub release | notes from CHANGELOG.md, `gh release create` with the zip and `SHA256SUMS` | the release already exists |

A dry run (Run workflow) does all but the push and the release. It tags the image `dry-run` and
does not push it.

## When it goes wrong

- **Before anything was pushed** (verify, tests or the zip failed): fix on main, move the tag
  (`git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z`, then tag again).
- **The image was pushed but the release failed**: re-run the failed job (Actions → the run →
  Re-run failed jobs). If the release itself must change, `gh release delete vX.Y.Z` and
  re-run.
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

## Repository settings (once, by the owner)

- Settings → Actions → General → Workflow permissions: read repository contents. Each
  workflow asks for what it needs.
- Settings → Code security: secret scanning and push protection on. A custom pattern for
  `*.ts.net` names also blocks pushes, not only CI.
- Settings → Rules → a tag ruleset on `v*`: only the owner may create, move or delete them.
- Packages → fone: public (see above).
