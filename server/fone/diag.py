"""Playback diagnostics from the extension: what fone and F1 TV's player were doing, so a
problem on a machine nobody is watching over (a Mac after it slept, glitches at 2x) can be
read afterwards instead of reproduced.

POST /api/diag   {"client", "build", "platform", "events": [{"t", "type", ...}, ...]}
                 (from the extension's audio engine every few seconds; refused from web
                 pages like every other write, see app.RefuseWebPages)
GET  /api/diag?client=&type=&since=&limit=   newest last; plus every client's last report
                 (every viewer's playback: the extension's and scripts' alone, X-Fone: 1;
                 tools/diag.py reads it)

Playback state only: positions, speeds, sync drift, seeks, buffering, player errors. Kept
in memory (the last 20000 events) and in <data_dir>/diag/<day>.jsonl (the UTC day it came in)
for 7 days after that day.
"""

from __future__ import annotations

import json
import logging
import math
import threading
import time
from collections import deque
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field

from .config import Config

log = logging.getLogger("fone.diag")

KEEP_DAYS = 7  # a day's file is kept this many days after its day (its name's)
MAX_EVENTS = 200  # per request
# (over it an event is kept as {t, type, truncated}. The engine's snapshots run to ~4.4 kB: 4000
# cut 3.4% of them, the sound's state of whole runs. In memory a 4 kB event takes ~20 kB.)
MAX_EVENT_BYTES = 8000
MAX_TYPE = 40  # characters of an event's type ('snap', 'seek', 'vod', ...)
MAX_DAY_BYTES = 64 << 20  # a day's file; a busy day's playback writes a few MB


def _clean(ev: dict) -> dict:
    """An event as kept: what the queries go by, a numeric t and a short type, made so."""
    t, typ = ev.get("t"), ev.get("type")
    if "t" in ev and not (isinstance(t, (int, float)) and not isinstance(t, bool) and math.isfinite(t)):
        ev = {**ev, "t": None}
    if "type" in ev and not (isinstance(typ, str) and len(typ) <= MAX_TYPE):
        ev = {**ev, "type": str(typ)[:MAX_TYPE] if typ is not None else None}
    return ev


def _days(root: Path, today: date) -> tuple[list[Path], list[Path]]:
    """The day files, oldest first: those kept (KEEP_DAYS after their day) and those past it.
    Another file there isn't one."""
    keep, old = [], []
    for f in sorted(root.glob("*.jsonl")):
        try:
            day = date.fromisoformat(f.stem)
        except ValueError:
            continue
        (keep if (today - day).days <= KEEP_DAYS else old).append(f)
    return keep, old


class DiagBody(BaseModel):
    client: str = Field(max_length=64)
    build: str = Field(default="", max_length=80)
    platform: str = Field(default="", max_length=80)
    events: list[dict[str, Any]] = Field(default_factory=list, max_length=MAX_EVENTS)


class DiagStore:
    def __init__(self, root: Path | None, size: int = 20000):
        self.root = root
        self.events: deque[dict] = deque(maxlen=size)
        self.clients: dict[str, dict] = {}
        self._lock = threading.Lock()
        self._pruned_day = ""
        self._full_day = ""
        if root:
            root.mkdir(parents=True, exist_ok=True)
            self._load()

    def _load(self) -> None:
        """The last days' events back into memory after a restart. A line that isn't an event is
        skipped, not the rest of its day; NUL bytes are dropped (an unclean shutdown leaves a run
        of them where the file's end hadn't been written, the next event after it)."""
        for f in _days(self.root, datetime.now(timezone.utc).date())[0]:
            try:
                data = f.read_bytes()
            except OSError as e:
                log.warning("unreadable diagnostics file %s: %s", f.name, e)
                continue
            bad = 0
            for line in data.replace(b"\0", b"").splitlines():
                if not line.strip():
                    continue
                try:
                    ev = json.loads(line)
                except ValueError:
                    ev = None
                if not isinstance(ev, dict):
                    bad += 1
                    continue
                ev = _clean(ev)
                self.events.append(ev)
                c = self.clients.setdefault(ev.get("client", "?"), {})
                c.update(last=ev.get("rx"), build=ev.get("build"), platform=ev.get("platform"))
            if bad:
                log.warning("diagnostics file %s: %d unreadable lines skipped", f.name, bad)

    def add(self, body: DiagBody) -> int:
        rx = time.time()
        kept = []
        for ev in body.events:
            try:  # (Python's json reads Infinity and NaN, which no answer can carry)
                line = json.dumps(ev, separators=(",", ":"), default=str, allow_nan=False)
            except ValueError:
                line = None
            if line is None or len(line) > MAX_EVENT_BYTES:
                ev = {"t": ev.get("t"), "type": ev.get("type"), "truncated": len(line) if line else "not JSON"}
            kept.append({**_clean(ev), "client": body.client, "build": body.build, "platform": body.platform, "rx": rx})
        with self._lock:
            self.events.extend(kept)
            self.clients[body.client] = {"last": rx, "build": body.build, "platform": body.platform}
            self._persist(kept, rx)
        return len(kept)

    def _persist(self, kept: list[dict], rx: float) -> None:
        if not self.root or not kept:
            return
        day = datetime.fromtimestamp(rx, timezone.utc).strftime("%Y-%m-%d")
        path = self.root / f"{day}.jsonl"
        try:
            if path.exists() and path.stat().st_size > MAX_DAY_BYTES:
                if self._full_day != day:
                    self._full_day = day
                    log.warning("diagnostics: %s is over %d MB, the rest of the day only kept in memory",
                                path.name, MAX_DAY_BYTES >> 20)
                return
            with path.open("a") as f:
                f.writelines(json.dumps(ev, separators=(",", ":"), default=str) + "\n" for ev in kept)
            if day != self._pruned_day:
                self._pruned_day = day
                for old in _days(self.root, date.fromisoformat(day))[1]:
                    old.unlink(missing_ok=True)
        except OSError as e:
            log.warning("diagnostics not saved: %s", e)

    def query(self, client: str | None, types: set[str] | None, since: float | None, limit: int) -> list[dict]:
        with self._lock:
            out = [ev for ev in self.events
                   if (client is None or ev.get("client") == client)
                   and (types is None or ev.get("type") in types)
                   and (since is None or (ev.get("t") or ev.get("rx") or 0) >= since)]
        return out[-limit:]


def make_router(store: DiagStore) -> APIRouter:
    r = APIRouter(prefix="/api/diag")

    @r.post("")
    def post(body: DiagBody):
        return {"ok": True, "stored": store.add(body)}

    @r.get("")
    def get(client: str | None = None, type: str | None = None, since: float | None = None,
            limit: Annotated[int, Query(ge=1, le=5000)] = 500):
        types = set(type.split(",")) if type else None
        return {"clients": store.clients, "events": store.query(client, types, since, limit)}

    return r


def make_store(cfg: Config) -> DiagStore:
    return DiagStore(cfg.data_dir / "diag")
