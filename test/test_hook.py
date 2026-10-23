"""Tests for the Claude Code hook and its installer: python -m unittest discover -s test"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOOK = os.path.join(ROOT, "hooks", "claude_code.py")
INSTALLER = os.path.join(ROOT, "hooks", "install_claude_code_hook.py")


def run_hook(store, event, raw=None):
    data = raw if raw is not None else json.dumps(event).encode("utf-8")
    return subprocess.run([sys.executable, HOOK, "--store", store], input=data,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def entries(store, sid="s1"):
    d = os.path.join(store, "sessions", "claude-code-" + sid, "files")
    out = {}
    for f in sorted(os.listdir(d)) if os.path.isdir(d) else []:
        with open(os.path.join(d, f), encoding="utf-8") as fh:
            rec = json.load(fh)
        out[rec["path"]] = rec
    return out


class HookTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.ws = os.path.join(self.tmp.name, "ws")
        self.store = os.path.join(self.tmp.name, "store")
        os.makedirs(self.ws)

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, rel, text):
        p = os.path.join(self.ws, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8", newline="") as f:
            f.write(text)
        return p

    def event(self, path, sid="s1", tool="Edit", key="file_path"):
        return {"session_id": sid, "cwd": self.ws, "hook_event_name": "PreToolUse",
                "tool_name": tool, "tool_input": {key: path}}

    def test_first_capture_wins(self):
        p = self.write("a.txt", "original\n")
        r = run_hook(self.store, self.event(p))
        self.assertEqual((r.returncode, r.stdout), (0, b""))
        self.write("a.txt", "edited by agent\n")
        run_hook(self.store, self.event(p))  # second edit in the same session
        rec = entries(self.store)[os.path.normpath(p)]
        self.assertTrue(rec["existed"])
        sdir = os.path.join(self.store, "sessions", "claude-code-s1")
        with open(os.path.join(sdir, *rec["blob"].split("/")), encoding="utf-8") as f:
            self.assertEqual(f.read(), "original\n")

    def test_new_file_relative_path_and_notebook(self):
        run_hook(self.store, self.event("sub/new.py", tool="Write"))
        nb = self.write("n.ipynb", "{}")
        run_hook(self.store, self.event(nb, tool="NotebookEdit", key="notebook_path"))
        es = entries(self.store)
        new = es[os.path.normpath(os.path.join(self.ws, "sub", "new.py"))]
        self.assertEqual((new["existed"], new["blob"]), (False, None))
        self.assertTrue(es[os.path.normpath(nb)]["existed"])

    def test_sessions_are_separate(self):
        p = self.write("a.txt", "v1\n")
        run_hook(self.store, self.event(p, sid="s1"))
        self.write("a.txt", "v2\n")
        run_hook(self.store, self.event(p, sid="s2"))
        self.assertIn(os.path.normpath(p), entries(self.store, "s1"))
        self.assertIn(os.path.normpath(p), entries(self.store, "s2"))

    def test_concurrent_captures_leave_one_entry_and_one_blob(self):
        p = self.write("c.txt", "x" * 100000)
        with ThreadPoolExecutor(8) as ex:
            list(ex.map(lambda _: run_hook(self.store, self.event(p)), range(16)))
        self.assertEqual(len(entries(self.store)), 1)
        base = os.path.join(self.store, "sessions", "claude-code-s1", "base")
        self.assertEqual(len(os.listdir(base)), 1)

    def test_ignores_bad_input_and_own_store(self):
        for raw in (b"", b"not json", json.dumps({"tool_input": {}}).encode()):
            r = run_hook(self.store, None, raw=raw)
            self.assertEqual((r.returncode, r.stdout), (0, b""))
        os.makedirs(self.store, exist_ok=True)
        run_hook(self.store, self.event(os.path.join(self.store, "x.txt")))
        run_hook(self.store, self.event(self.ws))  # a directory
        self.assertEqual(entries(self.store), {})


class InstallerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.settings = os.path.join(self.tmp.name, "claude", "settings.json")
        self.store = os.path.join(self.tmp.name, "store")
        os.makedirs(os.path.dirname(self.settings))
        self.original = {
            "env": {"FOO": "bar"},
            "model": "opus",
            "hooks": {
                "PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "echo other"}]}],
                "Stop": [{"hooks": [{"type": "command", "command": "notify"}]}],
            },
        }
        with open(self.settings, "w", encoding="utf-8") as f:
            json.dump(self.original, f)

    def tearDown(self):
        self.tmp.cleanup()

    def install(self, *extra):
        r = subprocess.run([sys.executable, INSTALLER, "--settings", self.settings, "--store", self.store, *extra],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        with open(self.settings, encoding="utf-8") as f:
            return json.load(f)

    def test_install_is_idempotent_and_preserves_settings(self):
        self.install()
        s = self.install()
        self.assertEqual(s["env"], {"FOO": "bar"})
        self.assertEqual(s["hooks"]["Stop"], self.original["hooks"]["Stop"])
        pre = s["hooks"]["PreToolUse"]
        self.assertEqual(pre[0], self.original["hooks"]["PreToolUse"][0])
        ours = [g for g in pre if "wat_claude_code_hook.py" in g["hooks"][0]["command"]]
        self.assertEqual(len(ours), 1)
        self.assertEqual(ours[0]["matcher"], "Edit|Write|MultiEdit|NotebookEdit")
        self.assertIn("--store", ours[0]["hooks"][0]["command"])
        self.assertTrue(os.path.isfile(os.path.join(self.store, "hooks", "wat_claude_code_hook.py")))
        backups = [f for f in os.listdir(os.path.dirname(self.settings)) if ".wat-backup-" in f]
        self.assertTrue(backups)

    def test_uninstall_restores_original_hooks(self):
        self.install()
        s = self.install("--uninstall")
        self.assertEqual(s, self.original)

    def test_installed_command_runs(self):
        s = self.install()
        cmd = s["hooks"]["PreToolUse"][-1]["hooks"][0]["command"]
        target = os.path.join(self.tmp.name, "t.txt")
        with open(target, "w") as f:
            f.write("hi")
        ev = json.dumps({"session_id": "x", "cwd": self.tmp.name, "tool_name": "Edit",
                         "tool_input": {"file_path": target}})
        r = subprocess.run(cmd, shell=True, input=ev.encode(), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(os.listdir(os.path.join(self.store, "sessions", "claude-code-x", "files")))

    def test_refuses_invalid_json(self):
        with open(self.settings, "w") as f:
            f.write("{ broken")
        r = subprocess.run([sys.executable, INSTALLER, "--settings", self.settings, "--store", self.store],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
        self.assertNotEqual(r.returncode, 0)
        with open(self.settings) as f:
            self.assertEqual(f.read(), "{ broken")


if __name__ == "__main__":
    unittest.main()
