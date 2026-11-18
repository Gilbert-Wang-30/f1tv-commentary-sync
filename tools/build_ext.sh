#!/usr/bin/env bash
# The extension as Chrome loads it unpacked: extension/ without its tests and test data,
# local.js as the repo has it (no servers: the install asks for one in fone's settings) and no
# build.js (without it background.js never polls an update server: only tools/publish_ext.sh's
# builds update themselves).
#
#   tools/build_ext.sh <outdir> [version]   the release zip, <outdir>/fone-extension-<version>.zip:
#                                           one folder, fone/, with LICENSE and THIRD_PARTY.md.
#                                           Unzipped over the last release's folder, Chrome keeps
#                                           the same extension and its settings.
#   tools/build_ext.sh --stage <dir>        only the files, into <dir> (tools/publish_ext.sh adds
#                                           its servers and update stamp on top)
#   --worktree    extension/ as it is on disk, uncommitted and untracked files too (what
#                 publish_ext.sh always shipped), instead of the files committed at HEAD
#
# version: the manifest's by default. A release candidate's (1.0.1-rc.1) goes into the zip's
# manifest as version_name: Chrome's version takes only numbers, and must be the manifest's.
# Either way every file the manifest, background.js and the pages load must be there.
set -euo pipefail

usage() { echo "usage: tools/build_ext.sh [--worktree] (<outdir> [version] | --stage <dir>)" >&2; exit 2; }
HERE=$PWD  # paths given are the caller's, not the repo root's
abs() { case $1 in /*) printf '%s' "$1" ;; *) printf '%s/%s' "$HERE" "$1" ;; esac; }
WORKTREE=0 STAGE_ONLY=
while [ $# -gt 0 ]; do
  case $1 in
    --worktree) WORKTREE=1; shift ;;
    --stage) [ $# -ge 2 ] || usage; STAGE_ONLY=$(abs "$2"); shift 2 ;;
    -*) usage ;;
    *) break ;;
  esac
done
cd "$(dirname "$0")/.."
if [ -n "$STAGE_ONLY" ]; then
  [ $# -eq 0 ] || usage
  ROOT=$STAGE_ONLY
  if [ -e "$ROOT" ] && [ -n "$(ls -A "$ROOT")" ]; then echo "build_ext.sh: $ROOT is not empty" >&2; exit 1; fi
  mkdir -p "$ROOT"
else
  case $# in 1|2) ;; *) usage ;; esac
  OUT=$(abs "$1") VER=${2:-}
  TMP=$(mktemp -d)
  trap 'rm -rf "$TMP"' EXIT
  ROOT=$TMP/fone
  mkdir "$ROOT"
fi

if [ "$WORKTREE" = 1 ]; then
  cp -r extension/. "$ROOT/"
else
  git archive --format=tar HEAD:extension | tar -x -C "$ROOT"
fi
# build.js/build.json: a published build's stamp (gitignored), which only publish_ext.sh writes.
rm -rf "$ROOT"/*.test.js "$ROOT/testdata" "$ROOT/build.js" "$ROOT/build.json"

# Everything the extension loads by name. build.js may be missing: background.js tries it.
python3 - "$ROOT" <<'PY'
import json, os, re, sys
root = sys.argv[1]
m = json.load(open(os.path.join(root, "manifest.json"), encoding="utf-8"))
refs = {}  # file -> where it's named

def ref(path, where):
    path = path.split("?")[0].split("#")[0]
    if path and "*" not in path and "://" not in path and not path.startswith("//"):
        refs.setdefault(os.path.normpath(path.lstrip("/")), where)

def icons(v, where):
    for p in (v.values() if isinstance(v, dict) else [v] if isinstance(v, str) else []):
        ref(p, where)

bg = m.get("background", {}).get("service_worker")
if bg:
    ref(bg, "manifest background")
for cs in m.get("content_scripts", []):
    for p in cs.get("js", []) + cs.get("css", []):
        ref(p, "manifest content_scripts")
for war in m.get("web_accessible_resources", []):
    for p in war.get("resources", []):
        ref(p, "manifest web_accessible_resources")
for key in ("options_page", "devtools_page"):
    if m.get(key):
        ref(m[key], "manifest " + key)
for key, sub in (("options_ui", "page"), ("action", "default_popup"), ("side_panel", "default_path")):
    if m.get(key, {}).get(sub):
        ref(m[key][sub], f"manifest {key}.{sub}")
icons(m.get("icons"), "manifest icons")
icons(m.get("action", {}).get("default_icon"), "manifest action.default_icon")
for r in m.get("declarative_net_request", {}).get("rule_resources", []):
    ref(r.get("path", ""), "manifest declarative_net_request")

STR = r"""['"]([^'"]+)['"]"""
for dirpath, _, files in os.walk(root):
    for f in files:
        full = os.path.join(dirpath, f)
        rel = os.path.relpath(full, root)
        if rel.startswith("vendor" + os.sep):
            continue
        text = open(full, encoding="utf-8", errors="replace").read() if f.endswith((".js", ".html")) else ""
        if f.endswith(".js"):
            for call in re.findall(r"importScripts\(([^)]*)\)", text):
                for p in re.findall(STR, call):
                    if p != "build.js":
                        ref(p, rel + " importScripts")
            # pages opened by name: getURL('dashboard.html?mode=…'), createDocument({url: 'offscreen.html'})
            for p in re.findall(r"""['"]([\w./-]+\.html)(?:\?[^'"]*)?['"]""", text):
                ref(p, rel)
        elif f.endswith(".html"):
            for p in re.findall(r"""<(?:script|link|img)\b[^>]*?\b(?:src|href)=["']([^"']+)["']""", text):
                ref(p, rel)

missing = sorted(f"{p} (named in {w})" for p, w in refs.items()
                 if p.startswith("..") or not os.path.isfile(os.path.join(root, p)))
if missing:
    sys.exit("build_ext.sh: missing from the build: " + ", ".join(missing))
PY

if [ -n "$STAGE_ONLY" ]; then exit 0; fi

# The release: local.js still the placeholder, the version the manifest's.
if ! grep -qxF 'self.FONE_LOCAL = { servers: [] };' "$ROOT/local.js" || grep -q '://' "$ROOT/local.js"; then
  echo "build_ext.sh: extension/local.js is not the repo's placeholder (servers belong in tools/publish.env)" >&2; exit 1
fi
MANIFEST_VER=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$ROOT/manifest.json")
VER=${VER:-$MANIFEST_VER}
if [ "${VER%%-*}" != "$MANIFEST_VER" ]; then
  echo "build_ext.sh: version $VER is not the manifest's ($MANIFEST_VER): bump extension/manifest.json" >&2; exit 1
fi
if [ "$VER" != "$MANIFEST_VER" ]; then
  python3 - "$ROOT/manifest.json" "$VER" <<'PY'
import json, sys
m = json.load(open(sys.argv[1], encoding="utf-8"))
out = {}
for k, v in m.items():
    out[k] = v
    if k == "version":
        out["version_name"] = sys.argv[2]
open(sys.argv[1], "w", encoding="utf-8").write(json.dumps(out, indent=2, ensure_ascii=False) + "\n")
PY
fi
cp LICENSE THIRD_PARTY.md "$ROOT/"

# The same commit gives the same zip: sorted entries, the commit's time on each, fixed modes.
EPOCH=${SOURCE_DATE_EPOCH:-$(git log -1 --format=%ct 2>/dev/null || date +%s)}
mkdir -p "$OUT"
ZIP="$OUT/fone-extension-$VER.zip"
python3 - "$TMP" "$ZIP" "$EPOCH" <<'PY'
import os, sys, time, zipfile
base, out, epoch = sys.argv[1], sys.argv[2], max(int(sys.argv[3]), 315532800)  # zip can't go before 1980
when = time.gmtime(epoch)[:6]
entries = []
for dirpath, dirs, files in os.walk(os.path.join(base, "fone")):
    rel = os.path.relpath(dirpath, base)
    entries.append((rel.replace(os.sep, "/") + "/", None))
    entries += [(os.path.join(rel, f).replace(os.sep, "/"), os.path.join(dirpath, f)) for f in files]
with zipfile.ZipFile(out + ".tmp", "w") as z:
    for name, path in sorted(entries):
        info = zipfile.ZipInfo(name, when)
        info.create_system = 3  # unix, so the modes below hold
        if path is None:
            info.external_attr = (0o40755 << 16) | 0x10
            z.writestr(info, b"")
        else:
            info.external_attr = 0o100644 << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, open(path, "rb").read(), compresslevel=9)
os.replace(out + ".tmp", out)
PY
echo "$ZIP"
