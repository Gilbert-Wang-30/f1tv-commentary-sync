"""gate.py: the title filter, log-only by default, the room's folders.
python3 -m unittest discover -s recorder (stdlib only, no recorder needed)."""
import ast
import importlib
import os
import sys
import tempfile
import time
import unittest
from datetime import datetime
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))


def load(**env):
    """gate.py imported afresh with this environment (it reads it at import)."""
    keys = ("GATE_RECORD", "GATE_SKIP", "GATE_ACTION", "FONE_FILENAME_TZ", "TZ", "GATE_REC")
    clean = {k: v for k, v in os.environ.items() if k not in keys}
    with mock.patch.dict(os.environ, {**clean, "BREC_HTTP_BASIC_USER": "u", "BREC_HTTP_BASIC_PASS": "p", **env},
                         clear=True):
        sys.modules.pop("gate", None)
        return importlib.import_module("gate")


class Titles(unittest.TestCase):
    def test_default_keeps_f1_in_english_and_chinese(self):
        g = load()
        for t in ("【胡闹P房】16点 巴林 排位赛", "日本大奖赛 正赛", "F1 Japanese Grand Prix - Race watchalong",
                  "FP2 live", "Sprint Qualifying", "Abu Dhabi GP", "F2 feature race", "方程式 围场 发布会"):
            self.assertTrue(g.is_f1(t), t)

    def test_default_leaves_other_streams(self):
        g = load()
        for t in ("小播一会粥", "GPU benchmark night", "Racing game marathon", "Just chatting"):
            self.assertIs(g.is_f1(t), False, t)
        self.assertIsNone(g.is_f1("  "))  # no title: left alone

    def test_streamer_tag_and_skip(self):
        g = load(GATE_RECORD="胡闹P房|F1", GATE_SKIP="F1 25|游戏")
        self.assertTrue(g.is_f1("【胡闹P房】周末闲聊"))  # the tag alone
        self.assertIs(g.is_f1("Abu Dhabi GP"), False)  # (not in this filter)
        self.assertIs(g.is_f1("F1 25 career mode"), False)  # skipped

    def test_empty_record_is_the_default(self):
        self.assertEqual(load(GATE_RECORD="").RECORD.pattern, load().F1_TITLES)

    def test_backfill_fills_the_lives_this_records(self):
        """The server's backfill fills a live only if this filter would record it (GATE_RECORD /
        GATE_SKIP, which docker-compose.yml passes on): its default words are these, word for word."""
        src = Path(__file__).resolve().parent.parent / "server" / "fone" / "backfill.py"
        if not src.exists():
            self.skipTest(f"no {src}: run from the whole checkout (CONTRIBUTING.md)")
        words = [ast.literal_eval(n.value) for n in ast.parse(src.read_text(encoding="utf-8")).body
                 if isinstance(n, ast.Assign) and [getattr(t, "id", None) for t in n.targets] == ["F1_TITLES"]]
        self.assertEqual(words, [load().F1_TITLES])


ROOM = {"objectId": "o1", "roomId": 123, "name": "Acct", "title": "小播一会粥", "recording": True, "streaming": True}


class Tick(unittest.TestCase):
    def run_tick(self, g, rooms):
        calls = []
        g.api = lambda method, path: calls.append((method, path)) if method == "POST" else rooms
        pending, told = [], set()
        with mock.patch.object(g, "log") as log:
            g.tick(pending, told)
            g.tick(pending, told)
        return calls, pending, log

    def test_log_only_by_default(self):
        g = load()
        self.assertEqual(g.ACTION, "log")
        calls, pending, log = self.run_tick(g, [dict(ROOM)])
        self.assertEqual(calls, [])  # nothing stopped
        self.assertEqual(pending, [])  # nothing to delete
        self.assertEqual(log.call_count, 1)  # said once, not every poll
        self.assertIn("would stop", log.call_args[0][0])
        # a session someone else stopped isn't restarted either
        calls, _, _ = self.run_tick(g, [{**ROOM, "title": "F1 Race", "recording": False,
                                         "autoRecordForThisSession": False}])
        self.assertEqual(calls, [])

    def test_stop_stops_and_restarts(self):
        g = load(GATE_ACTION="stop")
        calls, pending, _ = self.run_tick(g, [dict(ROOM)])
        self.assertEqual(calls, [("POST", "/api/room/o1/stop")] * 2)
        self.assertEqual(len(pending), 2)
        calls, _, _ = self.run_tick(g, [{**ROOM, "title": "F1 Race", "recording": False,
                                         "autoRecordForThisSession": False}])
        self.assertEqual(calls, [("POST", "/api/room/o1/start")] * 2)


class Cleanup(unittest.TestCase):
    def test_stub_deleted_in_the_room_number_folder_and_the_account_folder(self):
        with tempfile.TemporaryDirectory() as d:
            g = load(GATE_REC=d, FONE_FILENAME_TZ="Europe/Berlin")
            now = time.time()
            stamp = datetime.fromtimestamp(now - 20, g.TZ).strftime("%Y%m%d-%H%M%S-%f")[:-3]
            stubs = []
            for folder in ("123", "Acct"):
                (Path(d) / folder).mkdir()
                stubs.append(Path(d) / folder / f"{stamp}-小播一会粥.flv")
                stubs[-1].write_bytes(b"x")
            keep = Path(d) / "123" / f"{stamp}-F1 Race.flv"
            keep.write_bytes(b"x")
            with mock.patch.object(g, "log"):
                g.cleanup({"roomId": 123, "name": "Acct"}, now)
            self.assertEqual([s.exists() for s in stubs], [False, False])
            self.assertTrue(keep.exists())
            # file names read in the gate's zone: in another, the stub is hours out and kept
            stub = Path(d) / "123" / f"{stamp}-小播一会粥.flv"
            stub.write_bytes(b"x")
            with mock.patch.object(g, "log"):
                load(GATE_REC=d, FONE_FILENAME_TZ="Asia/Tokyo").cleanup({"roomId": 123, "name": "Acct"}, now)
            self.assertTrue(stub.exists())


if __name__ == "__main__":
    unittest.main()
