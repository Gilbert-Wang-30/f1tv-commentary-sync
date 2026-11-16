#!/usr/bin/env bash
# A replay no recording covers, end to end, against the real Bilibili: headless Chrome with the
# extension, a mock fone server with nothing recorded for the session (its channel's room the real
# 23954427), and a mock F1 TV playing a stretch of that room's real 直播回放 as "F1 TV's sound".
# fone has to find the replay, the moment in it by sound, and play it there. Needs the internet.
#   e2e/vod/run.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
PW_IMAGE=${PW_IMAGE:-mcr.microsoft.com/playwright/python:v1.63.0-noble}
IMAGE=${E2E_IMAGE:-fone:dev} # only for its ffmpeg and python
WORK=$(mktemp -d)
cleanup() { docker run --rm -v "$WORK":/w alpine rm -rf /w/media >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
mkdir -p "$WORK/media" && chmod -R 777 "$WORK"
BVID=${VOD_BVID:-BV1JF31zgEbR} CID=${VOD_CID:-30901406039} AT=${VOD_AT:-2400} LEN=${VOD_LEN:-660}

echo "== the replay's sound from ${AT}s ($LEN s) as F1 TV's, and a mock F1 TV video"
docker run --rm --cpus 2 -v "$WORK":/w -e BVID=$BVID -e CID=$CID -e AT=$AT -e LEN=$LEN "$IMAGE" sh -c '
set -e
URL=$(python3 -c "
import json, os, urllib.request
r = urllib.request.Request(f\"https://api.bilibili.com/x/player/playurl?bvid={os.environ[\"BVID\"]}&cid={os.environ[\"CID\"]}&fnval=16&fnver=0&qn=0&try_look=1\",
    headers={\"User-Agent\": \"Mozilla/5.0\", \"Referer\": \"https://www.bilibili.com/\"})
a = json.load(urllib.request.urlopen(r))[\"data\"][\"dash\"][\"audio\"]
print(next(x for x in a if x[\"id\"] == 30232)[\"base_url\"])")
ffmpeg -v error -y -user_agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36" \
  -headers "Referer: https://live.bilibili.com/
" -ss $AT -t $LEN -i "$URL" -ac 1 -ar 8000 /w/media/f1.wav
ffmpeg -v error -y -f lavfi -i color=c=gray:s=64x36:r=2:d=$LEN -f lavfi -i anullsrc=r=48000:cl=stereo -t $LEN \
  -c:v libx264 -preset ultrafast -g 4 -c:a aac -b:a 16k -movflags +faststart /w/media/video.mp4
ls -la /w/media'

echo "== running headless Chrome"
# (VOD_SHOT=<dir>: a screenshot of the stats cut from the streamer's screen, at 2560×1270, there)
mkdir -p "$WORK/out" && chmod 777 "$WORK/out"
docker run --rm --cpus 4 --cpu-shares 256 --ipc=host \
  -v "$PWD/extension":/ext:ro -v "$PWD/e2e":/e2e:ro -v "$WORK/media":/media:ro -v "$WORK/out":/out -e BVID=$BVID -e AT=$AT -e VOD_SHOT \
  "$PW_IMAGE" sh -c 'pip install -q --break-system-packages playwright==1.63.0 >/dev/null 2>&1; python3 /e2e/vod/test_vod.py'
if [ -n "${VOD_SHOT:-}" ]; then cp "$WORK/out/"* "$VOD_SHOT"/ 2>/dev/null || true; fi
