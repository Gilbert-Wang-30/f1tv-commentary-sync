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
  With a server (mock_streams.py's fone.test), live: its channel's Bilibili room recorded here
    instead of the server's recording, at the delay set for that stream; the sponsor clips the
    server found muted by wall time; rewinding past what's recorded here and back again, in step
    with the picture; the stream refused here: back to the server's; off air when the page
    opened: the server's, and back to the stream once it's on air.
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
HOSTS = ["api.live.bilibili.com", "cn-test-01.bilivideo.com", "hls.test", "f1tv.formula1.com", "fone.test"]
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
        await sw.evaluate("chrome.storage.sync.set({source: 'local', stream: 'https://live.bilibili.com/5555', bufferMin: 1, servers: [], f1Feed: 'off'})")

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

        async def live_page(fl=32, noclock=False):
            await page.goto(f"https://f1tv.formula1.com/detail/{CID}/test-race?action=play&tm=1&ev=live{'&noclock=1' if noclock else ''}")
            await page.wait_for_function("() => document.getElementById('v').readyState >= 3")
            # the live edge 20 s ahead of the playhead (the mock's default), and F1 TV's picture `fl` s
            # behind its own clock (32: where the real one starts, about)
            await page.evaluate(f"() => {{ window.__event = 'live'; window.__origin = Date.now() - {fl * 1000} - contentPos() * 1000; }}")

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
        E.check(st["delaySource"] == "live" and abs(st["delay"] - 28) < 1e-6 and abs(st.get("f1Lat", 0) - 32) < 0.5,
                f"live default delay {st['delay']} (HTTP-FLV), F1 TV {st.get('f1Lat')} s behind its own clock")
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
        E.check(abs((edge - st["m"]) - (st["f1Lat"] - st["delay"])) < 0.3 and abs(st["f1Lat"] - 32) < 1,
                f"the commentary plays F1 TV's latency less the delay behind its edge (4 s where F1 TV starts, HTTP-FLV's default): "
                f"{edge - st['m']:.2f} (F1 TV {st['f1Lat']} s behind its clock)")
        a0 = st["audioTime"]
        await asyncio.sleep(2)
        st = await E.status(page)
        E.check(1.6 < st["audioTime"] - a0 < 2.4, f"the audio plays: {st['audioTime'] - a0:.2f}s in 2 s")

        # F1 TV's player rebuilt with its content position re-based (seen 2026-10-23 in FP1: its
        # position and its edge 585 s back together, a new MSE handle, the picture where it was, so
        # its clock on the picture too): the commentary goes on where it was, not 585 s back.
        b = await E.status(page)
        await page.evaluate("() => { window.__off -= 584; window.__origin += 584000; mainVid().setAttribute('handleID', '9'); }")
        await asyncio.sleep(2)
        st = await E.wait_status(page, lambda s: s.get("state") == "sync" and s.get("at", 0) > b["at"] + 1.5, 10, "after the re-base")
        moved = st["m"] - (b["m"] + (st["at"] - b["at"]))
        E.check(abs(moved) < 0.5, f"F1 TV's player re-based its position 584 s back: the commentary went on where it was ({moved:+.2f}s)")

        # F1 TV's picture to INTERNATIONAL (the world feed the streamer watches), live, once, by its
        # own channel switcher: the commentary re-synced after it, in sync; back to F1 LIVE yourself,
        # left there; F1 TV's sound 'English Int.' its international English commentary, not F1 LIVE's
        await sw.evaluate("chrome.storage.sync.set({f1Feed: 'intl'})")
        await E.wait_js(page, "() => document.getElementById('mainview').dataset.channelId", lambda c: c == "1025", 20, "INTERNATIONAL")
        st = await E.wait_status(page, lambda s: s.get("state") == "sync", 20, "in sync on INTERNATIONAL")
        await asyncio.sleep(6)
        clicks = await page.evaluate("() => window.__intlClicks || 0")
        st = await E.status(page)
        E.check(clicks == 1 and st["state"] == "sync" and abs(st["drift"]) < 0.08,
                f"live: F1 TV switched to INTERNATIONAL once ({clicks} click), the commentary in sync after it ({st['state']}, drift {st['drift'] * 1000:+.0f} ms)")
        await page.evaluate("() => tmSwitchFeed(1033, 'F1 LIVE')")
        await asyncio.sleep(8)
        ch = await page.evaluate("() => document.getElementById('mainview').dataset.channelId")
        E.check(ch == "1033" and await page.evaluate("() => window.__intlClicks") == 1, f"…and back on F1 LIVE by you: left there ({ch})")
        await sw.evaluate("chrome.storage.sync.set({f1Audio: 'eng'})")
        await E.wait_js(page, "() => __curAudio()", lambda n: n == "English Int.", 20, "English Int.")
        E.check(True, "F1 TV's sound 'English Int.': its international English commentary, not F1 LIVE's own 'English'")
        await sw.evaluate("chrome.storage.sync.set({f1Audio: 'mute', f1Feed: 'off'})")
        st = await E.wait_status(page, lambda s: s.get("state") == "sync", 20, "in sync again")

        # The streamer window (V): the stream's picture, from the recorder, in step with the
        # commentary: the frame shown within one of the mock's 5 fps frames of the moment the
        # commentary plays, the engine's own; rewinding F1 TV, the picture goes back with it; ⧉
        # puts it in a window of its own.
        async def picture(fr, pred, timeout, what):
            return await E.wait_js(fr, "() => JSON.parse(document.documentElement.dataset.state || 'null')", lambda s: s and pred(s), timeout, what)

        def in_step_with(pic, st):  # the picture's moment against the engine's, at the same time
            return pic["target"] - (st["m"] + (pic["at"] - st["at"]))

        await page.keyboard.press("v")
        fr = None
        for _ in range(40):
            fr = next((f for f in page.frames if "streamer.html" in f.url), None)
            if fr:
                break
            await asyncio.sleep(0.25)
        pic = await picture(fr, lambda s: s["src"] == "stream" and s["drawn"] > 10 and s["shown"] is not None, 20, "the streamer's picture")
        st = await E.status(page)
        pic = await picture(fr, lambda s: s["at"] > st["at"], 2, "a newer picture state")
        E.check(abs(pic["shown"] - pic["target"]) < 0.25 and abs(in_step_with(pic, st)) < 0.15,
                f"the streamer window (V): the stream's picture at the commentary's moment (frame {pic['shown'] - pic['target']:+.2f}s off, "
                f"{in_step_with(pic, st):+.2f}s from the engine's), {pic['drawn']} frames drawn")
        await picture(fr, lambda s: s["kept"] > 40, 50, "40 s of picture kept")
        before = (await E.status(page))["m"]
        await page.evaluate("() => tmSeek(contentPos() - 30)")
        st = await E.wait_status(page, lambda s: s.get("state") == "sync" and s.get("m") is not None and abs((before - s["m"]) - 30) < 2, 15, "rewound 30 s")
        pic = await picture(fr, lambda s: s["at"] > st["at"] + 1 and s["shown"] is not None and abs(s["shown"] - s["target"]) < 0.25, 10, "the picture rewound")
        st = await E.status(page)
        E.check(abs(in_step_with(pic, st)) < 0.3, f"rewinding F1 TV 30 s, the picture went back with the commentary ({in_step_with(pic, st):+.2f}s)")
        await page.evaluate("() => tmSeek(contentPos() + 30)")
        async with ctx.expect_page() as popped:
            await page.evaluate(f"() => document.getElementById('fone-streamer').shadowRoot.getElementById('pop').click()")
        win = await popped.value
        await win.wait_for_load_state()
        pic = await picture(win, lambda s: s["src"] == "stream" and s["drawn"] > 10, 20, "the picture in its own window")
        boxed = await page.evaluate("() => !document.getElementById('fone-streamer').hidden")
        E.check(not boxed, f"⧉: the picture in a window of its own ({pic['drawn']} frames drawn), the box over F1 TV closed")
        await win.close()

        # Go live: 30 s behind, L takes F1 TV (and the commentary with it) as far forward as both
        # allow: first as far as F1 TV's reported edge reaches (the mock's is always 20 s ahead:
        # +20), the rest once that has landed (+11: the commentary 3 s behind its edge, Go live's aim
        # on HTTP-FLV).
        st = await E.wait_status(page, lambda s: s.get("state") == "sync" and s["rec"]["kept"] >= 45, 40, "45 s recorded")
        before = st["m"]
        await page.evaluate("() => tmSeek(contentPos() - 30)")
        st = await E.wait_status(page, lambda s: s.get("state") == "sync" and s.get("m") is not None and before - s["m"] > 25, 15, "rewound 30 s")
        m0 = st["m"]
        await page.evaluate("() => { window.__seekCalls.length = 0; window.__f1live = 0; }")
        await page.keyboard.press("l")
        await asyncio.sleep(1.6)
        calls = await page.evaluate("() => window.__seekCalls.slice()")
        E.check(len(calls) >= 1 and calls[0]["timingType"] == 3 and 19500 < calls[0]["target"] <= 20000 and calls[0]["cls"] is True,
                f"Go live (L), 30 s behind: a relative seek of F1 TV (a Tiledmedia.TimingConfig) as far as its edge reaches, {calls[0]['target'] / 1000:+.1f}s")
        await asyncio.sleep(4)
        calls = await page.evaluate("() => window.__seekCalls.slice()")
        st = await E.wait_status(page, lambda s: s.get("state") == "sync", 15, "after Go live")
        edge = st["rec"]["edge"]
        E.check(len(calls) == 2 and 10000 < calls[1]["target"] < 12500 and abs((edge - st["m"]) - 3) < 0.5 and not st.get("holding") and st["m"] - m0 > 29,
                f"...then the rest, {calls[1]['target'] / 1000:+.1f}s: the commentary {edge - st['m']:.2f}s behind its edge, moved {st['m'] - m0:+.1f}s, not held")
        # Paused 2 s, then F1 TV's own LIVE badge, taken over: those 2 s forward again (never
        # "already live" for a pause). (A page without the SDK's TimingConfig: a plain object
        # through its strict-check switch, put back after.)
        await page.evaluate("() => { window.__seekCalls.length = 0; delete window.Tiledmedia.TimingConfig; mainVid().pause(); }")
        await asyncio.sleep(2)
        await page.evaluate("() => mainVid().play()")
        await asyncio.sleep(0.5)
        await page.evaluate("() => document.getElementById('livebadge').click()")
        await asyncio.sleep(1.6)
        calls, f1 = await page.evaluate("() => [window.__seekCalls.slice(), window.__f1live]")
        st = await E.wait_status(page, lambda s: s.get("state") == "sync", 15, "after LIVE")
        edge = st["rec"]["edge"]
        strict = await page.evaluate("() => 'disableStrictJSChecks' in window.Tiledmedia")
        E.check(len(calls) == 1 and 1500 < calls[0]["target"] < 2700 and f1 == 0 and abs((edge - st["m"]) - 3) < 0.5 and not st.get("holding")
                and calls[0]["strict"] is True and calls[0]["cls"] is False and not strict,
                f"paused 2 s, F1 TV's LIVE badge: fone's Go live instead of F1 TV's jump, {calls[0]['target'] / 1000:+.1f}s, "
                f"{edge - st['m']:.2f}s behind its edge, not held (without TimingConfig: the strict check off for the call, then back)")
        await page.evaluate("() => { window.__seekCalls.length = 0; }")
        await page.keyboard.press("l")
        await asyncio.sleep(1)
        E.check(await page.evaluate("() => window.__seekCalls.length") == 0, "Go live again: as live as the commentary allows, no seek")
        # F1 TV ahead of the commentary (its clock says 3 s nearer live: the commentary at its edge,
        # auto-hold holding): Go live steps F1 TV back to where the commentary keeps up.
        await page.evaluate("() => { window.__origin += 3000; window.__seekCalls.length = 0; }")
        await E.wait_status(page, lambda s: s.get("holding") or s.get("state") == "waiting", 10, "held for the commentary")
        await page.keyboard.press("l")
        st = await E.wait_status(page, lambda s: s.get("state") == "sync" and not s.get("holding") and abs((s["rec"]["edge"] - s["m"]) - 3) < 0.6, 10, "stepped back")
        calls = await page.evaluate("() => window.__seekCalls.slice()")
        E.check(len(calls) == 1 and -3600 < calls[0]["target"] < -2000,
                f"F1 TV ahead of the commentary, held: Go live steps it back {calls[0]['target'] / 1000 if calls else None}s, "
                f"the commentary {st['rec']['edge'] - st['m']:.2f}s behind its edge")

        # F1 TV's edge as the real one reports it: in 5.76 s steps, 30-35.8 s behind its clock, F1 TV
        # playing on past it between steps. Paused 3 s, Go live: those 3 s back, though the edge may
        # not reach them yet (a seek stops there): the rest as soon as it does, within a step.
        STEP = "(((Date.now() - window.__origin - 30000) % 5760 + 5760) % 5760)"  # ms since the edge last stepped
        await page.evaluate("() => { window.__edge = () => Math.floor((Date.now() - window.__origin - 30000) / 5760) * 5760; }")
        await asyncio.sleep(7)  # (a step or two seen)
        await page.evaluate("() => { window.__seekCalls.length = 0; mainVid().pause(); }")
        await asyncio.sleep(3)
        await page.evaluate("() => mainVid().play()")
        await asyncio.sleep(1)
        await page.keyboard.press("l")
        st = await E.wait_status(page, lambda s: s.get("state") == "sync" and abs((s["rec"]["edge"] - s["m"]) - 3) < 0.7, 10, "live again after a 3 s pause")
        await asyncio.sleep(1)
        calls = await page.evaluate("() => window.__seekCalls.slice()")
        total = sum(c["target"] for c in calls) / 1000
        E.check(2.3 < total < 3.5 and all(c["target"] > 0 for c in calls) and not st.get("holding"),
                f"paused 3 s, Go live against F1 TV's stepping edge: {[c['target'] / 1000 for c in calls]} s, "
                f"the commentary {st['rec']['edge'] - st['m']:.2f}s behind its edge again")
        # ...and while it waits for the edge, a rewind of yours ends it: paused 3 s again, Go live
        # just before a step (the edge reaching only part of the 3), then 10 s back yourself: no
        # seek after that.
        await page.evaluate("() => mainVid().pause()")
        await asyncio.sleep(3)
        await page.evaluate("() => mainVid().play()")
        ms = await page.evaluate(f"() => {STEP}")
        print(f"   (the edge stepped {ms} ms ago)", flush=True)
        await asyncio.sleep(((3500 - ms) % 5760) / 1000)
        await page.evaluate("() => { window.__seekCalls.length = 0; }")
        await page.keyboard.press("l")
        await asyncio.sleep(1.3)
        at_once = await page.evaluate("() => window.__seekCalls.slice()")
        await page.evaluate("() => tmSeek(contentPos() - 10)")
        await asyncio.sleep(7)
        calls = await page.evaluate("() => window.__seekCalls.slice()")
        st = await E.status(page)
        lag = st["rec"]["edge"] - st["m"]
        E.check(len(at_once) <= 1 and calls == at_once and all(c["target"] < 2500 for c in calls) and lag > 13,
                f"Go live waiting on F1 TV's edge ({[c['target'] / 1000 for c in at_once]} s at once), then 10 s back yourself: "
                f"left there ({lag:.1f}s behind the edge, seeks {[c['target'] / 1000 for c in calls]})")
        await page.evaluate("() => { window.__edge = null; }")
        await page.keyboard.press("l")
        st = await E.wait_status(page, lambda s: s.get("state") == "sync" and abs((s["rec"]["edge"] - s["m"]) - 3) < 0.5, 10, "back to live")

        # Rewind F1 TV 30 s: the commentary goes back 30 s with it (the buffer has it).
        before = (await E.status(page))["m"]
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

        # The connection drops: the recorder reconnects (re-resolving the room, ~1 s in all). Its
        # timestamps start again at 0 (as Bilibili's FLV does), so it's placed by arrival, as fresh
        # as the old one: the newest audio sits at the same m as the CDN's newest tag, before and
        # after (within a frame or two of read timing), and F1 TV isn't held (4 s behind the edge,
        # the audio waiting to be placed counts as in hand).
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
                f"F1 TV not held ({held}), gaps filled {st['rec']['filled']}s, {st['state']} '{st['text']}'")
        E.check(st["rec"]["player"]["err"] is None, f"the MSE player has no error ({st['rec']['player']})")

        # A nudge is kept for this stream, in this browser.
        await page.keyboard.press("]")
        st = await E.wait_status(page, lambda s: abs(s.get("delay", 0) - 28.5) < 1e-6, 5, "nudged")
        # in a new tab: a new attach, so the delay is read back from what was saved
        old = page
        page = await ctx.new_page()
        await old.close()
        # (this time F1 TV's player starts 35 s behind its clock, and gives no clock at first)
        await live_page(fl=35, noclock=True)
        st = await E.wait_status(page, lambda s: s.get("clock") == "edge" and s.get("delay") is not None, 20, "back after a reload")
        E.check(abs(st["delay"] - 28.5) < 1e-6 and st["delaySource"] == "stream", f"the nudge was kept for the stream: {st['delay']} ({st['delaySource']})")
        st = await E.wait_status(page, lambda s: s.get("state") == "sync", 30, "in sync after a reload")
        # Without F1 TV's clock: as if it had started where it usually does (32 s behind it). Once
        # the clock comes, the lock is made again by where F1 TV really is: 3 s further behind.
        await asyncio.sleep(1)
        st = await E.status(page)
        lag0 = st["rec"]["edge"] - st["m"]
        E.check(st.get("f1Lat") is None and abs(lag0 - (32 - 28.5)) < 0.3, f"no clock from F1 TV's player yet: {lag0:.2f}s behind the edge (as if 32 s behind it)")
        await page.evaluate("() => { window.__noClock = false; }")
        st = await E.wait_status(page, lambda s: s.get("state") == "sync" and s.get("f1Lat") is not None
                                 and abs((s["rec"]["edge"] - s["m"]) - (s["f1Lat"] - s["delay"])) < 0.3, 15, "locked again by F1 TV's clock")
        E.check(abs(st["f1Lat"] - 35) < 0.5, f"its clock came: F1 TV {st['f1Lat']} s behind it, the commentary {st['rec']['edge'] - st['m']:.2f}s behind its edge")
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
        E.check(st["state"] == "after" and st.get("lead") is None and not st.get("holding") and not paused
                and "轮播" in st["text"] and st.get("onAir") is False,
                f"off air mid-session, showing replays: '{st['text']}' (on air {st.get('onAir')}), F1 TV not held (paused {paused})")

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
                    and abs((edge - st["m"]) - (st["f1Lat"] - st["delay"])) < 0.3 and abs(st["delay"] - 25) < 1e-6,
                    f"HLS, {what}: in sync (drift {st['drift'] * 1000:+.0f} ms, {edge - st['m']:.2f}s behind its edge), "
                    f"{st['rec']['kept']}s kept, {st['rec']['fmt']}")
        stats = mock("/_ctl/stats")
        E.check(stats["hls_segments"] >= 12, f"{stats['hls_segments']} segments fetched over {stats['hls_playlists']} playlist loads")
        # F1 TV nearer live than where it usually starts (31 s behind its clock: the commentary 6 s
        # behind its HLS edge, nearer than Go live's 7): Go live leaves it there, not a step back
        # (the commentary isn't held, nor near it).
        await page.evaluate("() => { window.__origin += 4000; window.__seekCalls.length = 0; }")
        st = await E.wait_status(page, lambda s: s.get("state") == "sync" and abs((s.get("f1Lat") or 0) - 31) < 0.5, 10, "F1 TV 31 s behind its clock")
        await page.keyboard.press("l")
        await asyncio.sleep(1.5)
        calls = await page.evaluate("() => window.__seekCalls.slice()")
        st = await E.status(page)
        E.check(not calls and st["state"] == "sync" and not st.get("holding"),
                f"HLS, F1 TV 31 s behind its clock ({st['rec']['edge'] - st['m']:.2f}s behind the edge): Go live, no step back ({calls})")

        # ---------------- with a server: live straight from the stream ----------------
        mock("/_ctl/online")
        await sw.evaluate("chrome.storage.sync.set({source: 'server', servers: ['https://fone.test']})")
        st = await E.wait_status(page, lambda s: s.get("state") == "sync" and s.get("direct"), 40, "with a server: live from the stream")
        await asyncio.sleep(3)
        st = await E.status(page)
        rec, edge = st["rec"], st["rec"]["edge"]
        E.check(st["source"] == "server" and st["server"] == "https://fone.test" and st["channel"] == "测试解说"
                and rec["url"] == "https://live.bilibili.com/5555" and rec["state"] == "recording"
                and st["delaySource"] == "stream" and abs(st["delay"] - 28.5) < 1e-6 and abs((edge - st["m"]) - (st["f1Lat"] - st["delay"])) < 0.3
                and abs(st["drift"]) < 0.08,
                f"with a server, live: its channel's Bilibili room recorded here ({rec['url']}), at the delay set for the stream "
                f"({st['delay']}: {edge - st['m']:.2f}s behind its edge), drift {st['drift'] * 1000:+.0f} ms")
        rows = await page.evaluate(f"() => {E.PANEL}.getElementById('kv').textContent")
        E.check("straight from the stream" in rows and "sponsor clips" in rows, "Details say where live comes from")
        # a sponsor clip the server has just found (it aired 1 s ago): the engine looks every 1.5 s,
        # and mutes it by wall time while the commentary plays it, 3.5 s after it aired (its delay),
        # and on past its end until the server's analysis is 3 s past it (no clip after it, then)
        ad_w = mock("/_ctl/ad?in=-1")["w"]
        st = await E.wait_status(page, lambda s: s.get("ad"), 10, "the sponsor clip muted")
        heard = time.time()
        text = await page.evaluate(f"() => {E.PANEL}.getElementById('text').textContent")
        E.check(st["ad"] == "测试广告" and "sponsor clip muted" in text and 1.5 < heard - ad_w < 6,
                f"the server's sponsor clip muted by wall time, {heard - ad_w:.1f}s after it aired ('{text}')")
        st = await E.wait_status(page, lambda s: not s.get("ad"), 15, "the sponsor clip over")
        over = time.time() - ad_w
        E.check(9 < over < 15, f"…until it has played and the server knows nothing follows ({over:.1f}s after it aired)")

        # A break's clips back to back, the next one recognised only 5 s into it (live, as the server
        # finds them): the mute holds across the hand-off (no burst of the clip between them), and
        # the commentary fades back in after the break
        mock("/_ctl/ads_lag?s=2")
        a_w = mock("/_ctl/ad?in=-1&d=6")["w"]
        b_w = a_w + 6
        await E.wait_status(page, lambda s: s.get("ad"), 10, "the first clip muted")
        heard_gaps, told = [], False
        while time.time() < b_w + 8:
            if not told and time.time() >= b_w + 5:
                mock(f"/_ctl/ad?at={b_w}&d=6")
                told = True
            st = await E.status(page)
            if not st.get("ad") and (st.get("vol") or 0) > 0.01:
                heard_gaps.append(round(time.time() - a_w, 1))
            await asyncio.sleep(0.1)
        E.check(not heard_gaps, f"two clips back to back, the second known only 5 s into it: muted throughout (heard at {heard_gaps})")
        st = await E.wait_status(page, lambda s: not s.get("ad"), 20, "back after the break")
        v0 = st.get("vol")
        await asyncio.sleep(1.6)
        v1 = (await E.status(page)).get("vol")
        E.check(v0 is not None and v0 < 0.8 and v1 == 1, f"…and after it the commentary fades back in (volume {v0} → {v1})")
        mock("/_ctl/ads_lag?s=0")

        # Rewound past what this browser has recorded (it keeps 1 min here): the server's recording
        # plays it, the moment carried over by its wall time. The mock's F1 TV edge follows its
        # playhead at first, so F1 TV looks as live as ever and only the round trip's own carry
        # keeps the moment; then its edge is where it really is, and forward again within the
        # stream's recording the commentary goes back to the stream at the same moment; Go live
        # takes both to the stream's edge; rewound again, Go live from the server's recording does.
        # In step with the picture throughout: the commentary's wall time less F1 TV's position
        # (on the stream recorded here: m + now - its edge; on the mock server's: PIECE_W + m).
        sync_here = lambda s: s["m"] + s["at"] - s["rec"]["edge"] - s["p"]  # noqa: E731
        piece_w = mock("/_ctl/stats")["piece_w"]
        k0 = sync_here(await E.status(page))

        async def rewound(what):
            await page.evaluate("() => tmSeek(contentPos() - 120)")
            st = await E.wait_status(page, lambda s: s.get("source") == "server" and not s.get("direct") and s.get("m") is not None,
                                     15, "rewound into the server's recording")
            k = piece_w + st["m"] - st["p"]
            E.check(abs(k - k0) < 0.3 and abs(st["delay"] - 21) < 1e-6,
                    f"{what}: rewound 120 s past this browser's recording, the server's recording, in step with the picture "
                    f"({k - k0:+.2f}s), at the server's delay ({st['delay']})")

        async def back(what, lag=None):  # (None: F1 TV's latency less the delay, the lock's own)
            want = lambda s: lag if lag is not None else s["f1Lat"] - s["delay"]  # noqa: E731
            st = await E.wait_status(page, lambda s: s.get("direct") and s.get("state") == "sync" and abs(s["rec"]["edge"] - s["m"] - want(s)) < 1,
                                     20, what)
            edge, k, lag = st["rec"]["edge"], sync_here(st), want(st)
            E.check(abs(k - k0) < 0.3 and abs((edge - st["m"]) - lag) < 0.6 and abs(st["delay"] - 28.5) < 1e-6,
                    f"{what}: the stream recorded here, {edge - st['m']:.2f}s behind its edge (delay {st['delay']}), "
                    f"in step with the picture ({k - k0:+.2f}s)")

        await rewound("F1 TV's edge following it")
        await page.evaluate("() => { const e0 = contentPos() * 1000 + 140000, t0 = Date.now(); window.__edge = () => e0 + Date.now() - t0; }")
        await page.evaluate("() => tmSeek(contentPos() + 110)")
        await back("forward 110 s, within the stream's recording")
        await page.keyboard.press("l")
        await back("Go live", 3)
        await rewound("again")
        await page.keyboard.press("l")
        await back("Go live from the server's recording", 3)

        # the stream refused here: 22 s on (20 from 2 s after its last audio), the server's recording plays instead
        mock("/_ctl/refuse")
        t0 = time.time()
        st = await E.wait_status(page, lambda s: s.get("source") == "server" and not s.get("direct") and not s.get("rec"), 45,
                                 "back to the server's recording")
        took, n = time.time() - t0, mock("/_ctl/stats")["fone_timelines"]
        E.check(abs(st["delay"] - 21) < 1e-6 and st["delaySource"] == "live",
                f"…at the server's recording's own delay again: {st['delay']} ({st['delaySource']})")
        await asyncio.sleep(7)  # (the log goes out every 5 s)
        stats = mock("/_ctl/stats")
        logged = [e.get("on") for e in stats["diag"]]
        E.check(18 < took < 45 and stats["fone_timelines"] > n and logged[:1] == [True] and logged[-1] is False
                and not any("bilibili" in json.dumps(e) for e in stats["diag"]),  # (no URL in the log)
                f"the stream refused here: back to the server's recording after {took:.0f}s "
                f"(its timeline asked again: {stats['fone_timelines'] - n} times in 7 s), logged: {stats['diag'][-1]}")
        mock("/_ctl/accept")

        # The server's live recording ends (the streamer off air: Bilibili shows replays, which the
        # server doesn't record): past its end, the panel says so, rather than syncing to nothing.
        await page.keyboard.press("l")  # (from the edge: auto-hold held F1 TV while the stream was refused)
        await asyncio.sleep(2)

        # The streamer reconnects: the server's recording goes on in a new file 15 s later. Its m runs
        # on across files without those 15 s: the commentary is placed again by its wall time, silent
        # through the gap (F1 TV not held), and in step with the picture after it. Rewound back
        # across the gap, Go live takes it to the edge by wall time, in step, not held. Another
        # reconnect overlapping by 5 s (clipped by the server): skipped, in step.
        def server_wall(m):  # the wall time of server position m, as the mock server maps it
            pcs = mock("/_ctl/stats")["pieces"]
            pc = next((x for x in pcs if x["m"] <= m < x["m"] + x["d"]), None)
            return pc and pc["w"] + (m - pc["m"])

        def in_step(st):
            w = server_wall(st["m"])
            return None if w is None else w - st["p"] - k0

        st = await E.status(page)
        k0 = server_wall(st["m"]) - st["p"]
        mock("/_ctl/fone_cut?len=15")
        cut_m = mock("/_ctl/stats")["pieces"][0]["d"]
        st = await E.wait_status(page, lambda s: s.get("state") == "gap", 40, "the reconnect's gap")
        E.check(st.get("lead") is None and not st.get("holding"), f"the reconnect's gap: '{st['text']}', F1 TV not held")
        st = await E.wait_status(page, lambda s: s.get("m") is not None and s["m"] > cut_m + 1 and s.get("state") != "gap", 40, "after the gap")
        d = in_step(st)
        E.check(d is not None and abs(d) < 0.3, f"after the gap: the new file's audio, in step with the picture ({d:+.2f}s)")
        await page.evaluate("() => tmSeek(contentPos() - 30)")
        await asyncio.sleep(2)
        await page.keyboard.press("l")
        await asyncio.sleep(4)
        st = await E.status(page)
        d = in_step(st) if st.get("m") is not None else None
        E.check(d is not None and abs(d) < 0.3 and not st.get("holding") and (st.get("lead") or 0) > 3,
                f"rewound back across the gap, Go live: in step ({d}), lead {st.get('lead')}, F1 TV not held ({st['state']} '{st['text']}')")
        mock("/_ctl/fone_cut?len=-5")
        cut_m = mock("/_ctl/stats")["pieces"][1]["m"] + mock("/_ctl/stats")["pieces"][1]["d"]
        st = await E.wait_status(page, lambda s: s.get("m") is not None and s["m"] > cut_m + 6 and s.get("state") != "gap", 40, "past the overlap")
        d = in_step(st)
        E.check(d is not None and abs(d) < 0.3 and not st.get("holding"), f"a reconnect overlapping by 5 s: skipped, in step ({d:+.2f}s)")

        mock("/_ctl/fone_end")
        st = await E.wait_status(page, lambda s: s.get("text", "").endswith("is off air"), 25, "the server's recording ended")
        E.check(st["state"] == "waiting" and st.get("onAir") is False and st.get("lead") is None and not st.get("holding"),
                f"the server's live recording ended: '{st['text']}' (on air {st.get('onAir')}), F1 TV not held")
        mock("/_ctl/fone_live")

        # The server's other channel, room 6666, off air when the page opens (nothing recorded here),
        # F1 TV at its edge: waiting on the stream, said so; on air, the stream (the recorder looks
        # every 30 s while off air).
        await sw.evaluate("chrome.storage.sync.set({channel: '测试频道'})")  # (a new attach: the give-up above is forgotten)
        st = await E.wait_status(page, lambda s: s.get("channel") == "测试频道" and (s.get("rec") or {}).get("state") == "offline", 20, "off air at open")
        await asyncio.sleep(3)
        st = await E.status(page)
        E.check(st.get("direct") and st.get("onAir") is False and "not live" in st["text"] and not st.get("holding"),
                f"off air when the page opened, F1 TV live: on the stream, waiting ({st['state']} '{st['text']}'), F1 TV not held")
        mock("/_ctl/on6666")
        st = await E.wait_status(page, lambda s: s.get("direct") and s.get("state") == "sync", 80, "on air: the stream")
        E.check(st["rec"]["url"] == "https://live.bilibili.com/6666" and st["rec"]["state"] == "recording" and st.get("onAir") is True,
                f"on air: room 6666's stream recorded here ({st['rec']['kept']}s kept), on air {st.get('onAir')}")
        await ctx.close()
    print(f"\n{E.passed} checks passed")


asyncio.run(main())
