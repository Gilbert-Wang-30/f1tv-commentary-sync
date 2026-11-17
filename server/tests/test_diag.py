"""Playback diagnostics: POST from the extension, GET to read them back (diag.py)."""
import json
import time

from fastapi import FastAPI
from fastapi.testclient import TestClient

from fone.diag import DiagStore, make_router


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
    store_events = [{"t": 1.0, "type": "snap", "blob": "x" * 10000}, {"t": 2.0, "type": "seek"}]
    c = client_for(store)
    c.post("/api/diag", json={"client": "c", "events": store_events})
    again = DiagStore(tmp_path)  # a server restart
    evs = again.query(None, None, None, 10)
    assert [e["type"] for e in evs] == ["snap", "seek"] and evs[0]["truncated"] > 10000 and "blob" not in evs[0]
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


def test_rejects_garbage(tmp_path):
    c = client_for(DiagStore(tmp_path))
    assert c.post("/api/diag", json={"events": []}).status_code == 422  # no client
    assert c.post("/api/diag", json={"client": "c", "events": [{}] * 500}).status_code == 422  # too many
