#!/usr/bin/env python3
"""fone's version is extension/manifest.json's: CHANGELOG.md has a section for it, a release
tag names it, the server image is stamped with the tag (FONE_VERSION), and docker-compose.yml
runs that image by default.

  tools/check_version.py                     every push: the manifest's version is one Chrome
                                             takes, CHANGELOG.md has its section, newest first,
                                             every older one dated; the server image the setup
                                             files name (docker-compose.yml, .env.example, the
                                             README) is not older than it
  tools/check_version.py --tag v1.0.1        a release: the tag is vX.Y.Z, the manifest's version,
                                             or vX.Y.Z-rc.N for a pre-release (nothing else: the
                                             image's tags are read from it as semver), its
                                             section says something and, for a release proper,
                                             carries its date
      --dry-run                              (release.yml run by hand) an undated section will do
      --notes FILE                           writes that section's text, for the release notes

Prints version=… and prerelease=… (for $GITHUB_OUTPUT) when all is well.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HEADING = re.compile(r"^## \[(?P<name>[^\]]+)\](?:\s+-\s+(?P<date>\S.*?))?\s*$")
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
# X.Y.Z or X.Y.Z-rc.N: docker/metadata-action reads the image's tags from it as semver, which a
# fourth number or a leading zero fails (and the image would go out with no tag)
TAG = re.compile(r"v(?P<version>(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){2})(?P<suffix>-rc\.(?:0|[1-9]\d*))?")
# The released server image a checkout runs by default (and the docs name): one release's own
IMAGE = re.compile(r"ghcr\.io/[\w.-]+/fone:(\d+\.\d+\.\d+)\b")
IMAGE_FILES = ("docker-compose.yml", ".env.example", "README.md")


class Problem(Exception):
    def __init__(self, msg: str, file: str | None = None):
        super().__init__(msg)
        self.file = file


def chrome_version(v: str) -> tuple[int, ...]:
    """Chrome's manifest version: 1-4 dot-separated integers, 0-65535, no leading zeros."""
    parts = v.split(".")
    if not 1 <= len(parts) <= 4 or not all(re.fullmatch(r"0|[1-9]\d{0,4}", p) and int(p) <= 65535 for p in parts):
        raise Problem(f"version {v!r} is not one Chrome takes (1-4 numbers 0-65535, as in 1.0.1)",
                      "extension/manifest.json")
    return tuple(int(p) for p in parts)


def key(v: str) -> tuple[int, ...]:
    # 1.0 and 1.0.0 are the same version to Chrome
    t = chrome_version(v)
    return t + (0,) * (4 - len(t))


def sections(text: str) -> list[dict]:
    """CHANGELOG.md's '## [name] - date' sections in order, each with its text."""
    out: list[dict] = []
    for line in text.splitlines():
        m = HEADING.match(line)
        if m:
            out.append({"name": m["name"].strip(), "date": (m["date"] or "").strip(), "lines": []})
        elif line.startswith("## "):
            raise Problem(f"heading {line!r} is not '## [x.y.z] - yyyy-mm-dd'", "CHANGELOG.md")
        elif out:
            out[-1]["lines"].append(line)
    for s in out:
        s["body"] = "\n".join(s.pop("lines")).strip()
    return out


def check(manifest_version: str, changelog: str, tag: str | None = None, dry_run: bool = False) -> dict:
    """What the release is ({version, prerelease, notes}), or Problem."""
    mv = key(manifest_version)
    secs = sections(changelog)
    versions = [s for s in secs if s["name"].lower() != "unreleased"]
    if not versions:
        raise Problem("no '## [x.y.z] - date' sections", "CHANGELOG.md")
    for s in secs:
        if s["name"].lower() == "unreleased" and s is not secs[0]:
            raise Problem("'## [Unreleased]' belongs at the top", "CHANGELOG.md")
    prev = None
    for s in versions:
        try:
            v = key(s["name"])
        except Problem:
            raise Problem(f"section [{s['name']}] is not a version", "CHANGELOG.md") from None
        if prev is not None and v >= prev[0]:
            raise Problem(f"[{s['name']}] comes after [{prev[1]}]: newest first", "CHANGELOG.md")
        prev = (v, s["name"])
        if s["date"].lower() != "unreleased" and not DATE.match(s["date"]):
            raise Problem(f"[{s['name']}]'s date {s['date']!r} is not yyyy-mm-dd or 'unreleased'", "CHANGELOG.md")
    mine = next((s for s in versions if key(s["name"]) == mv), None)
    if mine is None:
        raise Problem(f"no section for the manifest's version: add '## [{manifest_version}] - unreleased'",
                      "CHANGELOG.md")
    for s in versions:
        if key(s["name"]) < mv and not DATE.match(s["date"]):
            raise Problem(f"[{s['name']}] is older than the manifest's {manifest_version} but not dated",
                          "CHANGELOG.md")
    version, prerelease = manifest_version, False
    if tag is not None:
        m = TAG.fullmatch(tag)
        if not m:
            raise Problem(f"tag {tag!r} is not vX.Y.Z or vX.Y.Z-rc.N, as in v1.0.1 or v1.0.1-rc.1")
        if key(m["version"]) != mv:
            raise Problem(f"tag {tag} is not the manifest's version {manifest_version}: bump "
                          "extension/manifest.json (and CHANGELOG.md) first", "extension/manifest.json")
        version, prerelease = tag[1:], bool(m["suffix"])
        if not mine["body"]:
            raise Problem(f"[{mine['name']}] says nothing: it becomes the release notes", "CHANGELOG.md")
        if not prerelease and not dry_run and not DATE.match(mine["date"]):
            raise Problem(f"[{mine['name']}] is still '{mine['date'] or 'undated'}': give it the release's date",
                          "CHANGELOG.md")
    return {"version": version, "prerelease": prerelease, "notes": mine["body"]}


def check_images(manifest_version: str, texts: dict[str, str]) -> None:
    """The server image each setup file names ({file: its text}) is the manifest's version, or
    the coming one's while the manifest isn't bumped yet: never an older release's (a checkout
    of 1.0.2 running the 1.0.1 server). Problem otherwise."""
    mv = key(manifest_version)
    for f, text in texts.items():
        for v in IMAGE.findall(text):
            if key(v) < mv:
                raise Problem(f"names the server image fone:{v}, older than the manifest's {manifest_version}: "
                              "bump it with the version", f)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--tag", help="the release tag, as in v1.0.1")
    ap.add_argument("--dry-run", action="store_true", help="an undated CHANGELOG section will do")
    ap.add_argument("--notes", metavar="FILE", help="write the version's CHANGELOG section here")
    ap.add_argument("--root", default=str(ROOT), help=argparse.SUPPRESS)
    a = ap.parse_args(argv)
    root = Path(a.root)
    try:
        manifest = json.loads((root / "extension/manifest.json").read_text(encoding="utf-8"))
        changelog = (root / "CHANGELOG.md").read_text(encoding="utf-8")
        r = check(manifest["version"], changelog, a.tag, a.dry_run)
        check_images(manifest["version"], {f: (root / f).read_text(encoding="utf-8")
                                           for f in IMAGE_FILES if (root / f).is_file()})
    except FileNotFoundError as e:
        return fail(Problem(f"{e.filename} is missing"))
    except Problem as e:
        return fail(e)
    if a.notes:
        Path(a.notes).write_text(r["notes"] + "\n", encoding="utf-8")
    print(f"version={r['version']}")
    print(f"prerelease={'true' if r['prerelease'] else 'false'}")
    return 0


def fail(e: Problem) -> int:
    if os.environ.get("GITHUB_ACTIONS") == "true":
        print(f"::error{' file=' + e.file if e.file else ''}::{e}", file=sys.stderr)
    else:
        print(f"check_version: {e.file + ': ' if e.file else ''}{e}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
