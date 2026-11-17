"""seed.sh: fone-recorder's config.json from FONE_ROOMS, and when the recorder doesn't start.
Run with the system's sh: dash in the recorder's image (Debian) and on CI's Ubuntu, busybox ash
in the python:*-alpine test containers."""
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).parent
SEED, TEMPLATE = HERE / "seed.sh", HERE / "config.json"


class Seed(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dir)
        self.config = self.dir / "config.json"

    def seed(self, rooms, tz="Asia/Shanghai"):
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "SEED_CONFIG": str(self.config),
               "SEED_TEMPLATE": str(TEMPLATE), "FONE_ROOMS": rooms, "TZ": tz}
        return subprocess.run(["sh", str(SEED)], env=env, capture_output=True, text=True, timeout=30)

    def rooms(self):
        return [r["RoomId"]["Value"] for r in json.loads(self.config.read_text(encoding="utf-8"))["rooms"]]

    def test_rooms_written_once(self):
        r = self.seed(" 12345678=MyStreamer , 777 ")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.rooms(), [12345678, 777])
        self.assertIn("Asia/Shanghai", self.config.read_text(encoding="utf-8"))
        # after that the file is 录播姬's own
        self.assertEqual(self.seed("999").returncode, 0)
        self.assertEqual(self.rooms(), [12345678, 777])

    def test_leading_zeros_are_the_same_room(self):
        # (as the server's config.parse_rooms reads them: 0123 is room 123, in folder 123)
        r = self.seed("0123=MyStreamer, 123, 00456, abc=x")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.rooms(), [123, 456])  # (valid JSON: no "Value": 0123)
        self.assertIn("skipping 'abc=x'", r.stderr)
        self.config.unlink()
        r = self.seed("0=A, 000, 5")  # (no Bilibili room is 0)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.rooms(), [5])
        self.assertIn("skipping '0=A'", r.stderr)
        self.assertIn("skipping '000'", r.stderr)

    def test_the_file_names_zone(self):
        self.assertEqual(self.seed("1", tz="Europe/Berlin").returncode, 0)
        self.assertIn('time_zone: \\"Europe/Berlin\\"', self.config.read_text(encoding="utf-8"))
        self.config.unlink()
        r = self.seed("1", tz="Bad Zone")
        self.assertEqual(r.returncode, 1)
        self.assertFalse(self.config.exists())

    def test_no_room_anywhere_doesnt_start(self):
        r = self.seed("")
        self.assertEqual(r.returncode, 1)
        self.assertIn("FONE_ROOMS", r.stderr)
        self.assertFalse(self.config.exists())
        # a config.json with no room, FONE_ROOMS still empty: nothing to record either
        shutil.copyfile(TEMPLATE, self.config)
        r = self.seed(" , ")
        self.assertEqual(r.returncode, 1)
        self.assertIn("doesn't start", r.stderr)
        self.assertEqual(self.config.read_bytes(), TEMPLATE.read_bytes())

    def test_a_roomless_config_is_written_again_once_rooms_are_named(self):
        shutil.copyfile(TEMPLATE, self.config)
        r = self.seed("0777")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.rooms(), [777])
        self.assertEqual((self.dir / "config.json.bak").read_bytes(), TEMPLATE.read_bytes())


if __name__ == "__main__":
    unittest.main()
