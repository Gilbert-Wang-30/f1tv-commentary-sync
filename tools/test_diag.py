#!/usr/bin/env python3
"""tools/diag.py: the server's diag files read directly (--file), lines for events the server
cut down, and the sync-by-sound report. Standard library only.
    python3 tools/test_diag.py
"""
import contextlib
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("diag", TOOLS / "diag.py")
diag = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diag)

T0 = 1794000000.0
C = {"client": "ctest", "build": "9.9.9", "platform": "Linux", "rx": T0}


def snap(t, cid="100", state="sync", clock="preroll", vod=None, **sound):
    snd = {"state": "listening", "looks": 1, "runs": [], "splices": 0, "breaks": 0, "err": None}
    snd.update(sound)
    return {**C, "t": T0 + t, "type": "snap", "state": state, "clock": clock, "cid": cid, "delay": 50, "vod": vod, "sound": snd}


def look(t, val, score, sure, nxt=4.0, wide=False):
    return {**C, "t": T0 + t, "type": "sound", "off": val, "val": val, "score": score, "next": nxt, "sure": sure, "wide": wide, "c": val}


def a_run():
    """Heard at 10 s, two sure looks agreeing at 30 and 45 s (locked at the snap of 50 s, a jump
    of 5.5 s with it), a later 4 s jump, a nudge, a lost; then a reset (looks back to 1)."""
    evs = [snap(0), snap(5), snap(10, runs=[15]), look(30, 55.0, 20, True, wide=True), snap(35, runs=[40], looks=2),
           look(45, 55.02, 30, True), {**C, "t": T0 + 45.1, "type": "sound", "jump": 5.5},
           snap(50, runs=[55], looks=3, state="syncing"), snap(55, runs=[60], looks=3)]
    evs[-2]["sound"]["state"] = "locked"
    evs[-1]["sound"].update(state="locked", err=0.01)
    evs += [look(60, 54.98, 6, False), look(75, 55.01, 12, True), snap(80, runs=[85], looks=5, state="sync"),
            {**C, "t": T0 + 90, "type": "nudge", "delta": 0.5, "delay": 50.5},
            {**C, "t": T0 + 200, "type": "sound", "jump": -4.0}, {**C, "t": T0 + 300, "type": "sound", "lost": True}]
    evs[-4]["sound"]["state"] = "locked"
    # a new run: the looks counter went back
    evs += [snap(400, looks=1, runs=[5]), look(410, 70.0, 5, False), snap(415, looks=2, runs=[20])]
    return evs


class ReadFiles(unittest.TestCase):
    def test_nul_runs_and_bad_lines(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "2026-11-16.jsonl"
            a, b = json.dumps(snap(1)), json.dumps(look(2, 50, 9, True))
            # (an unclean shutdown: NULs where a line was, then the next line straight after them)
            p.write_bytes(a.encode() + b"\n" + b"\0" * 300 + b.encode() + b"\n{not json\n\n")
            evs, bad = diag.read_files([p])
        self.assertEqual([e["type"] for e in evs], ["snap", "sound"])
        self.assertEqual(bad, 1)

    def test_sorted_across_files(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "b.jsonl").write_text(json.dumps(look(5, 50, 9, True)) + "\n")
            (Path(d) / "a.jsonl").write_text(json.dumps(snap(9)) + "\n" + json.dumps(snap(1)) + "\n")
            evs, _ = diag.read_files(sorted(Path(d).glob("*.jsonl")))
        self.assertEqual([round(e["t"] - T0) for e in evs], [1, 5, 9])


class Lines(unittest.TestCase):
    def test_a_snap_the_server_cut_down(self):
        # (over 4000 bytes the server keeps only {t, type, truncated}: this raised TypeError)
        s = diag.line({**C, "t": T0, "type": "snap", "truncated": 4286})
        self.assertIn("4286 bytes", s)

    def test_sound_events_of_every_kind(self):
        self.assertIn("resync asked", diag.line({**C, "t": T0, "type": "sound", "resync": "asked"}))
        self.assertIn("off (by hand)", diag.line({**C, "t": T0, "type": "sound", "on": False}))
        self.assertIn("jumped +5.5", diag.line({**C, "t": T0, "type": "sound", "jump": 5.5}))
        self.assertIn("sure match 20", diag.line(look(0, 55, 20, True)))

    def test_a_snap_without_state(self):
        e = snap(0)
        e["state"] = None
        self.assertIn("snap  None", diag.line(e))

    def test_ms_and_missing_times(self):
        self.assertEqual(diag.fmt_t(T0 * 1000), diag.fmt_t(T0))
        self.assertEqual(diag.fmt_t(None), "--:--:--")


class SoundRuns(unittest.TestCase):
    def test_a_run_summed_up(self):
        runs = diag.sound_runs(a_run())
        self.assertEqual(len(runs), 2)
        r = runs[0]
        self.assertEqual((r["mode"], r["cid"], r["looks"], r["sure"]), ("server", "100", 4, 3))
        self.assertTrue(r["locked"])
        self.assertEqual(r["lock_from"], "snap")
        self.assertAlmostEqual(r["to_lock_s"], 40.0)  # heard at 10 s, locked at the snap of 50 s
        self.assertEqual(r["first_jump"], 5.5)
        self.assertEqual(r["later_jumps"], [-4.0])
        self.assertEqual((r["lost"], r["nudges_after"]), (1, 1))
        self.assertAlmostEqual(r["val_median"], 55.01)
        self.assertFalse(runs[1]["locked"])
        self.assertEqual(runs[1]["looks"], 1)

    def test_modes(self):
        live = [snap(0, clock="edge", runs=[5])]
        bili = [snap(0, vod={"state": "placed"}, runs=[5])]
        self.assertEqual(diag.sound_runs(live)[0]["mode"], "live")
        self.assertEqual(diag.sound_runs(bili)[0]["mode"], "bili")

    def test_snaps_not_kept_go_on_and_the_lock_comes_from_the_looks(self):
        evs = [snap(0, runs=[20])]
        evs += [{**C, "t": T0 + 5 * i, "type": "snap", "truncated": 4300} for i in range(1, 20)]
        evs += [look(20, 50.0, 15, True), look(35, 50.05, 18, True), look(50, 50.03, 16, True)]
        runs = diag.sound_runs(evs)
        self.assertEqual(len(runs), 1)
        r = runs[0]
        self.assertEqual((r["locked"], r["lock_from"], r["truncated"]), (True, "looks", 19))
        self.assertAlmostEqual(r["to_lock_s"], 35.0)

    def test_two_sure_looks_that_disagree_dont_lock(self):
        evs = [snap(0, runs=[20]), {**C, "t": T0 + 5, "type": "snap", "truncated": 4300},
               look(20, 50.0, 15, True), look(35, 50.5, 18, True)]
        self.assertFalse(diag.sound_runs(evs)[0]["locked"])

    def test_report_from_files(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "x.jsonl"
            p.write_text("".join(json.dumps(e) + "\n" for e in a_run()))
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                diag.main(["--file", str(p), "--report", "sound"])
                diag.main(["--file", str(p), "--minutes", "1"])
        text = out.getvalue()
        self.assertIn("2 runs of sync by sound", text)
        self.assertIn("jump +5.50", text)
        self.assertRegex(text, r"server\s+2\s+1\s+5")  # runs, locked, looks
        self.assertIn("timeline of ctest", text)
        self.assertNotIn("nudge", text.split("timeline of ctest")[1].lower())  # (older than the last minute)


if __name__ == "__main__":
    unittest.main()
