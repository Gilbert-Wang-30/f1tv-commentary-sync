"""Timing rebuilt from OpenF1 (timing_openf1.py) against small synthetic OpenF1 answers.

Made up on purpose (the repo is public): a 4-car, 6-lap race on a circular track, a
12-car qualifying with a red flag and a 3-car practice, each with just enough in it to pin
one rule down: every value shows up at the moment the live feed would have shown it, never
before. Shapes and quirks are OpenF1's as checked against real sessions (pit `date` is the
pit exit, an out-lap's duration runs from the previous lap's end, a pit lane start reads as
a stop, 404 for "no rows").
"""

import asyncio
import json
import math
import time
from datetime import datetime, timezone

import httpx
import pytest

from fastapi.testclient import TestClient

from fone import timing_openf1
from fone.timing import TimingService, TimingSettings, _Attempt
from fone.timing_openf1 import OpenF1, _repair_stints, build, fetch
from fone.timing_state import SessionTimeline, iso, track_outline

from test_timing import app_for, make_service


def Z(t: float) -> str:
    """OpenF1's time format."""
    return datetime.fromtimestamp(t, timezone.utc).isoformat()


def driver(num: int, tla: str, first: str, last: str, team: str, colour: str, key: int) -> dict:
    return {"session_key": key, "driver_number": num, "name_acronym": tla, "first_name": first, "last_name": last,
            "full_name": f"{first} {last.upper()}", "broadcast_name": f"{first[0]} {last.upper()}",
            "team_name": team, "team_colour": colour}


def session(key: int, kind: str, name: str, start: float, end: float) -> dict:
    return {"session_key": key, "session_type": kind, "session_name": name, "date_start": Z(start),
            "date_end": Z(end), "meeting_key": 9100, "circuit_key": 46, "circuit_short_name": "Ringtown",
            "country_name": "Testland", "country_code": "TST", "location": "Ringtown", "gmt_offset": "09:00:00",
            "year": 2026, "is_cancelled": False}


def rcm(t: float, category: str, message: str, **kw) -> dict:
    return {"date": Z(t), "category": category, "message": message, "flag": kw.get("flag"),
            "scope": kw.get("scope"), "sector": kw.get("sector"), "driver_number": kw.get("driver"),
            "lap_number": kw.get("lap"), "qualifying_phase": kw.get("phase")}


def lap(key: int, num: int, n: int, start: float, dur: float | None, out: bool = False,
        sectors: tuple | None = None) -> dict:
    """One OpenF1 lap row; sectors 30/40/30 % of the lap unless given."""
    if sectors is None and dur:
        s1, s2 = round(0.3 * dur, 3), round(0.4 * dur, 3)
        sectors = (s1, s2, round(dur - s1 - s2, 3))
    s1, s2, s3 = sectors or (None, None, None)
    return {"session_key": key, "driver_number": num, "lap_number": n, "date_start": Z(start), "lap_duration": dur,
            "duration_sector_1": s1, "duration_sector_2": s2, "duration_sector_3": s3, "is_pit_out_lap": out}


def back_to_back(key: int, num: int, start: float, durations: list, out: dict) -> list[dict]:
    """A race's laps: each starts where the last ended. `out`: out-lap number -> its sectors."""
    rows, t = [], start
    for n, d in enumerate(durations, 1):
        rows.append(lap(key, num, n, t, d, n in out, out.get(n)))
        t += d or 0
    return rows


# ---- a race ------------------------------------------------------------------------------

RACE = 9001
R0 = iso("2026-03-29T05:00:00Z")  # scheduled start
GO = R0 + 600.0  # lights out, ten minutes late
RADIUS = 2000  # decimetres: a 1.26 km circle
RACE_LAPS = {
    1: [43.0, 40.0, 40.0, 40.0, 40.0, 40.0],
    44: [43.2, 40.2, 55.2, 48.2, 40.2, 40.2],  # into the pits at the end of lap 3
    16: [43.4, 40.4, 40.4, 40.4, None],  # stops on lap 5
    4: [43.6, 40.6, 40.6, 55.6, 48.6, 40.6],  # starts from the pit lane, stops after lap 4
}
RACE_OUT = {44: {4: (20.0, 16.0, 12.2)}, 4: {5: (20.0, 16.0, 12.6)}, 1: {6: (20.0, 12.0, 8.0)}}  # out-laps
GRID = [44, 1, 16, 4]
STOPPED_16 = GO + 175.0


def race_world() -> dict:
    laps = [r for num, d in RACE_LAPS.items() for r in back_to_back(RACE, num, GO, d, RACE_OUT.get(num, {}))]
    ends = {num: [GO + sum(d[:n]) for n in range(1, len(d) + 1) if all(d[:n])] for num, d in RACE_LAPS.items()}
    intervals = []
    for n in range(1, 7):
        done = sorted((e[n - 1], num) for num, e in ends.items() if len(e) >= n)
        for (t, num), prev in zip(done, [None] + done[:-1]):
            intervals.append({"date": Z(t + 0.4), "driver_number": num, "gap_to_leader": round(t - done[0][0], 3),
                              "interval": round(t - prev[0], 3) if prev else 0.0, "session_key": RACE})
    intervals.append({"date": Z(GO + 250.0), "driver_number": 4, "gap_to_leader": "+1 LAP", "interval": 5.123,
                      "session_key": RACE})
    intervals.append({"date": Z(GO + 255.0), "driver_number": 4, "gap_to_leader": 26.6, "interval": None,
                      "session_key": RACE})
    position = [{"date": Z(R0 - 1800), "driver_number": num, "position": i, "session_key": RACE}
                for i, num in enumerate(GRID, 1)]
    for t, order in ((GO + 20.0, {1: 1, 44: 2}), (GO + 145.0, {16: 2, 44: 3}), (GO + 176.0, {44: 2, 4: 3, 16: 4})):
        position += [{"date": Z(t), "driver_number": num, "position": p, "session_key": RACE} for num, p in order.items()]
    location = []
    for k in range(int((GO + 330 - (R0 - 1200)) * 4)):
        t = R0 - 1200 + k / 4
        for num, d in RACE_LAPS.items():
            x, y = circle(num, t, d)
            location.append({"date": Z(t), "driver_number": num, "x": x, "y": y, "z": 100, "session_key": RACE})
    return {
        "sessions": [session(RACE, "Race", "Race", R0, R0 + 7200)],
        "drivers": [driver(1, "AAA", "Ann", "Alpha", "Team One", "FF8000", RACE),
                    driver(44, "BBB", "Ben", "Bravo", "Team Two", "27F4D2", RACE),
                    driver(16, "CCC", "Cal", "Charlie", "Team Three", "E80020", RACE),
                    driver(4, "DDD", "Dan", "Delta", "Team One", "FF8000", RACE)],
        "laps": laps,
        "stints": [
            # car 1 drives through the pit lane after lap 5: a "stint" on the same set
            {"driver_number": 1, "stint_number": 1, "lap_start": 1, "lap_end": 5, "compound": "MEDIUM", "tyre_age_at_start": 0},
            {"driver_number": 1, "stint_number": 2, "lap_start": 6, "lap_end": 6, "compound": "MEDIUM", "tyre_age_at_start": 5},
            {"driver_number": 44, "stint_number": 1, "lap_start": 1, "lap_end": 3, "compound": "MEDIUM", "tyre_age_at_start": 2},
            {"driver_number": 44, "stint_number": 2, "lap_start": 4, "lap_end": 6, "compound": "HARD", "tyre_age_at_start": 0},
            {"driver_number": 16, "stint_number": 1, "lap_start": 1, "lap_end": 5, "compound": "SOFT", "tyre_age_at_start": 0},
            # OpenF1 on a pit lane start: a "stint" from lap 2 with the compound of the real stop
            {"driver_number": 4, "stint_number": 1, "lap_start": 1, "lap_end": 1, "compound": "MEDIUM", "tyre_age_at_start": 0},
            {"driver_number": 4, "stint_number": 2, "lap_start": 2, "lap_end": 6, "compound": "HARD", "tyre_age_at_start": 0},
        ],
        "pit": [{"date": Z(GO + 145.0), "driver_number": 44, "lap_number": 3, "lane_duration": 25.0, "stop_duration": 2.4},
                {"date": Z(GO + 186.0), "driver_number": 4, "lap_number": 4, "lane_duration": 25.0, "stop_duration": 2.6},
                {"date": Z(GO + 210.0), "driver_number": 1, "lap_number": 5, "lane_duration": 20.0, "stop_duration": None}],
        "position": position,
        "intervals": intervals,
        "race_control": [
            rcm(R0 - 1800, "Flag", "GREEN LIGHT - PIT EXIT OPEN", flag="GREEN", scope="Track"),
            rcm(GO + 0.078, "SessionStatus", "SESSION STARTED"),
            rcm(GO + 95, "Flag", "YELLOW IN TRACK SECTOR 5", flag="YELLOW", scope="Sector", sector=5),
            rcm(GO + 100, "SafetyCar", "SAFETY CAR DEPLOYED"),
            rcm(GO + 150, "SafetyCar", "SAFETY CAR IN THIS LAP"),
            rcm(GO + 160, "Flag", "CLEAR IN TRACK SECTOR 5", flag="CLEAR", scope="Sector", sector=5),
            rcm(GO + 170, "Flag", "TRACK CLEAR", flag="CLEAR", scope="Track"),
            rcm(GO + 243, "Flag", "CHEQUERED FLAG", flag="CHEQUERED", scope="Track"),
            rcm(GO + 243.4, "SessionStatus", "SESSION FINISHED"),
        ],
        "weather": [{"date": Z(R0 - 1790), "air_temperature": 21.46, "track_temperature": 33.0, "humidity": 55.0,
                     "pressure": 1012.3, "rainfall": 0, "wind_direction": 182, "wind_speed": 1.2}],
        "session_result": [{"driver_number": 1, "position": 1, "number_of_laps": 6, "dnf": False, "dns": False},
                           {"driver_number": 44, "position": 2, "number_of_laps": 6, "dnf": False, "dns": False},
                           {"driver_number": 4, "position": 3, "number_of_laps": 6, "dnf": False, "dns": False},
                           {"driver_number": 16, "position": None, "number_of_laps": 4, "dnf": True, "dns": False}],
        "location": location,
    }


def circle(num: int, t: float, durations: list) -> tuple[int, int]:
    """Where the car is: on the grid before the start, one turn per lap, parked when stopped."""
    if num == 16:
        t = min(t, STOPPED_16)
    if t < GO:
        f = -0.01 * (GRID.index(num) + 1)
    else:
        f, start = 0.0, GO
        for d in durations:
            if d is None or t < start + d:
                f += (t - start) / (d or 40.4)
                break
            f, start = f + 1, start + d
        else:
            f += (t - start) / durations[-1]  # the slow-down lap
    a = 2 * math.pi * f
    return round(RADIUS * math.cos(a)), round(RADIUS * math.sin(a))


# ---- a qualifying (12 cars) ---------------------------------------------------------------

QUALI = 9002
Q0 = iso("2026-03-28T06:00:00Z")
P1, P2, P3 = Q0, Q0 + 1620, Q0 + 3000  # green lights
RED, RESUME = P1 + 300, P1 + 420  # a red flag in Q1: its clock stops for two minutes
Q_CARS = list(range(1, 13))


def quali_world() -> dict:
    laps, flying = [], []
    for i, num in enumerate(Q_CARS):
        runs = [(P1 + 30 + 4 * i, 80.0 + 0.1 * i, 1)]  # Q1: car 1 fastest, car 12 out
        if num != 12:
            runs.append((P2 + 30 + 4 * i, 79.5 - 0.1 * i if num != 1 else 80.5, 2))  # Q2: car 1 out
        if num not in (1, 12):
            runs.append((P3 + 30 + 4 * i, 79.0 + 0.05 * i, 3))
        prev_end = None
        for exit_, fly, part in runs:  # out-lap (90 s on track), flying lap, in-lap (95 s)
            n = len([r for r in laps if r["driver_number"] == num]) + 1
            # OpenF1: an out-lap after the first runs from the previous in-lap's end (garage time in)
            laps += [lap(QUALI, num, n, exit_, None if prev_end is None else exit_ + 90 - prev_end, True,
                         (None, 50.0, 40.0)),
                     lap(QUALI, num, n + 1, exit_ + 90, fly),
                     lap(QUALI, num, n + 2, exit_ + 90 + fly, 95.0)]
            flying.append((exit_ + 90 + fly, num, part, fly))
            prev_end = exit_ + 90 + fly + 95
    status = [rcm(P1 + 0.1, "SessionStatus", "SESSION STARTED", phase=1),
              rcm(RED + 0.2, "SessionStatus", "SESSION ABORTED", phase=1),
              rcm(RESUME + 0.1, "SessionStatus", "SESSION STARTED", phase=1),
              rcm(P1 + 1200 + 0.1, "SessionStatus", "SESSION FINISHED", phase=1),
              rcm(P2 + 0.1, "SessionStatus", "SESSION STARTED", phase=2),
              rcm(P2 + 900 + 0.1, "SessionStatus", "SESSION FINISHED", phase=2),
              rcm(P3 + 0.1, "SessionStatus", "SESSION STARTED", phase=3),
              rcm(P3 + 780 + 0.1, "SessionStatus", "SESSION FINISHED", phase=3)]
    flags = [rcm(P1, "Flag", "GREEN LIGHT - PIT EXIT OPEN", flag="GREEN", scope="Track", phase=1),
             rcm(RED, "Flag", "RED FLAG", flag="RED", scope="Track", phase=1),
             rcm(RED + 30, "Flag", "TRACK CLEAR", flag="CLEAR", scope="Track", phase=1),
             rcm(RESUME, "Flag", "GREEN LIGHT - PIT EXIT OPEN", flag="GREEN", scope="Track", phase=1),
             rcm(P1 + 1200, "Flag", "CHEQUERED FLAG", flag="CHEQUERED", scope="Track", phase=1),
             rcm(P2, "Flag", "GREEN LIGHT - PIT EXIT OPEN", flag="GREEN", scope="Track", phase=2),
             rcm(P2 + 900, "Flag", "CHEQUERED FLAG", flag="CHEQUERED", scope="Track", phase=2),
             rcm(P3, "Flag", "GREEN LIGHT - PIT EXIT OPEN", flag="GREEN", scope="Track", phase=3),
             rcm(P3 + 780, "Flag", "CHEQUERED FLAG", flag="CHEQUERED", scope="Track", phase=3)]
    return {
        "sessions": [session(QUALI, "Qualifying", "Qualifying", Q0, Q0 + 3600)],
        "drivers": [driver(n, f"Q{n:02d}", "Quinn", f"Racer{n}", "Team Q", "777777", QUALI) for n in Q_CARS],
        "laps": laps,
        "stints": [{"driver_number": n, "stint_number": 1, "lap_start": 1, "lap_end": 9, "compound": "SOFT",
                    "tyre_age_at_start": 0} for n in Q_CARS],
        "position": quali_positions(flying),
        "race_control": status + flags,
        "session_result": [{"driver_number": n, "position": n} for n in Q_CARS],
    }


def quali_positions(flying: list[tuple]) -> list[dict]:
    """The official order as each flying lap lands: by best in the running part, knock-outs
    below in the order they went out (what OpenF1's position table holds)."""
    order, out, best = list(Q_CARS), [], {}
    rows = [{"date": Z(P1 - 600), "driver_number": n, "position": i, "session_key": QUALI} for i, n in enumerate(order, 1)]
    for part, ko in ((1, None), (2, 12), (3, 1)):
        if ko:
            out.insert(0, ko)
        for t, num, p, sec in sorted(f for f in flying if f[2] == part):
            best[(num, p)] = sec
            running = [n for n in order if n not in out]
            rank = {n: k for k, n in enumerate(running)}
            new = sorted(running, key=lambda n: (best.get((n, part), math.inf), rank[n])) + out
            rows += [{"date": Z(t), "driver_number": n, "position": i, "session_key": QUALI}
                     for i, n in enumerate(new, 1) if order.index(n) + 1 != i]
            order = new
    return rows


# ---- a practice (3 cars, one deleted lap) ------------------------------------------------

PRACTICE = 9003
F0 = iso("2026-03-27T02:30:00Z")


def practice_world() -> dict:
    # car 7: out-lap, 1:30.000, 1:28.000 (deleted later), in-lap; cars 8 and 9: out-lap, a lap, in-lap
    laps = [lap(PRACTICE, 7, 1, F0 + 60, None, True, (None, 50.0, 40.0)), lap(PRACTICE, 7, 2, F0 + 150, 90.0),
            lap(PRACTICE, 7, 3, F0 + 240, 88.0), lap(PRACTICE, 7, 4, F0 + 328, 100.0),
            lap(PRACTICE, 8, 1, F0 + 70, None, True, (None, 50.0, 40.0)), lap(PRACTICE, 8, 2, F0 + 160, 89.0),
            lap(PRACTICE, 8, 3, F0 + 249, 100.0),
            lap(PRACTICE, 9, 1, F0 + 80, None, True, (None, 50.0, 40.0)), lap(PRACTICE, 9, 2, F0 + 170, 92.0),
            lap(PRACTICE, 9, 3, F0 + 262, 100.0)]
    pos = [(F0 - 600, {7: 1, 8: 2, 9: 3}), (F0 + 249.0, {8: 1, 7: 2}), (F0 + 328.0, {7: 1, 8: 2}),
           (F0 + 412.0, {8: 1, 7: 2})]
    return {
        "sessions": [session(PRACTICE, "Practice", "Practice 1", F0, F0 + 3600)],
        "drivers": [driver(n, f"P{n:02d}", "Pat", f"Driver{n}", "Team P", "555555", PRACTICE) for n in (7, 8, 9)],
        "laps": laps,
        "stints": [{"driver_number": n, "stint_number": 1, "lap_start": 1, "lap_end": 4, "compound": "HARD",
                    "tyre_age_at_start": 0} for n in (7, 8, 9)],
        "position": [{"date": Z(t), "driver_number": n, "position": p} for t, o in pos for n, p in o.items()],
        "race_control": [rcm(F0 + 0.1, "SessionStatus", "SESSION STARTED"),
                         rcm(F0, "Flag", "GREEN LIGHT - PIT EXIT OPEN", flag="GREEN", scope="Track"),
                         rcm(F0 + 400, "Other", "CAR 7 (P07) TIME 1:28.000 DELETED - TRACK LIMITS AT TURN 4 LAP 4 11:35:30"),
                         rcm(F0 + 3600, "Flag", "CHEQUERED FLAG", flag="CHEQUERED", scope="Track"),
                         rcm(F0 + 3600.1, "SessionStatus", "SESSION FINISHED")],
        "session_result": [],
    }


# ---- serving them --------------------------------------------------------------------------

WORLDS = {RACE: race_world, QUALI: quali_world, PRACTICE: practice_world}
MEETING = [{"meeting_key": 9100, "meeting_name": "Test Grand Prix", "meeting_official_name": "TEST GRAND PRIX 2026",
            "location": "Ringtown"}]


class FakeOpenF1:
    """api.openf1.org for the worlds above: filters by session_key / driver_number, 404 for no rows."""

    def __init__(self, worlds: dict):
        self.worlds = worlds
        self.calls: list[tuple[str, dict]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.host != "api.openf1.org":
            return httpx.Response(401)  # F1's archive since 2026-10-18
        ep = request.url.path.rsplit("/", 1)[-1]
        q = dict(request.url.params)
        self.calls.append((ep, q))
        if ep == "meetings":
            rows = MEETING
        elif "session_key" not in q:
            rows = []  # the year's calendar: nothing scheduled
        else:
            rows = self.worlds.get(int(q["session_key"]), {}).get(ep, [])
            if "driver_number" in q:
                rows = [r for r in rows if str(r["driver_number"]) == q["driver_number"]]
        return httpx.Response(200, json=rows) if rows else httpx.Response(404, json={"detail": "No results found."})


def built(tmp_path_factory, key: int, world: dict | None = None) -> SessionTimeline:
    fake = FakeOpenF1({key: world or WORLDS[key]()})

    async def go():
        async with httpx.AsyncClient(transport=httpx.MockTransport(fake)) as client:
            return await fetch(OpenF1(client, pace=0, retry=0), key, time.time())

    tables = asyncio.run(go())
    d = tmp_path_factory.mktemp(f"openf1-{key}")
    meta = build(tables, d)
    return SessionTimeline(d, meta["t0"])


@pytest.fixture(scope="module")
def race(tmp_path_factory) -> SessionTimeline:
    return built(tmp_path_factory, RACE)


@pytest.fixture(scope="module")
def quali(tmp_path_factory) -> SessionTimeline:
    return built(tmp_path_factory, QUALI)


@pytest.fixture(scope="module")
def practice(tmp_path_factory) -> SessionTimeline:
    return built(tmp_path_factory, PRACTICE)


E = 0.001  # stream offsets are whole milliseconds: "at" an event means just after its time


def row(tl: SessionTimeline, t: float, num: int) -> dict:
    return next(r for r in tl.state(t)["tower"] if r["num"] == str(num))


def order(tl: SessionTimeline, t: float) -> list[str]:
    return [r["num"] for r in tl.state(t)["tower"]]


def timing_data(tl: SessionTimeline, t: float) -> dict:
    return tl.topics["TimingData"].at(t - tl.t0)


# ---- the race ---------------------------------------------------------------------------


def test_race_session_info_and_drivers(race):
    st = race.state(GO - 60)
    assert st["available"] and st["status"] == "Inactive"
    assert st["session"] == {"key": RACE, "name": "Race", "type": "Race", "meeting": "Test Grand Prix"}
    info = race.info()
    assert info["Meeting"]["Circuit"] == {"Key": 46, "ShortName": "Ringtown"}
    assert info["StartDate"] == "2026-03-29T14:00:00" and info["GmtOffset"] == "09:00:00"  # local, like the feed
    r = row(race, GO - 60, 1)
    assert (r["code"], r["name"], r["team"], r["color"]) == ("AAA", "Ann Alpha", "Team One", "#FF8000")
    assert st["clock"] == {"remaining": None, "lap": 1, "laps": 6}
    assert st["weather"] == {"air": 21.5, "track": 33.0, "humidity": 55.0, "rain": False, "windSpeed": 1.2,
                             "windDir": 182}
    assert race.state(R0 - 3601)["available"] is False  # t0 = an hour before the scheduled start


def test_a_lap_time_shows_when_the_lap_ends_never_before(race):
    end = GO + 43.0 + 40.0  # car 1's lap 2 ends as its lap 3 starts
    assert row(race, end - 0.01, 1)["last"] is None  # a race's first lap has no time (it starts on the grid)
    r = row(race, end + E, 1)
    assert (r["last"], r["best"], r["lastFlag"]) == ("40.000", "40.000", "overall")
    assert row(race, end + E, 44)["last"] is None  # 44 crosses 0.4 s later, slower: green, not purple
    r = row(race, GO + 83.4 + E, 44)
    assert (r["last"], r["best"], r["lastFlag"]) == ("40.200", "40.200", "personal")
    assert row(race, GO + 83.4 + E, 1)["lastFlag"] == "overall"
    # Each sector time as its sector ends (as the feed published it, a moment after the line).
    s1 = GO + 43.0 + 12.0 + timing_openf1.PUBLISH_LAG  # lap 2's first sector
    sectors = lambda t: timing_data(race, t)["Lines"]["1"]["Sectors"]  # noqa: E731
    assert sectors(s1 - 0.01)[0]["Value"] == "12.900"  # lap 1's
    assert sectors(s1 + E)[0]["Value"] == "12.000"


def test_positions_and_gaps_change_at_their_own_time(race):
    assert order(race, GO + 19.99) == ["44", "1", "16", "4"]  # the grid
    assert order(race, GO + 20.0 + E) == ["1", "44", "16", "4"]
    t = GO + 43.2 + 0.4  # 44's first gap, as it crossed the line
    assert row(race, t - 0.01, 44)["gap"] is None
    r = row(race, t + E, 44)
    assert (r["gap"], r["interval"]) == ("+0.200", "+0.200")
    assert row(race, t + E, 1)["gap"] == "LAP 2"  # the leader's: the lap it's on
    assert (row(race, GO + 250 + E, 4)["gap"], row(race, GO + 250 + E, 4)["interval"]) == ("1 L", "+5.123")
    r = row(race, GO + 255 + E, 4)  # a row with only a gap leaves the interval as it was
    assert (r["gap"], r["interval"]) == ("+26.600", "+5.123")


def test_lap_count(race):
    assert race.state(GO + 42.9)["clock"]["lap"] == 1
    assert race.state(GO + 43.0 + E)["clock"]["lap"] == 2  # the leader began lap 2
    assert race.state(GO + 300)["clock"] == {"remaining": None, "lap": 6, "laps": 6}


def test_pit_stop_tyres_and_tyre_age(race):
    r = row(race, GO + 119.9, 44)  # 2 laps on a used set (2 laps old at the start)
    assert (r["inPit"], r["pits"], r["tyre"], r["tyreAge"], r["newTyre"]) == (False, 0, "MEDIUM", 4, False)
    r = row(race, GO + 120.1, 44)  # pit entry = exit - lane time
    assert (r["inPit"], r["pits"], r["tyre"]) == (True, 1, "MEDIUM")
    assert row(race, GO + 139.0, 44)["tyreAge"] == 5  # its in-lap ended in the pit lane
    assert row(race, GO + 144.9, 44)["tyre"] == "MEDIUM"  # the new set shows at the exit, not before
    r = row(race, GO + 145.0 + E, 44)
    assert (r["inPit"], r["pitOut"], r["tyre"], r["tyreAge"], r["newTyre"]) == (False, True, "HARD", 0, True)
    assert r["stints"] == [{"compound": "MEDIUM", "laps": 5, "new": False}, {"compound": "HARD", "laps": 0, "new": True}]
    out_s1 = GO + 138.6 + 20.0 + timing_openf1.PUBLISH_LAG  # PIT OUT until the out-lap's first sector ends
    assert row(race, out_s1 - 0.01, 44)["pitOut"] and not row(race, out_s1 + E, 44)["pitOut"]
    assert row(race, GO + 186.8 + E, 44)["tyreAge"] == 1


def test_a_pit_lane_starts_phantom_stint_is_repaired(race):
    r = row(race, GO + 150, 4)  # OpenF1 says HARD from lap 2: really the start set until its stop
    assert (r["tyre"], r["tyreAge"], len(r["stints"])) == ("MEDIUM", 3, 1)
    r = row(race, GO + 186.0 + E, 4)
    assert (r["tyre"], r["pits"]) == ("HARD", 1)
    assert r["stints"] == [{"compound": "MEDIUM", "laps": 4, "new": True}, {"compound": "HARD", "laps": 0, "new": True}]
    rows = [{"stint_number": 1, "lap_start": 1, "lap_end": 1, "compound": "SOFT"},
            {"stint_number": 2, "lap_start": 2, "lap_end": 61, "compound": "MEDIUM"}]
    assert [(r["lap_start"], r["lap_end"]) for r in _repair_stints(rows, [35])] == [(1, 35), (36, 61)]
    assert [(r["lap_start"], r["lap_end"]) for r in _repair_stints(rows, [1])] == [(1, 1), (2, 61)]  # a real stop
    same = [dict(rows[0], compound="MEDIUM"), rows[1]]
    assert [(r["lap_start"], r["lap_end"]) for r in _repair_stints(same, [])] == [(1, 61)]


def test_grid_and_tyre_history_fields(race):
    rows = race.state(GO + 300)["tower"]
    assert {r["num"]: r["grid"] for r in rows} == {"44": 1, "1": 2, "16": 3, "4": 4}
    assert [r["pos"] for r in rows] == [1, 2, 3, 4]
    r = next(r for r in rows if r["num"] == "1")  # its drive-through didn't change tyres: one set
    assert (r["stints"], r["pits"], r["tyreAge"]) == ([{"compound": "MEDIUM", "laps": 6, "new": True}], 1, 6)
    app = race.topics["TimingAppData"].at(GO + 300 - race.t0)["Lines"]["1"]["Stints"]
    assert [s["TyresNotChanged"] for s in app] == ["0", "1"]


def test_tyre_sets_fold_the_feeds_pass_through_stints():
    from fone.timing_state import _tyre_sets
    # A pit lane start in the live feed: a second stint on the same set, counted for a while, then
    # turned into the real second set when the car stops.
    start = {"Compound": "SOFT", "New": "true", "TyresNotChanged": "0", "TotalLaps": 13}
    phantom = {"Compound": "SOFT", "New": "true", "TyresNotChanged": "1", "TotalLaps": 6}
    assert _tyre_sets([start, phantom]) == [{"compound": "SOFT", "laps": 13, "new": True}]
    stopped = dict(phantom, Compound="MEDIUM", TyresNotChanged="0", TotalLaps=0)
    assert _tyre_sets([start, stopped]) == [{"compound": "SOFT", "laps": 13, "new": True},
                                            {"compound": "MEDIUM", "laps": 0, "new": True}]
    # A new set the feed hasn't identified yet (UNKNOWN for a few seconds) is a set of its own.
    pending = {"Compound": "UNKNOWN", "New": "false", "TyresNotChanged": "1", "TotalLaps": 0}
    assert _tyre_sets([start, pending]) == [{"compound": "SOFT", "laps": 13, "new": True},
                                            {"compound": "UNKNOWN", "laps": 0, "new": False}]


def test_safety_car_then_track_clear(race):
    track = lambda t: race.state(t)["track"]  # noqa: E731
    assert track(GO + 95.4)["flag"] == "GREEN"
    assert track(GO + 95.6)["flag"] == "YELLOW"  # whole-second race control times carried ~0.5 s on
    assert track(GO + 100.6) == {"status": "SCDeployed", "flag": "SC", "message": "SAFETY CAR DEPLOYED"}
    assert track(GO + 165)["flag"] == "SC"  # "in this lap" and sector clears don't end it
    t = track(GO + 170.6)
    assert (t["flag"], t["status"], t["message"]) == ("GREEN", "AllClear", "TRACK CLEAR")


def test_a_race_without_status_rows_starts_at_lights_out(tmp_path_factory):
    # OpenF1 has no SessionStatus rows for older sessions: the flags and the laps say as much,
    # and a race's first green light (the pit exit opening for the laps to the grid) isn't its start.
    world = race_world()
    world["race_control"] = [r for r in world["race_control"] if r["category"] != "SessionStatus"]
    tl = built(tmp_path_factory, RACE, world)
    assert [tl.state(t)["status"] for t in (R0 - 1700, GO - 1, GO + 1, GO + 244)] == [
        "Inactive", "Inactive", "Started", "Finished"]
    assert row(tl, GO - 1, 1)["tyre"] == "MEDIUM" and row(tl, GO - 400, 1)["tyre"] == "UNKNOWN"


def test_chequered_flag_ends_it(race):
    st = race.state(GO + 243.3)
    assert (st["status"], st["track"]["flag"]) == ("Started", "GREEN")
    st = race.state(GO + 243.5)
    assert (st["status"], st["track"]["flag"]) == ("Finished", "CHEQUERED")


def test_a_retirement_shows_once_the_car_has_stopped(race):
    stand = STOPPED_16 + timing_openf1.STOP_SECONDS  # standing still this long, by its locations
    r = row(race, stand - 0.5, 16)
    assert not r["retired"] and r["gap"] is not None
    r = row(race, stand + 0.5, 16)
    assert r["retired"] and r["gap"] is None  # the feed blanks a stopped car's gaps
    assert not any(x["retired"] for x in race.state(stand + 0.5)["tower"] if x["num"] != "16")


def test_positions_window_and_track_outline(race):
    cars = race.positions(GO + 50, GO + 60)
    assert set(cars) == {"1", "44", "16", "4"}
    for samples in cars.values():
        ts = [s[0] for s in samples]
        assert ts == sorted(ts) and ts[-1] <= GO + 60 and ts[1] >= GO + 50
        assert all(math.hypot(x, y) == pytest.approx(RADIUS, abs=2) for _, x, y in samples)
    found = race.positions(GO - 600, GO - 590)["44"]
    assert {(x, y) for _, x, y in found} == {(1996, -126)}  # on the grid, standing
    tr = track_outline([race])
    assert tr["source"] == {"session": RACE, "driver": "1", "lap": 40.0}
    assert 150 <= len(tr["outline"]) <= 170  # 4 Hz over a 40 s lap
    assert all(math.hypot(x, y) == pytest.approx(RADIUS, abs=2) for x, y in tr["outline"])


# ---- qualifying -----------------------------------------------------------------------------


def test_quali_bests_gaps_and_order(quali):
    t1 = P1 + 30 + 90 + 80.0  # car 1's flying lap
    assert row(quali, t1 - 0.01, 1)["best"] is None
    r = row(quali, t1 + E, 1)
    assert (r["pos"], r["best"], r["last"], r["lastFlag"], r["gap"]) == (1, "1:20.000", "1:20.000", "overall", None)
    t2 = P1 + 34 + 90 + 80.1
    r = row(quali, t2 + E, 2)
    assert (r["pos"], r["best"], r["gap"], r["interval"]) == (2, "1:20.100", "+0.100", "+0.100")
    st = quali.state(P1 + 600)
    assert [r["num"] for r in st["tower"]] == [str(n) for n in Q_CARS]
    assert row(quali, P1 + 600, 12)["gap"] == "+1.100"


def test_quali_red_flag_stops_the_clock(quali):
    clock = lambda t: quali.state(t)["clock"]["remaining"]  # noqa: E731
    assert clock(P1 - 100) == "18:00"
    assert clock(P1 + 60.1) == "17:00"  # green at P1 + 0.1
    assert quali.state(RED + 10)["track"]["flag"] == "RED"
    st = quali.state(RED + 60)  # track clear, session still stopped: the dashboard's RED FLAG
    assert (st["status"], clock(RED + 60), clock(RED + 100)) == ("Aborted", "13:00", "13:00")
    assert quali.state(RESUME - 50)["status"] == "Inactive"  # about a minute before the restart
    assert clock(RESUME + 60.1) == "12:00"
    st = quali.state(P1 + 1210)
    assert (st["status"], st["track"]["flag"], st["clock"]["remaining"]) == ("Finished", "CHEQUERED", "00:00")


def test_quali_part_change_and_knock_outs(quali):
    before, after = P2 - timing_openf1.PART_LEAD - 1, P2 - timing_openf1.PART_LEAD + 1
    st = quali.state(before)
    assert st["part"] == 1 and not any(r["knockedOut"] for r in st["tower"]) and st["status"] == "Finished"
    st = quali.state(after)
    assert st["part"] == 2 and st["clock"]["remaining"] == "15:00"
    out = [r for r in st["tower"] if r["knockedOut"]]
    assert [(r["num"], r["pos"], r["best"], r["gap"]) for r in out] == [("12", 12, "1:21.100", "+1.100")]  # its Q1 time
    r = row(quali, after, 1)
    assert (r["best"], r["last"], r["gap"]) == (None, None, None)  # a new part: times start over
    assert quali.state(P2 + 30.1)["clock"]["remaining"] == "14:30"
    st = quali.state(P3 - 30)
    assert st["part"] == 3
    assert [r["num"] for r in st["tower"] if r["knockedOut"]] == ["1", "12"]
    assert row(quali, P3 - 30, 1)["best"] == "1:20.500"  # car 1 went out in Q2: its Q2 time


def test_quali_out_lap_time_counts_from_the_last_lap_line(quali):
    # Car 3's Q2 out-lap: OpenF1's duration runs from its Q1 in-lap's end (garage time included),
    # the feed shows it when the out-lap ends, and it's never a best.
    q1_in_end = P1 + 38 + 90 + 80.2 + 95
    fly_start = P2 + 38 + 90
    assert row(quali, fly_start - 0.01, 3)["last"] is None
    r = row(quali, fly_start + E, 3)
    assert r["last"] == timing_openf1.lap_text(fly_start - q1_in_end) and r["lastFlag"] == "none" and r["best"] is None


def test_quali_pit_lane_from_laps(quali):
    exit_ = P1 + 30
    assert row(quali, exit_ - 0.01, 1)["inPit"]  # in the garage until the out-lap
    r = row(quali, exit_ + E, 1)
    assert not r["inPit"] and r["pitOut"]
    in_end = exit_ + 90 + 80.0 + 95.0 + timing_openf1.PUBLISH_LAG
    assert not row(quali, in_end - 0.01, 1)["inPit"]
    r = row(quali, in_end + E, 1)
    assert r["inPit"] and r["pits"] == 1 and r["last"] == "1:35.000" and r["lastFlag"] == "none"


# ---- practice -----------------------------------------------------------------------------


def test_practice_order_gaps_and_a_deleted_lap(practice):
    st = practice.state(F0 + 330.1)
    assert [(r["num"], r["best"], r["gap"], r["interval"]) for r in st["tower"]] == [
        ("7", "1:28.000", None, None), ("8", "1:29.000", "+1.000", "+1.000"), ("9", "1:32.000", "+4.000", "+3.000")]
    assert st["clock"]["remaining"] == "54:30"
    # Race control deletes 1:28.000 at +400; the feed drops it as the car loses its place for it.
    r = row(practice, F0 + 411.9, 7)
    assert (r["pos"], r["best"]) == (1, "1:28.000")
    st = practice.state(F0 + 412.0 + E)
    assert [(r["num"], r["best"], r["gap"]) for r in st["tower"]][:2] == [("8", "1:29.000", None), ("7", "1:30.000", "+1.000")]
    assert st["track"]["message"].startswith("CAR 7 (P07) TIME 1:28.000 DELETED")


def test_practice_session_end(practice):
    st = practice.state(F0 + 3601)
    assert (st["status"], st["track"]["flag"], st["clock"]["remaining"]) == ("Finished", "CHEQUERED", "00:00")


# ---- the service: when the archive refuses ----------------------------------------------


def service(tmp_path, fake, **settings) -> TimingService:
    opts = {"openf1_pace": 0, "openf1_retry": 0.01, "retry_seconds": 0.2, **settings}
    return make_service(tmp_path, handler=fake, **opts)


def wait_rebuilt(svc: TimingService, key: int, timeout: float = 30.0) -> str:
    deadline = time.time() + timeout
    while time.time() < deadline:
        got = svc._openf1.get(key)
        if got and key not in svc._fetching:
            return got.result
        time.sleep(0.05)
    raise AssertionError("no OpenF1 attempt")


def test_archive_401_falls_back_to_openf1(tmp_path):
    fake = FakeOpenF1({RACE: race_world()})
    svc = service(tmp_path, fake)
    with TestClient(app_for(svc)) as c:
        url = f"/api/timing/session/{RACE}"
        first = c.get(f"{url}/state", params={"t": GO + 100}).json()
        assert first["available"] is False and first["reason"] in ("downloading the timing archive",
                                                                     "downloading timing from OpenF1")
        assert wait_rebuilt(svc, RACE) == "ok"
        st = c.get(f"{url}/state", params={"t": GO + 100.6}).json()
        assert st["available"] and st["track"]["flag"] == "SC" and len(st["tower"]) == 4
        assert svc._attempts[RACE].result == "unknown session"  # what the archive said
        meta = svc.store.meta(RACE)
        assert (meta["source"], meta["complete"], meta["meeting"], meta["name"]) == ("openf1", True, 9100, "Race")
        tr = c.get(f"{url}/track").json()
        assert tr["available"] and tr["outline"] and tr["source"]["session"] == RACE
        assert c.get(f"{url}/positions", params={"from": GO + 50, "to": GO + 52}).json()["cars"]
        # A rebuild has its own positions: browser uploads are turned away like an archive's.
        body = {"messages": [{"Timestamp": Z(GO + 60).replace("+00:00", "Z"), "Entries": {"1": {"X": 1, "Y": 2}}}]}
        assert c.post(f"{url}/positions", json=body).json()["reason"] == "archived"
        assert c.get("/api/timing/status").json()["openf1"][str(RACE)]["result"] == "ok"
    locations = [q for ep, q in fake.calls if ep == "location"]
    assert len(locations) == 4 and all("date>" in q and "date<" in q for q in locations)  # per car, in a window


def test_one_rebuild_at_a_time(tmp_path):
    fake = FakeOpenF1({RACE: race_world(), PRACTICE: practice_world()})
    svc = service(tmp_path, fake)

    async def both():
        return await asyncio.gather(svc.fetch_openf1(RACE), svc.fetch_openf1(PRACTICE))

    assert asyncio.run(both()) == ["ok", "ok"]
    keys = [q.get("session_key") for ep, q in fake.calls if ep != "meetings"]
    first = keys[0]
    assert keys == [first] * keys.count(first) + [k for k in keys if k != first]  # never interleaved
    assert asyncio.run(svc.fetch_openf1(RACE)) == "stored"  # never twice


def test_nothing_on_openf1_is_reported_and_not_asked_again(tmp_path):
    fake = FakeOpenF1({})
    svc = service(tmp_path, fake)
    asyncio.run(svc._fetch_task(424242))
    assert svc._openf1[424242].result == "no data"
    assert svc._missing_reason(424242) == "no timing data for this session"
    asked = len(fake.calls)
    asyncio.run(svc._fetch_task(424242))  # retried by the dashboard a minute later: OpenF1 isn't
    assert len(fake.calls) == asked
    svc._openf1[424242] = _Attempt(time.time() - 7 * 3600, "no data")  # hours later it is
    asyncio.run(svc._fetch_task(424242))
    assert len(fake.calls) > asked


def test_not_before_the_session_is_well_over(tmp_path):
    fake = FakeOpenF1({RACE: race_world()})
    svc = service(tmp_path, fake)
    svc._set_schedule([dict(race_world()["sessions"][0], date_start=Z(time.time() - 3600),
                            date_end=Z(time.time() - 600))])
    asyncio.run(svc._fetch_task(RACE))
    assert svc._openf1[RACE].result == "not over" and fake.calls == []  # the schedule says so: not even asked
    assert svc._missing_reason(RACE) == "timing comes from OpenF1 half an hour after the session"
    # OpenF1's own answer for a session outside the schedule, or one that overran
    world = race_world()
    world["sessions"][0]["date_end"] = Z(time.time() - 600)
    svc = service(tmp_path / "b", FakeOpenF1({RACE: world}))
    assert asyncio.run(svc.fetch_openf1(RACE)) == "not over"
    world["sessions"][0]["date_end"] = Z(time.time() - 3600)
    world["race_control"] = [r for r in world["race_control"] if r["message"] != "SESSION FINISHED"]
    assert asyncio.run(svc.fetch_openf1(RACE)) == "not over"  # no finish yet: overran


def test_never_over_a_live_capture(tmp_path):
    fake = FakeOpenF1({RACE: race_world()})
    svc = service(tmp_path, fake)
    svc.store.write_meta(RACE, {"key": RACE, "source": "live", "t0": GO, "ended": True})
    asyncio.run(svc._fetch_task(RACE))
    assert RACE not in svc._openf1 and fake.calls == [] and svc.store.meta(RACE)["source"] == "live"


def test_plan_rebuilds_a_recently_ended_session_not_captured(tmp_path):
    fake = FakeOpenF1({RACE: race_world()})
    svc = service(tmp_path, fake, record_live=True)
    svc._set_schedule(race_world()["sessions"])
    end = R0 + 7200
    assert RACE in svc.plan(end + 11 * 60)[1]
    asyncio.run(svc._fetch_task(RACE))
    assert svc.store.meta(RACE)["source"] == "openf1"
    # The capture window is still open (4 h from the start), but no capture goes over a rebuild.
    assert svc.plan(end + 40 * 60)[0] == []


def test_openf1_retries_when_rate_limited(tmp_path):
    hits = []

    def flaky(request):
        hits.append(str(request.url))
        if len(hits) <= 2:
            return httpx.Response(429)
        return httpx.Response(200, json=[{"session_key": 7}])

    async def go():
        async with httpx.AsyncClient(transport=httpx.MockTransport(flaky)) as client:
            return await OpenF1(client, pace=0, retry=0.01).get("sessions", session_key=7)

    assert asyncio.run(go()) == [{"session_key": 7}] and len(hits) == 3


def test_openf1_is_asked_a_second_apart_and_waits_out_a_retry_after(monkeypatch):
    """429s came at 1-2 s apart from one address (a server may share it with others asking):
    a second between requests, the backoff doubling, and a 429's Retry-After waited out when
    it says longer; one too long for a rebuild to wait is given up, for the session's next try."""
    assert OpenF1(None).pace == 1.0 and TimingSettings().openf1_pace == 1.0
    slept, real_sleep = [], asyncio.sleep

    async def sleep(d, *a, **k):  # (time stands still: what would be waited is noted)
        slept.append(round(d, 1))
        await real_sleep(0)

    monkeypatch.setattr(timing_openf1.asyncio, "sleep", sleep)
    answers = []

    def api(request):
        return answers.pop(0)

    async def go(retry=0.5):
        async with httpx.AsyncClient(transport=httpx.MockTransport(api)) as client:
            f1 = OpenF1(client, retry=retry)
            return await f1.get("laps", session_key=7), await f1.get("stints", session_key=7)

    answers[:] = [httpx.Response(429, headers={"Retry-After": "30"}), httpx.Response(429),
                  httpx.Response(200, json=[1]), httpx.Response(200, json=[2])]
    assert asyncio.run(go()) == ([1], [2])
    # (Retry-After over the first backoff; then the backoff, doubled; then a second's pace)
    assert slept == [30.0, 1.0, 1.0]
    slept.clear()
    answers[:] = [httpx.Response(429, headers={"Retry-After": "1"}), httpx.Response(200, json=[1]),
                  httpx.Response(200, json=[2])]
    assert asyncio.run(go(retry=4)) == ([1], [2]) and slept == [4.0, 1.0]  # (the backoff, longer)
    answers[:] = [httpx.Response(429, headers={"Retry-After": "3600"})]
    with pytest.raises(timing_openf1.OpenF1Error, match="HTTP 429, retry after 3600 s"):
        asyncio.run(go())
    assert answers == []  # (asked once)
    # Retry-After as an HTTP date, or nonsense
    now = 1790000000.0
    date = datetime.fromtimestamp(now + 42, timezone.utc).strftime("%a, %d %b %Y %H:%M:%S GMT")
    assert timing_openf1.retry_after(httpx.Response(429, headers={"Retry-After": date}), now) == 42
    assert [timing_openf1.retry_after(httpx.Response(429, headers=h)) for h in ({}, {"Retry-After": "soon"},
            {"Retry-After": "-5"}, {"Retry-After": "nan"})] == [None, None, 0.0, None]


def live_capture_without_positions(tmp_path) -> dict:
    """The race as our own live capture of the anonymous feed would hold it: no Position.z."""
    d = tmp_path / "timing" / str(RACE)
    d.mkdir(parents=True)
    tb = asyncio.run(_fetch_world(RACE, positions=False))
    meta = build(tb, d)
    (d / "Position.z.jsonStream").unlink(missing_ok=True)
    (d / "meta.json").write_text(json.dumps({"key": RACE, "source": "live", "t0": meta["t0"], "ended": True,
                                             "created": time.time(), "meeting": 9100}))
    return {f.name: f.read_bytes() for f in d.iterdir()}


async def _fetch_world(key: int, positions: bool = True):
    async with httpx.AsyncClient(transport=httpx.MockTransport(FakeOpenF1({key: WORLDS[key]()}))) as client:
        return await fetch(OpenF1(client, pace=0, retry=0), key, time.time(), positions=positions)


def test_a_finished_capture_without_positions_gets_openf1s(tmp_path):
    before = live_capture_without_positions(tmp_path)
    fake = FakeOpenF1({RACE: race_world()})
    svc = service(tmp_path, fake)
    with TestClient(app_for(svc)) as c:
        url = f"/api/timing/session/{RACE}"
        assert c.get(f"{url}/track").json()["available"] is False  # asks OpenF1 for them
        deadline = time.time() + 20
        while (svc._fills.get(RACE) or _Attempt(0, "")).result in ("", "downloading") and time.time() < deadline:
            time.sleep(0.05)
        assert svc._fills[RACE].result == "ok"
        assert c.get(f"{url}/positions", params={"from": GO + 50, "to": GO + 52}).json()["cars"].keys() == {
            "1", "44", "16", "4"}
        svc._track_miss.clear()  # (a miss is remembered for a minute)
        assert c.get(f"{url}/track").json()["available"]
        assert c.get(f"{url}/state", params={"t": GO + 100.6}).json()["track"]["flag"] == "SC"
    d = tmp_path / "timing" / str(RACE)
    after = {f.name: f.read_bytes() for f in d.iterdir()}
    assert {n for n in after if n not in before} == {"Position.z.jsonStream"}
    assert all(after[n] == before[n] for n in before)  # the capture itself untouched
    assert [ep for ep, _ in fake.calls if ep not in ("sessions", "race_control", "drivers", "location")] == []
    # Done once: a capture with positions isn't asked about again.
    assert asyncio.run(svc.fill_positions(RACE)) == "has positions"


def test_no_positions_fill_for_a_running_capture_or_a_rebuild(tmp_path):
    live_capture_without_positions(tmp_path)
    meta = json.loads((tmp_path / "timing" / str(RACE) / "meta.json").read_text())
    (tmp_path / "timing" / str(RACE) / "meta.json").write_text(json.dumps({**meta, "ended": False}))
    fake = FakeOpenF1({RACE: race_world()})
    svc = service(tmp_path, fake)
    assert asyncio.run(svc.fill_positions(RACE)) == "not a finished capture"
    (tmp_path / "timing" / str(RACE) / "meta.json").write_text(json.dumps({**meta, "source": "openf1"}))
    assert asyncio.run(svc.fill_positions(RACE)) == "not a finished capture" and fake.calls == []
