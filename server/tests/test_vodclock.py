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
import time
from contextlib import asynccontextmanager
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
    # the line's text height from small words far along it, the title's boxes all much taller
    # than that (a flag read into each): no text-height words left to place the title by
    tall = [W("a", 900, 20, 6, 8), W("b", 960, 20, 6, 8), W("c", 1020, 20, 6, 8), W("Italian", 75, 10, 36, 30),
            W("GP:", 113, 10, 20, 30), W("Race", 136, 10, 25, 30), W("1:58:31", 75, 37, 60, 13, ("2", "1", "1"))]
    hd = vc.find_header(tall, (1080, 1920))
    assert hd is not None and hd.session == "Race" and hd.clock[0] <= 75


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
    # (bold digits tesseract finds no text in with a margin round them: a frame taller than
    # 1080 lines is read again without one. The service decodes 1080p at most, see below)
    ("fp3_5539_1440p", (1440, 2560), "Practice 3", 3339, None),
    # (cut tight to the text, 37:59 read as 17:59: a margin round it reads it right)
    ("dutch2026_sprint_3759_lap18", (1080, 1920), "Sprint", 2279, (18, 24)),
])
def test_ocr_of_the_header(name, size, session, shown, lap):
    got = vc.read_frame(frame_of(name, size))
    assert got is not None, name
    assert vc.kind_of(got[0]) == vc.kind_of(session) and got[1] == shown and got[2] == lap, got


@needs_ocr
def test_a_leading_3_is_read_with_a_margin():
    # 2026 Japanese GP race, 37:43 on screen: cut tight to it, tesseract read 27:43 at every size.
    # (the header where find_header put it on the whole frame: on this crop alone tesseract splits
    # the title, 'Jay' 'nese GP:', and no clock is under it)
    hd = vc.Header((72, 30, 122, 49), None, 3, "Race")
    assert vc.read_with(frame_of("japan2026_race_3743_lap50", (1080, 1920)), hd)[1] == 37 * 60 + 43


def test_only_a_frame_over_1080_lines_is_read_again_without_a_margin(monkeypatch):
    # Without one, the clocks a margin left unread came back with their leading digit wrong
    # (34:48 as 24:48): the service's 1080p frames keep the margin's 'unread'.
    asked: list[tuple[str, bool]] = []

    def ocr(img, box, scale, whitelist, margin=True):
        asked.append((whitelist, margin))
        return "" if margin else ("24:48" if ":" in whitelist else "19/24")

    monkeypatch.setattr(vc, "_ocr", ocr)
    hd = vc.Header((72, 30, 122, 49), (200, 30, 240, 49), 3, "Race")
    assert vc.read_with(np.zeros((1080, 1920), np.uint8), hd)[1:3] == (None, None)
    assert asked and all(m for _w, m in asked)
    asked.clear()
    assert vc.read_with(np.zeros((1440, 2560), np.uint8), hd)[1:3] == (24 * 60 + 48, (19, 24))
    assert {m for _w, m in asked} == {True, False}


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
    """A CDN: 206 and just the range asked for; one 'ignoring-range' answers 200, the whole file.
    `down`: no connection; `refuse`: that status, and nothing (an expired URL's 403)."""

    def __init__(self, video: bytes):
        self.video, self.ranges, self.sent, self.down, self.refuse = video, [], 0, False, None

    @asynccontextmanager
    async def stream(self, method, url, headers=None, timeout=None):
        a, b = (int(x) for x in headers["Range"].split("=")[1].split("-"))
        self.ranges.append((a, b))
        if self.down:
            raise ConnectionError("the CDN refuses")
        if self.refuse:
            yield SimpleNamespace(status_code=self.refuse, aiter_bytes=None)
            return
        whole = "ignoring-range" in url
        body = self.video if whole else self.video[a:b + 1]

        async def chunks():
            for i in range(0, len(body), 64):
                self.sent += len(body[i:i + 64])
                yield body[i:i + 64]

        yield SimpleNamespace(status_code=200 if whole else 206, aiter_bytes=chunks)

    async def aclose(self):
        pass


class FakeBili:
    def __init__(self, video: bytes, init_end: int, index: tuple[int, int], urls=("https://m1/v.m4s",)):
        self.http = FakeHttp(video)
        self.pagelists = self.playurls = 0
        self.dash = {"video": [{"codecid": 7, "height": 1080, "bandwidth": 1, "baseUrl": urls[0], "backupUrl": list(urls[1:]),
                                "segment_base": {"initialization": f"0-{init_end}", "index_range": f"{index[0]}-{index[1]}"}}]}

    async def pagelist(self, bvid):
        self.pagelists += 1
        if getattr(self, "risk_control", False):
            raise RuntimeError("Bilibili: -352 risk control")
        return [{"page": 1, "cid": 7, "duration": 9068}]

    async def playurl(self, bvid, cid):
        self.playurls += 1
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


START = 1788614224.0  # the event time at the replay's content 0 (the streamer's screen)
PAGES = [{"page": 1, "duration": 9068}]
SLOT = 1788613200  # (21点场: the live began 13:00-14:00 UTC)
BV, KEY = "BV1ATbL6dEp9", 11357


class Rig:
    """The service against a fake Bilibili whose frames show the header the streamer's screen
    showed then (OCR stood in for: what its words say), and a fake timing service."""

    def __init__(self, tmp_path, monkeypatch):
        self.tmp, self.c = tmp_path, quali_clock()
        self.video, self.init_end, self.index = fake_video()
        self.reads: list[float] = []  # the frames decoded (content s)
        self.unreadable: set[int] = set()  # frames (s into the replay) whose OCR fails
        self.meta: dict | None = {"t0": 1, "name": "Qualifying", "source": "openf1"}
        self.untimed: set[int] = set()  # sessions with no timing stored (yet)
        self.reason = "downloading timing from OpenF1"
        monkeypatch.setattr(vc, "read_with", self.read_with)
        monkeypatch.setattr(vc.Clock, "load", classmethod(lambda cls, d, meta: self.c))
        self.timing = SimpleNamespace(store=SimpleNamespace(meta=lambda k: None if k in self.untimed else self.meta,
                                                            dir=lambda k: tmp_path),
                                      _missing_reason=lambda k: self.reason)

    def words(self, img):
        """The header the streamer's screen showed then: the session's clock at that event time."""
        if round(float(img[0, 0])) in self.unreadable:
            raise ValueError("tesseract said something odd")
        t = START + vc.content_of(PAGES, 1, float(img[0, 0]))
        for s in quali_clock().segs:
            if s.run and s.a <= t < s.b:
                shown, part = int(s.r - (t - s.a)), s.part
                break
        else:
            return []
        return [W("Italian", 75, 17, 36, 9), W("GP:", 113, 17, 20, 9), W("Qualifying", 136, 17, 50, 9),
                W(str(part), 190, 17, 6, 9), W(f"{shown // 60:02d}:{shown % 60:02d}", 75, 37, 46, 13, ("2", "1", "1"))]

    def read_with(self, img, hd):
        ws = self.words(img)
        return (f"Qualifying {ws[3]['text']}", vc.parse_clock(ws[4]["text"]), None, ws[4]["text"]) if ws else None

    def frame(self, mp4: bytes, at: float):
        assert mp4[:100] == b"I" * 100
        img = np.array([[struct.unpack(">d", mp4[100:108])[0] + at]])  # (the frame: just its time)
        self.reads.append(float(img[0, 0]))
        return img

    def bili(self, **kw) -> FakeBili:
        return FakeBili(self.video, self.init_end, self.index, **kw)

    def service(self, bili: FakeBili | None = None) -> vc.VodClockService:
        return vc.VodClockService(SimpleNamespace(data_dir=self.tmp), self.timing, bili=bili or self.bili(),
                                  words_fn=self.words, frame_fn=self.frame)


async def settled(svc: vc.VodClockService, *args) -> dict:
    """What it knows once the job an ask started is done (not asking again)."""
    svc.get(BV, KEY, SLOT, *args)
    while (BV, KEY) in svc.tasks:
        await asyncio.sleep(0.01)
    return {x: v for x, v in svc.state[(BV, KEY)].items() if x != "seen"}


def far_E(c: vc.Clock, avoid=()) -> float:
    """A moment the first frames (and `avoid`) are nowhere near: where the extension is, in Q1
    (or a later part)."""
    first = [START + vc.content_of(PAGES, 1, a) for _p, a in vc.plan(c, PAGES, SLOT)[:vc.PAR]] + list(avoid)
    return next(ts[0] for part in (1, 2, 3) for s in range(1070, 0, -30) if (ts := c.when(s, part=part))
                and all(abs(ts[0] - f) > vc.NEAR_E + 60 for f in first))


def test_service_reads_agrees_then_near_E(tmp_path, monkeypatch):
    rig = Rig(tmp_path, monkeypatch)
    E = far_E(rig.c)

    async def run():
        svc = rig.service()
        await svc.start()
        assert svc.get(BV, KEY, SLOT)["status"] == "working"
        st = await settled(svc)
        assert st["status"] == "ok" and len(st["readings"]) >= 2, st
        assert len(rig.reads) == vc.PAR  # (the first frames agreed: all read at once)
        for r in st["readings"]:  # each the event time its frame's clock showed
            assert abs(r["wall"] - (START + vc.content_of(PAGES, 1, r["at"]))) < 1.0, r
        # where the extension is: no reading near it yet -> three frames there, read once
        assert svc.get(BV, KEY, SLOT, E).get("more") is True
        st = await settled(svc, E)
        assert len(rig.reads) == vc.PAR + 3 and not st.get("more")
        assert any(abs(r["wall"] - E) < 10 for r in st["readings"]), (E, st["readings"])
        svc.get(BV, KEY, SLOT, E + 30)
        assert not svc.tasks  # (one near it already)
        svc.get(BV, KEY, SLOT, START + 60)  # (before the session: nothing to read there)
        assert not svc.tasks
        await svc.stop()
        # kept: a new service answers at once from disk
        svc2 = rig.service()
        await svc2.start()
        st2 = svc2.get(BV, KEY, SLOT)
        assert st2["status"] == "ok" and st2["readings"] == st["readings"] and not svc2.tasks
        assert json.loads((tmp_path / "vodclock" / f"{BV}.{KEY}.json").read_text())["status"] == "ok"

    asyncio.run(run())


def test_a_frame_that_fails_fails_alone(tmp_path, monkeypatch):
    """A frame whose reading raises is that frame unread, the job goes on. One that can't be
    downloaded isn't a frame read, nor a reason for 'none'. Near E, that moment isn't asked for
    again at the extension's every ask (20 s: a pagelist, a playurl and every mirror each
    time), nor another before a backoff."""
    rig = Rig(tmp_path, monkeypatch)
    rig.unreadable = {round(a) for _p, a in vc.plan(rig.c, PAGES, SLOT)[:1]}
    E = far_E(rig.c)

    async def run():
        bili = rig.bili()
        svc = rig.service(bili)
        await svc.start()
        st = await settled(svc)
        seen = svc.state[(BV, KEY)]["seen"]
        bad = [s for s in seen if round(s["at"]) in rig.unreadable]
        assert st["status"] == "ok" and len(bad) == 1 and bad[0]["shown"] is None and len(seen) > 1, (st, seen)
        # the CDN down: nothing read near E; the video's URLs (not what failed) kept
        bili.http.down = True
        n = len(seen)
        st = await settled(svc, E)
        assert st["status"] == "ok" and len(seen) == n and svc._video_cache and st["tried"] == [E] and st["near_fails"] == 1
        assert st["near_again"] - time.time() == pytest.approx(vc.RETRY, abs=5)
        asked = (bili.pagelists, bili.playurls, len(bili.http.ranges))
        E2 = far_E(rig.c, avoid=[E] + [r["wall"] for r in st["readings"]])
        for e in (E, E + 5, E2):  # (that moment again; another, before the backoff is over)
            assert not svc.get(BV, KEY, SLOT, e).get("more") and not svc.tasks
        assert (bili.pagelists, bili.playurls, len(bili.http.ranges)) == asked
        # still down after it: the next wait twice as long
        svc.state[(BV, KEY)]["near_again"] = 0
        st = await settled(svc, E2)
        assert st["near_fails"] == 2 and st["near_again"] - time.time() == pytest.approx(2 * vc.RETRY, abs=5)
        # back: another moment read, the misses forgotten
        bili.http.down = False
        svc.state[(BV, KEY)]["near_again"] = 0
        E3 = far_E(rig.c, avoid=[E, E2] + [r["wall"] for r in st["readings"]])
        st = await settled(svc, E3)
        assert len(seen) == n + 3 and any(abs(r["wall"] - E3) < 10 for r in st["readings"])
        assert "near_fails" not in st and "near_again" not in st and st["tried"] == [E, E2, E3]
        # Bilibili's risk control refusing the pagelist: a miss as well, no job at the next ask
        bili.risk_control = True
        svc.state[(BV, KEY)]["near_again"] = 0
        E4 = far_E(rig.c, avoid=[E, E2, E3] + [r["wall"] for r in st["readings"]])
        st = await settled(svc, E4)
        assert st["status"] == "ok" and st["near_fails"] == 1 and E4 in st["tried"]
        assert not svc.get(BV, KEY, SLOT, E4 + 5).get("more") and not svc.tasks
        bili.risk_control = False
        # no video at all for the first frames: an error (asked again later), not a 'none'
        down = rig.bili()
        down.http.down = True
        svc2 = vc.VodClockService(SimpleNamespace(data_dir=tmp_path / "2"), rig.timing, bili=down,
                                  words_fn=rig.words, frame_fn=rig.frame)
        await svc2.start()
        st = await settled(svc2)
        assert st["status"] == "error" and "the CDN refuses" in st["why"] and not svc2.state[(BV, KEY)]["seen"], st

    asyncio.run(run())


def test_a_refused_url_is_asked_for_anew_a_mirror_down_is_not(tmp_path, monkeypatch):
    """Bilibili's signed URLs expire (a 403 then): those are dropped and a new playurl asked for
    next time. A mirror down or slow says nothing about them: kept."""
    rig = Rig(tmp_path, monkeypatch)

    async def run():
        bili = rig.bili()
        svc = rig.service(bili)
        await svc.start()
        assert (await settled(svc))["status"] == "ok" and bili.playurls == 1 and svc._video_cache
        page = {"page": 1, "cid": 7}
        bili.http.down = True
        with pytest.raises(RuntimeError, match="the CDN refuses"):
            await svc._fragment(BV, page, 100.0)
        assert svc._video_cache
        bili.http.down, bili.http.refuse = False, 403
        with pytest.raises(vc.Refused, match="HTTP 403"):
            await svc._fragment(BV, page, 100.0)
        assert not svc._video_cache
        bili.http.refuse = None
        mp4, _ = await svc._fragment(BV, page, 100.0)
        assert mp4[:100] == b"I" * 100 and bili.playurls == 2

    asyncio.run(run())


def test_timing_gone_is_no_other_timing(tmp_path, monkeypatch):
    """An OpenF1 rebuild pruned (timing.py: after keep_days): its 'ok' stands, no job, no rebuild
    asked for. Timing that's there again, other than before, is worked out anew."""
    rig = Rig(tmp_path, monkeypatch)
    asked = []
    rig.timing._missing_reason = lambda k: asked.append(k) or "downloading timing from OpenF1"

    async def run():
        bili = rig.bili()
        svc = rig.service(bili)
        await svc.start()
        st = await settled(svc)
        assert st["status"] == "ok" and st["timing"] == ["openf1", 1]
        reads, calls = len(rig.reads), bili.pagelists
        rig.untimed = {KEY}  # (pruned)
        assert svc.get(BV, KEY, SLOT)["status"] == "ok" and not svc.tasks
        await svc.stop()
        svc = rig.service(bili)  # (and from disk, after a restart)
        await svc.start()
        assert svc.get(BV, KEY, SLOT)["status"] == "ok" and not svc.tasks
        # asked for more near E meanwhile: nothing to read by, a miss (not every 20 s)
        E = far_E(rig.c)
        st = await settled(svc, E)
        assert st["status"] == "ok" and st["near_fails"] == 1 and not svc.get(BV, KEY, SLOT, E).get("more")
        assert (len(rig.reads), bili.pagelists, asked) == (reads, calls, [])
        # rebuilt since, the same: as it was; another: worked out again
        rig.untimed = set()
        assert svc.get(BV, KEY, SLOT)["status"] == "ok" and not svc.tasks
        rig.meta = {**rig.meta, "t0": 2}
        assert svc.get(BV, KEY, SLOT)["status"] == "working"
        assert (await settled(svc))["timing"] == ["openf1", 2]
        await svc.stop()

    asyncio.run(run())


def test_timing_not_there_yet_is_an_error_asked_again_later_not_a_lasting_none(tmp_path, monkeypatch):
    """An OpenF1 rebuild refused for now (429) outlasting the wait was a 'none' kept for good (in
    memory: NONE_TTL only applied to one read from disk) and for 6 h on disk."""
    rig = Rig(tmp_path, monkeypatch)
    rig.untimed = {KEY}
    rig.reason = "timing unavailable (OpenF1: error: HTTP 429)"
    monkeypatch.setattr(vc, "TIMING_WAIT", -1.0)

    async def run():
        bili = rig.bili()
        svc = rig.service(bili)
        await svc.start()
        st = await settled(svc)
        assert st["status"] == "error" and "429" in st["why"] and st["again"] - time.time() == pytest.approx(vc.RETRY, abs=5)
        assert svc.get(BV, KEY, SLOT)["status"] == "error" and not svc.tasks  # (not before its time)
        assert json.loads((tmp_path / "vodclock" / f"{BV}.{KEY}.json").read_text())["status"] == "error"
        svc.state[(BV, KEY)]["again"] = 0
        st = await settled(svc)
        assert st["status"] == "error" and st["again"] - time.time() == pytest.approx(2 * vc.RETRY, abs=5)  # (doubling)
        assert bili.pagelists == 0  # (nothing asked of Bilibili without the session's timing)
        rig.untimed = set()
        svc.state[(BV, KEY)]["again"] = 0
        st = await settled(svc)
        assert st["status"] == "ok" and "again" not in st and "fails" not in st
        # no timing for the session anywhere: 'none', asked again after NONE_TTL (in memory too)
        rig.untimed, rig.reason = {KEY + 1}, "no timing data for this session"
        k2 = (BV, KEY + 1)
        svc.get(BV, KEY + 1, SLOT)
        while svc.tasks:
            await asyncio.sleep(0.01)
        assert svc.get(BV, KEY + 1, SLOT)["status"] == "none" and not svc.tasks
        svc.state[k2]["at"] -= vc.NONE_TTL + 1
        assert svc.get(BV, KEY + 1, SLOT)["status"] == "working" and svc.tasks
        await svc.stop()

    asyncio.run(run())


def test_a_relays_car_positions_are_no_timing(tmp_path, monkeypatch):
    """(timing.RELAY: positions from the viewer's browser, no capture's: no clock in them)"""
    rig = Rig(tmp_path, monkeypatch)
    rig.meta = {"t0": 1, "source": "relay"}
    monkeypatch.setattr(vc, "TIMING_WAIT", -1.0)
    asked = []
    rig.timing._missing_reason = lambda k: asked.append(k) or "downloading the timing archive"

    async def run():
        svc = rig.service()
        await svc.start()
        st = await settled(svc)
        assert st["status"] == "error" and "downloading the timing archive" in st["why"] and asked == [KEY]
        rig.meta = {"t0": 1, "source": "openf1", "name": "Qualifying"}  # (its rebuild, in its place)
        svc.state[(BV, KEY)]["again"] = 0
        assert (await settled(svc))["status"] == "ok"

    asyncio.run(run())


def test_waiting_for_timing_holds_no_frame_slot(tmp_path, monkeypatch):
    """Two replays waiting (up to TIMING_WAIT, 7 min) for a session's timing held both slots:
    every other replay waited behind them, its timing there or not."""
    rig = Rig(tmp_path, monkeypatch)
    rig.untimed = {KEY + 1}

    async def run():
        svc = rig.service()
        await svc.start()
        for bv in ("BV1aaaaaaaaa", "BV1bbbbbbbbb", "BV1ccccccccc"):
            svc.get(bv, KEY + 1, SLOT)
        await asyncio.sleep(0.05)
        assert all(s["status"] == "working" and "waiting for the session's timing" in s["why"] for s in svc.state.values())
        st = await asyncio.wait_for(settled(svc), 5)  # (FakeBili's: its timing there)
        assert st["status"] == "ok"
        assert len(svc.tasks) == 3  # (the others still waiting)
        await svc.stop()

    asyncio.run(run())


def test_frames_read_are_kept_their_times_worked_out_again(tmp_path, monkeypatch):
    """The wall times of what a frame showed were kept with it and reused for good: a session's
    timing replaced (a capture by the archive), a server whose clock logic changed, gave the
    same answer again. Now only what the frames showed is kept; the times are worked out from the
    session's timing as it is, again whenever that changes; frames read another way (OCR) are
    read again."""
    rig = Rig(tmp_path, monkeypatch)
    f = tmp_path / "vodclock" / f"{BV}.{KEY}.json"

    async def run():
        svc = rig.service()
        await svc.start()
        st = await settled(svc)
        assert st["status"] == "ok" and st["timing"] == ["openf1", 1] and len(rig.reads) == vc.PAR
        walls = [r["wall"] for r in st["readings"]]
        assert all("cands" not in s for s in json.loads(f.read_text())["seen"])
        # the session's timing replaced: the same frames, their times from the new clock
        c = rig.c
        rig.c = vc.Clock(c.kind, c.number, [vc.Seg(s.a + 100, s.b + 100, s.r, s.run, s.part) for s in c.segs])
        rig.meta = {**rig.meta, "source": "archive", "t0": 101}
        assert svc.get(BV, KEY, SLOT)["status"] == "working"
        st = await settled(svc)
        assert [r["wall"] for r in st["readings"]] == [pytest.approx(w + 100) for w in walls]
        assert len(rig.reads) == vc.PAR and st["timing"] == ["archive", 101]  # (no frame read again)
        await svc.stop()
        # a file from before (times kept with each frame, no timing said): worked out afresh
        old = json.loads(f.read_text())
        for s in old["seen"]:
            s["cands"] = [1.0]
        del old["timing"]
        f.write_text(json.dumps(old))
        svc = rig.service()
        await svc.start()
        st = await settled(svc)
        assert [r["wall"] for r in st["readings"]] == [pytest.approx(w + 100) for w in walls] and len(rig.reads) == vc.PAR
        await svc.stop()
        # frames read by an OCR of another version: read again
        f.write_text(json.dumps({**json.loads(f.read_text()), "v": vc.OCR + 1}))
        svc = rig.service()
        await svc.start()
        st = await settled(svc)
        assert st["status"] == "ok" and len(rig.reads) == 2 * vc.PAR and st["v"] == vc.OCR
        await svc.stop()

    asyncio.run(run())


def test_memory_holds_the_latest_asked_for(tmp_path, monkeypatch):
    rig = Rig(tmp_path, monkeypatch)
    monkeypatch.setattr(vc, "MAX_KEPT", 2)

    async def run():
        svc = rig.service()
        await svc.start()
        bvs = ("BV1aaaaaaaaa", "BV1bbbbbbbbb", BV)
        for bv in bvs:
            svc.get(bv, KEY, SLOT)
        await asyncio.sleep(0)
        assert len(svc.state) == 3  # (none forgotten while being read)
        while svc.tasks:
            await asyncio.sleep(0.01)
        svc.get(BV, KEY, SLOT)
        assert list(svc.state) == [(bvs[1], KEY), (BV, KEY)]
        n = len(rig.reads)
        assert svc.get(bvs[0], KEY, SLOT)["status"] == "ok" and not svc.tasks and len(rig.reads) == n  # (from disk)
        assert list(svc.state) == [(BV, KEY), (bvs[0], KEY)]

    asyncio.run(run())


def test_without_ffmpeg_or_tesseract_it_says_so(tmp_path, monkeypatch):
    monkeypatch.setattr(vc.shutil, "which", lambda tool: None if tool == "tesseract" else f"/usr/bin/{tool}")

    async def run():
        svc = vc.VodClockService(SimpleNamespace(data_dir=tmp_path), None, bili=FakeBili(*fake_video()))
        await svc.start()
        assert svc.get(BV, KEY, SLOT) == {"status": "none", "why": "no tesseract on the fone server"}
        assert not svc.tasks and not svc.state

    asyncio.run(run())


def test_a_mirror_ignoring_range_is_refused_before_the_whole_file(tmp_path, monkeypatch):
    rig = Rig(tmp_path, monkeypatch)
    rig.video += b"\x00" * 1_000_000  # (the page's whole video: big)

    async def run():
        bili = rig.bili(urls=("https://ignoring-range/v.m4s", "https://m1/v.m4s"))
        svc = rig.service(bili)
        await svc.start()
        assert (await settled(svc))["status"] == "ok"
        asked = bili.http.ranges
        assert len(asked) >= 2 * (1 + vc.PAR) and len(asked) % 2 == 0  # (each from the first mirror, then the next)
        assert bili.http.sent == sum(b - a + 1 for a, b in asked) // 2  # (nothing of the whole file)

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
