#!/usr/bin/env bash
# The repository is public: nothing from one install's own setup goes in it. Fails on
#  - files that only live on one machine, tracked: recorder/api.env, tools/publish.env, a .env,
#    a published build's build.js/build.json, build output, an extension's private key
#  - extension/local.js with servers in it (the repo's is a placeholder: tools/publish.env
#    fills the published copy) and the Mac scripts with their update server filled in
#  - anywhere: Tailscale names (a host under .ts.net) and addresses (100.64/10), home
#    directories, and NAS paths (under /mnt, in a first folder named nas)
#  - outside the docs and the example settings (*.md, *.example): home-network addresses
#    (10/8, 172.16/12, 192.168/16) and other paths under /mnt
# So an address a reader puts their own in place of (a 192.168.x.y one) is written in the README,
# docs/ or a *.example file; code, tests and pages use a name (my-server) or the documentation
# addresses (192.0.2.x, 198.51.100.x, 203.0.113.x: not private, never flagged). A Tailscale name
# is written <machine>.<tailnet>.ts.net, which names no host.
#   tools/check_public.sh [repo]    (this repository by default)
set -uo pipefail
REPO=${1:-$(dirname "$0")/..}
cd "$REPO" || exit 2
git rev-parse --git-dir >/dev/null 2>&1 || { echo "check_public.sh: $REPO is not a git repository" >&2; exit 2; }
fail=0
err() {  # file, line, message
  fail=1
  if [ "${GITHUB_ACTIONS:-}" = true ]; then echo "::error file=$1${2:+,line=$2}::$3"
  else echo "$1${2:+:$2}: $3"; fi
}
# git grep -no's file:line:match lines, each one reported (fed by < <(…): a pipe's subshell would
# lose fail)
each() {  # message
  while IFS= read -r hit; do
    f=${hit%%:*} rest=${hit#*:}
    err "$f" "${rest%%:*}" "$1: ${rest#*:}"
  done
}

while IFS= read -r f; do
  err "$f" "" "only belongs on one machine: git rm --cached it, and gitignore it"
done < <(git ls-files -- recorder/api.env tools/publish.env '*.env' extension/build.js extension/build.json \
           '*.zip' '*.tar.gz' '*.crx' '*.pem' | grep -v '\.example$')

if [ -f extension/local.js ] &&
   { ! grep -qxF 'self.FONE_LOCAL = { servers: [] };' extension/local.js || grep -q '://' extension/local.js; }; then
  err extension/local.js "" "not the placeholder 'self.FONE_LOCAL = { servers: [] };': servers go in tools/publish.env"
fi
for f in tools/mac/install-mac.sh tools/mac/fone-sync.sh; do
  [ ! -f "$f" ] || grep -q __FONE_DIST__ "$f" || err "$f" "" "the update server is filled in: keep __FONE_DIST__ (FONE_DIST_URL fills the published copy)"
done

# Third-party code and binary files aside, every tracked file; EXAMPLES: not the docs or the
# example settings.
ALL=(-- . ':!extension/vendor/')
EXAMPLES=(':!*.md' ':!*.example')
each "a Tailscale name (in an example: <machine>.<tailnet>.ts.net)" < <(
  git grep -nIoE '[A-Za-z0-9-]+\.ts\.net' "${ALL[@]}")
OCTET='(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])'
LAN="(10(\.$OCTET){3}|172\.(1[6-9]|2[0-9]|3[01])(\.$OCTET){2}|192\.168(\.$OCTET){2})"
TAILSCALE="100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])(\.$OCTET){2}"
each "a home-network address (an example to fill in goes in a *.md or *.example file; elsewhere use 192.0.2.10)" < <(
  git grep -nIoE "(^|[^0-9.])$LAN([^0-9.]|$)" "${ALL[@]}" "${EXAMPLES[@]}")
each "a Tailscale address" < <(git grep -nIoE "(^|[^0-9.])$TAILSCALE([^0-9.]|$)" "${ALL[@]}")
each "a home directory" < <(git grep -nIoE '(/home|/Users)/[a-z][A-Za-z0-9._-]*' "${ALL[@]}")
MNT='/mnt/[A-Za-z0-9._/-]+' NAS=':/mnt/[n]as(/.*)?$'
each "a NAS path (a setting of one install: .env)" < <(
  git grep -nIoE "$MNT" "${ALL[@]}" | grep -E "$NAS"
  git grep -nIoE "$MNT" "${ALL[@]}" "${EXAMPLES[@]}" | grep -vE "$NAS")

[ "$fail" = 0 ] && echo "check_public: nothing personal in the tracked files"
exit "$fail"
