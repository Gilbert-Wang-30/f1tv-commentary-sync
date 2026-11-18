import asyncio
import json
import os
import re
import shutil
import time
from dataclasses import dataclass, field, replace
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from fone import backfill as bf
from fone import backfill_bili as bb
from fone import backfill_dedup, config, recordings
from fone.backfill import BackfillService, Settings, make_router, parse_rooms, subtract
from fone.backfill_dedup import JoinFinder, Timeline, load_part
from fone.backfill_writer import import_name
from fone.extractor import Extractor, Piece, Segment
from fone.store import Store
from test_backfill_synth import PKT, ff, write_frames

FIX = Path(__file__).parent / "fixtures" / "backfill"
ROOM, UID, CHANNEL = 23954427, 1313650809, "胡闹P房"
KL_LIVE = 1791010991.0
KL_TITLE = "【胡闹P房】16点 巴林 排位赛"


# ---- fakes ----------------------------------------------------------------------------------------


@dataclass
class Rec:
    channel: str
    name_time: float | None
    mtime: float
    relpath: str = "x.flv"


@dataclass
class FileState:
    rec: Rec
    status: str = "done"
    out_dir: Path = Path("/nowhere")
    pieces: list = field(default_factory=list)
    segs: list = field(default_factory=list)
    provisional: bool = False


class FakeExtractor:
    def __init__(self):
        self.files: dict[str, FileState] = {}
        self.ensured = []

    def add(self, fid, pieces, status="done", channel=CHANNEL, seg=2.0, out_dir=Path("/nowhere"), provisional=False):
        end = max(p.media + p.duration for p in pieces)
        segs = [Segment(f"seg_{i:05d}.ts", i * seg, seg) for i in range(int(end / seg))]
        lo = min(p.wall for p in pieces)
        hi = max(p.wall + p.duration for p in pieces)
        self.files[fid] = FileState(Rec(channel, lo, hi), status, out_dir, pieces, segs, provisional)
        return self.files[fid]

    def pieces(self, st):
        return st.pieces, st.segs, st.provisional

    def ensure(self, st):
        self.ensured.append(st)


class FakeBili(bb.BiliClient):
    def __init__(self, archives=None, pages=None):
        super().__init__(httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(599))))
        self.archives = archives if archives is not None else \
            json.loads((FIX / "series_archives.json").read_text())["data"]["archives"]
        self.page_list = pages or json.loads((FIX / "pagelist.json").read_text())["data"]
        self.statuses: list = []
        self.raise_next: Exception | None = None
        self.log: list[str] = []

    async def api(self, url, params=None, referer=""):
        raise AssertionError(f"unexpected API call {url}")

    def _hit(self, what):
        self.log.append(what)
        if self.raise_next:
            e, self.raise_next = self.raise_next, None
            raise e

    async def room_info(self, room):
        self._hit("room")
        return self.statuses.pop(0)

    async def series_id(self, mid):
        self._hit("series_id")
        return 4169347

    async def series_archives(self, mid, sid, since, max_pages=3):
        self._hit("archives")
        return self.archives

    async def pagelist(self, bvid):
        self._hit("pagelist")
        return self.page_list

    async def playurl(self, bvid, cid):
        self._hit("playurl")
        return {"audio": [{"id": 30280, "baseUrl": f"https://cdn/{cid}-30280.m4s"}],
                "video": [{"id": 80, "codecid": 7, "height": 1080, "bandwidth": 1, "baseUrl": f"https://cdn/{cid}-30080.m4s"}]}


class FakeDownloader:
    """Hands out local files instead of CDN downloads (but asks for the URLs like the real one)."""

    def __init__(self, files: dict[str, Path]):
        self.files, self.asked = files, []

    async def fetch(self, urls_fn, dest, progress=None):
        self.asked += await urls_fn()
        shutil.copyfile(self.files[dest.name], dest)
        if progress:
            progress(dest.stat().st_size, dest.stat().st_size)
        return dest.stat().st_size

    async def close(self):
        pass


def make_service(tmp_path, extractor=None, bili=None, downloader=None, **settings):
    cfg = replace(config.load(), data_dir=tmp_path / "data", rec_dir=tmp_path / "rec")
    store = Store(cfg.data_dir / "fone.sqlite3")
    s = Settings(rooms={ROOM: CHANNEL}, import_dir=tmp_path / "import", danmakus=False, **settings)
    return BackfillService(cfg, extractor or FakeExtractor(), store, s, bili=bili or FakeBili(),
                           downloader=downloader or FakeDownloader({}),
                           http=httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(599))))


def status(live, live_time=KL_LIVE, title=KL_TITLE):
    return bb.RoomStatus(ROOM, UID, 1 if live else 0, live_time if live else None, title)


# ---- settings & helpers ---------------------------------------------------------------------------


def test_settings_from_env():
    s = Settings.from_env({"FONE_ROOMS": "23954427=胡闹P房, 5=x ,bad", "FONE_IMPORT_DIR": "/rec/fone-import",
                           "FONE_BACKFILL_VIDEO": "720p"})
    assert s.rooms == {23954427: "胡闹P房", 5: "x"} and s.import_dir == Path("/rec/fone-import")
    assert s.video_height == 720 and s.enabled and s.danmakus
    assert Settings.from_env({"FONE_BACKFILL_VIDEO": "none"}).video_height is None
    assert not Settings.from_env({}).enabled
    assert parse_rooms("") == {}


def test_subtract():
    assert subtract((0, 100), [(10, 20), (15, 50), (90, 200)], 5) == [[0, 10], [50, 90]]
    assert subtract((0, 100), [(-5, 3), (97, 100)], 5) == [[3, 97]]
    assert subtract((0, 100), [(0, 100)], 5) == []
    assert subtract((0, 100), [], 60) == [[0, 100]]


# ---- live log & gap detection ---------------------------------------------------------------------


def test_live_log_periods(tmp_path):
    svc = make_service(tmp_path)
    svc.record(status(True), CHANNEL, KL_LIVE + 30)
    svc.record(status(True), CHANNEL, KL_LIVE + 90)
    (p,) = svc.db.periods(ROOM)
    assert (p["start"], p["last_live"], p["stop"], p["title"], p["uid"]) == (KL_LIVE, KL_LIVE + 90, None, KL_TITLE, UID)
    # Restart: a new 开播 closes the old period and opens a new one.
    svc.record(status(True, KL_LIVE + 600, "new title"), CHANNEL, KL_LIVE + 610)
    new, old = svc.db.periods(ROOM)
    assert old["stop"] == KL_LIVE + 610 and new["start"] == KL_LIVE + 600 and new["stop"] is None
    # Rerun loop (live_status 2) is not live.
    svc.record(bb.RoomStatus(ROOM, UID, 2, None, "rerun"), CHANNEL, KL_LIVE + 9000)
    assert all(p["stop"] is not None for p in svc.db.periods(ROOM))
    assert svc.rooms[ROOM]["liveStatus"] == 2 and not svc.rooms[ROOM]["live"]
    assert len(svc.db.periods(pending=True)) == 2


def test_poll_rooms_backs_off_on_risk_control(tmp_path):
    bili = FakeBili()
    bili.raise_next = bb.RiskControl("HTTP 412")
    svc = make_service(tmp_path, bili=bili)
    asyncio.run(svc.poll_rooms())
    assert "412" in svc.rooms[ROOM]["error"] and svc.db.periods(ROOM) == []
    bili.statuses = [status(True)]
    asyncio.run(svc.poll_rooms())
    assert svc.db.periods(ROOM)[0]["start"] == KL_LIVE


def end_period(svc, start=KL_LIVE, length=3600, now=None):
    svc.record(status(True, start), CHANNEL, start + 60)
    svc.record(status(True, start), CHANNEL, start + length)
    svc.record(status(False), CHANNEL, now or start + length + 60)


def test_gap_detection_waits_for_extraction_then_schedules(tmp_path):
    ex = FakeExtractor()
    svc = make_service(tmp_path, extractor=ex)
    end_period(svc)
    S = KL_LIVE
    # Recorder joined 8 s late (ignored, < 60 s) and lost 250 s mid-stream.
    f = ex.add("a", [Piece(S + 8, 0, 992), Piece(S + 1250, 992, 2350)], status="running")
    ex.add("other", [Piece(S, 0, 3600)], channel="someone else")
    assert svc.check_periods(now=S + 3700) == []  # still extracting
    f.status = "done"
    (job,) = svc.check_periods(now=S + 3720)
    assert job.data["gaps"] == [[S + 1000, S + 1250]] and job.data["window"] == [S + 1000, S + 1250]
    assert job.data["liveTime"] == S and job.data["title"] == KL_TITLE and job.data["source"] == "auto"
    assert svc.check_periods(now=S + 3800) == []  # checked once


def test_gap_detection_gives_up_waiting_and_ensures_idle_files(tmp_path):
    ex = FakeExtractor()
    svc = make_service(tmp_path, extractor=ex)
    end_period(svc)
    idle = ex.add("old", [Piece(KL_LIVE, 0, 600)], status="idle")
    assert svc.check_periods(now=KL_LIVE + 3700) == [] and ex.ensured == [idle]
    (job,) = svc.check_periods(now=KL_LIVE + 3660 + svc.settings.settle + 1)
    assert job.data["gaps"] == [[KL_LIVE + 600, KL_LIVE + 3600]]


def test_no_recordings_known_yet_schedules_nothing(tmp_path):
    """Startup races the first scan of the NAS (and an unreachable NAS scans as empty):
    no files at all must not read as "the whole stream is missing"."""
    ex = FakeExtractor()
    svc = make_service(tmp_path, extractor=ex)
    end_period(svc)
    assert svc.check_periods(now=KL_LIVE + 4000) == [] and svc.status()["jobs"] == []
    ex.add("a", [Piece(KL_LIVE + 5, 0, 1000)])  # the scan lands: now the real gap counts
    (job,) = svc.check_periods(now=KL_LIVE + 4000)
    assert job.data["gaps"] == [[KL_LIVE + 1005, KL_LIVE + 3600]]


def test_partial_imports_are_swept(tmp_path):
    svc = make_service(tmp_path)
    d = svc.settings.import_dir / CHANNEL
    d.mkdir(parents=True)
    old, fresh, done = d / "a.flv.part", d / "b.flv.part", d / "c.flv"
    for p in (old, fresh, done):
        p.write_bytes(b"x")
    os.utime(old, (time.time() - 7200, time.time() - 7200))
    os.utime(done, (time.time() - 7200, time.time() - 7200))
    svc._sweep_partial_imports()
    assert not old.exists() and fresh.exists() and done.exists()


def test_fully_recorded_stream_schedules_nothing(tmp_path):
    ex = FakeExtractor()
    svc = make_service(tmp_path, extractor=ex)
    end_period(svc)
    ex.add("a", [Piece(KL_LIVE + 5, 0, 3600)])
    assert svc.check_periods(now=KL_LIVE + 4000) == []
    assert svc.status()["jobs"] == []


# ---- which lives are filled: the recorder gate's titles -------------------------------------------

GAME = "小播一会粥"  # (a stream the gate stops recording with GATE_ACTION=stop)


def another_days_recording(ex):
    """Recordings are known (the first scan is done), none of them of this live."""
    ex.add("yesterday", [Piece(KL_LIVE - 86400, 0, 3600)])


def live(svc, titles, start=KL_LIVE, length=3600):
    """A live seen with these titles in turn, the last one until start + length, then over."""
    times = [start + 60 + k * (length - 60) / len(titles) for k in range(len(titles))] + [start + length]
    for t, title in zip(times, [*titles, titles[-1]]):
        svc.record(status(True, start, title), CHANNEL, t)
    svc.record(status(False), CHANNEL, start + length + 60)


def test_a_live_whose_title_isnt_f1_is_not_filled(tmp_path, caplog):
    ex = FakeExtractor()
    another_days_recording(ex)
    svc = make_service(tmp_path, extractor=ex)
    live(svc, [GAME, "下播前闲聊"])
    with caplog.at_level("INFO", logger="fone.backfill"):
        assert svc.check_periods(now=KL_LIVE + 4000) == []
        assert svc.check_periods(now=KL_LIVE + 4100) == []
    (p,) = svc.db.periods(ROOM)
    assert p["checked"] == KL_LIVE + 4000 and p["wanted"] == 0 and GAME in p["skipped"]
    said = [r.getMessage() for r in caplog.records if r.name == "fone.backfill"]
    assert said == [f"room {ROOM} live {KL_LIVE}: {p['skipped']}"]  # (once)
    st = svc.status()
    assert st["jobs"] == [] and st["periods"][0]["skipped"] == p["skipped"]
    assert ex.ensured == []  # (nothing waited for either)


def test_an_f1_title_is_filled(tmp_path):
    ex = FakeExtractor()
    another_days_recording(ex)
    svc = make_service(tmp_path, extractor=ex)
    live(svc, [KL_TITLE])
    (job,) = svc.check_periods(now=KL_LIVE + 4000)
    assert job.data["source"] == "auto" and job.data["gaps"] == [[KL_LIVE, KL_LIVE + 3600]]
    (p,) = svc.db.periods(ROOM)
    assert p["wanted"] == 1 and p["skipped"] is None and p["checked"] == KL_LIVE + 4000
    # the gate's default words, judged the same (recorder/test_gate.py's titles)
    for t in ("【胡闹P房】16点 巴林 排位赛", "日本大奖赛 正赛", "F1 Japanese Grand Prix - Race watchalong",
              "FP2 live", "Sprint Qualifying", "Abu Dhabi GP", "F2 feature race", "方程式 围场 发布会"):
        assert svc.settings.wanted(t) is True, t
    for t in (GAME, "GPU benchmark night", "Racing game marathon", "Just chatting"):
        assert svc.settings.wanted(t) is False, t


def test_a_title_that_turns_f1_mid_live_is_filled(tmp_path):
    """The gate starts recording again when the title turns F1: what came before it is missing,
    and it's one live (one 开播), filled once any title it had was F1."""
    ex = FakeExtractor()
    svc = make_service(tmp_path, extractor=ex)
    live(svc, [GAME, GAME, KL_TITLE, "下播前闲聊"])
    ex.add("a", [Piece(KL_LIVE + 1300, 0, 2000)])  # recorded from when the title turned F1
    (job,) = svc.check_periods(now=KL_LIVE + 4000)
    assert job.data["gaps"] == [[KL_LIVE, KL_LIVE + 1300], [KL_LIVE + 3300, KL_LIVE + 3600]]
    assert svc.db.periods(ROOM)[0]["wanted"] == 1


def test_a_live_with_no_title_seen_is_filled(tmp_path):
    ex = FakeExtractor()
    another_days_recording(ex)
    svc = make_service(tmp_path, extractor=ex)
    live(svc, ["", " "])
    (job,) = svc.check_periods(now=KL_LIVE + 4000)
    assert svc.db.periods(ROOM)[0]["wanted"] is None and job.data["source"] == "auto"


def test_the_gates_skip_and_record_settings(tmp_path):
    ex = FakeExtractor()
    another_days_recording(ex)
    s = Settings.from_env({"FONE_BACKFILL_RECORD": "胡闹P房|F1", "FONE_BACKFILL_SKIP": "F1 25|游戏"})
    svc = make_service(tmp_path, extractor=ex, record=s.record, skip=s.skip)
    live(svc, ["F1 25 career mode"])
    assert svc.check_periods(now=KL_LIVE + 4000) == []
    assert "F1 25 career mode" in svc.db.periods(ROOM)[0]["skipped"]
    live(svc, ["【胡闹P房】周末闲聊"], start=KL_LIVE + 86400)  # the streamer's tag alone
    (job,) = svc.check_periods(now=KL_LIVE + 86400 + 4000)
    assert job.data["liveTime"] == KL_LIVE + 86400
    assert s.wanted("Abu Dhabi GP") is False  # (not in this filter: GATE_RECORD replaces the words)


def test_an_empty_filter_is_the_gates_default_words():
    # (docker-compose.yml passes GATE_RECORD / GATE_SKIP on even when .env leaves them empty)
    for env in ({}, {"FONE_BACKFILL_RECORD": "", "FONE_BACKFILL_SKIP": ""}):
        s = Settings.from_env(env)
        assert s.record.pattern == bf.F1_TITLES and s.record.flags & re.I and s.skip is None
        assert s.wanted("【胡闹P房】16点 巴林 排位赛") and s.wanted(GAME) is False and s.wanted("") is None
    with pytest.raises(ValueError, match="FONE_BACKFILL_SKIP='F1 \\(' isn't a regex"):
        Settings.from_env({"FONE_BACKFILL_SKIP": "F1 ("})


def test_a_live_left_alone_then_live_again_is_judged_again(tmp_path):
    """A poll that missed the room ends the period, and it's left alone at once (no recording to
    wait for); the same 开播 live again, now with an F1 title, is judged again when it ends."""
    ex = FakeExtractor()
    another_days_recording(ex)
    svc = make_service(tmp_path, extractor=ex)
    svc.record(status(True, title=GAME), CHANNEL, KL_LIVE + 60)
    svc.record(status(False), CHANNEL, KL_LIVE + 120)
    assert svc.check_periods(now=KL_LIVE + 130) == [] and svc.db.periods(ROOM)[0]["skipped"]
    svc.record(status(True), CHANNEL, KL_LIVE + 180)  # KL_TITLE
    p = svc.db.periods(ROOM)[0]
    assert (p["checked"], p["skipped"], p["stop"], p["wanted"]) == (None, None, None, 1)
    svc.record(status(True), CHANNEL, KL_LIVE + 3640)
    svc.record(status(False), CHANNEL, KL_LIVE + 3700)
    (job,) = svc.check_periods(now=KL_LIVE + 3800)
    assert job.data["window"] == [KL_LIVE, KL_LIVE + 3640]


def test_a_live_asked_for_by_hand_is_imported_whatever_its_title(api):
    client, svc = api
    another_days_recording(svc.extractor)
    live(svc, [GAME])
    assert svc.check_periods(now=KL_LIVE + 4000) == []
    r = client.post("/api/backfill/import", json={"from": KL_LIVE, "to": KL_LIVE + 3600, "channel": CHANNEL})
    assert r.status_code == 200 and r.json()["job"]["source"] == "manual" and r.json()["job"]["state"] == "waiting"
    r = client.post("/api/backfill/import", json={"bvid": "BV1ePHq6DE8B"})
    assert r.status_code == 200 and r.json()["job"]["bvid"] == "BV1ePHq6DE8B"
    assert [j["source"] for j in client.get("/api/backfill/status").json()["jobs"]] == ["manual", "manual"]


OLD_PERIODS = """CREATE TABLE bf_period (
    room INTEGER NOT NULL, start REAL NOT NULL, last_live REAL NOT NULL, stop REAL, title TEXT NOT NULL,
    uid INTEGER NOT NULL, channel TEXT NOT NULL, checked REAL, PRIMARY KEY (room, start))"""  # (before 1.0.1)


def test_a_database_from_before_titles_were_judged(tmp_path):
    """Its periods get the new columns, empty: an ended one still to check is judged by the one
    title it has (its first), and one with none is filled."""
    import sqlite3

    db = tmp_path / "data" / "fone.sqlite3"
    db.parent.mkdir()
    with sqlite3.connect(db) as c:
        c.execute(OLD_PERIODS)
        c.executemany("INSERT INTO bf_period VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
            (ROOM, KL_LIVE - 86400, KL_LIVE - 82800, KL_LIVE - 82740, KL_TITLE, UID, CHANNEL, KL_LIVE - 82000),
            (ROOM, KL_LIVE, KL_LIVE + 3600, KL_LIVE + 3660, KL_TITLE, UID, CHANNEL, None),
            (ROOM, KL_LIVE + 7200, KL_LIVE + 9000, KL_LIVE + 9060, GAME, UID, CHANNEL, None),
            (ROOM, KL_LIVE + 9600, KL_LIVE + 10000, KL_LIVE + 10060, "", UID, CHANNEL, None)])
    c.close()
    ex = FakeExtractor()
    another_days_recording(ex)
    svc = make_service(tmp_path, extractor=ex)
    assert [(p["wanted"], p["skipped"]) for p in svc.db.periods(ROOM)] == [(None, None)] * 4
    jobs = svc.check_periods(now=KL_LIVE + 20000)
    assert sorted(j.data["liveTime"] for j in jobs) == [KL_LIVE, KL_LIVE + 9600]
    game = svc.db.periods(ROOM, since=KL_LIVE + 7200)[1]
    assert game["start"] == KL_LIVE + 7200 and GAME in game["skipped"]
    assert svc.db.periods(ROOM)[-1]["checked"] == KL_LIVE - 82000  # (an old check stays)
    # and a live seen now writes its judgement
    svc.record(status(True, KL_LIVE + 30000), CHANNEL, KL_LIVE + 30060)
    assert svc.db.periods(ROOM)[0]["wanted"] == 1
    make_service(tmp_path, extractor=ex)  # (and a second start finds the columns there)


def old_database(tmp_path, *periods):
    import sqlite3

    db = tmp_path / "data" / "fone.sqlite3"
    db.parent.mkdir()
    with sqlite3.connect(db) as c:
        c.execute(OLD_PERIODS)
        c.executemany("INSERT INTO bf_period VALUES (?, ?, ?, ?, ?, ?, ?, ?)", periods)
    c.close()


def test_a_live_on_through_the_upgrade_keeps_its_first_titles_judgement(tmp_path):
    """Logged by a server from before 1.0.1 with an F1 title, then a game title after the upgrade:
    still one to fill (and one that was a game stream stays left alone with no title seen)."""
    old_database(tmp_path, (ROOM, KL_LIVE, KL_LIVE + 600, None, KL_TITLE, UID, CHANNEL, None),
                 (ROOM + 1, KL_LIVE, KL_LIVE + 600, None, GAME, UID, CHANNEL, None))
    ex = FakeExtractor()
    another_days_recording(ex)
    svc = make_service(tmp_path, extractor=ex)
    svc.record(status(True, title=GAME), CHANNEL, KL_LIVE + 660)
    svc.record(replace(status(True, title=""), room=ROOM + 1), CHANNEL, KL_LIVE + 660)
    assert svc.db.period(ROOM, KL_LIVE)["wanted"] == 1 and svc.db.period(ROOM + 1, KL_LIVE)["wanted"] == 0
    svc.record(status(False), CHANNEL, KL_LIVE + 3600)
    (job,) = svc.check_periods(now=KL_LIVE + 4000)
    assert job.data["liveTime"] == KL_LIVE


def test_an_auto_job_from_before_for_a_game_stream_expires(tmp_path):
    """Made by a server from before 1.0.1, which filled every live: one whose live isn't to fill
    stops waiting for its replay without asking Bilibili; one that is goes on."""
    old_database(tmp_path, (ROOM, KL_LIVE, KL_LIVE + 3600, KL_LIVE + 3660, GAME, UID, CHANNEL, KL_LIVE + 4000),
                 (ROOM, KL_LIVE + 7200, KL_LIVE + 9000, KL_LIVE + 9060, KL_TITLE, UID, CHANNEL, KL_LIVE + 9500))
    bili = FakeBili()
    svc = make_service(tmp_path, bili=bili)
    game = svc.submit(CHANNEL, (KL_LIVE, KL_LIVE + 3600), gaps=[[KL_LIVE, KL_LIVE + 3600]], room=ROOM, uid=UID,
                      live_time=KL_LIVE, title=GAME, source="auto", period=(KL_LIVE, KL_LIVE + 3600))
    asyncio.run(svc.step(game))
    game = svc.db.job(game.id)
    assert game.state == "expired" and game.error.startswith("not a live to fill") and GAME in game.error
    assert bili.log == []
    f1 = svc.submit(CHANNEL, (KL_LIVE + 7200, KL_LIVE + 9000), room=ROOM, uid=UID, live_time=KL_LIVE + 7200,
                    title=KL_TITLE, source="auto", period=(KL_LIVE + 7200, KL_LIVE + 9000))
    asyncio.run(svc.step(f1))
    assert svc.db.job(f1.id).state != "expired" and "archives" in bili.log


# ---- jobs -----------------------------------------------------------------------------------------


def test_job_finds_the_replay_pinned_by_live_time(tmp_path):
    bili = FakeBili()
    svc = make_service(tmp_path, bili=bili)
    gap = [KL_LIVE + 1000, KL_LIVE + 1250]
    job = svc.submit(CHANNEL, tuple(gap), gaps=[gap], room=ROOM, uid=UID, live_time=KL_LIVE, title=KL_TITLE,
                     source="auto")
    asyncio.run(svc.step(job))
    job = svc.db.job(job.id)
    assert job.state == "downloading" and job.error is None
    assert job.data["bvid"] == "BV1ePHq6DE8B" and job.data["startExact"] and job.data["liveTime"] == KL_LIVE
    # The series listing is cached: a second job doesn't list again.
    job2 = svc.submit(CHANNEL, tuple(gap), gaps=[gap], room=ROOM, uid=UID, live_time=KL_LIVE, source="auto")
    asyncio.run(svc.step(job2))
    assert bili.log.count("archives") == 1 and bili.log.count("series_id") == 1


def test_job_waits_for_the_replay_then_expires(tmp_path):
    svc = make_service(tmp_path, give_up_after=3600)
    t = time.time()
    job = svc.submit(CHANNEL, (t - 600, t - 300), gaps=[[t - 600, t - 300]], room=ROOM, uid=UID, live_time=t - 900)
    asyncio.run(svc.step(job))
    job = svc.db.job(job.id)
    assert job.state == "waiting" and job.next_try > t + 500
    old = svc.submit(CHANNEL, (t - 9000, t - 8000), room=ROOM, uid=UID, live_time=t - 9500)
    asyncio.run(svc.step(old))
    assert svc.db.job(old.id).state == "expired"


def test_manual_window_takes_the_one_possible_replay(tmp_path):
    """No live log for this stream: the window at the very end of the 15点 slot's stream can only
    'maybe' overlap (its exact start is unknown), but nothing else could be meant."""
    bili = FakeBili()
    bili.statuses = [status(False)]  # the uploader's uid comes from the room
    svc = make_service(tmp_path, bili=bili)
    end = KL_LIVE + 10379
    job = svc.submit(CHANNEL, (end - 200, end - 100))
    asyncio.run(svc.step(job))
    job = svc.db.job(job.id)
    assert job.state == "downloading" and job.data["bvid"] == "BV1ePHq6DE8B" and not job.data["startExact"]
    assert job.data["uid"] == UID and bili.log[0] == "room"


def test_job_errors_back_off_and_eventually_fail(tmp_path):
    bili = FakeBili()
    svc = make_service(tmp_path, bili=bili)
    job = svc.submit(CHANNEL, (KL_LIVE, KL_LIVE + 100), room=ROOM, uid=UID)
    bili.raise_next = bb.RiskControl("code -352")
    asyncio.run(svc.step(job))
    j = svc.db.job(job.id)
    assert j.state == "waiting" and j.attempts == 0 and j.next_try > time.time() + 800 and "352" in j.error
    for n in range(1, 6):
        bili.raise_next = bb.BiliError("boom")
        svc._series.clear()
        asyncio.run(svc.step(j))
        j = svc.db.job(job.id)
        assert j.attempts == n
    assert j.state == "failed" and "boom" in j.error


def test_end_to_end_job_from_a_synthetic_replay(tmp_path, synth, monkeypatch):
    """Gap -> series match -> download -> dedup -> place by live_time -> FLV in the import dir."""
    monkeypatch.setattr(backfill_dedup, "FRAGMENT_S", (25, 50))  # synthetic fragments are ~30 s
    arcs = [{"title": f"【直播回放】{KL_TITLE} 2026年10月03日15点场", "bvid": "BV1synthetic", "duration": 110,
             "pubdate": int(KL_LIVE + 3600)}]
    pages = [{"cid": 11, "page": 1, "part": f"0-{KL_TITLE}", "duration": 65},
             {"cid": 12, "page": 2, "part": f"1-{KL_TITLE}", "duration": 45}]
    files = {"p1_audio.m4s": synth.audio[0], "p2_audio.m4s": synth.audio[1],
             "p1_video.m4s": synth.video[0], "p2_video.m4s": synth.video[1]}
    dl = FakeDownloader(files)
    ex = FakeExtractor()
    svc = make_service(tmp_path, extractor=ex, bili=FakeBili(arcs, pages), downloader=dl)
    end_period(svc, length=110, now=KL_LIVE + 170)
    ex.add("rec", [Piece(KL_LIVE + 3, 0, 37)])  # the recorder lost everything after 40 s
    (job,) = svc.check_periods(now=KL_LIVE + 4000)
    for _ in range(3):
        asyncio.run(svc.step(svc.db.job(job.id)))
    job = svc.db.job(job.id)
    assert job.state == "done", job.error
    res = job.data["result"]
    out = Path(res["path"])
    assert out.parent == tmp_path / "import" / CHANNEL and out.exists() and res["video"] == "copy"
    assert out.name.startswith("20261003-150312-") and out.name.endswith(f"-{KL_TITLE}.flv")
    # live_time pins the start: capture = live_time - 0.395, recorder frame = + ARRIVAL_LATENCY.
    assert job.data["placement"]["method"] == "live_time"
    assert abs(res["start"] - (KL_LIVE - 0.395 + 2.09)) < 0.002
    assert [j["kind"] for j in job.data["joins"]] == ["fragment-join", "part-boundary"]
    assert job.data["selected"] == [1, 2]
    assert sorted(dl.asked) == sorted(["https://cdn/11-30280.m4s", "https://cdn/12-30280.m4s",
                                       "https://cdn/11-30080.m4s", "https://cdn/12-30080.m4s"])
    assert not (svc.work_root / "BV1synthetic").exists()  # work files cleaned up
    st = svc.status()
    assert st["jobs"][0]["state"] == "done" and st["jobs"][0]["result"]["path"] == str(out)


def test_recording_windows_stay_inside_pieces(tmp_path):
    ex = FakeExtractor()
    svc = make_service(tmp_path, extractor=ex)
    W = KL_LIVE
    ex.add("a", [Piece(W, 0, 300), Piece(W + 400, 300, 300)], out_dir=tmp_path / "hls" / "a")
    ex.add("p", [Piece(W, 0, 600)], provisional=True)
    wins = svc._recording_windows(CHANNEL, W - 100, W + 2000)
    assert len(wins) == 8
    for paths, wall0 in wins:
        n = [int(p.stem.split("_")[1]) for p in paths]
        assert n == list(range(n[0], n[0] + len(n))) and len(n) >= 15
        assert all(p.parent == tmp_path / "hls" / "a" for p in paths)
        media0 = n[0] * 2.0
        piece = Piece(W, 0, 300) if media0 < 300 else Piece(W + 400, 300, 300)
        assert abs(wall0 - (piece.wall + media0 - piece.media)) < 1e-9
        assert piece.media <= media0 and media0 + len(n) * 2.0 <= piece.media + piece.duration
    assert svc._recording_windows(CHANNEL, W + 5000, W + 6000) == []


def test_alignment_through_a_real_extracted_recording(tmp_path, synth, monkeypatch):
    """The production path: fone's extractor turns a recording into HLS + a wall map; windows are
    cut from those segments and aligned against the replay's pages. The recorder caught the
    stream from its 30th second (packets copied, as 录播姬 does)."""
    monkeypatch.setattr(bf, "WINDOW_S", 10.0)  # the synthetic fragments are only ~30 s long
    W = KL_LIVE  # truth: recorder-frame wall time of the replay's content 0
    first = synth.cuts[0][0]
    c0, dur = first * PKT, (synth.stream.n - first) * PKT
    (tmp_path / "rec" / CHANNEL).mkdir(parents=True)
    write_frames(synth.stream, list(range(first, synth.stream.n)), tmp_path / "rec.aac")
    flv = tmp_path / "rec" / CHANNEL / import_name(W + c0, "rec", ZoneInfo("Asia/Shanghai"))
    ff("-f", "aac", "-i", str(tmp_path / "rec.aac"), "-c", "copy", "-f", "flv", str(flv))
    os.utime(flv, (W + c0 + dur, W + c0 + dur))
    cfg = replace(config.load(), rec_dir=tmp_path / "rec", data_dir=tmp_path / "data")

    async def extract():
        ex = Extractor(cfg)
        ex.update(recordings.scan(cfg.rec_dir, cfg.filename_tz))
        (st,) = ex.files.values()
        ex.ensure(st)
        while st.status not in ("done", "error"):
            await asyncio.sleep(0.05)
        return ex

    ex = asyncio.run(extract())
    svc = BackfillService(cfg, ex, Store(cfg.data_dir / "fone.sqlite3"),
                          Settings(rooms={ROOM: CHANNEL}, import_dir=tmp_path / "import"), bili=FakeBili())
    windows = svc._recording_windows(CHANNEL, W - 60, W + 200)
    assert len(windows) == 8 and all(w0 >= W + c0 for _, w0 in windows)
    parts = [load_part(p, tmp_path / f"p{k}.aac") for k, p in enumerate(synth.audio)]
    jf = JoinFinder(parts, fragment_s=(25, 50))
    tl = Timeline(parts, jf.select(jf.candidates())[0])
    place, rows = bf.measure(tl, windows, tmp_path)
    assert place.measured == [1, 2], rows
    assert abs(place.offsets[1] - W) < 0.005 and abs(place.offsets[2] - W) < 0.005
    assert sum(r["ok"] for r in rows) >= 4


def test_jobs_and_periods_survive_a_restart(tmp_path):
    svc = make_service(tmp_path)
    end_period(svc)
    job = svc.submit(CHANNEL, (1.0, 2.0), bvid="BV1ePHq6DE8B")
    again = make_service(tmp_path)
    assert again.db.job(job.id).data["bvid"] == "BV1ePHq6DE8B"
    assert again.db.periods(ROOM)[0]["start"] == KL_LIVE


# ---- routes ---------------------------------------------------------------------------------------


@pytest.fixture
def api(tmp_path):
    svc = make_service(tmp_path)
    app = FastAPI()
    app.include_router(make_router(svc))
    return TestClient(app), svc


def test_status_route(api):
    client, svc = api
    svc.record(status(True), CHANNEL, KL_LIVE + 60)
    st = client.get("/api/backfill/status").json()
    assert st["enabled"] and st["rooms"][0]["channel"] == CHANNEL and st["rooms"][0]["live"]
    assert st["periods"][0]["start"] == KL_LIVE and st["jobs"] == [] and st["current"] is None


def test_import_route(api):
    client, svc = api
    r = client.post("/api/backfill/import", json={"bvid": "BV1ePHq6DE8B"})
    assert r.status_code == 200 and r.json()["job"]["state"] == "waiting"
    jid = r.json()["job"]["id"]
    assert client.post("/api/backfill/import", json={"bvid": "BV1ePHq6DE8B"}).json()["job"]["id"] == jid
    r = client.post("/api/backfill/import", json={"from": KL_LIVE, "to": KL_LIVE + 600, "channel": CHANNEL})
    assert r.status_code == 200 and r.json()["job"]["window"] == [KL_LIVE, KL_LIVE + 600]
    assert r.json()["job"]["source"] == "manual"
    assert client.post("/api/backfill/import", json={"bvid": "nope"}).status_code == 400
    assert client.post("/api/backfill/import", json={"from": 1, "to": 2, "channel": "x"}).status_code == 400
    assert client.post("/api/backfill/import", json={"from": 5, "to": 2}).status_code == 400
    assert client.post("/api/backfill/import", json={}).status_code == 400
    assert len(client.get("/api/backfill/status").json()["jobs"]) == 2


def test_import_route_when_not_configured(tmp_path):
    svc = make_service(tmp_path)
    svc.settings = replace(svc.settings, import_dir=None)
    app = FastAPI()
    app.include_router(make_router(svc))
    r = TestClient(app).post("/api/backfill/import", json={"bvid": "BV1ePHq6DE8B"})
    assert r.status_code == 409


def test_s0_reads_the_lives_danmaku_off_the_event_loop(tmp_path, monkeypatch):
    """(BV1P1as6hE9y, as test_backfill_start: S0 = live_time + 6) A multi-hour live's danmakus.com
    record is seconds of pure-Python msgpack, then the replay's XML of regexes: not on the loop
    the commentary's /hls is served from."""
    import threading

    svc = make_service(tmp_path)
    where = []
    for name in ("parse_dmks_live", "danmaku_origin"):
        real = getattr(bf, name)
        monkeypatch.setattr(bf, name, lambda *a, real=real: where.append(threading.current_thread()) or real(*a))

    async def lives(http, uid):
        return [{"id": "7a5add15", "start": 1790412961.0, "stop": 1790420000.0, "danmaku": 219}]

    async def full(http, live):
        return (FIX / "dmks_live_7a5add15.msgpack").read_bytes()

    async def dm_xml(cid):
        return (FIX / "dm_42232054404.xml").read_bytes()

    monkeypatch.setattr(bb, "dmks_lives", lives)
    monkeypatch.setattr(bb, "dmks_live_full", full)
    svc.bili.dm_xml = dm_xml
    s0, _events, live_time = asyncio.run(svc._s0(UID, 1790409600.0, 42232054404))
    assert (s0, live_time) == (1790412967.0, 1790412961.0)
    assert len(where) == 2 and threading.main_thread() not in where
