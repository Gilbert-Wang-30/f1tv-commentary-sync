"""F1 timing for sessions the server never captured, rebuilt from OpenF1's historical API.

F1's own archive (livetiming.formula1.com/static) answers 401 to everyone since 2026-10-18,
so a session this server didn't capture live has no feed left to download. OpenF1
(api.openf1.org, no auth for past sessions) keeps that same feed, cut into tables: laps,
positions, intervals, stints, pit stops, race control, weather and car locations. `build`
turns the tables back into the topic streams timing_state.py reads (the archive's format,
see there), so the dashboard serves such a session like any other.

No spoilers. The tables are final, so the only way to leak is a message placed too early;
each one is written at the moment the live feed carried it:
  * a lap's time, the car's best and lap count when the lap ends (the next lap's start,
    which is when the feed published it, else start + duration); a sector time as the
    sector ends; purple/green from the laps known by then;
  * positions and race gaps at their own timestamps (OpenF1 keeps every feed update);
    qualifying and practice gaps recomputed from the best laps known at each moment;
  * a lap race control deletes drops out of the bests a minute after its message (the
    feed took 10-57 s), or in practice and qualifying as the car loses its place for it;
  * pit lane: in at the pit entry, out at the exit (OpenF1's pit `date` is the exit, when
    the feed's pit lane time appeared), a new tyre at the exit, its age +1 per lap;
  * a retirement once the car has stood still for 30 s by its own locations, else once
    it's overdue (its last lap plus a margin);
  * qualifying: the next part, its knock-outs and its clock a minute before its green
    light, as the feed does, long after the last lap of the previous part is in.
Two things are taken from the session as a whole: a race's lap total (the winner's laps,
left out when the race ended under a red flag, the one case where they'd differ from the
scheduled distance) and a qualifying part's length (from the part itself when it ran to
the flag): both are on screen from the start anyway.
"""

from __future__ import annotations

import asyncio
import bisect
import email.utils
import heapq
import json
import logging
import math
import re
import statistics
import time
from array import array
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator

import httpx

from .timing_state import COMPOUNDS, POSITION_TOPIC, deflate, format_offset, iso, iso_ms, merge, session_kind

log = logging.getLogger("fone.timing")

BASE = "https://api.openf1.org/v1"
BUILDER = 1  # meta "builder": which version of this rebuild made a session
SETTLE_SECONDS = 30 * 60  # OpenF1's tables of a session are final this long after its scheduled end
LATE_SECONDS = 4 * 3600  # past this, a session without a finish message is taken as it is
LEAD = {"race": 3600.0, "quali": 900.0, "practice": 900.0}  # t0: this long before the scheduled start
TAIL_SECONDS = 30 * 60  # car positions kept this long after the finish (in-laps, parc fermé)
RCM_LAG = 0.5  # race control times are whole seconds; the feed carried them -0.3..+0.7 s from it
PART_LEAD = 60.0  # qualifying: the next part, its clock and knock-outs come this long before its start
INACTIVE_LEAD = 55.0  # ...and its "Inactive" status this long (also before a restart after a red flag)
PUBLISH_LAG = 0.3  # the feed published a time this long after the line (a lap or sector end we compute)
PIT_OUT_SECONDS = 30.0  # PIT OUT shows until the out-lap's first sector ends (this long if unknown)
FIRST_TYRE_LEAD = 300.0  # a race's starting tyres show this long before the start (the feed: ~8 min)
DELETE_LAG = 60.0  # a deleted lap time goes this long after race control's message (the feed: 10-57 s)
STOP_SECONDS = 30.0  # a retiring car is out once it has stood still this long
STOP_RADIUS = 50  # decimetres it may drift and still count as standing
TRACK_MESSAGES = {"1": "AllClear", "2": "Yellow", "4": "SCDeployed", "5": "Red", "6": "VSCDeployed",
                  "7": "VSCEnding"}
_STATUS = {"SESSION STARTED": "Started", "SESSION ABORTED": "Aborted", "SESSION FINISHED": "Finished"}
# Qualifying part lengths for a part that didn't run to its flag (otherwise measured): Q3 is
# 13 minutes from 2026 (both 2026 qualifyings captured here).
QUALI_MINUTES = {"Q": (18, 15, 12), "SQ": (12, 10, 8)}
RETRY_AFTER_MAX = 120.0  # a 429's Retry-After waited for up to this; longer: given up for now


class OpenF1Error(Exception):
    pass


def retry_after(r: httpx.Response, now: float | None = None) -> float | None:
    """A response's Retry-After in seconds (a number of them or an HTTP date), else None."""
    v = (r.headers.get("Retry-After") or "").strip()
    if not v:
        return None
    try:
        s = float(v)
    except ValueError:
        try:
            when = email.utils.parsedate_to_datetime(v)
        except (TypeError, ValueError):
            return None
        if when.tzinfo is None:
            when = when.replace(tzinfo=timezone.utc)
        s = when.timestamp() - (time.time() if now is None else now)
    return max(0.0, s) if math.isfinite(s) else None


class OpenF1:
    """OpenF1's REST API, gently: one request at a time, spaced, retried on 429 and 5xx with a
    doubling backoff, and after a 429's Retry-After when it says longer (the free tier is rate
    limited: 429s were seen at 1-2 s apart from one address, which a server may share)."""

    def __init__(self, client: httpx.AsyncClient, base: str = BASE, pace: float = 1.0, retry: float = 2.0,
                 tries: int = 4):
        self.client = client
        self.base = base.rstrip("/")
        self.pace = pace
        self.retry = retry
        self.tries = tries
        self.requests = 0
        self.bytes = 0
        self._next = 0.0

    async def get(self, endpoint: str, **params: Any) -> list[dict]:
        """One table's rows; [] when OpenF1 has none (it answers 404 to an empty result)."""
        last = "no answer"
        for attempt in range(self.tries):
            if attempt:
                self._next = max(self._next, time.monotonic() + min(60.0, self.retry * 2 ** (attempt - 1)))
            wait = self._next - time.monotonic()
            if wait > 0:
                await asyncio.sleep(wait)
            self._next = time.monotonic() + self.pace
            try:
                r = await self.client.get(f"{self.base}/{endpoint}", params=params,
                                          timeout=httpx.Timeout(30, read=60))
            except httpx.TransportError as e:
                last = type(e).__name__
                continue
            self.requests += 1
            self.bytes += len(r.content)
            if r.status_code == 404:
                return []
            if r.status_code == 200:
                rows = await asyncio.to_thread(json.loads, r.content)  # a car's locations are ~5 MB
                if not isinstance(rows, list):
                    raise OpenF1Error(f"{endpoint}: unexpected answer")
                return rows
            last = f"HTTP {r.status_code}"
            if r.status_code != 429 and r.status_code < 500:
                break
            if r.status_code == 429 and (after := retry_after(r)) is not None:
                if after > RETRY_AFTER_MAX:
                    last += f", retry after {after:.0f} s"
                    break
                self._next = max(self._next, time.monotonic() + after)
        raise OpenF1Error(f"{endpoint}: {last}")


# ---- fetching ------------------------------------------------------------------------


@dataclass
class Samples:
    """One car's locations: sensor time (UTC) and X/Y/Z, sorted by time."""
    t: array = field(default_factory=lambda: array("d"))
    x: array = field(default_factory=lambda: array("i"))
    y: array = field(default_factory=lambda: array("i"))
    z: array = field(default_factory=lambda: array("i"))


@dataclass
class Tables:
    """One session's OpenF1 rows."""
    session: dict
    meeting: dict = field(default_factory=dict)
    drivers: list[dict] = field(default_factory=list)
    laps: list[dict] = field(default_factory=list)
    stints: list[dict] = field(default_factory=list)
    pit: list[dict] = field(default_factory=list)
    race_control: list[dict] = field(default_factory=list)
    position: list[dict] = field(default_factory=list)
    intervals: list[dict] = field(default_factory=list)
    weather: list[dict] = field(default_factory=list)
    result: list[dict] = field(default_factory=list)
    grid: list[dict] = field(default_factory=list)
    location: dict[str, Samples] = field(default_factory=dict)


def _t(s: Any) -> float | None:
    """OpenF1 time ('2026-03-29T05:14:02.078000+00:00') -> unix seconds."""
    if not isinstance(s, str) or not s:
        return None
    try:
        return iso(s)
    except ValueError:
        return None


def _kind(session: dict) -> str:
    return session_kind({"Type": session.get("session_type"), "Name": session.get("session_name")})


def _scheduled(session: dict) -> tuple[float, float]:
    start = iso(session["date_start"])
    end = _t(session.get("date_end")) or start + 2 * 3600
    return start, end


def _finished(race_control: list[dict]) -> bool:
    """The session is over by its own messages: its last status is a finish (or, for sessions
    OpenF1 has no status rows for, the chequered flag is out)."""
    status = [r for r in race_control if r.get("category") == "SessionStatus"]
    if status:
        last = max(status, key=lambda r: _t(r.get("date")) or 0.0)
        return str(last.get("message") or "").upper() == "SESSION FINISHED"
    return any(r.get("flag") == "CHEQUERED" for r in race_control)


def _window(tb: Tables) -> tuple[float, float]:
    """The stretch of time a rebuilt session covers: t0 to the finish plus a tail."""
    start, end = _scheduled(tb.session)
    t0 = start - LEAD[_kind(tb.session)]
    finish = [_t(r.get("date")) for r in tb.race_control if r.get("category") == "SessionStatus"]
    return t0, max([end, *(f for f in finish if f)]) + TAIL_SECONDS


async def fetch(api: OpenF1, key: int, now: float, positions: bool = True) -> Tables | str:
    """Everything the dashboard shows about one session, or why not: "no data" (OpenF1 doesn't
    have it) or "not over" (it isn't, or its tables may still change)."""
    tb = await _session(api, key, now)
    if isinstance(tb, str):
        return tb
    meeting = await api.get("meetings", meeting_key=tb.session.get("meeting_key"))
    tb.meeting = meeting[0] if meeting else {}
    tb.laps = await api.get("laps", session_key=key)
    tb.position = await api.get("position", session_key=key)
    if not tb.laps and not tb.position:
        return "no data"
    tb.stints = await api.get("stints", session_key=key)
    tb.weather = await api.get("weather", session_key=key)
    tb.result = await api.get("session_result", session_key=key)
    if _kind(tb.session) == "race":
        tb.pit = await api.get("pit", session_key=key)
        tb.intervals = await api.get("intervals", session_key=key)
        tb.grid = await api.get("starting_grid", session_key=key)
    else:
        tb.pit = []
    if positions:
        await _locations(api, tb)
    return tb


async def fetch_positions(api: OpenF1, key: int, now: float) -> Tables | str:
    """Only the car locations (for a capture of a session that has the rest), or why not."""
    tb = await _session(api, key, now)
    if isinstance(tb, str):
        return tb
    await _locations(api, tb)
    return tb if any(s.t for s in tb.location.values()) else "no data"


async def _session(api: OpenF1, key: int, now: float) -> Tables | str:
    """The session, its race control and drivers, once it's over."""
    rows = [r for r in await api.get("sessions", session_key=key) if r.get("session_key") == key]
    if not rows or rows[0].get("is_cancelled") or not rows[0].get("date_start"):
        return "no data"
    tb = Tables(session=rows[0])
    _, end = _scheduled(tb.session)
    if now < end + SETTLE_SECONDS:
        return "not over"
    tb.race_control = await api.get("race_control", session_key=key)
    if not _finished(tb.race_control) and now < end + LATE_SECONDS:
        return "not over"  # overran (red flag, late start): wait for its finish
    tb.drivers = await api.get("drivers", session_key=key)
    return tb if tb.drivers else "no data"


async def _locations(api: OpenF1, tb: Tables) -> None:
    # Per car (all at once is ~100 MB) and within the session's window: OpenF1's locations
    # for a session can start the day before.
    lo, hi = _window(tb)
    span = {"date>": _query_time(lo), "date<": _query_time(hi)}
    for num in sorted({int(d["driver_number"]) for d in tb.drivers if d.get("driver_number") is not None}):
        got = await api.get("location", session_key=tb.session["session_key"], driver_number=num, **span)
        tb.location[str(num)] = await asyncio.to_thread(_samples, got, lo, hi)


def _query_time(t: float) -> str:
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")


def _samples(rows: list[dict], lo: float, hi: float) -> Samples:
    pts = []
    for r in rows:
        try:
            t = datetime.fromisoformat(r["date"]).timestamp()
            if lo <= t <= hi:
                pts.append((t, int(r["x"]), int(r["y"]), int(r.get("z") or 0)))
        except (KeyError, TypeError, ValueError):
            continue
    pts.sort()
    s = Samples()
    for t, x, y, z in pts:
        if s.t and t <= s.t[-1]:
            continue
        s.t.append(t)
        s.x.append(x)
        s.y.append(y)
        s.z.append(z)
    return s


# ---- formatting (the feed's own strings) ------------------------------------------------


def lap_text(sec: float) -> str:
    """92.818 -> '1:32.818', 28.394 -> '28.394'."""
    ms = round(sec * 1000)
    m, ms = divmod(ms, 60_000)
    return f"{m}:{ms // 1000:02d}.{ms % 1000:03d}" if m else f"{ms // 1000}.{ms % 1000:03d}"


def gap_text(sec: float) -> str:
    return f"+{sec:.3f}"


def clock_text(sec: float) -> str:
    s = max(0, round(sec))
    return f"{s // 3600:02d}:{s % 3600 // 60:02d}:{s % 60:02d}"


def _lapped(v: str) -> str | None:
    """OpenF1's '+1 LAP' / '+2 LAPS' -> the feed's '1 L'."""
    m = re.match(r"^\+?\s*(\d+)\s*LAPS?$", v.strip(), re.I)
    return f"{m.group(1)} L" if m else None


def _num(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _gmt(offset: Any) -> float:
    """'09:00:00' / '-03:00:00' -> seconds."""
    try:
        sign = -1 if str(offset).startswith("-") else 1
        h, m, *s = (int(x) for x in str(offset).lstrip("+-").split(":"))
        return sign * (h * 3600 + m * 60 + (s[0] if s else 0))
    except ValueError:
        return 0.0


# ---- the rebuild ---------------------------------------------------------------------


@dataclass
class _Lap:
    n: int
    start: float | None
    end: float | None
    sec: float | None
    out: bool  # a pit out-lap
    inlap: bool  # ends in the pit lane: neither one is ever a best on the timing screens
    sectors: list[float | None]
    sector_ends: list[float | None]


@dataclass
class _Stint:
    index: int
    lap_start: int
    lap_end: int | None
    age: int


@dataclass
class _Car:
    num: str
    laps: list[_Lap]
    pos: int | None = None
    best: dict[int, float] = field(default_factory=dict)  # part -> best lap (s); part 1 outside qualifying
    best_lap: dict[int, int] = field(default_factory=dict)
    timed: dict[int, dict[int, float]] = field(default_factory=dict)  # part -> lap -> s, deleted ones gone
    sector_best: dict[tuple[int, int], float] = field(default_factory=dict)  # (part, sector) -> s
    last_lap: int | None = None
    last_pb: bool = False
    last_purple: bool = False
    stint: _Stint | None = None
    knocked: bool = False
    retired: bool = False
    gaps: tuple[str, str] = ("", "")
    pits: int = 0

    def lap(self, n: int) -> _Lap | None:
        for lap in self.laps:
            if lap.n == n:
                return lap
        return None


class _Build:
    def __init__(self, tb: Tables):
        self.tb = tb
        s = tb.session
        self.key = int(s["session_key"])
        self.name = s.get("session_name") or ""
        self.type = s.get("session_type") or ""
        self.kind = _kind(s)
        self.sched_start, self.sched_end = _scheduled(s)
        self.gmt = _gmt(s.get("gmt_offset"))
        self.t0 = self.sched_start - LEAD[self.kind]
        self.msgs: dict[str, list[tuple[float, int, Any]]] = {}
        self._seq = 0
        self.rc = sorted((r for r in tb.race_control if _t(r.get("date")) is not None),
                         key=lambda r: _t(r["date"]))
        self.cars = self._cars()
        self.status = self._statuses()
        starts = [t for t, st, _ in self.status if st == "Started"]
        first_laps = [lap.start for car in self.cars.values() for lap in car.laps if lap.n == 1 and lap.start]
        self.start = starts[0] if starts else min(first_laps, default=self.sched_start)
        self.t0 = min(self.t0, self.start - 60)
        self.parts = self._parts()
        self.total: int | None = None
        self.lap_starts: dict[int, float] = {}  # a race's lap n: when its leader began it

    # -- output
    def add(self, topic: str, t: float, payload: Any) -> None:
        self._seq += 1
        self.msgs.setdefault(topic, []).append((max(t, self.t0), self._seq, payload))

    def write(self, out: Path) -> None:
        for topic, msgs in self.msgs.items():
            msgs.sort(key=lambda m: (m[0], m[1]))
            with open(out / f"{topic}.jsonStream", "w", encoding="utf-8") as f:
                for t, _, payload in msgs:
                    f.write(format_offset(t - self.t0) + json.dumps(payload, separators=(",", ":"),
                                                                     ensure_ascii=False) + "\n")

    def meta(self) -> dict:
        return {"t0": self.t0, "meeting": self.tb.session.get("meeting_key"), "name": self.name, "type": self.type}

    def run(self) -> None:
        self._session_info()
        self._session_status()
        self._clock()
        self._track_and_messages()
        self._weather()
        self._lap_count()
        self._timing()
        self._positions()

    # -- session status and parts
    def _statuses(self) -> list[tuple[float, str, int | None]]:
        out = []
        for r in self.rc:
            if r.get("category") == "SessionStatus":
                st = _STATUS.get(str(r.get("message") or "").upper())
                if st:
                    out.append((_t(r["date"]), st, r.get("qualifying_phase")))
        if out:
            return out
        # Older sessions without status rows: the track flags say as much. A race starts at
        # lights out (its first lap), not at its first green light: that opens the pit exit
        # for the laps to the grid.
        running = False
        if self.kind == "race":
            first = [lap.start for car in self.cars.values() for lap in car.laps if lap.n == 1 and lap.start]
            if first:
                out.append((min(first), "Started", None))
                running = True
        for r in self.rc:
            flag, t = r.get("flag"), self._rcm_time(r)
            if out and t < out[0][0]:
                continue
            if flag == "GREEN" and r.get("scope") == "Track" and not running:
                out.append((t, "Started", None))
                running = True
            elif flag == "RED" and running:
                out.append((t, "Aborted", None))
                running = False
            elif flag == "CHEQUERED" and out and out[-1][1] != "Finished":
                out.append((t, "Finished", None))
                running = False
        return out

    def _parts(self) -> list[tuple[int, float, float]]:
        """Qualifying parts: (number, when it shows, its first green light). Numbered by OpenF1
        when it says; else a start after a finish begins the next part."""
        if self.kind != "quali":
            return [(1, self.t0, self.start)]
        starts: dict[int, float] = {}
        part, finished = 0, True
        for t, st, phase in self.status:
            if st == "Started":
                part = int(phase) if isinstance(phase, int) and phase > 0 else part + 1 if finished else part
                starts.setdefault(part, t)
            finished = st == "Finished"
        parts = [(1, self.t0, starts.get(1, self.start))]
        for p in sorted(k for k in starts if k > 1):
            # Never before the previous part's last lap is in (cars finish theirs after the flag).
            prev_end = max((lap.end for car in self.cars.values() for lap in car.laps
                            if lap.end and lap.end < starts[p]), default=self.t0)
            parts.append((p, max(starts[p] - PART_LEAD, prev_end + 1.0), starts[p]))
        return parts

    def _session_status(self) -> None:
        self.add("SessionStatus", self.t0, {"Status": "Inactive", "Started": "Inactive"})
        prev, prev_t = "Inactive", self.t0
        for t, st, _ in self.status:
            if st == "Started" and prev in ("Aborted", "Finished"):
                # As the feed does, about a minute before the restart or the next part's green light.
                ti = max(prev_t + 1.0, t - INACTIVE_LEAD)
                if ti < t:
                    self.add("SessionStatus", ti, {"Status": "Inactive", "Started": "Finished"})
            self.add("SessionStatus", t, {"Status": st, "Started": "Finished" if st == "Finished" else "Started"})
            prev, prev_t = st, t

    # -- SessionInfo, DriverList
    def _local(self, t: float) -> str:
        return datetime.fromtimestamp(t + self.gmt, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")

    def _session_info(self) -> None:
        s, m = self.tb.session, self.tb.meeting
        meeting = {
            "Key": s.get("meeting_key"), "Name": m.get("meeting_name"), "OfficialName": m.get("meeting_official_name"),
            "Location": s.get("location") or m.get("location"),
            "Country": {"Key": s.get("country_key"), "Code": s.get("country_code"), "Name": s.get("country_name")},
            "Circuit": {"Key": s.get("circuit_key"), "ShortName": s.get("circuit_short_name")},
        }
        self.add("SessionInfo", self.t0, {
            "Meeting": meeting, "Key": self.key, "Type": self.type, "Name": self.name,
            "StartDate": self._local(self.sched_start), "EndDate": self._local(self.sched_end),
            "GmtOffset": s.get("gmt_offset") or "00:00:00",
        })

    def _driver_list(self, order: list[str]) -> None:
        info = {str(d["driver_number"]): d for d in self.tb.drivers if d.get("driver_number") is not None}
        out = {}
        for i, num in enumerate(order, 1):
            d = info.get(num, {})
            e = {"RacingNumber": num, "BroadcastName": d.get("broadcast_name"), "FullName": d.get("full_name"),
                 "Tla": d.get("name_acronym"), "Line": i, "TeamName": d.get("team_name"),
                 "TeamColour": d.get("team_colour"), "FirstName": d.get("first_name"),
                 "LastName": d.get("last_name"), "HeadshotUrl": d.get("headshot_url")}
            out[num] = {k: v for k, v in e.items() if v is not None}
        self.add("DriverList", self.t0, out)

    # -- clock (practice, qualifying): the race's tower shows laps instead
    def _clock(self) -> None:
        if self.kind == "race":
            return
        sprint = bool(re.search(r"sprint|shootout", self.name, re.I))
        defaults = list(QUALI_MINUTES["SQ" if sprint else "Q"])
        if not sprint and datetime.fromtimestamp(self.sched_start, timezone.utc).year >= 2026:
            defaults[2] = 13
        bounds = [t for _, t, _ in self.parts[1:]] + [math.inf]
        for (p, shows, _), until in zip(self.parts, bounds):
            events = [(t, st) for t, st, _ in self.status if shows <= t < until]
            if self.kind == "practice":
                default, ran = 60, self._practice_minutes(events)
            else:
                default, ran = defaults[min(p, 3) - 1], self._part_minutes(events)
            remaining = (ran or default) * 60.0
            self.add("ExtrapolatedClock", shows, {"Utc": iso_ms(shows), "Remaining": clock_text(remaining),
                                                  "Extrapolating": False})
            run_from = None
            for t, st in events:
                if st == "Started" and run_from is None:
                    run_from = t
                    self.add("ExtrapolatedClock", t, {"Utc": iso_ms(t), "Remaining": clock_text(remaining),
                                                      "Extrapolating": True})
                elif st == "Aborted" and run_from is not None and self.kind == "quali":
                    remaining = max(0.0, remaining - (t - run_from))  # qualifying's clock stops for a red flag
                    run_from = None
                    self.add("ExtrapolatedClock", t, {"Utc": iso_ms(t), "Remaining": clock_text(remaining),
                                                      "Extrapolating": False})
                elif st == "Finished":
                    run_from = None
                    self.add("ExtrapolatedClock", t, {"Utc": iso_ms(t), "Remaining": "00:00:00",
                                                      "Extrapolating": False})

    @staticmethod
    def _part_minutes(events: list[tuple[float, str]]) -> int | None:
        """A part's length, when it ran to its flag: its green-flag running time, to the minute."""
        ran, since = 0.0, None
        for t, st in events:
            if st == "Started" and since is None:
                since = t
            elif st in ("Aborted", "Finished") and since is not None:
                ran += t - since
                if st == "Finished":
                    minutes = round(ran / 60)
                    return minutes if 5 <= minutes <= 30 else None
                since = None
        return None

    @staticmethod
    def _practice_minutes(events: list[tuple[float, str]]) -> int | None:
        # Practice's clock runs on through red flags.
        starts = [t for t, st in events if st == "Started"]
        ends = [t for t, st in events if st == "Finished"]
        if not starts or not ends:
            return None
        minutes = round((ends[-1] - starts[0]) / 60)
        return minutes if 30 <= minutes <= 90 else None

    # -- track status and race control
    def _track_and_messages(self) -> None:
        self.add("TrackStatus", self.t0, {"Status": "1", "Message": TRACK_MESSAGES["1"]})
        self.add("RaceControlMessages", self.t0, {"Messages": []})
        base, sectors, shown = "1", set(), "1"
        i = 0
        for r in self.rc:
            cat, msg = r.get("category"), str(r.get("message") or "")
            if cat == "SessionStatus":
                continue  # OpenF1's own rows (the feed's SessionStatus topic), not race control's
            t = self._rcm_time(r)
            up = msg.upper()
            out = {"Utc": str(r["date"])[:19], "Lap": r.get("lap_number"), "Category": cat, "Flag": r.get("flag"),
                   "Scope": r.get("scope"), "Sector": r.get("sector"),
                   "RacingNumber": str(r["driver_number"]) if r.get("driver_number") is not None else None,
                   "Message": msg}
            if cat == "SafetyCar":
                vsc = "VSC" in up or "VIRTUAL" in up
                out["Mode"] = "VSC" if vsc else "SAFETY CAR"
                if "DEPLOYED" in up:
                    out["Status"], base = "DEPLOYED", "6" if vsc else "4"
                elif "ENDING" in up:
                    out["Status"], base = "ENDING", "7" if vsc else base
                elif "IN THIS LAP" in up:
                    out["Status"] = "IN THIS LAP"
            elif cat == "Flag":
                flag, scope = r.get("flag"), r.get("scope")
                if flag == "RED":
                    base = "5"
                elif scope == "Track" and flag in ("CLEAR", "GREEN"):
                    base = "1"
                    sectors.clear()
                elif flag in ("YELLOW", "DOUBLE YELLOW"):
                    sectors.add(r.get("sector") if scope == "Sector" else "track")
                elif flag == "CLEAR" and scope == "Sector":
                    sectors.discard(r.get("sector"))
            self.add("RaceControlMessages", t, {"Messages": {str(i): {k: v for k, v in out.items() if v is not None}}})
            i += 1
            status = base if base != "1" else "2" if sectors else "1"
            if status != shown:
                shown = status
                self.add("TrackStatus", t, {"Status": status, "Message": TRACK_MESSAGES[status]})

    @staticmethod
    def _rcm_time(r: dict) -> float:
        t = _t(r["date"])
        return t + RCM_LAG if t == math.floor(t) else t

    # -- weather
    def _weather(self) -> None:
        rows = sorted((r for r in self.tb.weather if _t(r.get("date"))), key=lambda r: _t(r["date"]))
        keys = (("AirTemp", "air_temperature", "{:.1f}"), ("Humidity", "humidity", "{:.1f}"),
                ("Pressure", "pressure", "{:.1f}"), ("Rainfall", "rainfall", "{:.0f}"),
                ("TrackTemp", "track_temperature", "{:.1f}"), ("WindDirection", "wind_direction", "{:.0f}"),
                ("WindSpeed", "wind_speed", "{:.1f}"))
        for r in rows:
            t = _t(r["date"])
            if t < self.t0 - 3600:
                continue
            w = {k: fmt.format(v) for k, src, fmt in keys if (v := _num(r.get(src))) is not None}
            if w:
                self.add("WeatherData", t, w)

    # -- the race's lap counter
    def _total_laps(self) -> int | None:
        """The race distance, from the laps the winner did; None when the race ended under a red
        flag (the one common case where they fall short of the scheduled distance)."""
        if self.status and len(self.status) > 1 and self.status[-1][1] == "Finished" \
                and self.status[-2][1] == "Aborted":
            return None
        done = [int(r["number_of_laps"]) for r in self.tb.result if _num(r.get("number_of_laps"))]
        return max(done, default=0) or None

    def _lap_count(self) -> None:
        if self.kind != "race":
            return
        self.total = self._total_laps()
        first = {"CurrentLap": 1}
        if self.total:
            first["TotalLaps"] = self.total
        self.add("LapCount", self.t0, first)
        for car in self.cars.values():
            for lap in car.laps:
                if lap.start is not None and lap.n >= 2 and (not self.total or lap.n <= self.total):
                    self.lap_starts[lap.n] = min(self.lap_starts.get(lap.n, math.inf), lap.start)
        last = 1
        for n, t in sorted(self.lap_starts.items(), key=lambda x: x[1]):
            if n > last:
                self.add("LapCount", t, {"CurrentLap": n})
                last = n

    # -- cars
    def _cars(self) -> dict[str, _Car]:
        by: dict[str, list[dict]] = {}
        for r in self.tb.laps:
            if r.get("driver_number") is not None and isinstance(r.get("lap_number"), int):
                by.setdefault(str(r["driver_number"]), []).append(r)
        nums = {str(d["driver_number"]) for d in self.tb.drivers if d.get("driver_number") is not None}
        nums |= set(by) | {str(r["driver_number"]) for r in self.tb.position if r.get("driver_number") is not None}
        cars = {num: _Car(num, _laps(by.get(num, []))) for num in sorted(nums, key=int)}
        if self.kind != "race":  # a car's last lap of a practice or qualifying session ends in the pits
            for car in cars.values():
                if car.laps:
                    car.laps[-1].inlap = True
        return cars

    def _initial_order(self) -> dict[str, int]:
        """Positions before the start (pre-session order; a race's grid): latest row before it."""
        pos: dict[str, tuple[float, int]] = {}
        for r in self.tb.position:
            t = _t(r.get("date"))
            if t is not None and t <= self.start and isinstance(r.get("position"), int):
                num = str(r["driver_number"])
                if num not in pos or t >= pos[num][0]:
                    pos[num] = (t, r["position"])
        return {num: p for num, (_, p) in pos.items()}

    def _grid(self, initial: dict[str, int]) -> dict[str, int]:
        if self.kind != "race":
            return {}
        grid = {str(r["driver_number"]): r["position"] for r in self.tb.grid
                if r.get("driver_number") is not None and isinstance(r.get("position"), int)}
        return grid or initial

    # -- timing: TimingData and TimingAppData, event by event
    def _timing(self) -> None:
        initial = self._initial_order()
        grid = self._grid(initial)
        order = sorted(self.cars, key=lambda n: (initial.get(n) is None, initial.get(n) or 0, int(n)))
        self._driver_list(order)
        quali, race = self.kind == "quali", self.kind == "race"
        lines, app = {}, {}
        for i, num in enumerate(order, 1):
            car = self.cars[num]
            car.pos = initial.get(num)
            ln: dict[str, Any] = {
                "Line": i, "RacingNumber": num, "Retired": False, "InPit": not race, "PitOut": False,
                "Stopped": False, "NumberOfLaps": 0, "NumberOfPitStops": 0,
                "Sectors": [{"Value": "", "PersonalFastest": False, "OverallFastest": False} for _ in range(3)],
                "BestLapTime": {"Value": ""},
                "LastLapTime": {"Value": "", "Status": 0, "OverallFastest": False, "PersonalFastest": False},
            }
            if car.pos is not None:
                ln["Position"] = str(car.pos)
            if race:
                lead = "LAP 1" if car.pos == 1 else ""  # the leader's "gap" is the lap it's on
                ln.update(GapToLeader=lead, IntervalToPositionAhead={"Value": lead, "Catching": False})
            elif quali:
                ln.update(KnockedOut=False, Cutoff=False, BestLapTimes=[{"Value": ""} for _ in range(3)],
                          Stats=[{"TimeDiffToFastest": "", "TimeDifftoPositionAhead": ""} for _ in range(3)])
            else:
                ln.update(TimeDiffToFastest="", TimeDiffToPositionAhead="")
            lines[num] = ln
            app[num] = {"RacingNumber": num, "Line": i, "Stints": []}
            if grid.get(num):
                app[num]["GridPos"] = str(grid[num])
        td: dict[str, Any] = {"Lines": lines}
        if quali:
            n = len(order)
            td.update(SessionPart=1, NoEntries=[n, _q1_cut(n), 10] if n > 10 else [n, n, n])
        self.add("TimingData", self.t0, td)
        self.add("TimingAppData", self.t0, {"Lines": app})

        self.part = 1
        self.overall: dict[tuple[int, str], tuple[float, _Car | None]] = {}  # (part, measure) -> (s, holder)
        self.cur_lap = 1
        events = self._events()
        events.sort(key=lambda e: (e[0], e[1], e[2]))
        i = 0
        while i < len(events):
            t = events[i][0]
            self.td, self.app, self.dirty = {}, {}, False
            while i < len(events) and events[i][0] - t < 0.0005:
                _, _, _, kind, num, data = events[i]
                getattr(self, f"_on_{kind}")(self.cars.get(num) if num is not None else None, data, t)
                i += 1
            if self.dirty and not race:
                self._gaps()
            if self.td:
                self.add("TimingData", t, self.td)
            if self.app:
                self.add("TimingAppData", t, {"Lines": self.app})

    def _put(self, car: _Car, delta: dict) -> None:
        lines = self.td.setdefault("Lines", {})
        lines[car.num] = merge(lines.get(car.num), delta)

    def _put_app(self, car: _Car, delta: dict) -> None:
        self.app[car.num] = merge(self.app.get(car.num), delta)

    def _events(self) -> list[tuple]:
        ev: list[tuple] = []
        race = self.kind == "race"

        def at(t: float | None, prio: int, kind: str, num: str | None = None, data: Any = None) -> None:
            if t is not None and t >= self.t0:
                ev.append((t, prio, len(ev), kind, num, data))

        for p, shows, _ in self.parts[1:]:
            at(shows, 0, "part", None, p)
        for car in self.cars.values():
            for lap in car.laps:
                for s, end in enumerate(lap.sector_ends):
                    if end is not None and lap.sectors[s] is not None:
                        at(end, 3, "sector", car.num, (lap, s))
                if lap.end is not None:
                    at(lap.end, 3, "lap", car.num, lap)
        self._stint_events(at)
        if race and self.tb.pit:
            self._pit_events(at)
        else:
            self._lap_pit_events(at)
        for r in self.tb.position:
            t = _t(r.get("date"))
            if t is not None and t > self.start and isinstance(r.get("position"), int):
                at(t, 5, "pos", str(r["driver_number"]), r["position"])
        for kind_, num, data, t in self._deletions():
            at(t, 4, kind_, num, data)
        if race:
            for r in self.tb.intervals:
                t = _t(r.get("date"))
                if t is not None and t >= self.start:
                    at(t, 6, "gap", str(r["driver_number"]), (r.get("gap_to_leader"), r.get("interval")))
            for n, t in self.lap_starts.items():
                at(t, 6, "lapcount", None, n)
            self._retirements(at)
        return [e for e in ev if e[4] is None or e[4] in self.cars]

    def _stint_events(self, at) -> None:
        by: dict[str, list[dict]] = {}
        for r in self.tb.stints:
            if r.get("driver_number") is not None and isinstance(r.get("lap_start"), int):
                by.setdefault(str(r["driver_number"]), []).append(r)
        pits = {(str(r["driver_number"]), r.get("lap_number")): _t(r.get("date")) for r in self.tb.pit}
        for num, rows in by.items():
            car = self.cars.get(num)
            if car is None:
                continue
            rows.sort(key=lambda r: (r.get("stint_number") or 0, r["lap_start"]))
            if self.kind == "race" and self.tb.pit:
                rows = _repair_stints(rows, sorted(lap for n, lap in pits if n == num and isinstance(lap, int)))
            last: tuple[_Stint, str] | None = None
            for i, r in enumerate(rows):
                st = _Stint(i, r["lap_start"], r.get("lap_end"), int(_num(r.get("tyre_age_at_start")) or 0))
                compound = str(r.get("compound") or "").upper()
                compound = compound if compound in COMPOUNDS else "UNKNOWN"
                # A drive through the pit lane opens a stint on the same tyres (as in the feed):
                # same compound, aged on from where the last one ended.
                same = last is not None and last[1] == compound and last[0].lap_end is not None \
                    and st.age == last[0].age + last[0].lap_end - last[0].lap_start + 1
                payload = {"LapFlags": 0, "Compound": compound, "New": "true" if st.age == 0 else "false",
                           "TyresNotChanged": "1" if same else "0", "TotalLaps": st.age, "StartLaps": st.age}
                last = st, compound
                out_lap, prev = car.lap(st.lap_start), car.lap(st.lap_start - 1)
                if self.kind == "race" and i == 0:
                    t = max(self.t0, self.start - FIRST_TYRE_LEAD)
                elif self.kind == "race" and pits.get((num, st.lap_start - 1)):
                    t = pits[(num, st.lap_start - 1)]  # the pit exit
                elif out_lap and out_lap.start:  # practice and qualifying: the out-lap starts at the pit exit
                    t = out_lap.start
                elif prev and prev.end:
                    t = prev.end
                else:  # OpenF1 lacks the stint's first lap (a car straight back in): with the next one
                    t = min((x for lap in car.laps if lap.n > st.lap_start for x in (lap.start, lap.end) if x),
                            default=None)
                at(t, 1, "stint", num, (st, payload))

    def _pit_events(self, at) -> None:
        for r in self.tb.pit:
            num, exit_ = str(r.get("driver_number")), _t(r.get("date"))
            car = self.cars.get(num)
            if car is None or exit_ is None:
                continue
            lane = _num(r.get("lane_duration")) or _num(r.get("pit_duration"))
            if lane and 5 < lane < 600:
                at(exit_ - lane, 2, "pit_in", num)
            at(exit_, 2, "pit_out", num)
            out_lap = car.lap(int(r["lap_number"]) + 1) if isinstance(r.get("lap_number"), int) else None
            clear = out_lap.sector_ends[0] if out_lap else None
            at(clear if clear and clear > exit_ else exit_ + PIT_OUT_SECONDS, 2, "pit_clear", num)

    def _lap_pit_events(self, at) -> None:
        """Practice and qualifying (OpenF1 has no pit table for them): out at each out-lap's
        start, in at the end of the lap before it (and of the car's last lap). The pit entry
        itself comes 5-25 s before that lap's end, which the tables don't tell."""
        durations = [lap.sec for car in self.cars.values() for lap in car.laps if lap.sec]
        typical = statistics.median(durations) if durations else 100.0
        for car in self.cars.values():
            in_pits = self.kind != "race"
            for k, lap in enumerate(car.laps):
                if lap.out and lap.start is not None and (k > 0 or self.kind != "race"):
                    at(lap.start, 2, "pit_out", car.num)
                    clear = lap.sector_ends[0]
                    at(clear if clear and clear > lap.start else lap.start + PIT_OUT_SECONDS, 2, "pit_clear", car.num)
                elif in_pits and lap.start is not None:
                    at(lap.start, 2, "track", car.num)  # OpenF1 lacks its out-lap: out by now
                in_pits = False
                nxt = car.laps[k + 1] if k + 1 < len(car.laps) else None
                if self.kind != "race" and (nxt is None or nxt.out):
                    t = lap.end if lap.end else lap.start + 1.25 * typical if lap.start else None
                    if nxt is not None and nxt.start is not None and t is not None:
                        t = min(t, nxt.start - 1.0)
                    at(t, 2, "pit_in", car.num)
                    in_pits = True

    def _retirements(self, at) -> None:
        durations = [lap.sec for car in self.cars.values() for lap in car.laps if lap.sec and lap.n > 1]
        typical = statistics.median(durations) if durations else 100.0
        for r in self.tb.result:
            num = str(r.get("driver_number"))
            car = self.cars.get(num)
            if car is None:
                continue
            if r.get("dns"):
                at(self.start, 7, "retire", num)
            elif r.get("dnf"):
                own = [lap.sec for lap in car.laps if lap.sec and lap.n > 1]
                lap_time = statistics.median(own) if own else typical
                last = car.laps[-1] if car.laps else None
                since = (last.start or last.end) if last else self.start
                if since is None:
                    continue
                # Out once it has stood still (its locations say when), else once it's overdue.
                if last is None:
                    t = self.start + 1.5 * lap_time
                elif last.end is not None:
                    t = last.end + 0.5 * lap_time  # parked after the line or in the garage
                else:
                    t = since + 1.5 * lap_time  # stopped somewhere on this lap
                at(self._stopped(num, since) or t, 7, "retire", num)

    def _stopped(self, num: str, since: float) -> float | None:
        """When the car has stood still for STOP_SECONDS after `since` (or stopped sending)."""
        s = self.tb.location.get(num)
        if s is None or not s.t:
            return None
        i, n = bisect.bisect_left(s.t, since), len(s.t)
        while i < n:
            x0, y0, t0 = s.x[i], s.y[i], s.t[i]
            j = i + 1
            while j < n and s.t[j] - t0 < STOP_SECONDS and abs(s.x[j] - x0) <= STOP_RADIUS \
                    and abs(s.y[j] - y0) <= STOP_RADIUS:
                j += 1
            if j == n or s.t[j] - t0 >= STOP_SECONDS:
                return t0 + STOP_SECONDS
            i = j
        return None

    def _deletions(self) -> list[tuple[str, str, int, float]]:
        """Lap times race control deleted (or reinstated): (kind, car, lap number, when)."""
        out = []
        moves: dict[str, list[float]] = {}
        for r in self.tb.position:
            t = _t(r.get("date"))
            if t is not None:
                moves.setdefault(str(r.get("driver_number")), []).append(t)
        for v in moves.values():
            v.sort()
        for r in self.rc:
            msg = str(r.get("message") or "").upper()
            m = re.match(r"CAR (\d+)\b", msg)
            verdict = re.search(r"\b(DELETED|REINSTATED)\b", msg)
            if not m or not verdict:
                continue
            car = self.cars.get(m.group(1))
            if car is None:
                continue
            said = self._rcm_time(r)
            lap = self._deleted_lap(car, msg, said)
            if lap is None:
                continue
            # The feed drops the time 10-60 s after the message: in practice and qualifying
            # as the car loses its place for it, in a race at no telling moment.
            later = [t for t in moves.get(car.num, []) if said <= t <= said + 90] if self.kind != "race" else []
            when = later[0] if later else said + DELETE_LAG
            out.append(("delete" if verdict.group(1) == "DELETED" else "reinstate", car.num, lap.n, when))
        return out

    def _deleted_lap(self, car: _Car, msg: str, when: float) -> _Lap | None:
        done = [lap for lap in car.laps if lap.end is not None and lap.end <= when]
        tm = re.search(r"\bTIME (\d+:\d{2}\.\d{3}|\d{1,3}\.\d{3})\b", msg)
        if tm:
            sec = sum(float(x) * 60 ** i for i, x in enumerate(reversed(tm.group(1).split(":"))))
            hits = [lap for lap in done if lap.sec is not None and abs(lap.sec - sec) < 0.0015]
            return hits[-1] if hits else None
        clock = re.search(r"\b(\d{1,2}):(\d{2}):(\d{2})\b", msg)
        if clock:  # the infringement's local time of day
            local = datetime.fromtimestamp(when + self.gmt, timezone.utc)
            h, mi, s = (int(x) for x in clock.groups())
            moment = local.replace(hour=h % 24, minute=mi, second=s)
            if moment > local + timedelta(hours=1):
                moment -= timedelta(days=1)
            u = moment.timestamp() - self.gmt
            for lap in done:
                if lap.start is not None and lap.start - 1 <= u <= lap.end + 1:
                    return lap
            return None
        n = re.search(r"\bLAP (\d+)\b", msg)
        if n:  # the feed counts a qualifying or practice car's laps one ahead of OpenF1
            return car.lap(int(n.group(1)) - (0 if self.kind == "race" else 1))
        return None

    # -- event handlers
    def _part_of(self, lap: _Lap) -> int:
        if self.kind != "quali":
            return 1
        t = lap.start if lap.start is not None else lap.end
        return max((p for p, _, start in self.parts if start <= (t or 0) + 1.0), default=1)

    def _on_part(self, _car, p: int, t: float) -> None:
        cut = _q1_cut(len([c for c in self.cars.values() if c.pos])) if self.part == 1 else 10
        self.part = p
        self.td["SessionPart"] = p
        for car in self.cars.values():
            if not car.knocked and car.pos is not None and car.pos > cut:
                car.knocked = True
                self._put(car, {"KnockedOut": True})
            reset = {"LastLapTime": {"Value": "", "PersonalFastest": False, "OverallFastest": False},
                     "BestLapTime": {"Value": ""}}
            if not car.knocked:
                reset["BestLapTimes"] = {str(p - 1): {"Value": ""}}
            self._put(car, reset)
            car.last_lap, car.last_pb, car.last_purple = None, False, False
        self.dirty = True

    def _on_stint(self, car: _Car, data: tuple, t: float) -> None:
        st, payload = data
        car.stint = st
        self._put_app(car, {"Stints": {str(st.index): payload}})

    def _on_pit_in(self, car: _Car, _data, t: float) -> None:
        car.pits += 1
        self._put(car, {"InPit": True, "PitOut": False, "NumberOfPitStops": car.pits})

    def _on_pit_out(self, car: _Car, _data, t: float) -> None:
        self._put(car, {"InPit": False, "PitOut": True})

    def _on_pit_clear(self, car: _Car, _data, t: float) -> None:
        self._put(car, {"PitOut": False})

    def _on_retire(self, car: _Car, _data, t: float) -> None:
        car.retired = True  # the feed blanks a stopped car's gaps; OpenF1's last ones go stale
        self._put(car, {"Retired": True, "GapToLeader": "", "IntervalToPositionAhead": {"Value": ""}})

    def _on_track(self, car: _Car, _data, t: float) -> None:
        self._put(car, {"InPit": False})

    def _on_pos(self, car: _Car, p: int, t: float) -> None:
        if car.pos == p:
            return
        was, car.pos = car.pos, p
        self._put(car, {"Position": str(p), "Line": p})
        self.dirty = True
        if self.kind == "race" and 1 in (was, p) and not car.retired:
            # The leader's gap is the lap it's on; the one it passed waits for its next gap.
            lead = f"LAP {self.cur_lap}" if p == 1 else ""
            self._put(car, {"GapToLeader": lead, "IntervalToPositionAhead": {"Value": lead}})

    def _on_gap(self, car: _Car, data: tuple, t: float) -> None:
        gap, itv = data
        if car.retired:
            return
        out: dict[str, Any] = {}
        leader = car.pos == 1  # OpenF1 has 0 for the leader's gap: the feed has the lap it's on
        if gap is not None:
            if isinstance(gap, (int, float)):
                out["GapToLeader"] = f"LAP {self.cur_lap}" if leader and gap == 0 else gap_text(gap)
            elif isinstance(gap, str) and _lapped(gap):
                out["GapToLeader"] = _lapped(gap)
        if itv is not None:
            if isinstance(itv, (int, float)):
                out["IntervalToPositionAhead"] = {"Value": f"LAP {self.cur_lap}" if leader and itv == 0 else gap_text(itv)}
            elif isinstance(itv, str) and _lapped(itv):
                out["IntervalToPositionAhead"] = {"Value": _lapped(itv)}
        if out:
            self._put(car, out)

    def _on_lapcount(self, _car, n: int, t: float) -> None:
        self.cur_lap = max(self.cur_lap, n)
        for car in self.cars.values():
            if car.pos == 1:
                self._put(car, {"GapToLeader": f"LAP {self.cur_lap}",
                                "IntervalToPositionAhead": {"Value": f"LAP {self.cur_lap}"}})

    def _purple(self, part: int, measure: str, car: _Car, sec: float) -> tuple[bool, _Car | None]:
        """Whether `sec` is the fastest so far, and who held it before."""
        best, holder = self.overall.get((part, measure), (math.inf, None))
        if sec < best - 1e-6:
            self.overall[(part, measure)] = (sec, car)
            return True, holder
        return False, None

    def _on_sector(self, car: _Car, data: tuple, t: float) -> None:
        lap, s = data
        if car.knocked:
            return
        sec, part = lap.sectors[s], self._part_of(lap)
        pb = sec < car.sector_best.get((part, s), math.inf) - 1e-6
        if pb:
            car.sector_best[(part, s)] = sec
        purple, holder = self._purple(part, f"s{s}", car, sec)
        self._put(car, {"Sectors": {str(s): {"Value": lap_text(sec), "PersonalFastest": pb, "OverallFastest": purple}}})
        if holder is not None and holder is not car:
            self._put(holder, {"Sectors": {str(s): {"OverallFastest": False}}})

    def _on_lap(self, car: _Car, lap: _Lap, t: float) -> None:
        if car.knocked:
            return
        self._put(car, {"NumberOfLaps": lap.n})
        st = car.stint
        if st and lap.n >= st.lap_start and (st.lap_end is None or lap.n <= st.lap_end):
            self._put_app(car, {"Stints": {str(st.index): {"TotalLaps": st.age + lap.n - st.lap_start + 1}}})
        if lap.sec is None or (self.kind == "race" and lap.n == 1):
            return  # the feed has no time for a race's first lap (it starts from the grid, not a line)
        part = self._part_of(lap)
        if part != self.part:
            return
        prev = car.best.get(part)
        valid = not (lap.out or lap.inlap)  # through the pit lane: shown, but never a best
        pb = valid and (prev is None or lap.sec < prev - 1e-6)
        purple, holder = False, None
        if valid:
            car.timed.setdefault(part, {})[lap.n] = lap.sec
            purple, holder = self._purple(part, "lap", car, lap.sec)
        self._put(car, {"LastLapTime": {"Value": lap_text(lap.sec), "PersonalFastest": pb, "OverallFastest": purple}})
        if holder is not None and holder is not car and holder.last_purple:
            holder.last_purple = False
            self._put(holder, {"LastLapTime": {"OverallFastest": False}})
        car.last_lap, car.last_pb, car.last_purple = lap.n, pb, purple
        if pb:
            self._set_best(car, part, lap.n, lap.sec)
        self.dirty = True

    def _set_best(self, car: _Car, part: int, n: int | None, sec: float | None) -> None:
        if sec is None:
            car.best.pop(part, None)
            car.best_lap.pop(part, None)
            value: dict[str, Any] = {"Value": ""}
        else:
            car.best[part], car.best_lap[part] = sec, n
            value = {"Value": lap_text(sec), "Lap": n}
        self._put(car, {"BestLapTime": value})
        if self.kind == "quali":
            self._put(car, {"BestLapTimes": {str(part - 1): value}})

    def _on_delete(self, car: _Car, n: int, t: float, reinstate: bool = False) -> None:
        lap = car.lap(n)
        part = self._part_of(lap) if lap else self.part
        timed = car.timed.setdefault(part, {})
        if reinstate:
            if lap is None or lap.sec is None or n in timed:
                return
            timed[n] = lap.sec
        elif timed.pop(n, None) is None:
            return
        best = min(timed.items(), key=lambda kv: (kv[1], kv[0]), default=None)
        if (best and best[1]) != car.best.get(part):
            self._set_best(car, part, *(best or (None, None)))
        if not reinstate and car.last_lap == n and (car.last_pb or car.last_purple):
            car.last_pb = car.last_purple = False
            self._put(car, {"LastLapTime": {"PersonalFastest": False, "OverallFastest": False}})
        if best and car.last_lap == best[0] and not car.last_pb:
            car.last_pb = True  # its last lap is its best now
            self._put(car, {"LastLapTime": {"PersonalFastest": True}})
        # The deleted lap no longer counts as the time to beat.
        fastest = min(((c.best[part], c) for c in self.cars.values() if part in c.best), default=(math.inf, None),
                      key=lambda x: x[0])
        self.overall[(part, "lap")] = fastest
        self.dirty = True

    def _on_reinstate(self, car: _Car, n: int, t: float) -> None:
        self._on_delete(car, n, t, reinstate=True)

    def _gaps(self) -> None:
        """Practice and qualifying gaps, from the best laps known now and the positions."""
        p = self.part
        cars = [c for c in self.cars.values() if not c.knocked]
        fastest = min((c.best[p] for c in cars if p in c.best), default=None)
        by_pos = {c.pos: c for c in cars if c.pos is not None}
        for car in cars:
            best = car.best.get(p)
            diff = ahead = ""
            if best is not None and fastest is not None:
                if car.pos != 1 and best >= fastest - 1e-6:
                    diff = gap_text(max(0.0, best - fastest))
                front = by_pos.get(car.pos - 1) if car.pos else None
                if front is not None and p in front.best and best >= front.best[p] - 1e-6:
                    ahead = gap_text(max(0.0, best - front.best[p]))
            if (diff, ahead) != car.gaps:
                car.gaps = (diff, ahead)
                if self.kind == "quali":
                    self._put(car, {"Stats": {str(p - 1): {"TimeDiffToFastest": diff, "TimeDifftoPositionAhead": ahead}}})
                else:
                    self._put(car, {"TimeDiffToFastest": diff, "TimeDiffToPositionAhead": ahead})

    # -- car positions (Position.z)
    def _positions(self) -> None:
        for t, payload in position_lines(self.tb):
            self.add(POSITION_TOPIC, t, payload)


def position_lines(tb: Tables) -> list[tuple[float, str]]:
    """Locations as the feed sends them, as (UTC, Position.z line): every car's sample at one
    sensor time per batch (they share the batch times), a second of batches per line, the
    line at its newest sample's time."""
    lo, hi = (round(x * 1000) for x in _window(tb))
    streams = [_stream(num, s) for num, s in tb.location.items() if s.t]
    out: list[tuple[float, str]] = []
    line: list[dict] = []
    line_ms = 0

    def batch(ms: int, entries: dict) -> None:
        nonlocal line, line_ms
        if line and ms // 1000 != line_ms // 1000:
            out.append((line_ms / 1000, deflate({"Position": line})))
            line = []
        line.append({"Timestamp": iso_ms(ms / 1000), "Entries": entries})
        line_ms = ms

    cur, entries = None, {}
    for ms, num, x, y, z in heapq.merge(*streams):
        if ms != cur:
            if entries:
                batch(cur, entries)
            cur, entries = ms, {}
        if lo <= ms <= hi:
            # Like the feed: "OnTrack" throughout, (0, 0) for a car that isn't sending (garage).
            entries[num] = {"Status": "OnTrack", "X": x, "Y": y, "Z": z}
    if entries:
        batch(cur, entries)
    if line:
        out.append((line_ms / 1000, deflate({"Position": line})))
    return out


def _stream(num: str, s: Samples) -> Iterator[tuple[int, str, int, int, int]]:
    for i in range(len(s.t)):
        yield round(s.t[i] * 1000), num, s.x[i], s.y[i], s.z[i]


def _q1_cut(n: int) -> int:
    """The last place through to Q2 (the extension's cutAfter; JS rounding)."""
    return n - math.floor((n - 10) / 2 + 0.5)


def _repair_stints(rows: list[dict], pit_laps: list[int]) -> list[dict]:
    """OpenF1 takes a pit lane start for a stop (the feed opens a second stint on the same tyres
    as the car passes the pit lane), then gives that stint the compound of the car's real first
    stop: SOFT, then MEDIUM from lap 2 on, for a car that ran its softs to lap 35. With the pit
    table, a stint that begins without a stop before it is moved to the first stop inside it
    that no stint begins after, or folded into the previous one if there's none."""
    out: list[dict] = []
    starts = {r["lap_start"] for r in rows}
    for r in rows:
        r = dict(r)
        if out and r["lap_start"] - 1 not in pit_laps:
            end = r.get("lap_end")
            stops = [p for p in pit_laps if p >= r["lap_start"] and p + 1 not in starts and (end is None or p < end)]
            if stops:
                out[-1]["lap_end"] = stops[0]
                r["lap_start"] = stops[0] + 1
                starts.add(r["lap_start"])
            elif str(r.get("compound")).upper() == str(out[-1].get("compound")).upper():
                out[-1]["lap_end"] = end
                continue
        out.append(r)
    return out


def _laps(rows: list[dict]) -> list[_Lap]:
    """One car's laps with the moments their sectors and the lap itself ended.

    A lap ends as the next one starts, which is when the feed published its time, except
    before an out-lap: a practice or qualifying out-lap "starts" at the pit exit, long after
    the in-lap ended in the pit lane (start + duration). And an out-lap's duration runs from
    the previous lap's end, garage time included (the time the feed showed), so an out-lap
    that goes straight back in ends at that end + duration."""
    rows = sorted(rows, key=lambda r: r["lap_number"])
    out: list[_Lap] = []
    for k, r in enumerate(rows):
        start, sec = _t(r.get("date_start")), _num(r.get("lap_duration"))
        nxt = rows[k + 1] if k + 1 < len(rows) and rows[k + 1]["lap_number"] == r["lap_number"] + 1 else None
        nstart = _t(nxt.get("date_start")) if nxt else None
        before_out = bool(nxt and nxt.get("is_pit_out_lap"))
        prev_end = out[-1].end if out and out[-1].n == r["lap_number"] - 1 else None
        end = None
        if nstart is not None and not before_out and (start is None or nstart > start):
            end = nstart
        elif sec and r.get("is_pit_out_lap") and prev_end is not None:
            end = prev_end + sec + PUBLISH_LAG
        elif start is not None and sec:
            end = start + sec + PUBLISH_LAG
        sectors = [_num(r.get(f"duration_sector_{i}")) for i in (1, 2, 3)]
        ends: list[float | None] = [None, None, None]
        if start is not None and sectors[0]:
            ends[0] = start + sectors[0] + PUBLISH_LAG
            if sectors[1]:
                ends[1] = ends[0] + sectors[1]
        if end is not None:
            if sectors[2]:
                ends[2] = end
            if ends[1] is None and sectors[1] and sectors[2]:
                ends[1] = end - sectors[2]
            ends = [min(e, end) if e is not None else None for e in ends]
        out.append(_Lap(r["lap_number"], start, end, sec, bool(r.get("is_pit_out_lap")), before_out, sectors, ends))
    return out


def build(tb: Tables, out: Path) -> dict:
    """Write one session's topic streams into `out`; returns its meta.json fields."""
    b = _Build(tb)
    b.run()
    b.write(out)
    return b.meta()
