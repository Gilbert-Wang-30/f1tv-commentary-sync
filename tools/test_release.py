#!/usr/bin/env python3
"""The release tools: check_version.py, build_ext.sh (and publish_ext.sh on top of it),
check_public.sh. Standard library only; needs git and bash (rsync for publish_ext.sh).
    python3 tools/test_release.py
"""
import importlib.util
import json
import os
import shutil
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
REPO = TOOLS.parent
spec = importlib.util.spec_from_file_location("check_version", TOOLS / "check_version.py")
cv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cv)

CHANGELOG = """# Changelog

Intro text.

## [1.0.1] - unreleased

### Added
- Releases.

## [0.5.4] - 2026-11-17

- The panel dragged anywhere.

## [0.5.3] - 2026-11-17

- Own sound.
"""
PLACEHOLDER = "self.FONE_LOCAL = { servers: [] };\n"


def run(*cmd, cwd=REPO, env=None, check=False):
    e = {k: v for k, v in os.environ.items() if k not in ("GITHUB_ACTIONS", "SOURCE_DATE_EPOCH")}
    e.update(env or {})
    p = subprocess.run(cmd, cwd=cwd, env=e, capture_output=True, text=True)
    if check and p.returncode:
        raise AssertionError(f"{cmd} failed ({p.returncode}): {p.stdout}{p.stderr}")
    return p


def git_repo(root: Path, files: dict, commit=False):
    for name, text in files.items():
        (root / name).parent.mkdir(parents=True, exist_ok=True)
        (root / name).write_text(text, encoding="utf-8")
    run("git", "init", "-q", cwd=root, check=True)
    run("git", "add", "-A", cwd=root, check=True)
    if commit:
        run("git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false",
            "commit", "-qm", "t", cwd=root, check=True)


class CheckVersion(unittest.TestCase):
    def test_chrome_versions(self):
        for ok in ("1", "1.0", "1.0.1", "0.5.4", "65535.0.0.1"):
            cv.chrome_version(ok)
        for bad in ("", "1.0.1.2.3", "01.0", "1.0.65536", "1.0.1-rc.1", "v1.0", "1..2"):
            with self.assertRaises(cv.Problem, msg=bad):
                cv.chrome_version(bad)

    def test_every_push(self):
        self.assertEqual(cv.check("0.5.4", CHANGELOG)["version"], "0.5.4")
        self.assertEqual(cv.check("1.0.1", CHANGELOG)["version"], "1.0.1")  # bumped, still unreleased: fine
        self.assertEqual(cv.check("1.0.1.0", CHANGELOG)["version"], "1.0.1.0")  # Chrome's 1.0.1
        with self.assertRaisesRegex(cv.Problem, "no section for the manifest's version"):
            cv.check("1.0.2", CHANGELOG)
        with self.assertRaisesRegex(cv.Problem, "newest first"):
            cv.check("0.5.4", CHANGELOG.replace("[0.5.3]", "[0.6.0]"))
        with self.assertRaisesRegex(cv.Problem, "older than the manifest's"):
            cv.check("1.0.1", CHANGELOG.replace("[0.5.4] - 2026-11-17", "[0.5.4] - unreleased"))
        with self.assertRaisesRegex(cv.Problem, "is not yyyy-mm-dd"):
            cv.check("0.5.4", CHANGELOG.replace("2026-11-17", "17 Nov", 1))
        with self.assertRaisesRegex(cv.Problem, "heading"):
            cv.check("0.5.4", CHANGELOG + "\n## Notes\n")
        with self.assertRaisesRegex(cv.Problem, "belongs at the top"):
            cv.check("0.5.4", CHANGELOG + "\n## [Unreleased]\n")
        self.assertEqual(cv.check("0.5.4", "## [Unreleased]\n- next\n\n" + CHANGELOG.split("\n", 4)[4])["version"],
                         "0.5.4")

    def test_tags(self):
        r = cv.check("0.5.4", CHANGELOG, "v0.5.4")
        self.assertEqual((r["version"], r["prerelease"], r["notes"]), ("0.5.4", False, "- The panel dragged anywhere."))
        with self.assertRaisesRegex(cv.Problem, "not the manifest's version"):
            cv.check("0.5.4", CHANGELOG, "v1.0.1")
        # vX.Y.Z or vX.Y.Z-rc.N only: anything else gives the image no semver tags
        for bad in ("0.5.4", "v0.5", "v0.5.4.0", "v00.5.4", "v0.5.4-beta", "v0.5.4-rc", "v0.5.4-rc.01", "v0.5.4-rc.1.2",
                    "v0.5.4+1", "v0.5.4-RC.1"):
            with self.assertRaisesRegex(cv.Problem, "is not vX.Y.Z or vX.Y.Z-rc.N", msg=bad):
                cv.check("0.5.4", CHANGELOG, bad)
        self.assertEqual(cv.check("0.5.4", CHANGELOG, "v0.5.4-rc.0")["prerelease"], True)
        # 1.0.1 still unreleased: a release candidate or a dry run may go, the release proper not
        with self.assertRaisesRegex(cv.Problem, "give it the release's date"):
            cv.check("1.0.1", CHANGELOG, "v1.0.1")
        r = cv.check("1.0.1", CHANGELOG, "v1.0.1-rc.1")
        self.assertEqual((r["version"], r["prerelease"]), ("1.0.1-rc.1", True))
        self.assertEqual(cv.check("1.0.1", CHANGELOG, "v1.0.1", dry_run=True)["notes"], "### Added\n- Releases.")
        with self.assertRaisesRegex(cv.Problem, "says nothing"):
            cv.check("0.5.3", CHANGELOG.replace("- Own sound.\n", ""), "v0.5.3")

    def test_cli_on_this_repo(self):
        p = run("python3", str(TOOLS / "check_version.py"))
        self.assertEqual(p.returncode, 0, p.stderr)
        manifest = json.loads((REPO / "extension/manifest.json").read_text())
        self.assertIn(f"version={manifest['version']}\nprerelease=false\n", p.stdout)
        with tempfile.TemporaryDirectory() as t:
            notes = Path(t) / "notes.md"
            p = run("python3", str(TOOLS / "check_version.py"), "--tag", "v" + manifest["version"], "--dry-run",
                    "--notes", str(notes))
            self.assertEqual(p.returncode, 0, p.stderr)
            self.assertTrue(notes.read_text().strip())
        p = run("python3", str(TOOLS / "check_version.py"), "--tag", "v999.0.0", env={"GITHUB_ACTIONS": "true"})
        self.assertEqual(p.returncode, 1)
        self.assertTrue(p.stderr.startswith("::error file=extension/manifest.json::"), p.stderr)


class BuildExt(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)

    def copy_repo(self, commit=True):
        """A repo of its own with this one's extension, its packager and what the zip adds."""
        root = self.tmp / "repo"
        shutil.copytree(REPO / "extension", root / "extension")
        (root / "tools").mkdir()
        shutil.copy(TOOLS / "build_ext.sh", root / "tools")
        for f in ("LICENSE", "THIRD_PARTY.md"):
            shutil.copy(REPO / f, root)
        for f in ("build.js", "build.json"):
            (root / "extension" / f).unlink(missing_ok=True)
        git_repo(root, {}, commit=commit)
        return root

    def test_release_zip_from_this_repo(self):
        p = run(str(TOOLS / "build_ext.sh"), str(self.tmp / "out"), check=True)
        version = json.loads((REPO / "extension/manifest.json").read_text())["version"]
        zpath = self.tmp / "out" / f"fone-extension-{version}.zip"
        self.assertEqual(p.stdout.strip(), str(zpath))
        z = zipfile.ZipFile(zpath)
        names = z.namelist()
        self.assertEqual(names, sorted(names))
        self.assertTrue(all(n.startswith("fone/") for n in names))
        for n in ("fone/manifest.json", "fone/background.js", "fone/offscreen.html", "fone/vendor/hls.light.min.js",
                  "fone/icons/128.png", "fone/LICENSE", "fone/THIRD_PARTY.md"):
            self.assertIn(n, names)
        for n in names:
            self.assertFalse(n.endswith(".test.js") or "/testdata/" in n or n.endswith(("/build.js", "/build.json")), n)
        self.assertEqual(z.read("fone/local.js").decode().splitlines()[-1], PLACEHOLDER.strip())
        self.assertEqual(json.loads(z.read("fone/manifest.json"))["version"], version)
        # the same commit, the same bytes
        run(str(TOOLS / "build_ext.sh"), str(self.tmp / "again"), check=True)
        self.assertEqual(zpath.read_bytes(), (self.tmp / "again" / zpath.name).read_bytes())

    def test_release_candidate_and_wrong_version(self):
        root = self.copy_repo()
        version = json.loads((root / "extension/manifest.json").read_text())["version"]
        run("tools/build_ext.sh", "out", f"{version}-rc.1", cwd=root, check=True)
        m = json.loads(zipfile.ZipFile(root / f"out/fone-extension-{version}-rc.1.zip").read("fone/manifest.json"))
        self.assertEqual((m["version"], m["version_name"]), (version, f"{version}-rc.1"))
        p = run("tools/build_ext.sh", "out", "999.0.0", cwd=root)
        self.assertEqual(p.returncode, 1)
        self.assertIn("bump extension/manifest.json", p.stderr)
        # relative paths are the caller's
        (self.tmp / "elsewhere").mkdir()
        run(str(root / "tools/build_ext.sh"), "rel", cwd=self.tmp / "elsewhere", check=True)
        run(str(root / "tools/build_ext.sh"), "--stage", "st", cwd=self.tmp / "elsewhere", check=True)
        self.assertTrue((self.tmp / f"elsewhere/rel/fone-extension-{version}.zip").is_file())
        self.assertTrue((self.tmp / "elsewhere/st/manifest.json").is_file())

    def test_only_committed_files_unless_worktree(self):
        root = self.copy_repo()
        (root / "extension/notes.txt").write_text("untracked")
        (root / "extension/build.js").write_text("self.FONE_BUILD = 'stale';")
        run("tools/build_ext.sh", "out", cwd=root, check=True)
        names = zipfile.ZipFile(next((root / "out").glob("*.zip"))).namelist()
        self.assertNotIn("fone/notes.txt", names)
        run("tools/build_ext.sh", "--worktree", "--stage", str(self.tmp / "st"), cwd=root, check=True)
        self.assertTrue((self.tmp / "st/notes.txt").exists())
        self.assertFalse((self.tmp / "st/build.js").exists())
        self.assertFalse(list((self.tmp / "st").glob("*.test.js")))
        self.assertEqual(run("tools/build_ext.sh", "--stage", str(self.tmp / "st"), cwd=root).returncode, 1)  # not empty

    def test_missing_files_and_filled_local_js_refused(self):
        root = self.copy_repo(commit=False)
        (root / "extension/sound.js").unlink()
        (root / "extension/dashboard.css").unlink()
        p = run("tools/build_ext.sh", "--worktree", "out", cwd=root)
        self.assertEqual(p.returncode, 1)
        self.assertIn("dashboard.css (named in dashboard.html), sound.js (named in offscreen.html)", p.stderr)
        shutil.copy(REPO / "extension/sound.js", root / "extension")
        shutil.copy(REPO / "extension/dashboard.css", root / "extension")
        (root / "extension/local.js").write_text('self.FONE_LOCAL = {"servers": ["http://192.0.2.10:8788"]};\n')
        p = run("tools/build_ext.sh", "--worktree", "out", cwd=root)
        self.assertEqual(p.returncode, 1)
        self.assertIn("not the repo's placeholder", p.stderr)
        # publish_ext.sh's staging takes it as it is: it writes local.js itself
        run("tools/build_ext.sh", "--worktree", "--stage", str(self.tmp / "st"), cwd=root, check=True)

    @unittest.skipUnless(shutil.which("rsync"), "publish_ext.sh needs rsync")
    def test_publish_ext_outputs(self):
        env = {"FONE_EXT_DEST": str(self.tmp / "dest"), "FONE_EXT_DIST": str(self.tmp / "dist"),
               "FONE_SERVERS": "http://srv.example:8788, http://192.0.2.10:8788", "FONE_DIST_URL": "http://srv.example:8789"}
        p = run(str(TOOLS / "publish_ext.sh"), env=env, check=True)
        dest, dist = self.tmp / "dest", self.tmp / "dist"
        build = json.loads((dest / "build.json").read_text())
        self.assertIn(f"published {build['build']} ->", p.stdout)
        self.assertEqual(build["version"], json.loads((REPO / "extension/manifest.json").read_text())["version"])
        self.assertEqual((dist / "build.json").read_text(), (dest / "build.json").read_text())
        self.assertEqual((dest / "build.js").read_text(), f"self.FONE_BUILD = '{build['build']}';\n")
        self.assertEqual((dest / "local.js").read_text(),
                         'self.FONE_LOCAL = {"servers": ["http://srv.example:8788", "http://192.0.2.10:8788"]};\n')
        self.assertFalse(list(dest.glob("*.test.js")) or (dest / "testdata").exists())
        self.assertTrue((dest / "offscreen.js").is_file() and (dest / "vendor/hls.light.min.js").is_file())
        for f in ("install-mac.sh", "fone-sync.sh"):
            text = (dist / f).read_text()
            self.assertIn("http://srv.example:8789", text)
            self.assertNotIn("__FONE_DIST__", text)
        listing = run("tar", "-tzf", str(dist / "fone-extension.tar.gz"), check=True).stdout.split()
        self.assertIn("./build.js", listing)
        self.assertIn("./manifest.json", listing)


# What check_public.sh must flag, put together here so that this file (which it reads too)
# holds none of it as written.
def ip(*octets):
    return ".".join(map(str, octets))


NAS = "/" + "mnt/nas/media"
SHARE = "/" + "mnt/share"
TS_NAME = "myhost.tail1234" + ".ts.net"
HOME = "/" + "home/someone"
LAN = ip(192, 168, 1, 20)


class CheckPublic(unittest.TestCase):
    CLEAN = {
        "extension/local.js": "// placeholder\n" + PLACEHOLDER,
        "tools/mac/install-mac.sh": 'BASE="${FONE_DIST:-__FONE_DIST__}"\n',
        "tools/mac/fone-sync.sh": 'BASE="${FONE_DIST:-__FONE_DIST__}"\n',
        # an example to fill in: a home-network address and a share under /mnt, in the docs and
        # the example settings only
        "tools/publish.env.example": f"FONE_SERVERS=http://my-server:8788,http://{LAN}:8788\n"
                                     f"FONE_EXT_DEST={SHARE}/apps/fone-extension\n",
        ".env.example": f"FONE_RECORDINGS={SHARE}/recordings\n# FONE_SERVER=http://{ip(10, 0, 0, 2)}:8788\n",
        "README.md": f"mkdir -p {SHARE}/recordings/fone-import\nhttp://{LAN}:8788 or "
                     "http://<machine>.<tailnet>.ts.net:8788\n",
        "docs/setup.md": f"`{ip(172, 16, 0, 2)}` is read as http://{ip(172, 16, 0, 2)}:8788\n",
        "server/tests/test_x.py": 'KL = "/rec/fone/x.flv"\n',
        "docker-compose.yml": "volumes:\n  - ${FONE_REC_ROOT:?set it in .env}:/rec:ro\n",
        "server/fone/app.py": f"VERSION = '{ip(10, 0, 1)}'  # 1.{ip(192, 168, 1, 1)} is a version, not an address\n",
        "extension/options.html": f"<input placeholder=\"http://my-server:8788\"> <code>{ip(192, 0, 2, 10)}</code>\n",
        "extension/vendor/x.min.js": f"var a='{ip(10, 0, 0, 1)}'\n",
    }

    def check(self, extra=None):
        with tempfile.TemporaryDirectory() as t:
            git_repo(Path(t), {**self.CLEAN, **(extra or {})})
            return run("bash", str(TOOLS / "check_public.sh"), t)

    def test_clean(self):
        p = self.check()
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)

    def test_this_repo_runs(self):
        p = run("bash", str(TOOLS / "check_public.sh"))
        self.assertIn(p.returncode, (0, 1), p.stderr)  # what it finds is CI's business, not a crash
        self.assertNotIn("tools/test_release.py", p.stdout)

    def test_findings(self):
        lan = "home-network address"
        cases = {
            "tools/publish.env": ("FONE_SERVERS=\n", "only belongs on one machine"),
            "recorder/api.env": ("x=y\n", "only belongs on one machine"),
            ".env": ("FONE_REC_ROOT=/srv\n", "only belongs on one machine"),
            "extension/build.js": ("self.FONE_BUILD='x';\n", "only belongs on one machine"),
            "fone-extension.zip": ("zip", "only belongs on one machine"),
            "key.pem": ("-----BEGIN PRIVATE KEY-----\n", "only belongs on one machine"),
            "extension/local.js": ('self.FONE_LOCAL = {"servers": ["http://192.0.2.10:8788"]};\n', "not the placeholder"),
            "tools/mac/fone-sync.sh": ('BASE="${FONE_DIST:-http://srv.example:8789}"\n', "update server is filled in"),
            # a Tailscale name, a Tailscale address and the NAS: in an example or a doc too
            "docs/setup.md": (f"http://{TS_NAME}:8788\n", "a Tailscale name"),
            "tools/publish.env.example": ("FONE_SERVERS=http://your-server.your-tailnet" + ".ts.net:8788\n",
                                          "a Tailscale name"),
            "docs/tailnet.md": (f"http://{ip(100, 101, 102, 103)}:8788\n", "a Tailscale address"),
            "recorder/x.json": (f'{{"h": "{ip(100, 101, 102, 103)}:8788"}}\n', "a Tailscale address"),
            "docs/nas.md": (f"mkdir -p {NAS}/library/recordings/fone-import\n", "a NAS path"),
            ".env.example": (f"FONE_RECORDINGS={NAS}/library/recordings\n", "a NAS path"),
            "server/tests/test_y.py": (f'KL = "{NAS}/library/recordings/x.flv"\n', "a NAS path"),
            # a home-network address or another /mnt path: anywhere but the docs and the examples
            "e2e/x.py": (f"HOST = '{LAN}'\n", lan),
            "server/fone/x.py": (f"H = ('{ip(10, 0, 0, 5)}', 1)\n", lan),
            "server/fone/y.py": (f"H = '{ip(172, 20, 0, 5)}'\n", lan),
            "extension/options2.html": (f"<code>{LAN}</code> or <code>my-server:8788</code>\n", lan),
            "extension/options.test.js": (f"assert.equal(O.server('{LAN}').url, 'http://{LAN}:8788');\n", lan),
            "README.example.txt": (f"http://{LAN}:8788\n", lan),
            "tools/x.sh": (f"cd {HOME}/code\n", "a home directory"),
            "docker-compose.yml": (f"volumes:\n  - {SHARE}/recordings:/rec:ro\n", "a NAS path"),
        }
        for name, (text, why) in cases.items():
            with self.subTest(name):
                p = self.check({name: text})
                self.assertEqual(p.returncode, 1, p.stdout)
                self.assertIn(name, p.stdout)
                self.assertIn(why, p.stdout)

    def test_github_annotations(self):
        with tempfile.TemporaryDirectory() as t:
            git_repo(Path(t), {**self.CLEAN, "e2e/x.py": f"\n\nHOST = '{LAN}'\n"})
            p = run("bash", str(TOOLS / "check_public.sh"), t, env={"GITHUB_ACTIONS": "true"})
        self.assertEqual(p.stdout.splitlines()[0], "::error file=e2e/x.py,line=3::a home-network address (an "
                         f"example to fill in goes in a *.md or *.example file; elsewhere use 192.0.2.10): '{LAN}'")


if __name__ == "__main__":
    unittest.main()
