"""A replay that no recording covers, end to end, against the real Bilibili (run.sh).

The mock fone server has nothing recorded for the session; its channel's room is the real
23954427, whose Bilibili space has the 直播回放 of the 2025 British GP. The mock F1 TV plays a
stretch of that replay's own sound (from AT s into it) as F1 TV's sound, and the session is put
on the wall clock as if the stream had started 17 minutes off where fone looks first. fone has
to: find the streamer and the replays that may hold the session, find this moment in them by
sound, play the replay there (hls.js on its fMP4, from Bilibili's mirrors), keep it there by
sync by sound, find the replay's ~5 s repeats, and the next time the video opens, start where
it was at once.
"""

import asyncio
import json
import os
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import test_e2e as E  # noqa: E402  (the F1 TV mock and the status helpers)
from playwright.async_api import async_playwright  # noqa: E402

CID = "1000099902"
BVID = os.environ.get("BVID", "BV1JF31zgEbR")
AT = float(os.environ.get("AT", "2400"))
SLOT = 1751806800  # 2025-07-06 21点场 (13:00 UTC)
# F1 TV's sound at picture p is the replay's AT + p; the session's p0 puts fone's first guess
# (the stream going live half an hour into its slot, the delay 50 s) 17 minutes after that
P0 = SLOT + 1800 - 50 + AT + 1020
PORT = 8799
CHANNEL = "马莎拉车"
DIAG = []  # (the engine's diagnostics, posted to the mock server: printed as it goes)


class Mock(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, obj, code=200):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("access-control-allow-origin", "*")
        self.send_header("content-length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        p = self.path.split("?")[0]
        if p == "/api/health":
            return self.send({"ok": True, "now": time.time()})
        if p == "/api/channels":
            return self.send([{"name": CHANNEL}])
        if p == "/api/danmaku/status":
            return self.send({"rooms": {"23954427": {"channel": CHANNEL}}})
        if p == f"/api/f1tv/{CID}":
            return self.send({"contentId": CID, "title": "British Grand Prix - Race", "sessionName": "Race", "subtype": "REPLAY",
                              "p0": P0, "anchor": "preroll", "duration": 7200})
        if p.startswith("/api/sync/"):
            return self.send({"delay": 45.0, "source": "channel"})
        if p == "/api/timeline":
            return self.send({"files": [], "pieces": [], "playlist": None, "live": False, "complete": True, "mutes": [], "edge": None})
        return self.send({"detail": "not here"}, 404)

    def do_PUT(self):
        self.send({"ok": True})

    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(n) if n else b""
        if self.path.startswith("/api/diag"):
            try:
                for ev in json.loads(body).get("events") or []:
                    DIAG.append(ev)
                    if ev.get("type") in ("vod", "sound"):
                        print("   diag:", json.dumps({k: v for k, v in ev.items() if k not in ("client", "build", "platform")}, ensure_ascii=False)[:300], flush=True)
            except ValueError:
                pass
        self.send({"ok": True})


async def main():
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Mock)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            tempfile.mkdtemp(), channel="chromium", headless=True,
            args=["--load-extension=/ext", "--disable-extensions-except=/ext", "--autoplay-policy=no-user-gesture-required"],
        )
        sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event("serviceworker")
        await sw.evaluate(f"chrome.storage.sync.set({{source: 'server', servers: ['http://127.0.0.1:{PORT}'], soundSync: true, f1Feed: 'off', f1Pick: false}})")
        blob = open("/media/video.mp4", "rb").read()
        wav = open("/media/f1.wav", "rb").read()

        def ranged(route, body, ctype):
            rng = route.request.headers.get("range")
            if not rng:
                return route.fulfill(body=body, content_type=ctype, headers={"accept-ranges": "bytes"})
            a, _, b = rng.split("=", 1)[1].partition("-")
            a, b = int(a), int(b) if b else len(body) - 1
            return route.fulfill(status=206, body=body[a:b + 1], headers={"content-type": ctype, "accept-ranges": "bytes",
                                                                          "content-range": f"bytes {a}-{b}/{len(body)}"})

        async def f1tv(route):
            url = route.request.url
            if url.endswith("/media/f1.wav"):
                return await ranged(route, wav, "audio/wav")
            if url.endswith("/media/video.mp4"):
                return await ranged(route, blob, "video/mp4")
            return await route.fulfill(body=E.TM_PAGE, content_type="text/html")

        await ctx.route("https://f1tv.formula1.com/**", f1tv)
        page = await ctx.new_page()

        async def open_replay():
            nonlocal page
            await page.goto(f"https://f1tv.formula1.com/detail/{CID}/2025-british-gp-race?action=play&tm=1&f1audio=element")
            await page.wait_for_function("() => document.getElementById('v').readyState >= 3")
            await page.evaluate("() => { window.__f1Off = 0; }")  # (F1 TV's sound at the picture's own position)

        def placed(s):  # where the commentary plays against where F1 TV's sound is in the replay (AT + p)
            return s["m"] - (AT + s["p"])

        # ---- found by sound (at 2× chosen: F1 TV held at 1× while it looks) ----
        await sw.evaluate("chrome.storage.sync.set({speed: 2})")
        t0 = time.time()
        await open_replay()
        st = await E.wait_status(page, lambda s: (s.get("vod") or {}).get("state") in ("listening", "searching", "placed", "none", "error"),
                                 60, "the replay looked up")
        v = st["vod"]
        E.check(v["state"] not in ("none", "error") and v["reps"] >= 1,
                f"no recording: {CHANNEL}'s Bilibili replays that may hold the session found ({v['reps']}), {st['text']!r}")
        await asyncio.sleep(3)
        r1, text = await page.evaluate("() => window.__sdkRate()"), (await E.status(page)).get("text")
        E.check(r1 == 1, f"2× chosen: F1 TV at 1× while it looks ({r1}×)")
        st = await E.wait_status(page, lambda s: (s.get("vod") or {}).get("state") == "placed", 240, "placed in the replay by sound")
        took = time.time() - t0
        E.check(st["vod"]["bvid"] == BVID and took < 40, f"this moment found in {st['vod']['bvid']} ({st['vod']['title']}) by sound in {took:.0f}s"
                f" ({st['vod']['tries']} looks)")
        E.check((st.get("sound") or {}).get("carries") is True, "placed: F1 TV's own sound turned off (the replay carries it)")
        await E.wait_js(page, "() => window.__sdkRate()", lambda r: r == 2, 15, "2× again")
        st = await E.wait_status(page, lambda s: s.get("state") == "sync" and abs(placed(s)) < 0.5, 30, "in step at 2×")
        E.check(True, f"…then 2× again, the commentary in step ({placed(st) * 1000:+.0f} ms, drift {st['drift'] * 1000:+.0f} ms)")
        await sw.evaluate("chrome.storage.sync.set({speed: 1})")
        st = await E.wait_status(page, lambda s: s.get("state") == "sync" and (s.get("sound") or {}).get("state") == "locked"
                                 and abs(placed(s)) < 0.15, 120, "in sync, locked by sound")
        E.check(abs(placed(st)) < 0.15 and abs(st["drift"]) < 0.1,
                f"plays there, locked by sound: {placed(st) * 1000:+.0f} ms from F1 TV's sound (match {st['sound']['score']}),"
                f" drift {st['drift'] * 1000:+.0f} ms, delay {st['delay']}")
        a0 = st["audioTime"]
        await asyncio.sleep(3)
        st = await E.status(page)
        E.check(2.4 < st["audioTime"] - a0 < 3.6 and st["state"] == "sync", f"the replay's sound plays: {st['audioTime'] - a0:.2f}s in 3 s")
        details = await page.evaluate(E.DETAILS)
        E.check(f"Bilibili 直播回放 {BVID}" in details, "Details: the recording is the Bilibili replay")
        shown = await page.evaluate(f"() => {E.PANEL}.getElementById('delay').textContent")
        E.check(shown.startswith("delay 0.0") or shown.startswith("delay −0.0"), f"the delay reads against 50 s: {shown!r}")
        # ↗: the replay's own page at the moment playing
        pg = st.get("page") or ""
        E.check(pg.startswith(f"https://www.bilibili.com/video/{BVID}/?p=1&t=") and abs(int(pg.split("t=")[1]) - st["m"]) < 3,
                f"↗ opens the replay at this moment: {pg}")
        # by hand: still placed, nothing kept by sound, a nudge moves it and is kept for the replay
        await sw.evaluate("chrome.storage.sync.set({soundSync: false})")
        await asyncio.sleep(2)
        b = await E.status(page)
        await page.keyboard.press("]")
        st = await E.wait_status(page, lambda s: s.get("state") == "sync" and abs(placed(s) - (placed(b) + 0.5)) < 0.15, 20, "nudged by hand")
        E.check((st.get("vod") or {}).get("state") == "placed" and abs(st["delay"] - (b["delay"] + 0.5)) < 0.01,
                f"by hand: the replay plays on where it was, a nudge moves it (delay {b['delay']} -> {st['delay']}, {placed(st) * 1000:+.0f} ms)")
        await page.keyboard.press("[")
        await sw.evaluate("chrome.storage.sync.set({soundSync: true})")
        # the replay's own danmaku (the live chat on it), on the overlay, in step with it
        await sw.evaluate("chrome.storage.sync.get('danmaku').then((s) => chrome.storage.sync.set({danmaku: {...(s.danmaku || {}), on: true}}))")
        n = await E.wait_js(page, "() => document.getElementById('fone-danmaku')?.shadowRoot?.querySelectorAll('.dm').length || 0",
                            lambda k: k > 0, 90, "the replay's danmaku on screen")
        E.check(n > 0, f"the replay's own danmaku scroll over the picture ({n} on screen)")
        # the streamer window (📺): the replay's own picture, at the commentary's moment
        await page.evaluate(f"() => {E.PANEL}.getElementById('pic').click()")
        async def pic_state():
            fr = next((f for f in page.frames if "streamer.html" in f.url), None)
            if not fr:
                return None
            raw = await fr.evaluate("() => document.documentElement.dataset.state || null")
            return json.loads(raw) if raw else None
        deadline, ps = time.time() + 60, None
        while time.time() < deadline:
            ps = await pic_state()
            if ps and ps.get("src") == "vod" and ps.get("target") and ps["vtime"] > 1 and abs(ps["vtime"] - ps["target"]) < 0.6:
                break
            await asyncio.sleep(0.5)
        E.check(ps and ps.get("src") == "vod" and abs(ps["vtime"] - ps["target"]) < 0.6,
                f"📺 the streamer window plays the replay's picture at the commentary's moment ({json.dumps(ps)[:160]})")
        await page.evaluate(f"() => {E.PANEL}.getElementById('pic').click()")
        st = await E.wait_status(page, lambda s: (s.get("vod") or {}).get("cuts") is not None, 120, "the repeats found")
        E.check(st["vod"]["cuts"] >= 7, f"the replay's ~5 s repeats found: {st['vod']['cuts']}")
        st = await E.wait_status(page, lambda s: s.get("state") == "sync" and abs(placed(s)) < 0.15, 30, "still in step after the repeats")
        E.check(True, f"still in step with the repeats cut: {placed(st) * 1000:+.0f} ms")

        # ---- a seek within the replay: there at once ----
        await page.evaluate("() => tmSeek(contentPos() + 120)")
        st = await E.wait_status(page, lambda s: s.get("state") == "sync" and abs(placed(s)) < 0.3, 30, "after a seek")
        E.check(True, f"F1 TV 2 min on: the commentary with it ({placed(st) * 1000:+.0f} ms)")

        # ---- opened again (another tab: the engine starts over): where it was, at once ----
        await page.close()
        page = await ctx.new_page()
        t1 = time.time()
        await open_replay()
        st = await E.wait_status(page, lambda s: s.get("state") == "sync" and abs(placed(s)) < 0.3, 60, "placed again")
        E.check((st.get("vod") or {}).get("how") == "kept" and time.time() - t1 < 30,
                f"opened again: where it was, at once ({time.time() - t1:.0f}s, {placed(st) * 1000:+.0f} ms, {st['vod']['how']})")
        await ctx.close()
    srv.shutdown()
    print(f"== {E.passed} passed")


try:
    asyncio.run(main())
except AssertionError as e:
    print("FAIL:", e)
    sys.exit(1)
