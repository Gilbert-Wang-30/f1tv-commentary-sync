#!/usr/bin/env bash
# End-to-end test of the no-server mode: headless Chrome with the extension recording a "live"
# stream itself (mock Bilibili and HLS platforms, mock_streams.py) in step with a mock F1 TV
# live player. No fone server anywhere. All in Docker.
#   e2e/local/run.sh                     the mock platforms (offline): test_local.py
#   e2e/local/run.sh real <live URL> ...  real streams (internet): real.py; E2E_OUT=<dir> keeps options.png
set -euo pipefail
cd "$(dirname "$0")/../.."
PW_IMAGE=${PW_IMAGE:-mcr.microsoft.com/playwright/python:v1.63.0-noble}
IMAGE=${E2E_IMAGE:-fone:dev} # only for its ffmpeg
WORK=$(mktemp -d)
CAP="--cpus 2 --cpu-shares 256"
cleanup() { docker run --rm -v "$WORK":/w alpine rm -rf /w/media >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

if [ "${E2E_BUILD:-1}" != 0 ]; then docker build -q -t "$IMAGE" server >/dev/null; fi
mkdir -p "$WORK/media/hls" "$WORK/media/fmp4" && chmod -R 777 "$WORK"

echo "== generating the mock F1 TV video and the 'live' commentary streams (20 min: FLV, HLS TS and fMP4)"
docker run --rm $CAP -v "$WORK":/w "$IMAGE" sh -c '
set -e
ffmpeg -v error -y -f lavfi -i color=c=gray:s=64x36:r=2:d=1200 -f lavfi -i anullsrc=r=48000:cl=stereo -t 1200 \
  -c:v libx264 -preset ultrafast -g 4 -c:a aac -b:a 16k -movflags +faststart /w/media/video.mp4
ffmpeg -v error -y -f lavfi -i sine=frequency=440:beep_factor=4:sample_rate=48000:duration=1200 \
  -f lavfi -i color=c=black:s=64x36:r=5:d=1200 -c:a aac -b:a 64k -ac 2 -c:v libx264 -preset ultrafast -g 10 \
  -shortest -f flv /w/media/live.flv
ffmpeg -v error -y -f lavfi -i sine=frequency=660:beep_factor=4:sample_rate=48000:duration=1200 \
  -f lavfi -i color=c=black:s=64x36:r=5:d=1200 -c:a aac -b:a 64k -ac 2 -c:v libx264 -preset ultrafast -g 10 \
  -shortest -f hls -hls_time 2 -hls_list_size 0 -hls_segment_filename /w/media/hls/seg_%05d.ts /w/media/hls/index.m3u8
ffmpeg -v error -y -f lavfi -i sine=frequency=880:beep_factor=4:sample_rate=44100:duration=1200 -c:a aac -b:a 64k -ac 2 \
  -f hls -hls_time 2 -hls_list_size 0 -hls_segment_type fmp4 -hls_fmp4_init_filename init.mp4 \
  -hls_segment_filename /w/media/fmp4/seg_%05d.m4s /w/media/fmp4/index.m3u8
'

echo "== running headless Chrome"
if [ "${1:-}" = real ]; then # the real platforms (real.py), streams given as the arguments after "real"
  shift
  mkdir -p "$WORK/out" && chmod 777 "$WORK/out"
  docker run --rm --cpus 4 --cpu-shares 256 --ipc=host \
    -v "$PWD/extension":/ext:ro -v "$PWD/e2e":/e2e:ro -v "$WORK/media":/media:ro -v "$WORK/out":/out -e REAL_TRACE -e REAL_SECS -e REAL_PICTURE \
    "$PW_IMAGE" sh -c 'pip install -q --break-system-packages playwright==1.63.0 >/dev/null 2>&1; python3 /e2e/local/real.py "$@"' real "$@"
  if [ -n "${E2E_OUT:-}" ]; then cp "$WORK/out/"* "$E2E_OUT"/; fi
  exit
fi
docker run --rm --cpus 4 --cpu-shares 256 --ipc=host \
  -v "$PWD/extension":/ext:ro -v "$PWD/e2e":/e2e:ro -v "$WORK/media":/media:ro \
  "$PW_IMAGE" sh -c 'pip install -q --break-system-packages playwright==1.63.0 >/dev/null 2>&1
    python3 /e2e/local/mock_streams.py & sleep 1.5; python3 /e2e/local/test_local.py'
