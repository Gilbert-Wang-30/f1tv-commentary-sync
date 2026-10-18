#!/bin/sh
# Records live streams with streamlink (YouTube, Twitch, Douyin, Huya, Kick, …: for Bilibili use
# fone-recorder, BililiveRecorder) into the layout the fone server scans: one folder per
# channel, each recording named for the moment it started, to the microsecond, in this
# container's time zone (TZ: make it the server's FONE_FILENAME_TZ):
#   /rec/<channel>/<yyyyMMdd-HHmmss-ffffff>-<title>.ts   (MPEG-TS, the site's own audio and video)
#
#   STREAMS       "channel=URL", several separated by spaces or newlines (required)
#   QUALITY       streamlink's stream names, the first one there wins (default: audio only if
#                 the site has it, else a small video: the server keeps only the audio)
#   GATE_RECORD   only start recording while the stream's title matches this extended regex
#                 (case-insensitive; empty: whatever is on). Like fone-recorder-gate, but checked
#                 only when a recording starts.
set -u
QUALITY=${QUALITY:-audio_only,360p,480p,worst}
GATE=${GATE_RECORD:-}

title_of() { # the live stream's title, empty when it's off air
  streamlink --json "$1" 2>/dev/null | python3 -c '
import json, sys
try: d = json.load(sys.stdin)
except Exception: sys.exit()
if d.get("streams"): print((d.get("metadata") or {}).get("title") or "-")'
}

# The recording's path: named for the moment it starts, the title cut to 60 characters (not
# bytes: a name cut inside a UTF-8 character is one the server can't read) and made safe.
file_for() { # channel title
  python3 - "$1" "$2" <<'PY'
import datetime, re, sys
title = re.sub(r'[/\\:*?"<>|\x00-\x1f]', '_', sys.argv[2])[:60].strip() or 'live'
print(f"/rec/{sys.argv[1]}/{datetime.datetime.now():%Y%m%d-%H%M%S-%f}-{title}.ts")
PY
}

record() { # channel url
  name=$1 url=$2
  echo "recording $name: $url ($QUALITY)"
  while true; do
    title=$(title_of "$url")
    if [ -z "$title" ]; then sleep 30; continue; fi # off air
    if [ -n "$GATE" ] && ! printf '%s' "$title" | grep -Eiq "$GATE"; then sleep 120; continue; fi
    echo "$name is live: $title"
    # remuxed to MPEG-TS by ffmpeg, timestamps from 0 (a site's own may be hours into the
    # stream, and some send fMP4). The folder every time: fone-janitor deletes empty ones.
    mkdir -p "/rec/$name"
    file=$(file_for "$name" "$title")
    streamlink --loglevel warning --stream-segment-timeout 20 --stream-timeout 60 --stdout "$url" "$QUALITY" \
      | ffmpeg -hide_banner -loglevel error -i pipe:0 -map 0 -c copy -flush_packets 1 -f mpegts "$file"
    echo "$name: stream ended"
    [ -s "$file" ] || rm -f "$file"
    sleep 5
  done
}

[ -n "${STREAMS:-}" ] || { echo "STREAMS is empty: nothing to record (channel=URL ...)"; exit 1; }
trap 'trap - TERM INT; kill 0; exit 0' TERM INT # docker stop: end the recordings (the files stay)
for entry in $STREAMS; do
  case "$entry" in *=*) record "${entry%%=*}" "${entry#*=}" & ;; *) echo "skipping '$entry' (not channel=URL)" ;; esac
done
wait
