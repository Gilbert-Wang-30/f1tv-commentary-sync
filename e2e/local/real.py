"""The no-server mode against real platforms: headless Chrome + the real extension recording each
stream given (its live page URL), in step with the mock F1 TV live player, for ~40 s each. What
the mocks in test_local.py can't show: the platforms' APIs as they are today, the session rules
on their real CDNs, Douyin's cookie, real audio through MSE.

  e2e/local/run.sh real https://live.bilibili.com/<room> https://www.twitch.tv/<name> ...

Needs internet access; reads public live streams, logged out. Prints a line per stream; exits
non-zero if one didn't get in sync. Also saves the settings page as /out/options.png.
"""

import asyncio
import json
import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import test_e2e as E  # noqa: E402
from playwright.async_api import async_playwright  # noqa: E402

CID = "1000099902"


async def settled(page, timeout=25):
    """In step and staying so: the median drift of the last 6 looks (3 s) under 80 ms, within
    `timeout` s (one look can catch a correction under way: after a seek, a restart; and the
    engine takes a drift under 0.3 s back by speed, 0.5-2 %: 85 ms can take 17 s). The last status
    and whether it settled."""
    drifts, st, t0 = [], {}, time.time()
    while time.time() - t0 < timeout:
        st = await E.status(page)
        drifts = (drifts + [abs(st["drift"]) if st.get("state") == "sync" and st.get("drift") is not None else 9])[-6:]
        if len(drifts) == 6 and sorted(drifts)[3] < 0.08:
            return st, True
        await asyncio.sleep(0.5)
    return st, False


async def main(urls):
    bad = 0
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            tempfile.mkdtemp(), channel="chromium", headless=True,
            args=["--load-extension=/ext", "--disable-extensions-except=/ext", "--autoplay-policy=no-user-gesture-required"])
        sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event("serviceworker")
        ext = sw.url.split("/")[2]
        blob = open("/media/video.mp4", "rb").read()

        async def f1tv(route):
            url = route.request.url
            if "/2.0/R/" in url:
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

        # the settings page, as a user sees it
        opt = await ctx.new_page()
        await opt.set_viewport_size({"width": 760, "height": 1100})
        await opt.goto(f"chrome-extension://{ext}/options.html")
        await opt.check("#srcLocal")
        await opt.fill("#stream", urls[0])
        await opt.click("#testStream")
        await opt.wait_for_function("() => /✅|⏸|❌/.test(document.getElementById('outStream').textContent)", timeout=20000)
        print("options page Test stream:", (await opt.text_content("#outStream")).replace("\n", " | "))
        os.makedirs("/out", exist_ok=True)
        await opt.screenshot(path="/out/options.png", full_page=True)
        await opt.close()

        page = await ctx.new_page()
        for url in urls:
            await sw.evaluate(f"chrome.storage.sync.set({{source: 'local', stream: {json.dumps(url)}, bufferMin: 5, servers: []}})")
            await page.goto(f"https://f1tv.formula1.com/detail/{CID}/test?action=play&tm=1&ev=live")
            await page.wait_for_function("() => document.getElementById('v').readyState >= 3")
            await page.evaluate("() => { window.__event = 'live'; window.__origin = Date.now() - 32000 - contentPos() * 1000; }")
            t0, st, synced = time.time(), {}, None
            while time.time() - t0 < 45:
                st = await E.status(page)
                if st.get("state") == "sync" and synced is None:
                    synced = time.time() - t0
                if synced is not None and time.time() - t0 > synced + float(os.environ.get("REAL_SECS", 15)):
                    break
                if os.environ.get("REAL_TRACE") and st.get("m") is not None and (st.get("rec") or {}).get("edge") is not None:
                    p = await page.evaluate("() => contentPos()")
                    fx = st.get("fixes") or {}
                    print(f"    t {time.time() - t0:5.1f}  p {p:8.2f}  m {st['m']:8.2f}  edge-m {st['rec']['edge'] - st['m']:5.2f}  "
                          f"drift {round((st.get('drift') or 0) * 1000):+5d} ms  seeks {fx.get('nSeeks')} rates {fx.get('nRates')} rate {fx.get('rate')}  {st.get('state')}", flush=True)
                await asyncio.sleep(0.5 if not os.environ.get("REAL_TRACE") else 2)
            pic_ok = True
            if os.environ.get("REAL_PICTURE", "0") not in ("", "0"):  # the streamer window too: what it decodes and shows
                await page.keyboard.press("v")
                pic = None
                for _ in range(60):
                    fr = next((f for f in page.frames if "streamer.html" in f.url), None)
                    pic = fr and await fr.evaluate("() => JSON.parse(document.documentElement.dataset.state || 'null')")
                    if pic and pic.get("drawn", 0) > 30:
                        break
                    await asyncio.sleep(0.5)
                hevc = await page.evaluate("async () => { try { return (await VideoDecoder.isConfigSupported({codec: 'hvc1.1.6.L120.90'})).supported; } catch (e) { return String(e); } }")
                print(f"    picture: {json.dumps(pic, ensure_ascii=False)} · this browser decodes HEVC: {hevc}", flush=True)
                await page.keyboard.press("v")
                # (the FLV platforms' picture drawn; the others' window saying they have none)
                platform = (st.get("rec") or {}).get("platform")
                pic_ok = bool(pic) and (pic.get("drawn", 0) > 30 if platform in ("bilibili", "douyin", "huya") else "no picture" in (pic.get("msg") or ""))
            rec = st.get("rec") or {}
            st, drift_ok = await settled(page)
            ok = st.get("state") == "sync" and drift_ok and not (rec.get("player") or {}).get("err") and pic_ok
            # What a live session does with it, beyond getting in step (REAL_FULL=0 skips it):
            # where the commentary sits (F1 TV's latency less the delay behind its edge), its live
            # page (↗), F1 TV paused 3 s then Go live (L) back to the commentary's aim, and 20 s
            # back then Go live again (the buffer has it).
            notes = []
            if ok and os.environ.get("REAL_FULL", "1") != "0":
                try:
                    lag = lambda s: (s.get("rec") or {}).get("edge", 0) - (s.get("m") or 0)  # noqa: E731
                    want_lag = st["f1Lat"] - st["delay"] if st.get("f1Lat") is not None else None
                    placed = want_lag is not None and abs(lag(st) - want_lag) < 0.6
                    notes.append(f"placed {lag(st):.2f}s behind its edge (want {want_lag and round(want_lag, 2)})")
                    page_url = st.get("page")
                    notes.append(f"live page {page_url}")
                    await page.evaluate("() => mainVid().pause()")
                    await asyncio.sleep(3)
                    await page.evaluate("() => mainVid().play()")
                    await asyncio.sleep(1)
                    await page.keyboard.press("l")
                    aim = 3 if rec.get("platform") in ("bilibili", "douyin", "huya") else 7  # (Go live's aim: HTTP-FLV 3, HLS 7)
                    st2 = await E.wait_status(page, lambda s: s.get("state") == "sync" and abs(lag(s) - aim) < 1.0, 15, "Go live")
                    notes.append(f"paused 3 s, Go live: {lag(st2):.2f}s behind its edge")
                    await page.evaluate("() => tmSeek(contentPos() - 20)")
                    st3 = await E.wait_status(page, lambda s: s.get("state") == "sync" and lag(s) > aim + 15, 15, "rewound 20 s")
                    await page.keyboard.press("l")
                    st4 = await E.wait_status(page, lambda s: s.get("state") == "sync" and abs(lag(s) - aim) < 1.0, 15, "Go live again")
                    notes.append(f"20 s back ({lag(st3):.1f}s), Go live again: {lag(st4):.2f}s")
                    st, again_ok = await settled(page)
                    ok = placed and bool(page_url) == (rec.get("platform") != "url") and again_ok
                except AssertionError as e:
                    notes.append(f"FAILED: {e}")
                    ok = False
            bad += not ok
            print(f"{'OK ' if ok else 'BAD'} {url}\n    {st.get('state')} '{st.get('text')}' drift {round((st.get('drift') or 0) * 1000)} ms, "
                  f"in sync after {synced and round(synced, 1)}s · {rec.get('name')} · {rec.get('state')} {rec.get('text') or ''} · "
                  f"kept {rec.get('kept')}s · {rec.get('fmt')} · audio {rec.get('kbps')} kbps · stream {rec.get('net')} kbps · "
                  f"edge-m {None if rec.get('edge') is None or st.get('m') is None else round(rec['edge'] - st['m'], 2)}s · "
                  f"player {rec.get('player')} · err {rec.get('err') or st.get('error')}", flush=True)
            if notes:
                print("    " + " · ".join(notes), flush=True)
        await ctx.close()
    return bad


sys.exit(asyncio.run(main(sys.argv[1:])))
