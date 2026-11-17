"""HTTP API for the browser extension."""

from __future__ import annotations

import asyncio
import html
import logging
import os
import re
import time
from contextlib import asynccontextmanager
from dataclasses import replace

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse
from pydantic import BaseModel, Field

from . import config, recordings
from .extractor import Extractor, FileState, Piece
from .f1 import F1Mapper
from .store import CLOCK_FAMILY, Store
from .timeline import MIN_CLIP_SECONDS, MIN_FILL_SECONDS, content_span, mutes as ad_mutes, uncovered, union

log = logging.getLogger("fone")
VERSION = os.environ.get("FONE_VERSION") or "dev"  # a release's image is stamped with its own
SEG_RE = re.compile(r"^seg_\d{5}\.ts$")
MAX_DELAY = 86400.0  # no streamer's delay is further off than this
# Screen-clock results good enough to beat the channel's calibrated default.
MEASURED_CONFIDENCE = ("high", "medium")


cfg = config.load()
store = Store(cfg.data_dir / "fone.sqlite3")
# Everything is built at import so the routers below can be mounted; nothing runs until
# lifespan starts it.
extractor = Extractor(cfg)
mapper = F1Mapper(store)


# Optional services, imported only when enabled (numpy, tesseract): (service, router).
def _timing():
    from .timing import TimingService, make_router

    svc = TimingService(cfg, mapper)
    return svc, make_router(svc)


def _ads():
    from .ads import AdService, make_router

    svc = AdService(cfg, extractor)
    return svc, make_router(svc)


def _screenclock():
    from .screenclock import ScreenClockService, make_router

    svc = ScreenClockService(cfg, extractor)
    return svc, make_router(svc)


def _video():
    from .video import VideoService, make_router

    svc = VideoService(cfg, extractor)
    return svc, make_router(svc)


def _backfill():
    from .backfill import BackfillService, Settings, make_router

    svc = BackfillService(cfg, extractor, store,
                          replace(Settings.from_env(), rooms=cfg.rooms, import_dir=cfg.import_dir))
    return svc, make_router(svc)


def _danmaku():
    from .danmaku import DanmakuService, make_router

    svc = DanmakuService(cfg)
    return svc, make_router(svc)


def _vodclock():
    from .vodclock import VodClockService, make_router

    svc = VodClockService(cfg, timing)
    return svc, make_router(svc)


def _build(name, build):
    """An enabled service, or None. One that can't even be built (missing numpy, bad
    settings) is left out rather than taking the commentary sync down with it."""
    if name not in cfg.features:
        return None
    try:
        svc, router = build()
    except Exception as e:
        log.exception("%s disabled: failed to initialise", name)
        FAILED[name] = str(e) or type(e).__name__
        return None
    routers.append(router)
    return svc


routers: list = []
FAILED: dict[str, str] = {}  # (a service that's on but couldn't start: why, for /api/health's notes)
timing = _build("timing", _timing)
ads = _build("ads", _ads)
screenclock = _build("screenclock", _screenclock)
video = _build("video", _video)
backfill = _build("backfill", _backfill)
danmaku = _build("danmaku", _danmaku)
vodclock = _build("vodclock", _vodclock) if timing is not None else None  # (reads the session's timing)
SERVICES = {name: svc for name, svc in
            (("timing", timing), ("ads", ads), ("screenclock", screenclock), ("video", video),
             ("backfill", backfill), ("danmaku", danmaku), ("vodclock", vodclock)) if svc is not None}


async def _scanner() -> None:
    while True:
        try:
            recs = await asyncio.to_thread(recordings.scan, cfg.rec_dir, cfg.filename_tz, cfg.channel_aliases,
                                           cfg.import_dir)
            extractor.update(recs)
            extractor.tick()
        except Exception:
            log.exception("scan failed")
        await asyncio.sleep(cfg.scan_interval)


@asynccontextmanager
async def lifespan(_: FastAPI):
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)  # one line per request otherwise
    task = asyncio.create_task(_scanner())
    log.info("watching %s (imports: %s; services: %s)", cfg.rec_dir, cfg.import_dir, ", ".join(SERVICES) or "none")
    started = []
    for name, svc in SERVICES.items():
        try:  # nor one that fails to start
            await svc.start()
            started.append(svc)
        except Exception:
            log.exception("%s failed to start", name)
    yield
    for svc in reversed(started):
        try:
            await svc.stop()
        except Exception:
            log.exception("stopping %s", type(svc).__name__)
    task.cancel()
    await extractor.shutdown()
    await mapper.close()


EXTENSION_ORIGIN = r"(chrome|moz)-extension://[^/]+"  # the extension's pages (Chrome's, Firefox's)


class RefuseWebPages:
    """What changes something, starts work or hands out what viewers did is for the extension
    (an Origin of its own, chrome-extension://…) and for scripts (no Origin, and the header
    X-Fone: 1, which curl, tools/ and the e2e harnesses send). A web page you merely visit is
    refused: it could otherwise re-tune your delays, write fake car positions into a live
    session, start replay downloads (GBs, over the recorders' connection, into the NAS) and
    OpenF1 rebuilds of any session, extract old recordings, or read every viewer's playback.

    A page can pass for neither. Its fetch() carries its own Origin. Its <img>, <script>, link,
    form GET or no-cors fetch() carry no Origin, but no header of its choosing either; a fetch()
    that adds one is a CORS request, whose preflight is refused (CORS below allows the
    extension's origins only). Sec-Fetch-Site can't tell them apart: Chrome sends it only to
    https and localhost, and a fone server is mostly plain http on the LAN or a VPN. (DNS
    rebinding, a page's own name pointed at the server, makes its requests same-origin: that
    isn't stopped here, Chrome's asking before a site reaches the local network is.)

    Open to anyone (OPEN): GETs that start nothing (status, the channels) and the recordings'
    audio for hls.js. The extension sends X-Fone on all of its requests anyway."""

    EXTENSION = re.compile(EXTENSION_ORIGIN)
    READ = frozenset({"GET", "HEAD"})
    # (JSON, as every answer: an extension from before 1.0.1 sends no X-Fone and gets this, and
    # whoever looks at the answer reads what to do rather than a bare 403)
    REFUSAL = {"error": "refused: not the fone extension. Update the fone extension (1.0.1 or later) "
                        "or send X-Fone: 1"}
    OPEN = re.compile(r"^/(|api/(health|channels|playlist\.m3u8|danmaku|danmaku/status|timing/status|backfill/status"
                      r"|ads/[^/]+|screenclock/[^/]+)|hls/[^/]+/[^/]+)$")

    def __init__(self, app):
        self.app = app

    @classmethod
    def trusted(cls, headers: dict[bytes, bytes]) -> bool:
        origin = headers.get(b"origin")
        if origin is not None:  # (a page's, "null" included; a script sends none)
            return bool(cls.EXTENSION.fullmatch(origin.decode("latin-1")))
        return headers.get(b"x-fone") == b"1"

    @classmethod
    def gated(cls, method: str, path: str) -> bool:
        # (an OPTIONS here is no preflight, CORS answered those: FastAPI's 405)
        return method != "OPTIONS" and not (method in cls.READ and cls.OPEN.match(path))

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and self.gated(scope["method"], scope["path"]) and not self.trusted(dict(scope["headers"])):
            resp = JSONResponse(self.REFUSAL, status_code=403)
            return await resp(scope, receive, send)
        await self.app(scope, receive, send)


app = FastAPI(title="fone", lifespan=lifespan)
app.add_middleware(RefuseWebPages)  # inside CORS, so its 403 carries the extension's CORS headers
# Only the extension's pages may read answers across origins, or send X-Fone. allow_private_network:
# Chrome preflights requests from a public origin to a LAN host.
app.add_middleware(CORSMiddleware, allow_origin_regex=EXTENSION_ORIGIN, allow_methods=["GET", "HEAD", "PUT", "POST"],
                   allow_headers=["Content-Type", "X-Fone"], allow_private_network=True)
for _router in routers:
    app.include_router(_router)

# Playback diagnostics from the extension (diag.py): always on, it's how problems get debugged.
from .diag import make_router as _diag_router, make_store as _diag_store  # noqa: E402

diag_store = _diag_store(cfg)
app.include_router(_diag_router(diag_store))


# ---- helpers ---------------------------------------------------------------


def _span_guess(st: FileState) -> tuple[float, float]:
    """Rough wall span for files we haven't extracted yet: [created, last write]."""
    rec = st.rec
    start = rec.name_time if rec.name_time is not None else rec.mtime - 6 * 3600
    return start, rec.mtime


def _channel_files(channel: str) -> list[FileState]:
    return [st for st in extractor.files.values() if st.rec.channel == channel]


async def _measured(cid: str, channel: str) -> dict | None:
    """Streamer delay from the screen clock of the recording covering this content:
    commentary about event E is recorded at E + delayScreen + reaction."""
    if screenclock is None or not cid.isdigit():
        return None
    cached = store.get_content(cid)
    try:
        data = cached[0] if cached else await mapper.content(cid)
    except Exception:
        log.exception("content %s", cid)
        return None
    span = content_span(data)
    if span is None:
        return None
    lo, hi = span[0] + cfg.default_delay, span[1] + cfg.default_delay  # where its commentary sits
    found = []
    for st in _channel_files(channel):
        if st.status not in ("running", "done"):
            continue
        pieces, _, _ = extractor.pieces(st)
        overlap = sum(max(0.0, min(hi, p.wall + p.duration) - max(lo, p.wall)) for p in pieces)
        if overlap > 0:
            found.append((st.rec.source == "recorder", overlap, st))
    for _, _, st in sorted(found, key=lambda f: f[:2], reverse=True):
        res = screenclock.result(st.rec.id)
        # zonesChecked False: OpenF1 was down, so the clock was read modulo 15 min and a
        # MultiViewer replay of another session could pass for a delay. Wait for the re-check.
        if res and res.get("delayScreen") is not None and res.get("confidence") in MEASURED_CONFIDENCE \
                and res.get("zonesChecked") is not False:
            screen = res["delayScreen"]
            return {"delay": round(screen + cfg.reaction_seconds, 3), "source": "measured", "screen": screen,
                    "reaction": cfg.reaction_seconds, "confidence": res["confidence"], "file": st.rec.id}
    return None


# ---- routes ----------------------------------------------------------------


def _notes() -> list[str]:
    """What this server's setup leaves out that a viewer may wonder about: the configuration's
    (config.notes, also logged at start: no room, a folder that isn't there) and the tools'.
    The options page's Test connection and the status page show them."""
    out = config.notes(cfg)
    out += [f"{name} is off: it couldn't start ({why}); the server's log has the details"
            for name, why in FAILED.items()]
    if vodclock is not None and vodclock.missing:
        out.append(f"No {' or '.join(vodclock.missing)} on the server: Bilibili replays aren't placed by the clock on "
                   "the streamer's screen")
    return out


@app.get("/api/health")
def health():
    return {"ok": True, "version": VERSION, "recDir": str(cfg.rec_dir), "files": len(extractor.files),
            "now": time.time(), "services": sorted(SERVICES), "notes": _notes()}


@app.get("/api/channels")
def channels():
    out: dict[str, dict] = {}
    now = time.time()
    for st in extractor.files.values():
        c = out.setdefault(st.rec.channel, {"name": st.rec.channel, "files": 0, "latest": 0.0, "live": False})
        c["files"] += 1
        c["latest"] = max(c["latest"], st.rec.mtime)
        c["live"] = c["live"] or extractor.is_growing(st.rec, now)
    return sorted(out.values(), key=lambda c: -c["latest"])


@app.get("/api/f1tv/{cid}")
async def f1tv(cid: str, refresh: bool = False):
    if not cid.isdigit():
        raise HTTPException(400, "content id must be numeric")
    return await mapper.content(cid, refresh=refresh)


class SyncBody(BaseModel):
    channel: str = Field(max_length=200)
    clock: str = Field(max_length=40)
    delay: float  # (put_sync checks it: pydantic's own error would echo an Infinity back, unanswerable)


@app.get("/api/sync/{cid}")
async def get_sync(cid: str, channel: str, clock: str):
    if (d := store.content_delay(cid, channel, clock)) is not None:
        return {"delay": d, "source": "content"}
    # The screen clock measures against true UTC, so only a true-UTC clock can use it.
    if CLOCK_FAMILY.get(clock) == "utc" and (measured := await _measured(cid, channel)) is not None:
        return measured
    # Only from a comparable clock: a live session's -0.2 on F1 TV's player clock (epoch)
    # once started a replay's commentary 45 s early.
    if (d := store.family_delay(channel, clock)) is not None:
        return {"delay": d, "source": "channel"}
    return {"delay": cfg.default_delay, "source": "default"}


@app.put("/api/sync/{cid}")
def put_sync(cid: str, body: SyncBody):
    # (Python's json reads Infinity and NaN: stored, the channel's every comparable clock would
    # start from it, and no answer can carry it)
    if not abs(body.delay) <= MAX_DELAY:
        raise HTTPException(422, f"delay must be a number of seconds within ±{MAX_DELAY:.0f}")
    store.set_delay(cid, body.channel, body.clock, round(body.delay, 3))
    return {"ok": True}


@app.get("/api/timeline")
def timeline(channel: str, start: float = Query(alias="from"), end: float = Query(alias="to")):
    now = time.time()
    candidates = []
    for st in _channel_files(channel):
        lo, hi = _span_guess(st)
        if hi >= start and lo <= end:
            extractor.ensure(st)  # old recordings are extracted on demand
            candidates.append(st)

    entries = []
    for st in candidates:
        pieces, segs, provisional = extractor.pieces(st)
        wall = pieces[0].wall if pieces else _span_guess(st)[0]
        entries.append((wall, st, pieces, segs, provisional))
    entries.sort(key=lambda e: e[0])

    # Files that may be in the playlist: those up to the first one still growing or being
    # extracted (keeps the playlist append-only). Imports join once fully extracted, so
    # they never hold the others back.
    eligible, blocked = [], False
    for i, (_, st, _, segs, _) in enumerate(entries):
        if segs and not blocked and (st.rec.source == "recorder" or st.status == "done"):
            eligible.append(i)
            blocked = st.status != "done"
    # Wall time each file is played for: recordings in wall order, then imports only where
    # nothing before them covers, so no two pieces overlap.
    played: dict[int, list[Piece]] = {}
    covered: list[tuple[float, float]] = []
    for i in sorted(eligible, key=lambda i: entries[i][1].rec.source != "recorder"):
        min_len = MIN_CLIP_SECONDS if entries[i][1].rec.source == "recorder" else MIN_FILL_SECONDS
        played[i] = [q for p in entries[i][2] for q in uncovered(p, covered, min_len)]
        covered = union(covered + [(p.wall, p.wall + p.duration) for p in played[i]])

    files, out_pieces, mutes, playlist_ids = [], [], [], []
    offset = 0.0
    for i, (wall, st, pieces, segs, provisional) in enumerate(entries):
        in_playlist = bool(played.get(i))
        duration = segs[-1].end if segs else 0.0
        ad_state = ads.state(st.rec.id) if ads is not None and in_playlist else None
        files.append({
            "id": st.rec.id, "name": st.rec.name, "title": st.rec.title, "source": st.rec.source,
            "status": st.status, "growing": extractor.is_growing(st.rec, now), "provisional": provisional,
            "inPlaylist": in_playlist, "wallStart": wall,
            "wallEnd": (pieces[-1].wall + pieces[-1].duration) if pieces else None,
            "duration": duration, "offset": offset if in_playlist else None, "error": st.error,
            "adsAnalyzedTo": ad_state["analyzedTo"] if ad_state else None,
        })
        if in_playlist:
            playlist_ids.append(st.rec.id)
            out_pieces += [{"w": p.wall, "m": offset + p.media, "d": p.duration, "f": i} for p in played[i]]
            if ad_state:
                mutes += ad_mutes(ad_state["spans"], played[i], offset)
            offset += duration
    out_pieces.sort(key=lambda p: p["w"])  # an import can fill a hole between two recordings
    mutes.sort(key=lambda m: m["w"])

    live_file = next((f for f in reversed(files) if f["inPlaylist"] and f["growing"]), None)
    return {
        "channel": channel,
        "now": now,
        "files": files,
        "pieces": out_pieces,
        "mutes": mutes,
        "playlist": f"/api/playlist.m3u8?files={','.join(playlist_ids)}" if playlist_ids else None,
        "live": live_file is not None,
        "edge": live_file["wallEnd"] if live_file else None,
        # Over the eligible files, not just those with pieces left: a reconnect's new file
        # can be wholly overlapped by the previous one for a moment, and "complete" would
        # then send the extension to its slow (60 s) refresh right as the stream resumes.
        "complete": all(entries[i][1].status == "done" for i in eligible),
    }


@app.get("/api/playlist.m3u8")
def playlist(files: str):
    lines = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-MEDIA-SEQUENCE:0", "#EXT-X-PLAYLIST-TYPE:EVENT"]
    body: list[str] = []
    target = 1.0
    complete = True
    for n, fid in enumerate(f for f in files.split(",") if f):
        st = extractor.files.get(fid)
        if st is None:
            raise HTTPException(404, f"unknown file {fid}")
        segs, _ = st.segments()
        if n:
            body.append("#EXT-X-DISCONTINUITY")
        for s in segs:
            target = max(target, s.duration)
            body += [f"#EXTINF:{s.duration:.6f},", f"/hls/{fid}/{s.name}"]
        if st.status != "done":
            complete = False
            break  # later files would shift once this one grows
    lines.insert(2, f"#EXT-X-TARGETDURATION:{int(target + 0.999)}")
    lines += body
    if complete:
        lines.append("#EXT-X-ENDLIST")
    return PlainTextResponse("\n".join(lines) + "\n", media_type="application/vnd.apple.mpegurl",
                             headers={"Cache-Control": "no-store"})


@app.get("/hls/{fid}/{name}")
def segment(fid: str, name: str):
    st = extractor.files.get(fid)
    if st is None or not SEG_RE.match(name):
        raise HTTPException(404)
    path = st.out_dir / name
    if not path.exists():
        raise HTTPException(404)
    return FileResponse(path, media_type="video/mp2t", headers={"Cache-Control": "public, max-age=3600"})


def _extras(st: FileState) -> str:
    """Status-page notes from the optional services."""
    out = []
    if ads is not None and (spans := ads.spans(st.rec.id)):
        out.append(f"{len(spans)} ad clip{'s' * (len(spans) > 1)}")
    if screenclock is not None and st.status in ("running", "done"):
        res = screenclock.result(st.rec.id) or {}
        if res.get("delayScreen") is not None:
            out.append(f"screen delay {res['delayScreen']:.2f} s ({res['confidence']})")
    return ", ".join(out)


@app.get("/", response_class=HTMLResponse)
def index():
    now = time.time()
    rows = []
    for st in sorted(extractor.files.values(), key=lambda s: -(s.rec.name_time or s.rec.mtime)):
        segs, _ = st.segments()
        dur = segs[-1].end if segs else 0
        growing = "🔴 live" if extractor.is_growing(st.rec, now) else ""
        source = " (import)" if st.rec.source == "import" else ""
        rows.append(
            f"<tr><td>{html.escape(st.rec.channel)}</td><td>{html.escape(st.rec.name)}{source}</td>"
            f"<td>{st.status} {growing}</td><td>{dur / 60:.1f} min</td>"
            f"<td>{html.escape(_extras(st))}</td><td>{html.escape(st.error or '')}</td></tr>"
        )
    return (
        "<!doctype html><meta charset=utf-8><title>fone</title>"
        "<style>body{font:14px system-ui;margin:2em}td{padding:4px 10px;border-bottom:1px solid #ddd}</style>"
        f"<h2>fone — {len(rows)} recordings in {html.escape(str(cfg.rec_dir))}</h2>"
        + "".join(f"<p>⚠ {html.escape(n)}</p>" for n in _notes())
        + "<table><tr><th>channel</th><th>file</th><th>status</th><th>audio</th><th>analysis</th><th>error</th></tr>"
        + "".join(rows) + "</table>"
    )
