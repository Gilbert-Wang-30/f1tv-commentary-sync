#!/usr/bin/env bash
# fone against a live stream on every platform it records, any day (no F1 session needed): the
# streams from tools/platform_check.py, each through e2e/local/run.sh real (in step with the e2e's
# mock F1 TV live player, then Go live after a pause, 20 s back and Go live again, the live page,
# the streamer window's picture). Exits non-zero if one of them didn't hold up.
set -euo pipefail
cd "$(dirname "$0")/.."
urls=$(python3 tools/platform_check.py)
[ -n "$urls" ] || { echo "platform_check: no live stream found anywhere" >&2; exit 1; }
echo "== live now: $urls"
# shellcheck disable=SC2086 # (one argument per URL)
REAL_PICTURE=${REAL_PICTURE-1} exec e2e/local/run.sh real $urls
