import asyncio
import json
from datetime import datetime, timezone
from pathlib import Path

import httpx

from fone.f1 import PREROLL, F1Mapper, session_kind
from fone.store import Store

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
