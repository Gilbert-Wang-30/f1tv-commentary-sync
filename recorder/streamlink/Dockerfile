# A recorder for any live stream streamlink can play (YouTube, Twitch, Douyin, Huya, Bilibili,
# Kick, …), writing the folder layout the fone server reads. See record.sh.
FROM python:3.12-alpine
RUN apk add --no-cache ffmpeg && pip install --no-cache-dir streamlink==8.6.2
COPY record.sh /record.sh
ENTRYPOINT ["/bin/sh", "/record.sh"]
