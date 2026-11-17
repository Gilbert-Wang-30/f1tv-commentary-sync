import asyncio
import json
from datetime import datetime, timezone
from pathlib import Path

import httpx

from fone.f1 import PREROLL, F1Mapper, session_kind
from fone.store import Store
from test_timing import make_service

FIX = Path(__file__).parent / "fixtures"


def load(name):
    return json.loads((FIX / name).read_text(encoding="utf-8-sig"))


def mock_transport():
    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if "f1tv.formula1.com" in url:
            cid = url.split("/VIDEO/")[1].split("/")[0]
            return httpx.Response(200, json=load(f"f1tv_{cid}.json"))
        if "api.multiviewer.app" in url:
            mk, sk = url.split("/meetings/")[1].split("/sessions/")
            f = FIX / f"mv_{mk}_{sk}.json"
            return httpx.Response(200, json=load(f.name)) if f.exists() else httpx.Response(404)
        if "livetiming.formula1.com" in url and "2026-10-03_Qualifying" in url:
            return httpx.Response(200, content=(FIX / "sessiondata_1308_11730.json").read_bytes())
        if "api.openf1.org/v1/sessions" in url:
            return httpx.Response(200, json=load("openf1_sessions_1308.json"))
        return httpx.Response(404)

    return httpx.MockTransport(handler)


def mapper(tmp_path):
    m = F1Mapper(Store(tmp_path / "db.sqlite3"))
    m.http = httpx.AsyncClient(transport=mock_transport())
    return m


def ts(s):
    return datetime.fromisoformat(s).replace(tzinfo=timezone.utc).timestamp()


def test_session_kind():
    assert session_kind("Sprint Qualifying") == "sprint_qualifying"
    assert session_kind("Sprint Shootout") == "sprint_qualifying"
    assert session_kind("Sprint") == "sprint"
    assert session_kind("Qualifying") == "qualifying"
    assert session_kind("Practice 3") == "practice"
    assert session_kind("FP1") == "practice"
    assert session_kind("Race") == "race"
    assert session_kind("Press Conference") is None


def test_replay_anchored_by_multiviewer(tmp_path):
    out = asyncio.run(mapper(tmp_path).content("1000011024"))
    assert out["anchor"] == "multiviewer"
    assert out["meetingKey"] == 1308 and out["sessionKey"] == 11730
    assert out["subtype"] == "REPLAY"
    # Q1 went green at 08:00:00.172Z and MultiViewer puts that 307.04 s into the replay.
    assert abs(out["startedUtc"] - ts("2026-10-03T08:00:00.172")) < 1e-3
    assert abs(out["p0"] - (ts("2026-10-03T08:00:00.172") - 307.04)) < 1e-3


def test_pre_live_content_found_via_multiviewer_and_uses_preroll(tmp_path):
    out = asyncio.run(mapper(tmp_path).content("1000011022"))
    assert out["sessionKey"] == 11731
    assert out["anchor"] == "preroll"
    assert out["kind"] == "race"
    assert abs(out["p0"] - (ts("2026-10-04T07:00:00") + PREROLL["race"])) < 1e-3


def test_unknown_content(tmp_path):
    m = mapper(tmp_path)

    def nothing(request):
        if "api.openf1.org" in str(request.url):
            return httpx.Response(200, json=[])
        return httpx.Response(200, json={"resultCode": "KO", "resultObj": {}})

    m.http = httpx.AsyncClient(transport=httpx.MockTransport(nothing))
    out = asyncio.run(m.content("999"))
    assert out["p0"] is None and "error" in out


def test_result_is_cached(tmp_path):
    m = mapper(tmp_path)
    first = asyncio.run(m.content("1000011024"))
    m.http = httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(500)))
    assert asyncio.run(m.content("1000011024")) == first


def test_streams_list_the_onboards(tmp_path):
    out = asyncio.run(mapper(tmp_path).content("1000011024"))
    st = out["streams"]
    assert len(st) == 26
    assert st[0] == {"channelId": 1033, "type": "additional", "title": "F1 LIVE", "number": None, "name": None,
                     "team": None, "color": None}
    nor = next(s for s in st if s["title"] == "NOR")
    assert nor["type"] == "obc" and nor["number"] == 1 and nor["channelId"] == 1016 and nor["name"] == "Lando Norris"
    assert nor["team"] == "McLaren" and nor["color"].startswith("#")
    assert sum(s["type"] == "obc" for s in st) == 22


def test_an_old_cached_replay_is_fetched_once_more_for_its_streams(tmp_path):
    m = mapper(tmp_path)
    first = asyncio.run(m.content("1000011024"))
    old = {k: v for k, v in first.items() if k != "streams"}  # what earlier versions cached
    m.store.put_content("1000011024", old)
    again = asyncio.run(m.content("1000011024"))
    assert again["streams"] and again["p0"] == first["p0"]


def test_an_exact_anchor_is_kept_when_the_timing_archive_refuses(tmp_path):
    # 2026-10-18: livetiming.formula1.com/static answers 401 to everything. An old cached
    # replay re-resolved for its streams keeps the exact anchor it had.
    m = mapper(tmp_path)
    first = asyncio.run(m.content("1000011024"))
    assert first["anchor"] == "multiviewer"
    m.store.put_content("1000011024", {k: v for k, v in first.items() if k != "streams"})
    inner = mock_transport()
    def refuse_archive(request):
        if "livetiming.formula1.com" in str(request.url):
            return httpx.Response(401)
        return inner.handle_request(request)
    m.http = httpx.AsyncClient(transport=httpx.MockTransport(refuse_archive))
    again = asyncio.run(m.content("1000011024"))
    assert again["streams"] and again["anchor"] == "multiviewer" and again["p0"] == first["p0"]
    assert again["startedUtc"] == first["startedUtc"]
    # never seen before, the same refusal gives the estimate
    fresh = mapper(tmp_path / "x") if (tmp_path / "x").mkdir() is None else None
    fresh.http = httpx.AsyncClient(transport=httpx.MockTransport(refuse_archive))
    est = asyncio.run(fresh.content("1000011024"))
    assert est["anchor"] == "preroll"


def test_a_failed_lookup_never_replaces_the_cached_answer(tmp_path):
    # an old replay re-resolved (for its streams) while F1 TV answers 503 and the archive 401:
    # the exact anchor it had is served, not an error, and not stored over it
    m = mapper(tmp_path)
    first = asyncio.run(m.content("1000011024"))
    m.store.put_content("1000011024", {k: v for k, v in first.items() if k != "streams"})
    m.http = httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(503)))
    again = asyncio.run(m.content("1000011024"))
    assert not again.get("error") and again["anchor"] == "multiviewer" and again["p0"] == first["p0"]
    assert m.store.get_content("1000011024")[0]["anchor"] == "multiviewer"


def test_answers_that_arent_json_or_of_another_shape_are_a_failed_lookup(tmp_path):
    # a 200 that's a maintenance page or a bot check, JSON of another shape: an error lookup (the
    # cached answer kept), never an exception out of the route
    pages = {
        "html": lambda r: httpx.Response(200, content=b"<html>Service unavailable</html>"),
        "binary": lambda r: httpx.Response(200, content=b"\xff\xfe\x00garbage"),
        "a list": lambda r: httpx.Response(200, json=[1, 2]) if "f1tv" in str(r.url) else httpx.Response(200, json={}),
        "odd sessions": lambda r: httpx.Response(200, json=[{"session_key": 1}, "x", 3])
        if "openf1" in str(r.url) else httpx.Response(200, json={"resultObj": {"containers": []}}),
        "odd multiviewer": lambda r: httpx.Response(200, json={"f1tv_content_id": 1000011024, "sync_offsets": [1]})
        if "multiviewer" in str(r.url) else mock_transport().handle_request(r),
    }
    m = mapper(tmp_path)
    first = asyncio.run(m.content("1000011024"))
    for what, page in pages.items():
        m.store.put_content("1000011024", {k: v for k, v in first.items() if k != "streams"})
        m.http = httpx.AsyncClient(transport=httpx.MockTransport(page))
        assert asyncio.run(m.content("1000011024"))["p0"] == first["p0"], what
        (tmp_path / what).mkdir()
        new = mapper(tmp_path / what)  # (nothing cached)
        new.http = httpx.AsyncClient(transport=httpx.MockTransport(page))
        out = asyncio.run(new.content("1000011024"))
        assert out["contentId"] == "1000011024" and (out.get("error") or out["anchor"] == "preroll"), (what, out)


# ---- no session of F1's own: F1 Academy, F2, F3 ----------------------------------------------------

MISSING = object()


def feeder_metadata(cid, session, key=MISSING, series="F1 ACADEMY"):
    """F1 TV's metadata for a feeder series' session, from the qualifying's: the same meeting and
    schedule fields, but no session of F1's own to look up (MeetingSessionKey absent, empty or
    null). As the server's cache holds one: '2026 United States GP - F1A Reverse Grid Race',
    sessionKey null, kind race, anchor preroll."""
    d = load("f1tv_1000011024.json")
    m = d["resultObj"]["containers"][0]["metadata"]
    m.update(contentId=int(cid), title=f"2026 Bahrain GP in Malaysia - {session}", externalId=None,
             additionalStreams=[])
    emf = m["emfAttributes"]
    emf.update(Series=series, Global_Title=f"2616 Bahrain GP - {session}")
    for k in ("MeetingSessionKey", "multipartEventMainMSK", "multipartEventMainHouseId", "multipartEventNextHouseId"):
        emf.pop(k)
    if key is not MISSING:
        emf["MeetingSessionKey"] = key
    return d


def feeder_mapper(tmp_path, pages):
    """A mapper whose F1 TV knows these contents; every other request is noted (none is expected:
    with no session key there's no MultiViewer session to ask)."""
    asked = []

    def handler(request):
        url = str(request.url)
        if "f1tv.formula1.com" in url:
            cid = url.split("/VIDEO/")[1].split("/")[0]
            return httpx.Response(200, json=pages[cid]) if cid in pages else httpx.Response(404)
        asked.append(url)
        return httpx.Response(404)

    m = F1Mapper(Store(tmp_path / "db.sqlite3"))
    m.http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return m, asked


def test_a_feeder_series_session_uses_the_preroll_of_its_kind(tmp_path):
    start = 1791014400.0  # (the fixture's sessionStartDate)
    cases = {"1000077801": ("F1A Reverse Grid Race", MISSING, "race"),
             "1000077802": ("F2 Sprint Race", "", "sprint"),
             "1000077803": ("F3 Qualifying", None, "qualifying"),
             "1000077804": ("F2 Feature Race", MISSING, "race"),
             "1000077805": ("F1A Practice", MISSING, "practice")}
    m, asked = feeder_mapper(tmp_path, {cid: feeder_metadata(cid, name, key) for cid, (name, key, _) in cases.items()})
    for cid, (name, _, kind) in cases.items():
        out = asyncio.run(m.content(cid))
        assert out["sessionKey"] is None and out["meetingKey"] == 1308 and out["subtype"] == "REPLAY", name
        assert (out["sessionName"], out["kind"], out["isSessionFeed"]) == (name, kind, False)
        assert out["anchor"] == "preroll" and out["scheduledStart"] == start
        assert out["p0"] == start + PREROLL[kind], name
        assert "error" not in out and "startedUtc" not in out and "channelOffsets" not in out  # (no MultiViewer)
        # what /api/f1tv/{cid} sends (the extension reads a missing session key as null)
        sent = json.loads(json.dumps(out))
        assert sent["sessionKey"] is None and sent["anchor"] == "preroll"
    assert asked == []


def test_a_feeder_video_that_isnt_a_session_has_no_anchor(tmp_path):
    # (highlights: F1 TV titles them after the place, as the server's cache has 'F1A Race 1
    # Highlights - United States'; no kind, no guess)
    d = feeder_metadata("1000078525", "x")
    d["resultObj"]["containers"][0]["metadata"].update(title="F1A Race 1 Highlights - United States",
                                                       contentSubtype="RACE HIGHLIGHTS")
    m, asked = feeder_mapper(tmp_path, {"1000078525": d})
    out = asyncio.run(m.content("1000078525"))
    assert out["sessionKey"] is None and out["kind"] is None and out["anchor"] is None and out["p0"] is None
    assert asked == []


# ---- exact anchors without F1's archive (401 to everyone since 2026-10-18) ----------------------

Q_CID = "1000011024"
Q_STARTED = ts("2026-10-03T08:00:00.172")  # Q1 green: the archive's StatusSeries (sessiondata fixture)
Q_SSV = 307.04  # MultiViewer's session_start
Q_EXACT = Q_STARTED - Q_SSV  # the archive's anchor, test_replay_anchored_by_multiviewer
Q_PDT = "2026-10-03T08:00:07.520Z"  # MultiViewer's session_start_pdt for 11730, as it answered 2026-11-17


def world_mapper(tmp_path, pages=None, mvs=None, archive=401, **mv):
    """A mapper whose world can change between lookups: F1 TV's pages (the fixtures and `pages`),
    MultiViewer's sessions (the fixtures, `mvs` {(mk, sk): answer}, and `mv` merged into
    11730's: None removes a field), F1's archive answering `archive` (200: the fixture), the
    server's timing (w["timing"]: session key -> Started). w["asked"]: every URL asked."""
    w = {"pages": pages or {}, "mvs": mvs or {}, "archive": archive, "timing": {}, "asked": []}
    q = load("mv_1308_11730.json")
    q.update(mv)
    w["mvs"].setdefault((1308, 11730), {k: v for k, v in q.items() if v is not None})

    def handler(request):
        url = str(request.url)
        w["asked"].append(url)
        if "f1tv.formula1.com" in url:
            cid = url.split("/VIDEO/")[1].split("/")[0]
            if cid in w["pages"]:
                return httpx.Response(200, json=w["pages"][cid])
        if "api.multiviewer.app" in url:
            mk, sk = url.split("/meetings/")[1].split("/sessions/")
            if (int(mk), int(sk)) in w["mvs"]:
                return httpx.Response(200, json=w["mvs"][int(mk), int(sk)])
            return httpx.Response(404)
        if "livetiming.formula1.com" in url and w["archive"] != 200:
            return httpx.Response(w["archive"])
        return mock_transport().handle_request(request)

    m = F1Mapper(Store(tmp_path / "db.sqlite3"))
    m.http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    m.timing_started = lambda key: w["timing"].get(key)
    return m, w


def session_page(cid, mk, sk, title, start):
    """F1 TV's page for a session's replay, from the qualifying's (onboards and all)."""
    d = load("f1tv_1000011024.json")
    m = d["resultObj"]["containers"][0]["metadata"]
    m.update(contentId=int(cid), title=title)
    m["emfAttributes"].update(MeetingKey=str(mk), MeetingSessionKey=str(sk), sessionStartDate=str(int(start * 1000)),
                              sessionEndDate=str(int((start + 7200) * 1000)))
    return d


def mv_session(mk, sk, cid, name, start=None, pdt=None, listed=()):
    """MultiViewer's answer for a session: `cid` its f1tv_content_id, `listed` the content ids its
    sync_offsets name ((content id, channel) or (content id, channel, session key))."""
    rows = []
    for x in listed:
        c, ch, key = (*x, sk) if len(x) == 2 else x
        rows.append({"diff": 0, "streamData": {"channelId": ch, "contentId": str(c), "meetingKey": str(mk),
                                               "sessionKey": str(key), "title": "INTERNATIONAL", "type": "additional"}})
    out = {"session_info": {"Name": name, "Path": f"2026/x/{sk}/", "Key": sk}, "f1tv_content_id": str(cid),
           "session_start": None if start is None else str(start), "sync_offsets": {"sync_offsets": rows}}
    if pdt is not None:
        out["session_start_pdt"] = pdt
    return out


def test_without_the_archive_the_servers_timing_gives_the_exact_anchor(tmp_path):
    # Started from the server's own capture of the session, checked against MultiViewer's pdt
    # (7.348 s after it: 7.469 ± 0.5 for a qualifying): the archive's anchor, to the ms
    m, w = world_mapper(tmp_path, session_start_pdt=Q_PDT)
    w["timing"][11730] = Q_STARTED
    out = asyncio.run(m.content(Q_CID))
    assert out["anchor"] == "timing" and out["isSessionFeed"] and out["kind"] == "qualifying"
    assert (out["startedUtc"], out["sessionStartVideo"], out["timingStarted"]) == (Q_STARTED, Q_SSV, Q_STARTED)
    assert abs(out["p0"] - Q_EXACT) < 1e-6
    assert any("livetiming.formula1.com" in u for u in w["asked"])  # (the archive is still asked first)
    # without a pdt to check against (2026 Italian GP race, 11361), the timing is taken as it is
    (tmp_path / "nopdt").mkdir()
    m, w = world_mapper(tmp_path / "nopdt")
    w["timing"][11730] = Q_STARTED
    out = asyncio.run(m.content(Q_CID))
    assert out["anchor"] == "timing" and abs(out["p0"] - Q_EXACT) < 1e-6


def test_the_anchor_from_a_live_capture_of_the_session(tmp_path):
    # the timing service's own Started (TimingService.started, as app.py wires it in)
    svc = make_service(tmp_path)
    w = svc._writer(11730)
    w.write("SessionStatus", {"Status": "Inactive", "Started": "Inactive"}, ts("2026-10-03T07:45:00.020"))
    w.write("SessionStatus", {"Status": "Started", "Started": "Started", "_kf": True}, Q_STARTED)
    m, _ = world_mapper(tmp_path, session_start_pdt=Q_PDT)
    m.timing_started = svc.started
    out = asyncio.run(m.content(Q_CID))
    assert out["anchor"] == "timing" and abs(out["p0"] - Q_EXACT) < 1e-3


def test_the_archive_still_comes_first(tmp_path):
    m, w = world_mapper(tmp_path, archive=200, session_start_pdt=Q_PDT)
    w["timing"][11730] = Q_STARTED + 0.3
    out = asyncio.run(m.content(Q_CID))
    assert out["anchor"] == "multiviewer" and out["startedUtc"] == Q_STARTED and abs(out["p0"] - Q_EXACT) < 1e-6


def test_multiviewers_pdt_alone_is_exact_to_a_fraction_of_a_second(tmp_path):
    m, w = world_mapper(tmp_path, session_start_pdt=Q_PDT)
    out = asyncio.run(m.content(Q_CID))
    assert out["anchor"] == "pdt" and "timingStarted" not in out
    assert out["startedUtc"] == ts("2026-10-03T08:00:07.520") - 7.469 and out["sessionStartVideo"] == Q_SSV
    assert abs(out["p0"] - Q_EXACT) < 0.17
    # a pdt that isn't a time: the pre-roll
    (tmp_path / "bad").mkdir()
    m, _ = world_mapper(tmp_path / "bad", session_start_pdt="soon")
    assert asyncio.run(m.content(Q_CID))["anchor"] == "preroll"


def test_a_capture_that_joined_late_fails_the_pdt_check(tmp_path):
    """2026 Mexico City FP3 (11399): the capture connected 15 min into the session, so its
    Started is when it connected (MultiViewer's pdt 879 s before it). TimingService.started
    skips a stream that opens on Started; one that came back after a drop says nothing of the
    kind, and MultiViewer's pdt is what tells. The check is ±0.5 s around pdt - 7.469."""
    pdt = ts("2026-10-03T08:00:07.520")
    for timing, anchor in ((pdt + 879, "pdt"), (pdt - 7.469 + 0.45, "timing"), (pdt - 7.469 - 0.45, "timing"),
                           (pdt - 7.469 + 0.55, "pdt"), (pdt - 7.469 - 0.55, "pdt")):
        d = tmp_path / str(timing)
        d.mkdir()
        m, w = world_mapper(d, session_start_pdt=Q_PDT)
        w["timing"][11730] = timing
        out = asyncio.run(m.content(Q_CID))
        assert out["anchor"] == anchor and out["timingStarted"] == timing, timing
        assert out["startedUtc"] == (timing if anchor == "timing" else pdt - 7.469)
        if anchor == "pdt":
            assert abs(out["p0"] - Q_EXACT) < 0.17


def test_without_multiviewers_session_start_the_pre_roll_whatever_the_timing(tmp_path):
    # live, or the first hours after: no session_start, so no position in the video to put Started at
    m, w = world_mapper(tmp_path, session_start=None, session_start_pdt=Q_PDT)
    w["timing"][11730] = Q_STARTED
    out = asyncio.run(m.content(Q_CID))
    assert out["anchor"] == "preroll" and out["p0"] == 1791014400 + PREROLL["qualifying"]
    assert out["timingStarted"] == Q_STARTED  # (noted: content() doesn't look again for it)


def test_a_session_that_started_late_is_anchored_on_its_start_not_the_schedule(tmp_path):
    """2026 Japanese GP race (11253, content 1000010209): scheduled 05:00Z, started 842 s later.
    The pre-roll put its replay at the schedule's -307.3 s, 599 s off; the session's Started (the
    server's timing: here OpenF1's rebuild) or MultiViewer's pdt (7.822 s after it) puts it right."""
    sched = ts("2026-03-29T05:00:00")
    started = sched + 842.078
    page = session_page("1000010209", 1281, 11253, "2026 Japanese Grand Prix", sched)
    mv = mv_session(1281, 11253, "1000010209", "Race", 550.38, "2026-03-29T05:14:09.900Z",
                    listed=[("1000010209", 1025), ("1000010209", 1033)])
    for timing, anchor, within in ((started, "timing", 1e-6), (None, "pdt", 0.06)):
        d = tmp_path / anchor
        d.mkdir()
        m, w = world_mapper(d, pages={"1000010209": page}, mvs={(1281, 11253): mv})
        if timing:
            w["timing"][11253] = timing
        out = asyncio.run(m.content("1000010209"))
        assert (out["anchor"], out["kind"], out["scheduledStart"]) == (anchor, "race", sched)
        assert abs(out["p0"] - (sched + 291.698)) < within, out["p0"] - sched  # not sched - 307.3
    # nothing exact to be had: the pre-roll, ten minutes off
    (tmp_path / "pre").mkdir()
    m, _ = world_mapper(tmp_path / "pre", pages={"1000010209": page}, mvs={(1281, 11253): {**mv, "session_start_pdt": None}})
    assert asyncio.run(m.content("1000010209"))["p0"] == sched + PREROLL["race"]


def test_the_session_feed_is_known_by_multiviewers_sync_offsets_too(tmp_path):
    """MultiViewer now names other videos as some sessions' content: the 2026 Italian GP race's
    post-race show (1000011143), Singapore's 1000079710. Their sync_offsets still list the race's
    own feed on the main channel (1025) for the session, and that makes it the session feed:
    anchored, not left to the manual clock (which refuses its Bilibili replay)."""
    sched = ts("2026-09-06T13:00:00")
    started = 1788696000.0 + 3810.936  # (the OpenF1 rebuild's Started)
    pages = {cid: session_page(cid, 1293, 11361, title, sched) for cid, title in (
        ("1000010363", "2026 Italian Grand Prix"), ("1000010364", "2026 Italian GP - F1 Kids"),
        ("1000010365", "2026 Italian Grand Prix - F1 LIVE"), ("1000010366", "2026 Italian Grand Prix"))}
    mv = mv_session(1293, 11361, "1000011143", "Race", 518.26,
                    listed=[("1000010363", 1025), ("1000010363", 1033), ("1000010365", 1033),
                            ("1000010366", 1025, 11236)])  # (another session's: as for 11378, 11390)
    m, w = world_mapper(tmp_path, pages=pages, mvs={(1293, 11361): mv})
    w["timing"][11361] = started
    out = asyncio.run(m.content("1000010363"))
    assert out["isSessionFeed"] and (out["anchor"], out["kind"]) == ("timing", "race")
    assert abs(out["p0"] - (sched - 307.324)) < 1e-3 and out["channelOffsets"] == {"1025": 0, "1033": 0}
    # the F1 Kids feed isn't listed (as 2025 Abu Dhabi's 1000010480): manual, as before; nor are a
    # feed listed on another channel only, or for another session
    for cid in ("1000010364", "1000010365", "1000010366"):
        out = asyncio.run(m.content(cid))
        assert not out["isSessionFeed"] and out["anchor"] is None and out["p0"] is None, cid
        assert "timingStarted" not in out


def test_a_preroll_anchor_is_upgraded_once_the_servers_timing_has_the_start(tmp_path):
    """The capture (or OpenF1's rebuild) often has Started only after the replay was first looked
    up: the next lookup re-resolves at once, not 10 min on, and only once for each Started."""
    m, w = world_mapper(tmp_path)  # (MultiViewer has session_start, no pdt; the archive 401)
    first = asyncio.run(m.content(Q_CID))
    assert first["anchor"] == "preroll" and "timingStarted" not in first
    n = len(w["asked"])
    assert asyncio.run(m.content(Q_CID)) == first and len(w["asked"]) == n  # (cached)
    w["timing"][11730] = Q_STARTED
    up = asyncio.run(m.content(Q_CID))
    assert up["anchor"] == "timing" and abs(up["p0"] - Q_EXACT) < 1e-6 and len(w["asked"]) > n
    n = len(w["asked"])
    assert asyncio.run(m.content(Q_CID)) == up and len(w["asked"]) == n  # exact: settled
    # live (no session_start yet): looked again once for the Started, then left for 10 min as before
    (tmp_path / "live").mkdir()
    m, w = world_mapper(tmp_path / "live", session_start=None)
    assert asyncio.run(m.content(Q_CID))["anchor"] == "preroll"
    w["timing"][11730] = Q_STARTED
    n = len(w["asked"])
    again = asyncio.run(m.content(Q_CID))
    assert again["anchor"] == "preroll" and again["timingStarted"] == Q_STARTED and len(w["asked"]) > n
    n = len(w["asked"])
    asyncio.run(m.content(Q_CID))
    assert len(w["asked"]) == n
    # a pdt anchor gets the timing's too; a timing one isn't looked at again for it
    (tmp_path / "pdt").mkdir()
    m, w = world_mapper(tmp_path / "pdt", session_start_pdt=Q_PDT)
    assert asyncio.run(m.content(Q_CID))["anchor"] == "pdt"
    w["timing"][11730] = Q_STARTED
    assert asyncio.run(m.content(Q_CID))["anchor"] == "timing"
    w["timing"][11730] = Q_STARTED + 0.2
    n = len(w["asked"])
    assert asyncio.run(m.content(Q_CID))["startedUtc"] == Q_STARTED and len(w["asked"]) == n


def test_an_exact_anchor_is_never_traded_for_a_lesser_one(tmp_path):
    # ranked multiviewer > timing > pdt > preroll: a re-resolve (for the stream list, or a
    # refresh) that can only make a lesser anchor keeps the one cached; a better one replaces it
    ways = {"multiviewer": dict(archive=200), "timing": dict(timing=Q_STARTED + 0.1),
            "pdt": dict(session_start_pdt=Q_PDT), "preroll": {}}
    for old in ("multiviewer", "timing", "pdt", "preroll"):
        for new in ("multiviewer", "timing", "pdt", "preroll"):
            d = tmp_path / f"{old}-{new}"
            d.mkdir()
            way = dict(ways[new])
            timing = way.pop("timing", None)
            m, w = world_mapper(d, **way)
            if timing:
                w["timing"][11730] = timing
            fresh = asyncio.run(m.content(Q_CID, refresh=True))
            assert fresh["anchor"] == new
            m.store.put_content(Q_CID, {**fresh, "anchor": old, "p0": 1.0, "startedUtc": 2.0, "sessionStartVideo": 3.0})
            out = asyncio.run(m.content(Q_CID, refresh=True))
            keep = old != "preroll" and ["multiviewer", "timing", "pdt", "preroll"].index(old) < \
                ["multiviewer", "timing", "pdt", "preroll"].index(new)
            if keep:
                assert (out["anchor"], out["p0"], out["startedUtc"], out["sessionStartVideo"]) == (old, 1.0, 2.0, 3.0)
            else:
                assert (out["anchor"], out["p0"]) == (new, fresh["p0"]), (old, new)
            assert m.store.get_content(Q_CID)[0]["anchor"] == out["anchor"]
