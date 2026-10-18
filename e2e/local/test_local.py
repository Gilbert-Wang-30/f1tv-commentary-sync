"""The no-server mode, end to end: headless Chrome + the real extension recording a live stream
itself, in step with a mock F1 TV live player (test_e2e.py's Tiledmedia mock). The platforms
are mock_streams.py's, reached under their real names, so the resolvers, the Referer rule,
the demuxers, the buffer, the MSE player and the live lock all run as they do for real.

  Bilibili room (HTTP-FLV): resolved, Referer added (the CDN refuses without), recorded;
    live lock at the default delay; the edge matches what the CDN sent; rewinding F1 TV 30 s
    takes the commentary back 30 s; past the buffer says so; a dropped connection (its
    timestamps start again at 0) is placed by arrival (no shift); a nudge is kept for the stream
    in a new tab; the streamer going off air releases F1 TV.
  A room off air: said so.
  A direct HLS URL (MPEG-TS segments): recorded, in sync.
  The stats and 弹幕 stay hidden (no server).
"""

import asyncio
import json
import os
import sys
import tempfile
import time
import urllib.request
import ssl

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import test_e2e as E  # noqa: E402  (the F1 TV mocks and the status helpers)
from playwright.async_api import async_playwright  # noqa: E402

MEDIA = "/media"
CID = "1000099901"
HOSTS = ["api.live.bilibili.com", "cn-test-01.bilivideo.com", "hls.test", "f1tv.formula1.com"]
_TLS = ssl.create_default_context()
_TLS.check_hostname = False
_TLS.verify_mode = ssl.CERT_NONE


def mock(path):
    return json.load(urllib.request.urlopen(f"https://127.0.0.1{path}", context=_TLS, timeout=5))


async def main():
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            tempfile.mkdtemp(), channel="chromium", headless=True,
            args=["--load-extension=/ext", "--disable-extensions-except=/ext", "--autoplay-policy=no-user-gesture-required",
                  "--ignore-certificate-errors", "--host-resolver-rules=" + ", ".join(f"MAP {h} 127.0.0.1" for h in HOSTS)],
        )
        sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event("serviceworker")
        await sw.evaluate("chrome.storage.sync.set({source: 'local', stream: 'https://live.bilibili.com/5555', bufferMin: 1, servers: []})")

        blob = open(f"{MEDIA}/video.mp4", "rb").read()

        async def f1tv(route):
            url = route.request.url
            if "/2.0/R/" in url:  # F1 TV's content API, in case the offscreen document's fetches come here
                return await route.fulfill(body=json.dumps({"resultObj": {"containers": [{"metadata": {
                    "title": "Test Grand Prix - Race", "contentSubtype": "LIVE"}}]}}), content_type="application/json")
            if not url.endswith("/media/video.mp4"):
                return await route.fulfill(body=E.TM_PAGE, content_type="text/html")
            rng = route.request.headers.get("range", "bytes=0-")
            a, _, b = rng.split("=", 1)[1].partition("-")
            a, b = int(a), int(b) if b else len(blob) - 1
            await route.fulfill(status=206, body=blob[a:b + 1], headers={
                "content-type": "video/mp4", "accept-ranges": "bytes", "content-range": f"bytes {a}-{b}/{len(blob)}"})

        await ctx.route("https://f1tv.formula1.com/**", f1tv)
        page = await ctx.new_page()

        async def live_page():
            await page.goto(f"https://f1tv.formula1.com/detail/{CID}/test-race?action=play&tm=1&ev=live")
            await page.wait_for_function("() => document.getElementById('v').readyState >= 3")
            # the live edge 20 s ahead of the playhead (the mock's default)
            await page.evaluate("() => { window.__event = 'live'; window.__origin = Date.now() - 5000 - contentPos() * 1000; }")

        # ---------------- Bilibili, HTTP-FLV ----------------
        await live_page()
        st = await E.wait_status(page, lambda s: s.get("state") == "sync", 40, "in sync with the stream recorded here")
        rec = st["rec"]
        E.check(st["clock"] == "edge" and st["source"] == "local" and st["server"] is None,
                f"no server: live, edge to edge, the commentary recorded here ({st['text']})")
        E.check(rec["platform"] == "bilibili" and rec["state"] == "recording" and rec["name"] == "测试解说" and st["channel"] == "测试解说",
                f"Bilibili room resolved and recording: {rec['name']} · {rec['title']} · {rec['fmt']}")
        stats = mock("/_ctl/stats")
        E.check(stats["refused"] == 0 and len(stats["flv"]) == 1,
                f"the CDN got Bilibili's Referer/Origin (the session rule): {len(stats['flv'])} connection, {stats['refused']} refused")
        E.check(st["delaySource"] == "live" and abs(st["delay"] - 23) < 1e-6, f"live default delay {st['delay']}")
        await asyncio.sleep(4)
        st = await E.status(page)
        E.check(st["state"] == "sync" and abs(st["drift"]) < 0.05, f"in sync: drift {st['drift'] * 1000:+.0f} ms ({st['text']})")

        # The edge is where the CDN is: m 0 is the first frame received (the start of the burst)
        stats = mock("/_ctl/stats")
        first = stats["flv"][0]["first"]
        edge = st["rec"]["edge"]
        at = (st.get("dm") or {}).get("at") or time.time()
        sent = stats["pos"] - (stats["t"] - at)  # the stream position the CDN was at when the engine looked
        E.check(abs(edge - (sent - first)) < 0.4, f"the live edge is what the CDN sent: {edge:.2f} vs {sent - first:.2f}")
        E.check(abs((edge - st["m"]) - 7) < 0.3, f"the commentary plays 7 s behind its edge (default): {edge - st['m']:.2f}")
        a0 = st["audioTime"]
        await asyncio.sleep(2)
        st = await E.status(page)
        E.check(1.6 < st["audioTime"] - a0 < 2.4, f"the audio plays: {st['audioTime'] - a0:.2f}s in 2 s")

        # Rewind F1 TV 30 s: the commentary goes back 30 s with it (the buffer has it, once it does).
        st = await E.wait_status(page, lambda s: s.get("state") == "sync" and s["rec"]["kept"] >= 45, 40, "45 s recorded")
        before = st["m"]
        await page.evaluate("() => tmSeek(contentPos() - 30)")
        st = await E.wait_status(page, lambda s: s.get("state") == "sync" and s.get("m") is not None and abs((before - s["m"]) - 30) < 2, 15,
                                 "rewound 30 s with the buffer")
        E.check(True, f"rewinding F1 TV 30 s took the commentary back {before - st['m']:.1f}s (kept {st['rec']['kept']}s)")
        # Past what's kept (bufferMin 1): said so.
        await page.evaluate("() => tmSeek(contentPos() - 120)")
        st = await E.wait_status(page, lambda s: s.get("state") == "before", 10, "rewound past the buffer")
        E.check("Before the recording" in st["text"], f"rewound past the buffer: {st['text']}")
        await page.evaluate("() => tmSeek(contentPos() + 150)")
        st = await E.wait_status(page, lambda s: s.get("state") == "sync", 15, "back to live")

        # The connection drops: the recorder reconnects. Its timestamps start again at 0 (as
        # Bilibili's FLV does), so it's placed by arrival, as fresh as the old one: the newest
        # audio sits at the same m as the CDN's newest tag, before and after (within a frame or
        # two of read timing), and the gap is too short to hold F1 TV.
        async def placement():
            st, stats = await E.status(page), mock("/_ctl/stats")
            return st, st["rec"]["end"] - (stats["flv"][-1]["last"] - first)
        st, d0 = await placement()
        mock("/_ctl/kill")
        held = False
        for _ in range(30):
            await asyncio.sleep(0.2)
            held |= bool((await E.status(page)).get("holding"))
        st = await E.wait_status(page, lambda s: s.get("state") == "sync", 15, "in sync after a reconnect")
        await asyncio.sleep(2)
        st, d1 = await placement()
        stats = mock("/_ctl/stats")
        E.check(len(stats["flv"]) >= 2 and abs(d1 - d0) < 0.25 and not held and st["state"] == "sync",
                f"reconnected ({len(stats['flv'])} connections), placed by arrival {(d1 - d0) * 1000:+.0f} ms off, "
                f"F1 TV not held, gaps filled {st['rec']['filled']}s")
        E.check(st["rec"]["player"]["err"] is None, f"the MSE player has no error ({st['rec']['player']})")

        # A nudge is kept for this stream, in this browser.
        await page.keyboard.press("]")
        st = await E.wait_status(page, lambda s: abs(s.get("delay", 0) - 23.5) < 1e-6, 5, "nudged")
        # in a new tab: a new attach, so the delay is read back from what was saved
        old = page
        page = await ctx.new_page()
        await old.close()
        await live_page()
        st = await E.wait_status(page, lambda s: s.get("clock") == "edge" and s.get("delay") is not None, 20, "back after a reload")
        E.check(abs(st["delay"] - 23.5) < 1e-6 and st["delaySource"] == "stream", f"the nudge was kept for the stream: {st['delay']} ({st['delaySource']})")
        st = await E.wait_status(page, lambda s: s.get("state") == "sync", 30, "in sync after a reload")
        E.check(st["rec"]["kept"] > 40, f"the recording outlived the tab: {st['rec']['kept']}s kept")
        hidden = await page.evaluate(f"() => [{E.PANEL}.getElementById('statsRow').hidden, {E.PANEL}.getElementById('dm').hidden]")
        E.check(hidden == [True, True], "no server: the stats and 弹幕 buttons are hidden")

        # The streamer goes off air mid-session: the panel says so, and F1 TV isn't held waiting
        # for commentary that isn't coming.
        mock("/_ctl/offline")
        st = await E.wait_status(page, lambda s: s.get("state") == "after", 45, "the stream stopped")
        await asyncio.sleep(3)
        st = await E.status(page)
        paused = await page.evaluate("() => document.getElementById('v').paused")
        E.check(st["state"] == "after" and st.get("lead") is None and not st.get("holding") and not paused,
                f"off air mid-session: '{st['text']}', F1 TV not held (paused {paused})")

        # ---------------- a room off air ----------------
        await sw.evaluate("chrome.storage.sync.set({stream: 'live.bilibili.com/6666'})")
        st = await E.wait_status(page, lambda s: (s.get("rec") or {}).get("label") == "Bilibili 6666" and s["rec"]["state"] == "offline"
                                 and s.get("state") == "none", 20, "off air")
        E.check(st["state"] == "none" and "not live" in st["text"], f"off air: {st['text']}")

        # ---------------- direct HLS URLs ----------------
        for url, what, fmt in (("https://hls.test/live/index.m3u8", "MPEG-TS segments", "48 kHz stereo"),
                               ("https://hls.test/master.m3u8", "YouTube's shape: its AAC-LC audio rendition, fMP4", "44.1 kHz stereo")):
            await sw.evaluate(f"chrome.storage.sync.set({{stream: '{url}'}})")
            st = await E.wait_status(page, lambda s: s.get("state") == "sync" and s.get("rec", {}).get("url") == url, 40, f"HLS in sync: {url}")
            await asyncio.sleep(5)
            st = await E.status(page)
            edge = st["rec"]["edge"]
            E.check(st["state"] == "sync" and abs(st["drift"]) < 0.05 and st["rec"]["state"] == "recording" and st["rec"]["fmt"] == fmt
                    and abs((edge - st["m"]) - 7) < 0.3,
                    f"HLS, {what}: in sync (drift {st['drift'] * 1000:+.0f} ms, {edge - st['m']:.2f}s behind its edge), "
                    f"{st['rec']['kept']}s kept, {st['rec']['fmt']}")
        stats = mock("/_ctl/stats")
        E.check(stats["hls_segments"] >= 12, f"{stats['hls_segments']} segments fetched over {stats['hls_playlists']} playlist loads")
        await ctx.close()
    print(f"\n{E.passed} checks passed")


asyncio.run(main())
