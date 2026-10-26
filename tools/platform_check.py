#!/usr/bin/env python3
"""Finds a stream that's live right now on each platform fone records (Bilibili, Twitch, YouTube,
Douyin, Huya, a plain HLS URL) and prints their live page URLs, one per line, for
e2e/local/run.sh real. No F1 session needed: the F1 TV side is the e2e's mock live player.

  e2e/local/run.sh real $(tools/platform_check.py)        # or: tools/platform_check.sh

Reads the platforms' public listings, logged out. A platform with no live stream found makes it
fail (said on stderr), unless PLATFORM_CHECK_PARTIAL=1 (then the rest are still listed).
"""

import http.cookiejar
import json
import os
import sys
import urllib.request

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36"
TWITCH_CLIENT = "kimne78kx3ncx6brgo4mv6wki5h1ko"  # Twitch's own web client (what fone's resolver uses)


def get(url, headers=None, data=None, opener=None):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": UA, **(headers or {})})
    return (opener or urllib.request.build_opener()).open(req, timeout=15).read()


def bilibili():
    r = json.loads(get("https://api.live.bilibili.com/room/v1/Area/getListByAreaID?areaId=0&sort=online&pageSize=5&page=1"))
    return f"https://live.bilibili.com/{r['data'][0]['roomid']}"


def twitch():
    q = {"query": "query{streams(first:5){edges{node{broadcaster{login}}}}}"}
    r = json.loads(get("https://gql.twitch.tv/gql", {"Client-ID": TWITCH_CLIENT, "Content-Type": "application/json"}, json.dumps(q).encode()))
    return f"https://www.twitch.tv/{r['data']['streams']['edges'][0]['node']['broadcaster']['login']}"


def youtube():
    return "https://www.youtube.com/@LofiGirl"  # (a channel: fone follows whatever it streams; this one, round the clock)


# Rooms that were live 2026-10-26 (game streamers who stream most days), asked when Douyin's
# listing doesn't answer (it often doesn't, logged out).
DOUYIN_ROOMS = ["504984819963", "736290595118", "932086041005", "57763199623", "748940965508", "681719494483"]


def douyin():
    jar = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    ref = {"Referer": "https://live.douyin.com/"}
    get("https://live.douyin.com/", ref, opener=op)  # (its anonymous ttwid cookie)
    try:
        r = json.loads(get("https://live.douyin.com/webcast/web/partition/detail/room/v2/?aid=6383&app_name=douyin_web&live_id=1"
                           "&device_platform=web&count=10&offset=0&partition=720&partition_type=1", ref, opener=op))
        return f"https://live.douyin.com/{r['data']['data'][0]['web_rid']}"
    except (ValueError, KeyError, IndexError):
        pass
    for rid in DOUYIN_ROOMS:  # (what fone's resolver asks: the room's status, 2 = live)
        q = ("aid=6383&app_name=douyin_web&live_id=1&device_platform=web&language=zh-CN&enter_from=web_live&cookie_enabled=true"
             f"&browser_language=zh-CN&browser_platform=Win32&browser_name=Chrome&browser_version=141.0.0.0&web_rid={rid}")
        try:
            d = json.loads(get(f"https://live.douyin.com/webcast/room/web/enter/?{q}", ref, opener=op))["data"]
            if d["data"][0]["status"] == 2:
                return f"https://live.douyin.com/{rid}"
        except (ValueError, KeyError, IndexError, TypeError):
            continue
    raise RuntimeError("none of the usual rooms is live")


def huya():
    r = json.loads(get("https://www.huya.com/cache.php?m=LiveList&do=getLiveListByPage&tagAll=0&page=1"))
    return f"https://www.huya.com/{r['data']['datas'][0]['profileRoom']}"


def hls():
    return "https://demo.unified-streaming.com/k8s/live/stable/live.isml/.m3u8"  # (a public live demo, round the clock)


def main():
    out, missing = [], []
    for name, find in (("Bilibili", bilibili), ("Twitch", twitch), ("YouTube", youtube), ("Douyin", douyin), ("Huya", huya), ("HLS", hls)):
        for attempt in range(2):
            try:
                out.append(find())
                break
            except Exception as e:  # noqa: BLE001 (a listing that didn't answer: skipped, said why)
                if attempt:
                    print(f"platform_check: no live {name} stream found ({e})", file=sys.stderr)
                    missing.append(name)
    print(" ".join(out))
    # (a platform left out isn't a platform that works: say so, unless that's all right this time)
    if missing and os.environ.get("PLATFORM_CHECK_PARTIAL") != "1":
        sys.exit(f"platform_check: {', '.join(missing)} not tested (PLATFORM_CHECK_PARTIAL=1 runs the rest anyway)")


if __name__ == "__main__":
    main()
