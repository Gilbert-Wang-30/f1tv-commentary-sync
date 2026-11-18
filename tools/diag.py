#!/usr/bin/env python3
"""Read the extension's playback diagnostics (GET /api/diag) as a timeline.

  tools/diag.py                     every client's last report, then the newest client's timeline
  tools/diag.py --client c1a2b3c4   that client
  tools/diag.py --minutes 30        how far back (default 20)
  tools/diag.py --server http://localhost:8788
  tools/diag.py --file d/*.jsonl    the server's own files (<data>/diag/<day>.jsonl, 7 days of them)
                                    instead of GET /api/diag, which serves only the last 20000 events
                                    in memory; --minutes then counts back from the newest event
                                    (default: all of them)
  tools/diag.py --report sound      sync by sound, per run (a video's, from a reset to the next):
                                    how it locked, how steady, what moved it; then per mode
"""
import argparse
import json
import statistics
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone


def fmt_t(t):
    if t is None:
        return "--:--:--"
    if t > 1e11:  # page.js stamps its SDK log in ms
        t /= 1000
    return datetime.fromtimestamp(t, timezone.utc).strftime("%H:%M:%S")


def read_files(paths):
    """Events from the server's diag files, oldest first, and how many lines couldn't be read.
    (A file written through an unclean shutdown can hold a run of NUL bytes where a line was:
    dropped, and the line after them read.)"""
    evs, bad = [], 0
    for path in paths:
        with open(path, "rb") as f:
            for raw in f:
                raw = raw.replace(b"\0", b"").strip()
                if not raw:
                    continue
                try:
                    e = json.loads(raw)
                except ValueError:
                    bad += 1
                    continue
                if isinstance(e, dict):
                    evs.append(e)
                else:
                    bad += 1
    evs.sort(key=_t)
    return evs, bad


def _t(e):
    t = e.get("t") if isinstance(e.get("t"), (int, float)) else e.get("rx")
    t = t if isinstance(t, (int, float)) else 0
    return t / 1000 if t > 1e11 else t


def speed_of(snap):
    v = snap.get("video") or {}
    r = ((v.get("dx") or {}).get("r")) or {}
    parts = [f"chosen x{v.get('rate')}"]
    if r:
        parts.append(f"page want {r.get('want')} sdk {r.get('sdk')}{'' if r.get('exact') else '~'} el {r.get('el')}"
                     f" ps {r.get('ps')} fails {r.get('fails')}" + (f" err {r.get('err')!r}" if r.get("err") else ""))
    return ", ".join(parts)


def line(e):
    t, k = fmt_t(e.get("t")), e.get("type")
    if e.get("truncated") is not None:  # (over the server's 4000 bytes: only t and type kept)
        return f"{t} {k} (not kept: {e['truncated']} bytes, over the server's limit)"
    if k == "snap":
        a, v = e.get("audio") or {}, e.get("video") or {}
        drift = e.get("drift")
        dm = ((v.get("dx") or {}).get("dm")) or {}
        dms = (f" | 弹幕 {'on' if dm.get('on') else 'off'} {dm.get('shown')}/{dm.get('n')} lanes {dm.get('lanes')} at {dm.get('rect')}"
               f" video {dm.get('video')} img {dm.get('img')}{' err ' + str(dm.get('err')) if dm.get('err') else ''}") if dm else ""
        sd = e.get("sound") or {}
        sds = (f" | by sound {sd.get('state')} match {sd.get('score')} to go {sd.get('err')} speed {sd.get('v')} bias {sd.get('bias')}"
               f" looks {sd.get('looks')} ({sd.get('why')}) breaks {sd.get('breaks')} splices {sd.get('splices')} runs {sd.get('runs')}"
               f" tap {sd.get('tap')}") if sd else ""
        # F1 TV's own sound: its track, the one fone picks (fx, eng, none: left to F1 TV), muted with its button
        # (or a mute of F1 TV's own, held the same way), subtitles
        fa, fs = ((v.get("dx") or {}).get("a")) or {}, ((v.get("dx") or {}).get("subs")) or {}
        f1s = (f" | F1 TV {fa.get('cur')} pick {fa.get('mode')}{' MUTED' if fa.get('muted') else ' MUTED (its own)' if fa.get('own') else ''}"
               f"{' subs on' if fs.get('want') else ''}") if fa.get("mode") else ""
        return (f"{t} snap  {e.get('state')!s:9} drift {drift if drift is None else round(drift, 3)}"
                f" | audio x{a.get('rate')} pp {a.get('pp')} rs {a.get('rs')} ahead {a.get('ahead')}s paused {a.get('paused')}"
                f" | video p {v.get('p')} paused {v.get('paused')} waiting {v.get('waiting')} {v.get('src')} | {speed_of(e)}{f1s}{dms}{sds}")
    if k == "seek":
        return f"{t} SEEK  {e.get('from')} -> {e.get('to')} (target {e.get('target')}, x{e.get('rate')}, ahead {e.get('ahead')}s, {e.get('src')})"
    if k == "state":
        return f"{t} state {e.get('from')} -> {e.get('to')}  {e.get('text') or ''}"
    if k == "tr":
        return (f"{t} RADIO sting at p {e.get('sting')} (score {e.get('score')}, E {e.get('E')}) -> "
                f"{e.get('clip') or 'no message near it'}{'' if e.get('d') is None else f' ({e.get(chr(100)):+} s)'}")
    if k == "sound":
        if e.get("jump") is not None:
            return f"{t} SOUND jumped {e.get('jump'):+} s to where F1 TV's sound is in the stream"
        if e.get("lost"):
            return f"{t} SOUND lost (no sure match for SND.LOST s of playing: 600 s in 0.5)"
        if e.get("err"):
            return f"{t} SOUND look failed: {e.get('err')}"
        if e.get("resync"):
            return f"{t} SOUND resync {e.get('resync')}"
        if "on" in e and "score" not in e:
            return f"{t} SOUND sync by sound {'on' if e.get('on') else 'off (by hand)'}"
        return (f"{t} sound look{' (wide)' if e.get('wide') else ''}: {'sure' if e.get('sure') else 'unsure'} match {e.get('score')}"
                f" (runner-up {e.get('next')}) at offset {e.get('off')} (lock {e.get('c')})")
    if k == "nudge":
        return f"{t} NUDGE {e.get('delta'):+} s -> delay {e.get('delay')}"
    if k == "relive":
        return f"{t} RE-SYNC to live (delay {e.get('delay')})"
    if k == "speed":
        return f"{t} SPEED engine follows x{e.get('to')} ({e.get('src')})"
    if k == "hls":
        return f"{t} HLS   {e.get('details')} {'FATAL ' if e.get('fatal') else ''}at {e.get('at')}"
    if k in ("wake", "gap"):
        return f"{t} {k.upper()}  {e.get('slept', e.get('s'))} s"
    if k == "pstate":
        return f"{t} PLAYER {e.get('from')} -> {e.get('to')} at p {e.get('p')} (want {e.get('want')} sdk {e.get('sdk')}, audio {e.get('audio')}, handle {e.get('h')}, views {e.get('nv')}{', err ' + repr(e.get('err')) if e.get('err') else ''})"
    if k == "audio":
        who = "fone" if e.get("auto") else "user" if e.get("manual") else "?"
        # mode: the sound fone picks (fx Track FX, eng English Int., none left to F1 TV; before 0.3.11 also
        # mute); muted: F1 TV silenced with its own button, held by fone's gain (own: a mute of F1 TV's own
        # held so); subs: the subtitles asked for
        pick = f"pick {e['mode']}" if e.get("mode") else f"fx {e.get('on')}"  # (0.3.10 and before: no mode)
        extra = (" MUTED (F1 TV's button)" if e.get("muted") else " MUTED (F1 TV's own)" if e.get("own") else "")
        extra += f" subs {'on' if e.get('subs') else 'off'}" if e.get("subs") is not None else ""
        return (f"{t} AUDIO {e.get('from')} -> {e.get('to')} ({e.get('kind')}, by {who}, {pick}, best {e.get('fx')}){extra} at p {e.get('p')}"
                f" ps {e.get('ps')} handle {e.get('h')}{', err ' + repr(e.get('err')) if e.get('err') else ''}")
    if k == "handle":
        return f"{t} HANDLE {e.get('from')} -> {e.get('to')} at p {e.get('p')} ps {e.get('ps')} (audio {e.get('audio')}, want {e.get('want')}, views {e.get('nv')})"
    if k == "sdk":
        how = "ok" if e.get("ok") else f"ERR {e.get('err')!r}"
        gi = " interrupted" if e.get("gi") else ""
        return f"{t} SDK   {e.get('name')}({e.get('args')}) {how}{gi} in {e.get('ms')} ms  [ps {e.get('ps')} handle {e.get('h')} views {e.get('nv')} player {e.get('pid')}]"
    if k == "fatal":
        return (f"{t} FATAL code {e.get('code')} {e.get('msg')!r} at p {e.get('p')} ps {e.get('ps')} handle {e.get('h')} views {e.get('nv')}"
                f" (our call {e.get('busy')}, f1tv apply {e.get('f1tv')}; before: {e.get('last')})")
    if k in ("player", "dead"):
        return f"{t} {k.upper():6}{e.get('from')} -> {e.get('to')} at p {e.get('p')}" if k == "player" else f"{t} DEAD  player {e.get('pid')} at p {e.get('p')} ps {e.get('ps')}"
    if k == "ob":
        return f"{t} OB    {e.get('from') or '-'} -> {e.get('to') or '-'} at p {e.get('p')} ps {e.get('ps')}{', err ' + repr(e.get('err')) if e.get('err') else ''}"
    return f"{t} {k} {json.dumps({x: y for x, y in e.items() if x not in ('t', 'type', 'client', 'build', 'platform', 'rx')})}"


# ---- sync by sound, per run ---------------------------------------------------------------------
# A run: one client's sync by sound on one video, from a reset (the snap's sound.looks counter
# going back: a new start, a seek elsewhere, another video) to the next, or a 10 min silence.
# Mode: 'live' (the edge clock: a stream recorded in this browser), 'bili' (a streamer's Bilibili
# replay: the snap's vod), 'server' (a fone server's recording of it).

SNAP_S = 5  # the extension's DIAG.SNAP: a snap every 5 s
RUN_GAP = 600
PLAYING = ("sync", "syncing")


def _mode(snap):
    return "bili" if snap.get("vod") else "live" if snap.get("clock") == "edge" else "server"


def sound_runs(evs):
    """The runs in `evs` (any order), each summed up: a dict per run, oldest first."""
    runs, cur = [], {}
    for e in sorted(evs, key=_t):
        c, t, k = e.get("client"), _t(e), e.get("type")
        r = cur.get(c)
        if k == "snap" and e.get("truncated") is not None:  # (not kept: the run goes on)
            if r is not None and t - r["t1"] < RUN_GAP:
                r["t1"], r["truncated"] = t, r["truncated"] + 1
            continue
        if k == "snap":
            snd = e.get("sound")
            if not snd or e.get("cid") is None:
                continue
            looks = snd.get("looks")
            if (r is None or r["cid"] != e["cid"] or t - r["t1"] > RUN_GAP
                    or (looks is not None and r["looks"] is not None and looks < r["looks"])):
                r = cur[c] = {"client": c, "cid": e["cid"], "mode": _mode(e), "builds": set(), "t0": t, "t1": t,
                              "looks": looks, "snaps": [], "ev": [], "truncated": 0}
                runs.append(r)
            r["t1"] = t
            r["looks"] = looks if looks is not None else r["looks"]
            r["builds"].add(e.get("build") or "?")
            if e.get("vod"):
                r["mode"] = "bili"
            r["snaps"].append(e)
        elif r is not None and k in ("sound", "nudge") and t - r["t1"] < RUN_GAP:
            r["ev"].append(e)
    return [_sum_run(r) for r in runs]


def _sum_run(r):
    snaps, ev = r["snaps"], r["ev"]
    sd = [x.get("sound") or {} for x in snaps]
    playing = [x for x in snaps if x.get("state") in PLAYING]
    looks = [e for e in ev if e.get("type") == "sound" and "score" in e]
    out = {"client": r["client"], "cid": r["cid"], "mode": r["mode"], "builds": sorted(r["builds"]), "start": r["t0"],
           "minutes": (r["t1"] - r["t0"]) / 60, "playing_min": len(playing) * SNAP_S / 60, "looks": len(looks),
           "sure": sum(1 for e in looks if e.get("sure")), "truncated": r["truncated"],
           "splices": max((x.get("splices") or 0) for x in sd), "breaks": max((x.get("breaks") or 0) for x in sd),
           "lost": sum(1 for e in ev if e.get("type") == "sound" and e.get("lost")),
           "scores_sure": [e["score"] for e in looks if e.get("sure")],
           "scores_unsure": [e["score"] for e in looks if not e.get("sure")]}
    heard = next((_t(x) for x, s in zip(snaps, sd) if sum(s.get("runs") or []) > 0), None)
    lock = next((_t(x) for x, s in zip(snaps, sd) if s.get("state") == "locked"), None)
    out["lock_from"] = "snap" if lock is not None else None
    if lock is None:
        # (its snaps not kept: the lock as FoneSound.judge makes it, two sure looks within 0.08 s
        # among the last four in 3 min)
        est = []
        for e in looks:
            if e.get("sure") and e.get("val") is not None:
                est = [x for x in est if _t(e) - _t(x) < 180][-3:] + [e]
                if sum(1 for x in est if abs(x["val"] - e["val"]) <= 0.08) >= 2:
                    lock, out["lock_from"] = _t(e), "looks"
                    break
    out["locked"] = lock is not None
    out["to_lock_s"] = lock - heard if lock is not None and heard is not None else None
    jumps = [e for e in ev if e.get("type") == "sound" and e.get("jump") is not None]
    out["first_jump"] = out["first_err"] = None
    out["later_jumps"], out["nudges_after"], out["val_sd"], out["val_median"], out["locked_min"] = [], 0, None, None, 0.0
    if lock is not None:
        first = [j for j in jumps if _t(j) <= lock + 2 * SNAP_S]
        out["first_jump"] = first[0]["jump"] if first else None
        at = next((s for x, s in zip(snaps, sd) if _t(x) >= lock and s.get("state") == "locked"), {})
        out["first_err"] = at.get("err")  # (what the easing had left at the first locked snap)
        out["later_jumps"] = [j["jump"] for j in jumps if _t(j) > lock + 2 * SNAP_S]
        out["nudges_after"] = sum(1 for e in ev if e.get("type") == "nudge" and _t(e) > lock)
        out["locked_min"] = (r["t1"] - lock) / 60 if out["lock_from"] == "looks" else \
            sum(1 for x, s in zip(snaps, sd) if x.get("state") in PLAYING and s.get("state") == "locked") * SNAP_S / 60
        vals = [e["val"] for e in looks if e.get("sure") and e.get("val") is not None and _t(e) >= lock - 30]
        if vals:
            m = statistics.median(vals)
            near = [v for v in vals if abs(v - m) <= 1]
            out["val_median"] = m
            out["val_sd"] = statistics.pstdev(near) if len(near) > 1 else None
    return out


def _f(x, fmt=".1f"):
    return "-" if x is None else format(x, fmt)


def _med(xs):
    return statistics.median(xs) if xs else None


def sound_report(evs):
    """sound_runs as text: a line per run, then a line per mode."""
    runs = sound_runs(evs)
    out = [f"{len(runs)} runs of sync by sound",
           "start (UTC)       mode   build        cid         min  play  looks sure  lock  heard->lock  first(jump|err)  later  lost  val sd  nudges after  splices/breaks"]
    for r in runs:
        day = datetime.fromtimestamp(r["start"], timezone.utc).strftime("%m-%d %H:%M:%S")
        b = r["builds"][0] if len(r["builds"]) == 1 else f"{r['builds'][0]}-{r['builds'][-1]}"
        lock = ("yes" + ("*" if r["lock_from"] == "looks" else "")) if r["locked"] else "no"
        first = f"jump {r['first_jump']:+.2f}" if r["first_jump"] is not None else f"err {r['first_err']:+.3f}" if r["first_err"] is not None else "-"
        out.append(f"{day}  {r['mode']:6} {b:12} {r['cid']!s:11} {r['minutes']:4.0f} {r['playing_min']:5.0f}  {r['looks']:5} {r['sure']:4}  {lock:4}  "
                   f"{_f(r['to_lock_s']):>11}  {first:>15}  {len(r['later_jumps']):5} {r['lost']:5}  {_f(r['val_sd'], '.3f'):>6}  "
                   f"{r['nudges_after']:12}  {r['splices']}/{r['breaks']}" + (f"  ({r['truncated']} snaps not kept)" if r["truncated"] else ""))
    if any(r["lock_from"] == "looks" for r in runs):
        out.append("(yes*: its snaps weren't kept, the lock read off its looks)")
    out.append("")
    out.append("mode    runs locked  looks  sure%  score sure (median)  unsure  heard->lock median s  later jumps/h  lost/h  (locked h)")
    for mode in ("live", "server", "bili"):
        rs = [r for r in runs if r["mode"] == mode]
        if not rs:
            continue
        looks, sure = sum(r["looks"] for r in rs), sum(r["sure"] for r in rs)
        h = sum(r["locked_min"] for r in rs) / 60
        jumps, lost = sum(len(r["later_jumps"]) for r in rs), sum(r["lost"] for r in rs)
        out.append(f"{mode:7} {len(rs):4} {sum(r['locked'] for r in rs):6} {looks:6} {100 * sure / looks if looks else 0:5.0f}%  "
                   f"{_f(_med([x for r in rs for x in r['scores_sure']])):>19}  {_f(_med([x for r in rs for x in r['scores_unsure']])):>6}  "
                   f"{_f(_med([r['to_lock_s'] for r in rs if r['to_lock_s'] is not None])):>20}  "
                   f"{_f(jumps / h if h else None, '.2f'):>13}  {_f(lost / h if h else None, '.2f'):>6}  ({h:.2f})")
    return out


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--server", default="http://localhost:8788")
    ap.add_argument("--file", nargs="+", metavar="JSONL", help="the server's diag files instead of GET /api/diag")
    ap.add_argument("--client")
    ap.add_argument("--minutes", type=float, help="how far back (default 20; with --file, from the newest event, default all)")
    ap.add_argument("--type")
    ap.add_argument("--report", choices=("timeline", "sound"), default="timeline")
    a = ap.parse_args(argv)
    types = set(a.type.split(",")) if a.type else None
    if a.report == "sound" and not types:
        types = {"snap", "sound", "nudge"}
    if a.file:
        evs, bad = read_files(a.file)
        if bad:
            print(f"({bad} unreadable lines left out)")
        if a.minutes is not None and evs:
            since = _t(evs[-1]) - a.minutes * 60
            evs = [e for e in evs if _t(e) >= since]
        clients = {}
        for e in evs:
            clients.setdefault(e.get("client"), {}).update(last=e.get("rx"), build=e.get("build"), platform=e.get("platform"))
        evs = [e for e in evs if (not a.client or e.get("client") == a.client) and (types is None or e.get("type") in types)]
    else:
        minutes = 20 if a.minutes is None else a.minutes
        q = {"since": time.time() - minutes * 60, "limit": 5000}
        if a.client:
            q["client"] = a.client
        if types:
            q["type"] = ",".join(sorted(types))
        # (X-Fone: a script's, not a web page's; the server hands every viewer's playback to no page)
        req = urllib.request.Request(f"{a.server}/api/diag?{urllib.parse.urlencode(q)}", headers={"X-Fone": "1"})
        d = json.load(urllib.request.urlopen(req, timeout=20))
        clients, evs = d["clients"], d["events"]
    for c, info in sorted(clients.items(), key=lambda x: -(x[1].get("last") or 0)):
        print(f"client {c}: {info.get('platform')} build {info.get('build')} last {fmt_t(info['last']) if info.get('last') else '?'}")
    if a.report == "sound":
        for x in sound_report(evs):
            print(x)
        return
    if not a.client and evs:
        newest = max(clients.items(), key=lambda x: x[1].get("last") or 0)[0]
        evs = [e for e in evs if e.get("client") == newest]
        back = a.minutes if a.minutes is not None else None if a.file else 20
        print(f"-- timeline of {newest} (newest client)" + (f", last {back:g} min --" if back is not None else " --"))
    for e in evs:
        print(line(e))


if __name__ == "__main__":
    main()
