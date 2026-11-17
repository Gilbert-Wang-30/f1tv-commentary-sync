"""Keeps fone-recorder to F1 streams.

A streamer also streams other things (games, chats). 录播姬 records every live session
(AutoRecord stays on, so if this gate is down everything still records); this polls its API
and judges each stream by its title (GATE_RECORD / GATE_SKIP). With GATE_ACTION=stop it
  - stops a recording whose title isn't F1, and deletes the seconds-old file that
    stopping leaves behind (only files the gate itself cut short, opened < 3 min ago);
  - starts recording again if the title switches to F1 mid-stream.
By default (GATE_ACTION=log) it only logs what it would stop, once per title: a filter that
doesn't fit the streamer's titles costs nothing until it's trusted.
Stdlib only; config via env (see .env.example). `python gate.py --check < titles.txt` tries
the filter on titles, one per line.
"""
import base64
import json
import os
import re
import sys
import time
import urllib.request
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

API = os.environ.get("GATE_API", "http://fone-recorder:2356").rstrip("/")
REC = Path(os.environ.get("GATE_REC", "/rec"))
POLL = float(os.environ.get("GATE_POLL", "3"))
# F1-ish titles, English or Chinese. A streamer's own tag (the 【…】 their F1 streams carry, say)
# is best added in GATE_RECORD: it catches a title with none of these words.
F1_TITLES = (r"F1|F2|F3|Formula|Grand Prix|\bGP\b|FP[123]|Qualifying|Sprint|\bRace\b"
             r"|一练|二练|三练|练习赛|排位赛|冲刺|正赛|大奖赛|发布会|围场|方程式|巡游")
RECORD = re.compile(os.environ.get("GATE_RECORD") or F1_TITLES, re.I)
SKIP = re.compile(os.environ["GATE_SKIP"], re.I) if os.environ.get("GATE_SKIP") else None
# stop: stop a recording that isn't F1 (and delete its stub); log: only say so
ACTION = (os.environ.get("GATE_ACTION") or "log").strip().lower()
# The zone of the file names' times (the recorder's template; the server's FONE_FILENAME_TZ).
TZ = ZoneInfo(os.environ.get("FONE_FILENAME_TZ") or os.environ.get("TZ") or "Asia/Shanghai")
CLEANUP_MAX_AGE = 180  # seconds: only files opened this recently are ours to delete
NAME = re.compile(r"^(\d{8}-\d{6}-\d{3})-(.*)\.(flv|xml)$")


def log(*a):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), *a, flush=True)


def auth():
    user, password = os.environ["BREC_HTTP_BASIC_USER"], os.environ["BREC_HTTP_BASIC_PASS"]
    return "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()


def api(method, path):
    req = urllib.request.Request(API + path, method=method, headers={"Authorization": auth()})
    if method == "POST":
        req.data = b""
    with urllib.request.urlopen(req, timeout=10) as r:
        body = r.read()
    return json.loads(body) if body else None


def is_f1(title):
    """True/False by title; None when there's no title to judge (then leave it alone)."""
    if not title or not title.strip():
        return None
    return bool(RECORD.search(title)) and not (SKIP and SKIP.search(title))


def folders(room):
    """The room's recording folders: its number (recorder/config.json's template) or its
    account name (an older seed's template, and 录播姬's own default)."""
    for name in dict.fromkeys(str(x) for x in (room.get("roomId"), room.get("name")) if x):
        if "/" not in name and name not in (".", "..") and (REC / name).is_dir():
            yield REC / name


def cleanup(room, stopped_at):
    """Delete the stub file(s) a just-stopped non-F1 recording left in the room's folder."""
    for f in [f for folder in folders(room) for f in folder.iterdir()]:
        m = NAME.match(f.name)
        if not m or is_f1(m.group(2)) is not False:
            continue
        try:
            opened = datetime.strptime(m.group(1), "%Y%m%d-%H%M%S-%f").replace(tzinfo=TZ).timestamp()
            st = f.stat()
        except (ValueError, OSError):
            continue
        if stopped_at - CLEANUP_MAX_AGE <= opened <= stopped_at + 5 and st.st_mtime >= opened - 5:
            f.unlink()
            log(f"deleted stub {f.name} ({st.st_size} bytes)")


def tick(pending, told):
    for room in api("GET", "/api/room"):
        oid, title = room["objectId"], room.get("title") or ""
        f1 = is_f1(title)
        if room.get("recording") and f1 is False:
            if ACTION == "stop":
                api("POST", f"/api/room/{oid}/stop")
                log(f"room {room['roomId']}: not F1 ({title!r}) - stopped recording")
                pending.append((room, time.time()))
            elif (room["roomId"], title) not in told:  # (once per title, not every poll)
                told.add((room["roomId"], title))
                log(f"room {room['roomId']}: not F1 ({title!r}) - would stop recording (GATE_ACTION=stop)")
        elif ACTION == "stop" and room.get("streaming") and not room.get("recording") and f1 \
                and not room.get("autoRecordForThisSession", True):
            # Only a session this gate stopped has autoRecordForThisSession off; any other
            # not-recording gap (reconnects, retries) is 录播姬's own business.
            api("POST", f"/api/room/{oid}/start")
            log(f"room {room['roomId']}: F1 ({title!r}) - started recording")
    # Give the recorder a moment to close the file before removing it.
    for item in [p for p in pending if time.time() - p[1] >= 5]:
        pending.remove(item)
        cleanup(*item)


def main():
    log(f"gate up: {API}, record if title matches /{RECORD.pattern}/"
        + (f", skip /{SKIP.pattern}/" if SKIP else "")
        + ("; stops the others" if ACTION == "stop" else "; only logs the others (GATE_ACTION=stop stops them)"))
    if ACTION not in ("stop", "log"):
        log(f"GATE_ACTION={ACTION!r} is neither stop nor log: only logging")
    auth()  # (no credentials: fail now, not on every poll)
    pending, told, failing = [], set(), False
    while True:
        try:
            tick(pending, told)
            if failing:
                log("recorder API reachable again")
            failing = False
        except Exception as e:  # recorder restarting, network blip: keep polling
            if not failing:
                log(f"recorder API error: {e!r}")
            failing = True
        time.sleep(POLL)


if __name__ == "__main__":
    if sys.argv[1:] == ["--check"]:  # quick title test: python gate.py --check < titles.txt
        for line in sys.stdin:
            print(is_f1(line.strip()), line.strip())
    else:
        main()
