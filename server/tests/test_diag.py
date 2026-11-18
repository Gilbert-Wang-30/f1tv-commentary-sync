"""Playback diagnostics: POST from the extension, GET to read them back (diag.py)."""
import json
import time
from datetime import datetime, timedelta, timezone

from fastapi import FastAPI
from fastapi.testclient import TestClient

from fone.diag import KEEP_DAYS, DiagStore, make_router


def client_for(store):
    app = FastAPI()
    app.include_router(make_router(store))
    return TestClient(app)


def test_events_round_trip_and_filter(tmp_path):
    store = DiagStore(tmp_path)
    c = client_for(store)
    t = time.time()
    body = {"client": "mac-1", "build": "0.2.15", "platform": "macOS",
            "events": [{"t": t, "type": "snap", "drift": 0.01}, {"t": t + 1, "type": "wake", "slept": 3600}]}
    assert c.post("/api/diag", json=body).json() == {"ok": True, "stored": 2}
    c.post("/api/diag", json={"client": "win", "events": [{"t": t + 2, "type": "snap"}]})
    got = c.get("/api/diag", params={"client": "mac-1"}).json()
    assert [e["type"] for e in got["events"]] == ["snap", "wake"]
    assert got["events"][1]["slept"] == 3600 and got["events"][1]["build"] == "0.2.15"
    assert set(got["clients"]) == {"mac-1", "win"} and got["clients"]["mac-1"]["platform"] == "macOS"
    assert [e["type"] for e in c.get("/api/diag", params={"type": "wake"}).json()["events"]] == ["wake"]
    assert len(c.get("/api/diag", params={"since": t + 0.5}).json()["events"]) == 2
    assert len(c.get("/api/diag", params={"limit": 1}).json()["events"]) == 1


def test_survives_a_restart_and_caps_oversized_events(tmp_path):
    store = DiagStore(tmp_path)
    # (a sound engine's snapshot runs to ~4.4 kB: whole)
    store_events = [{"t": 1.0, "type": "snap", "blob": "x" * 10000}, {"t": 2.0, "type": "seek"},
                    {"t": 3.0, "type": "snap", "sound": "y" * 4400}]
    c = client_for(store)
    c.post("/api/diag", json={"client": "c", "events": store_events})
    again = DiagStore(tmp_path)  # a server restart
    evs = again.query(None, None, None, 10)
    assert [e["type"] for e in evs] == ["snap", "seek", "snap"] and evs[0]["truncated"] > 10000 and "blob" not in evs[0]
    assert evs[2]["sound"] == "y" * 4400 and "truncated" not in evs[2]
    files = list(tmp_path.glob("*.jsonl"))
    assert len(files) == 1 and all(json.loads(line)["client"] == "c" for line in files[0].read_text().splitlines())


def test_whats_kept_is_bounded_and_answerable(tmp_path, monkeypatch):
    store = DiagStore(tmp_path)
    c = client_for(store)
    huge = "x" * 10000
    body = '{"client": "c", "events": [{"t": 1, "type": "%s"}, {"t": "%s", "type": "seek"}, ' \
           '{"t": 2, "type": "snap", "drift": Infinity}, {"t": NaN, "type": ["a"]}]}' % (huge, huge)
    assert c.post("/api/diag", content=body, headers={"content-type": "application/json"}).json()["stored"] == 4
    evs = c.get("/api/diag").json()["events"]  # (answerable: no Infinity in it)
    assert [(e["t"], e["type"]) for e in evs] == [(1, "x" * 40), (None, "seek"), (2, "snap"), (None, "['a']")]
    assert evs[0]["truncated"] > 10000 and evs[2]["truncated"] == "not JSON" and "drift" not in evs[2]
    assert len(c.get("/api/diag", params={"since": 1.5}).json()["events"]) == 3  # (t 2; those without: by arrival)
    assert next(tmp_path.glob("*.jsonl")).stat().st_size < 2000
    # a day's file stops growing at its cap (what's posted stays in memory)
    monkeypatch.setattr("fone.diag.MAX_DAY_BYTES", 1000)
    for _ in range(3):
        c.post("/api/diag", json={"client": "c", "events": [{"t": 3, "type": "snap", "v": "y" * 500}]})
    assert next(tmp_path.glob("*.jsonl")).stat().st_size < 1000 + 600 * 2
    assert len(store.query(None, {"snap"}, None, 10)) == 4
    assert [e["type"] for e in DiagStore(tmp_path).query(None, None, None, 10)][:4] == ["x" * 40, "seek", "snap", "['a']"]


def test_a_bad_line_costs_that_line_not_the_rest_of_its_day(tmp_path):
    # (an unclean shutdown: a run of NUL bytes where the file's end hadn't been written, then the
    # next event; and lines that aren't events)
    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    ev = lambda t: json.dumps({"t": t, "type": "snap", "client": "c", "rx": t})  # noqa: E731
    (tmp_path / f"{day}.jsonl").write_bytes(
        "\n".join([ev(1), '{"t": 2, "type": "sn', ev(3), "", "[4]", "nonsense", ev(5)]).encode()
        + b"\n" + b"\0" * 3431 + ev(6).encode() + b"\n" + ev(7).encode() + b"\n")
    store = DiagStore(tmp_path)
    assert [e["t"] for e in store.query(None, None, None, 100)] == [1, 3, 5, 6, 7]
    assert store.clients["c"]["last"] == 7


def test_kept_for_days_not_for_a_number_of_files(tmp_path):
    # (a server that gets diagnostics now and then: 7 files spanned 18 days)
    today = datetime.now(timezone.utc).date()
    for ago in (0, 1, 5, KEEP_DAYS, KEEP_DAYS + 1, 12, 17):
        day = today - timedelta(days=ago)
        (tmp_path / f"{day}.jsonl").write_text(json.dumps({"t": ago, "type": "snap", "client": "c"}) + "\n")
    (tmp_path / "notes.jsonl").write_text("mine\n")
    store = DiagStore(tmp_path)
    assert sorted(e["t"] for e in store.query(None, None, None, 100)) == [0, 1, 5, KEEP_DAYS]
    client_for(store).post("/api/diag", json={"client": "c", "events": [{"t": 99, "type": "seek"}]})
    left = sorted(f.name for f in tmp_path.glob("*.jsonl"))
    assert left == sorted([f"{today - timedelta(days=ago)}.jsonl" for ago in (0, 1, 5, KEEP_DAYS)] + ["notes.jsonl"])


def test_rejects_garbage(tmp_path):
    c = client_for(DiagStore(tmp_path))
    assert c.post("/api/diag", json={"events": []}).status_code == 422  # no client
    assert c.post("/api/diag", json={"client": "c", "events": [{}] * 500}).status_code == 422  # too many
