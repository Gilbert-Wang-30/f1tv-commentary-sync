"""The streamer's Bilibili replay on the event clock, by the clock on their screen (vodclock.py).

The clock models come from the real timing of the 2026 Italian GP: qualifying (OpenF1's
rebuild of its ExtrapolatedClock: Q1 from 14:00:00.031 UTC, 18 min; Q2 from 14:25:00.073, 15;
Q3 from 14:47:00.056, 13) and the race (no clock stored: its SessionStatus, started at
13:03:30.936, red-flagged at 13:07:42.762, restarted at 13:39:00.102). The header crops are
MultiViewer's header off 胡闹P房's replays (fixtures/vodclock, nothing else of their screen).
"""

import asyncio
import gzip
import io
import json
import shutil
import struct
from pathlib import Path
from types import SimpleNamespace

import pytest

pytest.importorskip("numpy")

import numpy as np  # noqa: E402

from fone import screenclock_media as sm  # noqa: E402
from fone import vodclock as vc  # noqa: E402

FIXTURES = Path(__file__).parent / "fixtures" / "vodclock"
needs_ocr = pytest.mark.skipif(not sm.tesseract_available() or not shutil.which("ffmpeg"), reason="needs tesseract + ffmpeg")

Q1, Q2, Q3 = 1788616800.031, 1788618300.073, 1788619620.056  # the parts' green lights (UTC)
RACE_T0, RACE_START, RED, RESTART = 1788696000.0, 1788699810.936, 1788700062.762, 1788701940.102


def quali_clock() -> vc.Clock:
    t0 = 1788615900.0
    ec = [(0.0, "13:45:00.000", "00:18:00", False), (900.031, "14:00:00.031", "00:18:00", True),
          (1980.071, "14:18:00.071", "00:00:00", False), (2340.073, "14:24:00.073", "00:15:00", False),
          (2400.073, "14:25:00.073", "00:15:00", True), (3300.087, "14:40:00.087", "00:00:00", False),
          (3660.056, "14:46:00.056", "00:13:00", False), (3720.056, "14:47:00.056", "00:13:00", True),
          (4500.071, "15:00:00.071", "00:00:00", False)]
    streams = {"ExtrapolatedClock": [(off, {"Utc": f"2026-09-05T{u}Z", "Remaining": r, "Extrapolating": x})
                                     for off, u, r, x in ec]}
    return vc.Clock.from_streams("Qualifying", t0, streams)


def race_clock() -> vc.Clock:
    st = [(0.0, "Inactive"), (3810.936, "Started"), (4062.762, "Aborted"), (5885.102, "Inactive"),
          (5940.102, "Started"), (10486.411, "Finished")]
    laps = [(0.0, {"CurrentLap": 1, "TotalLaps": 53}), (3899.731, {"CurrentLap": 2}), (3986.7, {"CurrentLap": 3}),
            (4105.841, {"CurrentLap": 4}), (6064.301, {"CurrentLap": 5})]
    return vc.Clock.from_streams("Race", RACE_T0, {"SessionStatus": [(o, {"Status": s}) for o, s in st], "LapCount": laps})


def test_qualifying_clock_by_part():
    c = quali_clock()
    assert c.kind == "quali" and [s.part for s in c.segs if s.run] == [1, 2, 3]
    # 'Qualifying 2 13:04' (Q2's 1:56 in, the middle of the second it showed)
    assert c.when(13 * 60 + 4, part=2) == [pytest.approx(Q2 + 116 - 0.5, abs=1e-6)]
    # without the part: Q1 passes 13:04 too, Q3 (13 min) never runs that high
    assert [round(t - Q1) for t in c.when(784)] == [296, 1616]
    assert c.when(18 * 60, part=1) == [pytest.approx(Q1 - 0.5)]  # (the first second, as it starts)
    assert c.when(900, part=2) == [pytest.approx(Q2 - 0.5)]
    assert c.when(5, part=3) == [pytest.approx(Q3 + 775 - 0.5)]
    assert c.running()[0] == (Q1, pytest.approx(Q1 + 1080, abs=0.1))


def test_race_clock_from_its_status_red_flag_and_restart():
    c = race_clock()
    assert c.kind == "race" and c.total_laps == 53
    # '1:58:31 Lap: 2/53' (the 2026 Italian GP replay, 4520 s in): 88-89 s after the start
    assert c.when(7111) == [pytest.approx(RACE_START + 88.5)]
    # stopped by the red flag at 1:55:48 (shown all through it): only as it ran down to it, and
    # as it ran on from it after the restart, not while it stood
    left = 7200 - (RED - RACE_START)
    assert c.when(6948) == [pytest.approx(RED - 0.326, abs=0.01), pytest.approx(RESTART - 0.326, abs=0.01)]
    assert c.when(6900) == [pytest.approx(RESTART + left - 6900 - 0.5, abs=0.01)]
    assert c.lap_at(RACE_START + 88.5) == 1 and c.lap_at(RACE_START + 89.2) == 2


def test_race_reading_needs_its_lap_and_total():
    c = race_clock()
    rd = vc.Reading(1, 4520.0, "Race", 7111, (2, 53), "")
    assert vc.candidates(c, rd) == [pytest.approx(RACE_START + 88.5)]  # (lap 2 from 1 s on: near enough)
    assert vc.candidates(c, vc.Reading(1, 0, "Race", 7111, (2, 57), "")) == []  # (another race)
    assert vc.candidates(c, vc.Reading(1, 0, "Race", 7111, (9, 53), "")) == []  # (OCR's lap: not then)
    assert vc.candidates(c, vc.Reading(1, 0, "Qualifying 2", 7111, None, "")) == []  # (another session)
    assert vc.candidates(c, vc.Reading(1, 0, "Race", None, None, "")) == []


def test_parse_clock_and_names():
    assert vc.parse_clock("13:04") == 784 and vc.parse_clock("1:58:31") == 7111 and vc.parse_clock("00:00") == 0
    assert vc.parse_clock("1304") == 784 and vc.parse_clock("15831") == 7111  # (colons lost)
    assert vc.parse_clock("1:12:3") is None and vc.parse_clock("13:64") is None and vc.parse_clock("") is None
    assert vc.kind_of("Qualifying 2") == ("quali", 2) and vc.kind_of("Qualifyinq 3") == ("quali", 3)
    assert vc.kind_of("Sprint Qualifying 1") == ("sprint_quali", 1) and vc.kind_of("Sprint Shootout") == ("sprint_quali", None)
    assert vc.kind_of("* Race.") == ("race", None) and vc.kind_of("Sprint") == ("sprint", None)
    assert vc.kind_of("Practice 3") == ("practice", 3) and vc.kind_of("Wind Track") == (None, None)


def W(text, x, y, w, h, line=("1", "1", "1")):
    return {"text": text, "x": x, "y": y, "w": w, "h": h, "line": line, "n": 0}


def test_header_from_words():
    # (tesseract's words off the 2026 Italian GP race replay; its 'Wind' etc. on the title's line)
    words = [W("Htalian", 75, 17, 36, 9), W("GP:", 113, 17, 20, 9), W("Race", 136, 17, 25, 9),
             W("Wind", 413, 20, 26, 9), W("1:58:31", 75, 37, 60, 13, ("2", "1", "1")),
             W("Lap:", 139, 37, 33, 16, ("2", "1", "1")), W("2/53", 176, 37, 37, 14, ("2", "1", "1")),
             W("Track", 301, 38, 44, 11, ("2", "1", "1"))]
    hd = vc.find_header(words, (1080, 1920))
    assert hd is not None
    assert hd.session == "Race"  # (the title alone, not 'Wind')
    assert hd.clock[0] <= 75 and hd.clock[2] == 137  # (on to the next word: a last digit tesseract left out)
    assert hd.lap is not None and hd.lap[0] <= 176 <= hd.lap[2] and hd.session == "Race"
    assert vc.find_header([W("Wind", 1, 1, 9, 9)], (1080, 1920)) is None


def frame_of(name: str, size: tuple[int, int]) -> np.ndarray:
    img = np.zeros(size, np.uint8)
    hdr = sm._read_pgm(io.BytesIO(gzip.decompress((FIXTURES / f"{name}.pgm.gz").read_bytes())))
    img[:hdr.shape[0], :hdr.shape[1]] = hdr
    return img


@needs_ocr
@pytest.mark.parametrize("name,size,session,shown,lap", [
    ("quali2_1304", (1080, 1920), "Qualifying 2", 784, None),
    ("race_15831_lap2", (1080, 1920), "Race", 7111, (2, 53)),
    ("race2025_13623_lap10", (1080, 1920), "Race", 5783, (10, 52)),
    ("fp3_5539_1440p", (1440, 2560), "Practice 3", 3339, None),
])
def test_ocr_of_the_header(name, size, session, shown, lap):
    got = vc.read_frame(frame_of(name, size))
    assert got is not None, name
    assert vc.kind_of(got[0]) == vc.kind_of(session) and got[1] == shown and got[2] == lap, got


def test_content_and_back():
    pages = [{"page": 1, "duration": 7221}, {"page": 2, "duration": 7224}]
    assert vc.content_of(pages, 1, 100) == 100 and vc.content_of(pages, 1, 2000) == pytest.approx(2000 - 4.18)
    assert vc.content_of(pages, 2, 0) == pytest.approx(7221 - 4 * 4.18)  # (page 1's 4 fragments: 3 repeats, page 2's own)
    for page, at in ((1, 50.0), (1, 4000.0), (2, 10.0), (2, 3274.1)):
        assert vc.page_at(pages, vc.content_of(pages, page, at)) == (page, pytest.approx(at, abs=0.11))
    assert vc.page_at(pages, 1e6) is None


def test_frames_agree_only_near_each_other():
    pages = [{"page": 1, "duration": 9068}]
    start = 1788614224.0  # (content 0 on the event clock)

    def rd(at, off=0.0, ts=None):
        c = vc.content_of(pages, 1, at)
        return vc.Reading(1, at, "Qualifying 2", 0, None, f"{at}"), ts if ts is not None else [start + c + off]

    # Q2 and Q3 a few minutes apart agree; Q1's drifting (the streamer's delay moving) doesn't
    found = [rd(4478.4), rd(5742.5, 0.6), rd(6162.5, -0.4), rd(3180.6, -12), rd(3638.4, -35), rd(2000, 0, ts=[])]
    ok = vc.confirmed(found, pages, 1788613200)
    assert [r.at for r, _t in ok] == [4478.4, 5742.5, 6162.5]
    # two frames 7 s apart in Q1 agree with each other (its own local start)
    found += [rd(3187.6, -12.3)]
    assert [r.at for r, _t in vc.confirmed(found, pages, 1788613200)] == [3180.6, 3187.6, 4478.4, 5742.5, 6162.5]
    # far apart: never compared (each may be right, the delay having moved between)
    assert vc.confirmed([rd(500), rd(500 + vc.NEAR + 60)], pages, None) == []
    # outside the slot's hour: not this live
    assert vc.confirmed([rd(4478.4), rd(4898.4)], pages, 1788613200 + 7200) == []


def test_plan_reads_where_the_clock_runs_first():
    c = quali_clock()
    pages = [{"page": 1, "duration": 9068}]
    slot = 1788613200  # (21点场: the live began 13:00-14:00 UTC; the session runs 14:00-15:00)
    pl = vc.plan(c, pages, slot)
    assert len(pl) >= 6 and all(p == 1 for p, _a in pl)
    ats = [a for _p, a in pl]
    assert all(abs(x - y) >= vc.STEP - 1 for i, x in enumerate(ats) for y in ats[:i])
    # the first: where the clock runs for most starts the hour allows (an hour or so in)
    assert 3000 < ats[0] < 4800, ats[:4]
    assert vc.plan(c, pages, slot + 86400) == []  # (a live a day later can't hold it)


def sidx_box(refs, timescale=1000, first_offset=0):
    body = struct.pack(">IIII", 0, 1, timescale, 0) + struct.pack(">I", first_offset) + struct.pack(">HH", 0, len(refs))
    for size, dur in refs:
        body += struct.pack(">III", size, dur, 0x90000000)
    return struct.pack(">I", 8 + len(body)) + b"sidx" + body


def test_sidx():
    b = b"\x00\x00\x00\x10free" + b"\x00" * 8 + sidx_box([(1000, 5000), (2000, 5013)])
    segs = vc.sidx_segments(b, 900)
    end = 900 + len(b)
    assert segs == [(0.0, 5.0, end, 1000), (5.0, 5.013, end + 1000, 2000)]
    with pytest.raises(ValueError):
        vc.sidx_segments(b"\x00\x00\x00\x10free" + b"\x00" * 8, 0)


# ---- the service: a fake Bilibili, frames whose header says what the session's clock did --------


class FakeHttp:
    def __init__(self, video: bytes):
        self.video, self.ranges = video, []

    async def get(self, url, headers=None, timeout=None):
        a, b = (int(x) for x in headers["Range"].split("=")[1].split("-"))
        self.ranges.append((a, b))
        return SimpleNamespace(status_code=206, content=self.video[a:b + 1])

    async def aclose(self):
        pass


class FakeBili:
    def __init__(self, video: bytes, init_end: int, index: tuple[int, int]):
        self.http = FakeHttp(video)
        self.dash = {"video": [{"codecid": 7, "height": 1080, "bandwidth": 1, "baseUrl": "https://m1/v.m4s", "backupUrl": [],
                                "segment_base": {"initialization": f"0-{init_end}", "index_range": f"{index[0]}-{index[1]}"}}]}

    async def pagelist(self, bvid):
        return [{"page": 1, "cid": 7, "duration": 9068}]

    async def playurl(self, bvid, cid):
        return self.dash

    async def close(self):
        pass


def fake_video() -> tuple[bytes, int, tuple[int, int]]:
    """An 'init' of 100 bytes, a sidx, then 5-s fragments whose bytes say where they start."""
    n = 9068 // 5 + 1
    sidx = sidx_box([(16, 5000)] * n)
    init = b"I" * 100
    video = init + sidx + b"".join(struct.pack(">d", k * 5.0) + b"\x00" * 8 for k in range(n))
    return video, 99, (100, 100 + len(sidx) - 1)


def test_service_reads_agrees_then_near_E(tmp_path, monkeypatch):
    start = 1788614224.0  # the event time at the replay's content 0 (the streamer's screen)
    pages = [{"page": 1, "duration": 9068}]
    c = quali_clock()
    video, init_end, index = fake_video()

    def decode(mp4: bytes, at: float):
        assert mp4[:100] == b"I" * 100
        return np.array([[struct.unpack(">d", mp4[100:108])[0] + at]])  # (the frame: just its time)

    def words(img):
        """The header the streamer's screen showed then: the session's clock at that event time."""
        t = start + vc.content_of(pages, 1, float(img[0, 0]))
        for s in c.segs:
            if s.run and s.a <= t < s.b:
                shown, part = int(s.r - (t - s.a)), s.part
                break
        else:
            return []
        return [W("Italian", 75, 17, 36, 9), W("GP:", 113, 17, 20, 9), W("Qualifying", 136, 17, 50, 9),
                W(str(part), 190, 17, 6, 9), W(f"{shown // 60:02d}:{shown % 60:02d}", 75, 37, 46, 13, ("2", "1", "1"))]

    reads = []

    def read_with(img, hd):  # (OCR stood in for: what the words said)
        ws = words(img)
        return (f"Qualifying {ws[3]['text']}", vc.parse_clock(ws[4]["text"]), None, ws[4]["text"]) if ws else None

    def frame(mp4, at):
        img = decode(mp4, at)
        reads.append(float(img[0, 0]))
        return img

    monkeypatch.setattr(vc, "read_with", read_with)
    monkeypatch.setattr(vc.Clock, "load", classmethod(lambda cls, d, meta: c))
    timing = SimpleNamespace(store=SimpleNamespace(meta=lambda k: {"t0": 1, "name": "Qualifying"}, dir=lambda k: tmp_path),
                             _missing_reason=lambda k: "x")
    # (a moment the first frames are nowhere near: where the extension is, in Q1)
    first = [start + vc.content_of(pages, 1, a) for _p, a in vc.plan(c, pages, 1788613200)[:vc.PAR]]
    E = next(t for t in (c.when(s, part=1)[0] for s in range(1070, 0, -30)) if all(abs(t - f) > vc.NEAR_E + 60 for f in first))

    async def run():
        svc = vc.VodClockService(SimpleNamespace(data_dir=tmp_path), timing, bili=FakeBili(video, init_end, index),
                                 words_fn=words, frame_fn=frame)
        await svc.start()
        st = svc.get("BV1ATbL6dEp9", 11357, 1788613200)
        assert st["status"] == "working"
        while svc.tasks:
            await asyncio.sleep(0.01)
        st = svc.get("BV1ATbL6dEp9", 11357, 1788613200)
        assert st["status"] == "ok" and len(st["readings"]) >= 2, st
        assert len(reads) == vc.PAR  # (the first frames agreed: all read at once)
        for r in st["readings"]:  # each the event time its frame's clock showed
            assert abs(r["wall"] - (start + vc.content_of(pages, 1, r["at"]))) < 1.0, r
        # where the extension is: no reading near it yet -> three frames there, read once
        st = svc.get("BV1ATbL6dEp9", 11357, 1788613200, E)
        assert st.get("more") is True
        while svc.tasks:
            await asyncio.sleep(0.01)
        st = svc.get("BV1ATbL6dEp9", 11357, 1788613200, E)
        assert len(reads) == vc.PAR + 3 and not st.get("more")
        assert any(abs(r["wall"] - E) < 10 for r in st["readings"]), (E, st["readings"])
        svc.get("BV1ATbL6dEp9", 11357, 1788613200, E + 30)
        assert not svc.tasks  # (one near it already)
        svc.get("BV1ATbL6dEp9", 11357, 1788613200, start + 60)  # (before the session: nothing to read there)
        assert not svc.tasks
        await svc.stop()
        # kept: a new service answers at once from disk
        svc2 = vc.VodClockService(SimpleNamespace(data_dir=tmp_path), timing, bili=FakeBili(video, init_end, index))
        await svc2.start()
        st2 = svc2.get("BV1ATbL6dEp9", 11357, 1788613200)
        assert st2["status"] == "ok" and st2["readings"] == st["readings"] and not svc2.tasks
        assert json.loads((tmp_path / "vodclock" / "BV1ATbL6dEp9.11357.json").read_text())["status"] == "ok"

    asyncio.run(run())


def test_route_checks_its_arguments(tmp_path):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    svc = vc.VodClockService(SimpleNamespace(data_dir=tmp_path), None)
    svc.get = lambda bvid, key, slot, E=None: {"status": "none", "bvid": bvid, "key": key, "slot": slot, "E": E}
    app = FastAPI()
    app.include_router(vc.make_router(svc))
    cl = TestClient(app)
    assert cl.get("/api/vod/clock", params={"bvid": "BV1ATbL6dEp9", "key": 11357, "slot": 1788613200}).json()["key"] == 11357
    assert cl.get("/api/vod/clock", params={"bvid": "nope", "key": 11357}).status_code == 400
    assert cl.get("/api/vod/clock", params={"bvid": "BV1ATbL6dEp9", "key": 0}).status_code == 422
