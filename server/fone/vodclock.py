"""Where a streamer's Bilibili replay (直播回放) runs on the event clock, read off their screen.

A 直播回放 says nothing exact about when it was recorded. Bilibili gives the Beijing hour the
live began (its title's '21点场') and when the replay was published; the media carry no
timestamp; danmakus.com merges a restarted live into the one before it (胡闹P房's 2026 Italian
GP qualifying replay: 'started 20:10', which was the F2 sprint's stream before it). What every
replay of theirs shows is MultiViewer's header, the session and its clock:

    Italian GP: Qualifying 2              Italian GP: Race
    13:04  Track Clear                    1:58:31 Lap: 2/53 (52 left)  Track Clear

The session's timing (timing.py's streams: the feed's ExtrapolatedClock or OpenF1's rebuild
of it; a race's clock, where neither has one, from its SessionStatus: 2 h from the start,
stopped by a red flag) says when the clock showed that, so each frame gives the event time on
the streamer's screen there. A few frames agreeing put the replay on the event clock to about
a second (2026 Italian GP race: 1.2 s from where its sound had put it); the extension plays it
from there and sync by sound does the rest (offscreen.js). Frames come from the replay's own
1080p video (the one fragment holding the moment, by its sidx), the OCR is screenclock_media's
tesseract.

    GET /api/vod/clock?bvid=BV…&key=<session key>[&slot=<unix s of the title's hour>][&E=<event s>]
      -> {"status": "working" | "ok" | "none" | "error", "readings": [{page, at, wall, text}],
          "more": true while it reads frames near E, "why": ...}

`at` is seconds into the replay's page `page` (1-based); `wall` the event time its screen
showed there. The streamer's own delay moves now and then, so the extension goes by the
reading nearest the moment it plays, and passes E for one near it (three frames, read once).
Bilibili's ~4.18 s repeats (one at every ~30-min fragment's start) sit between the frames:
the extension, which cuts them, puts each reading on its own timeline.
"""

from __future__ import annotations

import asyncio
import io
import json
import logging
import re
import statistics
import subprocess
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Annotated, Any, Callable

import numpy as np
from fastapi import APIRouter, HTTPException, Query

from . import backfill_bili as bb
from . import screenclock_media as sm
from .timing_state import read_stream

log = logging.getLogger("fone.vodclock")

BVID_RE = re.compile(r"^BV[0-9A-Za-z]{10}$")
RACE_CLOCK = {"race": 7200.0, "sprint": 3600.0}  # a race's clock where its timing has none
FRAGMENT, REPEAT = 1804.2, 4.18  # a replay's fragments, each but the first opening with a repeat
AGREE = 2.0  # frames whose wall clocks (repeats allowed for) are this close agree
MAX_FRAMES = 12  # the first frames, before giving up
STEP = 420.0  # between those
NEAR = 1500.0  # frames agree only this near each other (content s): see confirmed()
NEAR_E = 240.0  # a reading this near (event s) where the extension is serves it
PAR = 3  # frames read at once
TIMING_WAIT = 420.0  # longest wait for the session's timing (an OpenF1 rebuild: ~1 min)
NONE_TTL = 6 * 3600.0  # 'none' is asked again after this
URL_TTL = 90 * 60.0  # Bilibili's signed URLs: ~2 h
CLOCKISH = re.compile(r"[\d:.]{3,9}")


# ---- the session's clock -----------------------------------------------------------------------


def hms(text: str) -> float | None:
    """'01:59:59' / '00:13:00' (the feed's Remaining) -> seconds."""
    m = re.fullmatch(r"(\d+):(\d{2}):(\d{2})(?:\.\d+)?", str(text or "").strip())
    return int(m[1]) * 3600 + int(m[2]) * 60 + int(m[3]) if m else None


def utc(s: Any) -> float | None:
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def kind_of(name: str) -> tuple[str | None, int | None]:
    """A session's name, or the header's ('Qualifying 2', 'Practice 3', 'Race.', OCR's
    'Qualifyinq') -> (race | sprint | quali | sprint_quali | practice, its number)."""
    words = re.sub(r"[^a-z0-9 ]", " ", str(name).lower()).split()
    num = next((int(w) for w in words if w.isdigit() and len(w) == 1), None)
    has = lambda p: any(w.startswith(p) for w in words)  # noqa: E731
    if has("prac"):
        return "practice", num
    if has("quali") or has("shoot"):
        return ("sprint_quali" if has("sprint") else "quali"), num
    if has("sprint"):
        return "sprint", None
    if has("race") or has("rac"):
        return "race", None
    return None, None


@dataclass
class Seg:
    a: float  # wall time it starts
    b: float  # and ends (the next change)
    r: float  # remaining at a
    run: bool
    part: int  # qualifying's part (1 elsewhere)


@dataclass
class Clock:
    """What the session's clock showed when (wall time). MultiViewer shows the remaining time
    rounded down: 'C' from remaining C + 1 down to C."""

    kind: str
    number: int | None  # a practice's
    segs: list[Seg]
    laps: list[tuple[float, int]] = field(default_factory=list)  # (wall, CurrentLap)
    total_laps: int | None = None

    def when(self, shown: int, part: int | None = None) -> list[float]:
        """Wall times the clock showed `shown` while running (the middle of each second)."""
        out = []
        for s in self.segs:
            if not s.run or (part is not None and s.part != part):
                continue
            t = s.a + s.r - shown - 0.5
            if s.a - 0.5 <= t <= s.b + 0.5:
                out.append(t)
        return out

    def lap_at(self, t: float) -> int | None:
        n = None
        for w, lap in self.laps:
            if w > t:
                break
            n = lap
        return n

    def running(self) -> list[tuple[float, float]]:
        return [(s.a, s.b) for s in self.segs if s.run and s.b > s.a]

    @classmethod
    def from_streams(cls, name: str, t0: float, streams: dict[str, list[tuple[float, dict]]]) -> Clock | None:
        """`streams`: topic -> [(offset from t0, message)], as timing.py stores them."""
        kind, number = kind_of(name)
        if kind is None:
            return None
        events: list[tuple[float, float, bool]] = []  # (wall, remaining, running)
        run = False
        for _off, m in streams.get("ExtrapolatedClock", []):
            t, r = utc(m.get("Utc")), hms(m.get("Remaining"))
            if t is None or r is None:
                continue
            run = bool(m["Extrapolating"]) if "Extrapolating" in m else run
            events.append((t, r, run))
        if not events and kind in RACE_CLOCK:
            # A race the feed's clock isn't stored for (OpenF1's rebuild has none): 2 h (a sprint
            # 1 h) from the start, stopped while it's suspended.
            left, since = RACE_CLOCK[kind], None
            events.append((t0, left, False))
            for off, m in streams.get("SessionStatus", []):
                st, t = m.get("Status"), t0 + off
                if st == "Started" and since is None:
                    since = t
                    events.append((t, left, True))
                elif st in ("Aborted", "Finished", "Inactive", "Ends") and since is not None:
                    left, since = max(0.0, left - (t - since)), None
                    events.append((t, left, False))
        if not events:
            return None
        events.sort(key=lambda e: e[0])
        segs: list[Seg] = []
        part = 1
        for i, (t, r, running) in enumerate(events):
            if segs:
                p = segs[-1]
                before = p.r - (t - p.a) if p.run else p.r
                if r > before + 30 and kind in ("quali", "sprint_quali"):
                    part += 1  # the next part's whole clock
            end = events[i + 1][0] if i + 1 < len(events) else t + (r if running else 0.0)
            segs.append(Seg(t, end, r, running, part))
        laps, total = [], None
        for off, m in streams.get("LapCount", []):
            if isinstance(m.get("CurrentLap"), int):
                laps.append((t0 + off, m["CurrentLap"]))
            if isinstance(m.get("TotalLaps"), int) and m["TotalLaps"] > 0:
                total = m["TotalLaps"]
        return cls(kind, number, segs, sorted(laps), total)

    @classmethod
    def load(cls, directory: Path, meta: dict) -> Clock | None:
        streams = {}
        for topic in ("ExtrapolatedClock", "SessionStatus", "LapCount"):
            rows = []
            for off, raw in read_stream(directory / f"{topic}.jsonStream"):
                try:
                    rows.append((off, json.loads(raw)))
                except ValueError:
                    continue
            streams[topic] = rows
        return cls.from_streams(str(meta.get("name") or meta.get("type") or ""), float(meta["t0"]), streams)


# ---- the streamer's screen ---------------------------------------------------------------------

Box = tuple[int, int, int, int]


def parse_clock(text: str) -> int | None:
    """MultiViewer's clock: 'H:MM:SS', 'MM:SS' (OCR may lose the colons) -> seconds."""
    t = text.strip().replace(" ", "").replace(".", ":")
    m = re.fullmatch(r"(?:(\d{1,2}):)?(\d{1,2}):(\d{2})", t)
    if m:
        h, mi, s = int(m[1] or 0), int(m[2]), int(m[3])
    elif re.fullmatch(r"\d{3,6}", t):
        h, mi, s = int(t[:-4] or 0), int(t[-4:-2]), int(t[-2:])
    else:
        return None
    if s > 59 or mi > 59 or h > 3:
        return None
    return h * 3600 + mi * 60 + s


@dataclass
class Header:
    """Where MultiViewer's header is on a frame: the clock under its 'Event GP: Session' line
    and a race's 'N/M' lap."""

    clock: Box
    lap: Box | None
    scale: int
    session: str  # the title's after 'GP:', as tesseract read it ('Qualifying 2', 'Race.')


def _box(w: dict, pad: int, size: tuple[int, int], right: int | None = None) -> Box:
    h_img, w_img = size
    return (max(0, w["x"] - pad), max(0, w["y"] - pad), min(w_img, right if right is not None else w["x"] + w["w"] + pad),
            min(h_img, w["y"] + w["h"] + pad))


def find_header(words: list[dict], size: tuple[int, int]) -> Header | None:
    """From a frame's OCR words: the title line holding 'GP:', the clock-like word right
    under its start, a 'N/M' word after 'Lap:' on the clock's line."""
    for gp in words:
        if not re.fullmatch(r".*GP[:;]", gp["text"]):
            continue
        line = sorted((w for w in words if w["line"] == gp["line"]), key=lambda w: w["x"])
        # (tesseract's word boxes are now and then much taller than the text, a flag's read as one: the
        # line's text height is its smaller ones')
        th = int(statistics.median(sorted(w["h"] for w in line)[:max(1, len(line) // 2 + 1)]))
        # (the title alone, up to a gap either side: whatever else tesseract put on its line)
        a = b = line.index(gp)
        gap = lambda u, v: v["x"] - (u["x"] + u["w"])  # noqa: E731
        while a > 0 and gap(line[a - 1], line[a]) < 3 * th:
            a -= 1
        while b + 1 < len(line) and gap(line[b], line[b + 1]) < 3 * th:
            b += 1
        line = line[a:b + 1]
        x0 = line[0]["x"]
        ty = int(statistics.median(w["y"] for w in line if w["h"] <= 1.5 * th))
        # (the clock sits under the event's name: left of 'GP:', a flag maybe further left)
        under = [w for w in words if th * 0.5 < w["y"] - ty < th * 4 and x0 - th * 3 < w["x"] < gp["x"]
                 and CLOCKISH.fullmatch(w["text"])]
        if not under:
            continue
        ck = min(under, key=lambda w: (w["y"], w["x"]))
        pad = max(2, th // 3)
        row = sorted((w for w in words if abs(w["y"] - ck["y"]) < 1.5 * th and w["x"] > ck["x"] + th), key=lambda w: w["x"])
        # (tesseract's box may leave out a faint last digit, or run on over the lap: the clock's box
        # runs to the next word, 'H:MM:SS' wide at most)
        right = min([row[0]["x"] - 2] if row else [], default=ck["x"] + ck["w"] + 2 * th)
        right = min(max(right, ck["x"] + min(ck["w"], 6 * th)), ck["x"] + 7 * th)
        lap = None
        for i, w in enumerate(row[:-1]):
            if w["text"].lower().startswith("lap"):
                lap = _box(row[i + 1], pad, size)
                break
        session = " ".join(w["text"] for w in line if w["x"] > gp["x"])
        return Header(_box(ck, pad, size, right), lap, max(2, min(6, round(30 / max(th, 5)))), session)
    return None


@dataclass
class Reading:
    page: int
    at: float
    session: str  # the header's, as read
    shown: int | None  # the clock, seconds
    lap: tuple[int, int] | None  # (N, total)
    text: str

    def to_dict(self) -> dict:
        return {"page": self.page, "at": round(self.at, 3), "session": self.session, "shown": self.shown,
                "lap": list(self.lap) if self.lap else None, "text": self.text}


def _ocr(img: np.ndarray, box: Box, scale: int, whitelist: str | None) -> str:
    big = sm.upscale(sm.crop(img, sm.tighten(img, box)), scale)
    args = ["--psm", "7"] + (["-c", f"tessedit_char_whitelist={whitelist}"] if whitelist else [])
    return sm.tesseract(sm.pgm(big), *args).strip()


def read_with(img: np.ndarray, hd: Header) -> tuple[str, int | None, tuple[int, int] | None, str]:
    """The header `hd` found: (session, clock s, lap, text), its clock and lap read again closely."""
    session = hd.session
    # (read at three sizes, the most of them wins: one may drop a digit, '5:39' for '55:39')
    reads = [(raw, v) for sc in (hd.scale, hd.scale + 1, hd.scale + 2)
             if (v := parse_clock(raw := _ocr(img, hd.clock, sc, "0123456789:"))) is not None]
    shown, raw = None, reads[0][0] if reads else ""
    if reads:
        votes = {v: sum(1 for _r, x in reads if x == v) for _r, v in reads}
        shown = max(votes, key=lambda v: (votes[v], len(str(v))))
        raw = next(r for r, v in reads if v == shown)
    lap = None
    if hd.lap:  # ('N/M' read the same at two of three sizes, else none: it only rules readings out)
        laps = [(int(m[1]), int(m[2])) for sc in (hd.scale, hd.scale + 1, hd.scale + 2)
                if (m := re.fullmatch(r"(\d{1,2})/(\d{2})", _ocr(img, hd.lap, sc, "0123456789/"))) and int(m[1]) <= int(m[2])]
        lap = max(laps, key=laps.count) if laps and laps.count(max(laps, key=laps.count)) >= 2 else None
    return session, shown, lap, f"{session} {raw}" + (f" Lap {lap[0]}/{lap[1]}" if lap else "")


def read_frame(img: np.ndarray, words_of: Callable = sm.frame_words) -> tuple[str, int | None, tuple[int, int] | None, str] | None:
    """(session, clock s, lap, text) off a frame, or None: the header found by OCR of the whole
    frame (~2 s: the streamer changes tabs and windows, so every frame), then its clock read
    again closely."""
    hd = find_header(words_of(img), img.shape)
    return read_with(img, hd) if hd else None


# ---- frames agreeing ---------------------------------------------------------------------------


def content_of(pages: list[dict], page: int, at: float) -> float:
    """Replay seconds to (about) content seconds: the repeat at each fragment's start taken out."""
    before = sum(float(p["duration"]) for p in pages if p["page"] < page)
    # (a page's fragments each but the first open with one; the next page's first does)
    starts = sum(max(1, round(float(p["duration"]) / FRAGMENT)) for p in pages if p["page"] < page) + int(at // FRAGMENT)
    return before + at - REPEAT * starts


def page_at(pages: list[dict], c: float) -> tuple[int, float] | None:
    """Content seconds (as content_of counts them) to (page, seconds into it)."""
    for p in pages:
        d = float(p["duration"])
        lo, hi = content_of(pages, p["page"], 0.0), content_of(pages, p["page"], d)
        if lo <= c < hi - 3:
            at = c - lo
            for _ in range(3):  # (the repeats inside the page)
                at = c - lo + REPEAT * int(at // FRAGMENT)
            return int(p["page"]), round(min(at, d - 3), 1)
    return None


def candidates(clock: Clock, rd: Reading) -> list[float]:
    """Wall times this reading may have been on screen at (the clock running, the same session,
    part and lap)."""
    kind, num = kind_of(rd.session)
    if rd.shown is None or kind is None or kind != clock.kind:
        return []
    if kind == "practice" and num is not None and clock.number is not None and num != clock.number:
        return []
    if rd.lap and clock.total_laps and rd.lap[1] != clock.total_laps:
        return []
    ts = clock.when(rd.shown, num if kind in ("quali", "sprint_quali") else None)
    if rd.lap and clock.laps:
        ts = [t for t in ts if rd.lap[0] in (clock.lap_at(t - 1.5), clock.lap_at(t + 1.5))]
    return ts


def confirmed(found: list[tuple[Reading, list[float]]], pages: list[dict], slot: float | None) -> list[tuple[Reading, float]]:
    """Readings another one near it agrees with: the same start of the replay's content on the
    event clock, give or take AGREE s. Only near (NEAR s of content): the streamer's own delay
    moves now and then (their F1 TV buffering, a pause; 2026 Italian GP qualifying: Q1's clock
    off Q2's by up to 36 s), so frames an hour apart may each be right and still disagree.
    [(reading, its wall time)], in the replay's order."""
    starts = []
    for rd, ts in found:
        c = content_of(pages, rd.page, rd.at)
        # (the screen shows an event ~40-60 s after it; the live began in the slot's hour)
        starts.append((c, [(t - c, t) for t in ts if slot is None or slot - 600 <= t - c <= slot + 3600 + 300]))
    out: dict[int, tuple[float, int]] = {}  # reading -> (wall, how many agree with it)
    for i, (ci, si) in enumerate(starts):
        for j, (cj, sj) in enumerate(starts):
            if j <= i or abs(ci - cj) > NEAR:
                continue
            for a, ta in si:
                for b, tb in sj:
                    if abs(a - b) <= AGREE:
                        for k, t in ((i, ta), (j, tb)):
                            out[k] = (t, out.get(k, (t, 0))[1] + 1)
    keep = sorted(out, key=lambda k: starts[k][0])
    return [(found[k][0], out[k][0]) for k in keep]


def plan(clock: Clock, pages: list[dict], slot: float | None) -> list[tuple[int, float]]:
    """Frames to read first, (page, at): where the session's clock runs whenever in the slot's
    hour the live began, likeliest first, at least STEP s apart."""
    total = content_of(pages, max(p["page"] for p in pages), float(pages[-1]["duration"])) if pages else 0.0
    runs = clock.running()
    if not runs or total <= 0:
        return []
    lo_s, hi_s = (slot - 60, slot + 3600) if slot is not None else (min(a for a, _ in runs) - total, max(b for _, b in runs))
    grid = []
    for k in range(int(total // 60)):
        c = k * 60.0 + 30
        # (of the starts the hour allows, how many have the clock running at c; sampled every minute)
        n = sum(1 for s in np.arange(lo_s, hi_s, 60.0) if any(a + 20 < s + c < b - 20 for a, b in runs))
        if n:
            grid.append((n, c))
    grid.sort(key=lambda g: -g[0])
    chosen: list[float] = []
    for _n, c in grid:
        if all(abs(c - o) >= STEP for o in chosen):
            chosen.append(c)
    return [pa for c in chosen if (pa := page_at(pages, c))]


# ---- the replay's video ------------------------------------------------------------------------


def sidx_segments(b: bytes, at: int) -> list[tuple[float, float, int, int]]:
    """A sidx box's references (b: bytes from file offset `at`): [(start s, length s, offset, bytes)]."""
    i = 0
    while True:
        if i + 8 > len(b):
            raise ValueError("no sidx")
        size = int.from_bytes(b[i:i + 4], "big")
        if b[i + 4:i + 8] == b"sidx":
            break
        if size < 8:
            raise ValueError("bad box")
        i += size
    u32 = lambda o: int.from_bytes(b[o:o + 4], "big")  # noqa: E731
    end, v = i + size, b[i + 8]
    p = i + 16
    scale = u32(p)
    p += 4
    if v == 0:
        first, p = u32(p + 4), p + 8
    else:
        first, p = int.from_bytes(b[p + 8:p + 16], "big"), p + 16
    n = int.from_bytes(b[p + 2:p + 4], "big")
    p += 4
    off, t, out = at + end + first, 0, []
    for _ in range(n):
        ln, d = u32(p) & 0x7FFFFFFF, u32(p + 4)
        out.append((t / scale, d / scale, off, ln))
        off, t, p = off + ln, t + d, p + 12
    return out


def decode_frame(mp4: bytes, at: float, timeout: float = 60.0) -> np.ndarray | None:
    """The frame `at` s into a fragment (with its init segment), grey."""
    try:
        r = subprocess.run(sm.NICE + ["ffmpeg", "-v", "error", "-i", "-", "-ss", f"{max(0.0, at):.3f}", "-frames:v", "1",
                                      "-f", "image2pipe", "-vcodec", "pgm", "-pix_fmt", "gray", "-"],
                           input=mp4, capture_output=True, timeout=timeout, check=False)
    except subprocess.TimeoutExpired:
        return None
    return sm._read_pgm(io.BytesIO(r.stdout)) if r.returncode == 0 and r.stdout else None


@dataclass
class Video:
    urls: list[str]
    init: bytes
    segs: list[tuple[float, float, int, int]]
    at: float


# ---- the service -------------------------------------------------------------------------------


class VodClockService:
    """One job per (replay, session) at a time; what it read kept on disk (<data>/vodclock/)."""

    def __init__(self, cfg, timing, bili: bb.BiliClient | None = None, words_fn: Callable = sm.frame_words,
                 frame_fn: Callable[[bytes, float], np.ndarray | None] = decode_frame):
        self.cfg, self.timing = cfg, timing
        self.dir = Path(cfg.data_dir) / "vodclock"
        self.bili = bili
        self.words, self.decode = words_fn, frame_fn
        self.state: dict[tuple[str, int], dict] = {}
        self.tasks: dict[tuple[str, int], asyncio.Task] = {}
        self._video_cache: dict[tuple[str, int], Video] = {}
        self._sem: asyncio.Semaphore | None = None

    async def start(self) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        if self.bili is None:
            self.bili = bb.BiliClient(min_interval=1.0)

    async def stop(self) -> None:
        for t in self.tasks.values():
            t.cancel()
        if self.bili is not None:
            await self.bili.close()

    def _file(self, bvid: str, key: int) -> Path:
        return self.dir / f"{bvid}.{key}.json"

    def get(self, bvid: str, key: int, slot: float | None, E: float | None = None) -> dict:
        """What's known (status working | ok | none | error, readings); a job started when
        there's more to read: the first frames, or ones near event time E."""
        k = (bvid, key)
        st = self.state.get(k)
        if st is None:
            try:
                st = json.loads(self._file(bvid, key).read_text())
            except (OSError, ValueError):
                st = {"status": "working", "why": "starting", "seen": []}
            if st.get("status") in ("working", "error") or (st.get("status") == "none" and time.time() - st.get("at", 0) > NONE_TTL):
                st.update(status="working", why="starting")
            self.state[k] = st
        want_near = st.get("status") == "ok" and E is not None and self._wants(st, E)
        if k not in self.tasks and (st.get("status") == "working" or want_near):
            if want_near:
                st["more"] = True
            self.tasks[k] = asyncio.create_task(self._job(bvid, key, slot, E))
        return {x: v for x, v in st.items() if x != "seen"}

    @staticmethod
    def _wants(st: dict, E: float) -> bool:
        """A reading nearer E would help: none within NEAR_E s of it, it not looked for in vain
        already, and the clock running at E (before a session, in a break, nothing reads there)."""
        if any(abs(r["wall"] - E) < NEAR_E for r in st.get("readings", [])):
            return False
        if any(abs(e - E) < NEAR_E for e in st.get("tried", [])):
            return False
        return any(a - 30 < E < b + 30 for a, b in st.get("running", []))

    async def _job(self, bvid: str, key: int, slot: float | None, E: float | None) -> None:
        k = (bvid, key)
        try:
            if self._sem is None:
                self._sem = asyncio.Semaphore(2)
            async with self._sem:
                await self._read(k, bvid, key, slot, E)
            st = self.state[k]
            st["at"] = time.time()
            if st.get("status") in ("ok", "none"):
                self._file(bvid, key).write_text(json.dumps(st))
            log.info("%s (session %s): %s, %d frames, %s", bvid, key, st["status"], len(st.get("seen", [])),
                     st.get("why") or [r["text"] for r in st.get("readings", [])])
        except Exception as e:  # noqa: BLE001 - reported, asked again a minute later
            log.exception("%s (session %s) failed", bvid, key)
            if self.state.get(k, {}).get("status") != "ok":
                self._say(k, status="error", why=f"{type(e).__name__}: {e}"[:200])
                asyncio.get_running_loop().call_later(60, lambda: self.state.pop(k, None))
        finally:
            self.state.get(k, {}).pop("more", None)
            self.tasks.pop(k, None)

    def _say(self, k: tuple[str, int], **fields) -> None:
        self.state.setdefault(k, {}).update(fields)

    async def _clock(self, k: tuple[str, int], key: int) -> Clock | None:
        until = time.monotonic() + TIMING_WAIT
        while True:
            meta = self.timing.store.meta(key) if self.timing else None
            if meta and meta.get("t0") is not None:
                return await asyncio.to_thread(Clock.load, self.timing.store.dir(key), meta)
            why = await asyncio.to_thread(self.timing._missing_reason, key) if self.timing else "no timing service"
            if time.monotonic() > until or why in ("no timing data for this session", "session has not started"):
                self._say(k, why=f"the session's timing: {why}")
                return None
            self._say(k, why=f"waiting for the session's timing ({why})")
            await asyncio.sleep(5)

    async def _range(self, urls: list[str], a: int, b: int) -> bytes:
        err: Exception | None = None
        for u in urls:
            try:
                r = await self.bili.http.get(u, headers={"User-Agent": bb.UA, "Referer": "https://www.bilibili.com/",
                                                         "Range": f"bytes={a}-{b}"}, timeout=30)
                if r.status_code == 206 and len(r.content) == b - a + 1:
                    return r.content
                err = RuntimeError(f"HTTP {r.status_code}")
            except Exception as e:  # noqa: BLE001 - the next mirror
                err = e
        raise RuntimeError(f"the replay's video: {err}")

    async def _video(self, bvid: str, page: dict) -> Video:
        pk = (bvid, int(page["cid"]))
        v = self._video_cache.get(pk)
        if v and time.time() - v.at < URL_TTL:
            return v
        dash = await self.bili.playurl(bvid, int(page["cid"]))
        s = bb.pick_stream(dash, "video", 1080)
        sb = s.get("segment_base") or s.get("SegmentBase") or {}
        rng = lambda x: [int(n) for n in str(x).split("-")]  # noqa: E731
        init, index = rng(sb.get("initialization") or sb.get("Initialization")), rng(sb.get("index_range") or sb.get("indexRange"))
        urls = bb.stream_urls(s)
        b = await self._range(urls, 0, index[1])
        v = Video(urls, b[:init[1] + 1], sidx_segments(b[index[0]:], index[0]), time.time())
        self._video_cache[pk] = v
        return v

    async def _frame(self, bvid: str, page: dict, at: float) -> np.ndarray | None:
        v = await self._video(bvid, page)
        seg = next((s for s in v.segs if s[0] <= at < s[0] + s[1]), v.segs[-1])
        data = await self._range(v.urls, seg[2], seg[2] + seg[3] - 1)
        return await asyncio.to_thread(self.decode, v.init + data, at - seg[0])

    async def _read(self, k: tuple[str, int], bvid: str, key: int, slot: float | None, E: float | None) -> None:
        st = self.state[k]
        seen: list[dict] = st.setdefault("seen", [])
        clock = await self._clock(k, key)
        if clock is None:
            self._say(k, status="none")
            return
        pages = await self.bili.pagelist(bvid)
        by_page = {int(p["page"]): p for p in pages}
        st["running"] = clock.running()
        found = [(Reading(**{x: (tuple(v) if x == "lap" and v else v) for x, v in r.items() if x != "cands"}), r["cands"])
                 for r in seen]

        async def read(page: int, at: float) -> None:
            img = await self._frame(bvid, by_page[page], at)
            got = await asyncio.to_thread(read_frame, img, self.words) if img is not None else None
            rd = Reading(page, at, *(got[:3] if got else ("", None, None)), got[3] if got else "")
            ts = candidates(clock, rd)
            found.append((rd, ts))
            seen.append({**rd.to_dict(), "cands": ts})

        def done() -> list[tuple[Reading, float]]:
            ok = confirmed(found, pages, slot)
            st["readings"] = [{"page": rd.page, "at": rd.at, "wall": round(t, 3), "text": rd.text} for rd, t in ok]
            return ok

        # the first frames: where the clock should run, till two near each other agree
        if st.get("status") != "ok":
            todo = [pa for pa in plan(clock, pages, slot) if not any(s["page"] == pa[0] and abs(s["at"] - pa[1]) < 30 for s in seen)]
            while todo and len(seen) < MAX_FRAMES and not done():
                batch, todo = todo[:PAR], todo[PAR:]
                await asyncio.gather(*(read(p, a) for p, a in batch))
                self._say(k, why=f"{len(seen)} frames of the streamer's screen read")
            if not done():
                why = "no MultiViewer clock on the streamer's screen" if not any(c for _r, c in found) \
                    else "the clock on the streamer's screen doesn't agree with the session's"
                self._say(k, status="none", why=why)
                return
            self._say(k, status="ok", why=None)
        # then a reading near E, where the extension is: where the nearest says E is, and a bit on
        if E is not None and self._wants(st, E):
            st.setdefault("tried", []).append(E)
            near = min(done(), key=lambda x: abs(x[1] - E))
            c = content_of(pages, near[0].page, near[0].at) + (E - near[1])
            spots = [pa for cc in (c, c + 4, c + 8) if (pa := page_at(pages, cc))]
            await asyncio.gather(*(read(p, a) for p, a in spots))
            done()


def make_router(svc: VodClockService) -> APIRouter:
    r = APIRouter(prefix="/api/vod")

    @r.get("/clock")
    async def clock(bvid: str, key: Annotated[int, Query(gt=0, lt=10_000_000)],
                    slot: Annotated[float | None, Query(gt=1e9, lt=1e10)] = None,
                    E: Annotated[float | None, Query(gt=1e9, lt=1e10)] = None):
        if not BVID_RE.fullmatch(bvid):
            raise HTTPException(400, "bad bvid")
        return svc.get(bvid, key, slot, E)

    return r
