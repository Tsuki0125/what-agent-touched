#!/usr/bin/env python3
"""What Agent Touched: Claude Code PreToolUse hook.

Runs before every Edit / Write / MultiEdit / NotebookEdit tool call and saves
the file's original content the first time a session touches it
(copy-on-write). The VS Code extension compares those originals with the
files on disk to show what the agent changed.

Store layout (default ~/.what-agent-touched, override with --store DIR or
the WHAT_AGENT_TOUCHED_HOME environment variable):

    sessions/claude-code-<session_id>/
        session.json        session metadata; its mtime = last activity
        files/<key>.json    one entry per touched file (created with O_EXCL,
                            so the first capture wins without any locking)
        base/<key>-<uniq>   original bytes of the file

Standard library only; works on Linux, macOS and Windows with Python 3.6+.
The hook must never block or break an edit: every error is swallowed, it
prints nothing to stdout and always exits 0.
"""

import hashlib
import json
import os
import re
import shutil
import sys
import uuid
from datetime import datetime, timezone

AGENT = "claude-code"
PATH_KEYS = ("file_path", "notebook_path")
MAX_COPY_BYTES = 50 * 1024 * 1024
STORE_ENV = "WHAT_AGENT_TOUCHED_HOME"


def store_dir(argv):
    if "--store" in argv:
        i = argv.index("--store")
        if i + 1 < len(argv):
            return os.path.abspath(os.path.expanduser(argv[i + 1]))
    env = os.environ.get(STORE_ENV)
    if env:
        return os.path.abspath(os.path.expanduser(env))
    return os.path.join(os.path.expanduser("~"), ".what-agent-touched")


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def normalize(raw, cwd):
    p = raw
    if os.name == "nt":
        # Git Bash / MSYS style "/c/Users/..." -> "c:/Users/..."
        m = re.match(r"^/([a-zA-Z])(/.*)?$", p)
        if m:
            p = m.group(1) + ":" + (m.group(2) or "/")
    if not os.path.isabs(p):
        p = os.path.join(cwd or os.getcwd(), p)
    return os.path.normpath(os.path.abspath(p))


def file_key(path):
    # normcase lowercases and uses backslashes on Windows; no-op on POSIX.
    return hashlib.sha1(os.path.normcase(path).encode("utf-8", "surrogateescape")).hexdigest()


def is_inside(path, folder):
    path, folder = os.path.normcase(path), os.path.normcase(os.path.join(folder, ""))
    return path.startswith(folder)


def write_exclusive(path, data):
    """Create path with data; False if it already exists."""
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0), 0o644)
    except FileExistsError:
        return False
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    return True


def touch_session(sdir, event):
    meta = os.path.join(sdir, "session.json")
    info = {
        "agent": AGENT,
        "session_id": event.get("session_id"),
        "cwd": event.get("cwd"),
        "transcript_path": event.get("transcript_path"),
        "started": now_iso(),
    }
    if not write_exclusive(meta, json.dumps(info, indent=2).encode("utf-8")):
        os.utime(meta, None)


def capture(event, store):
    tool_input = event.get("tool_input") or {}
    raw = next((tool_input[k] for k in PATH_KEYS if isinstance(tool_input.get(k), str) and tool_input[k]), None)
    if not raw:
        return
    path = normalize(raw, event.get("cwd"))
    if is_inside(path, store) or os.path.isdir(path):
        return

    sid = re.sub(r"[^A-Za-z0-9_.-]", "_", str(event.get("session_id") or "unknown"))
    sdir = os.path.join(store, "sessions", "%s-%s" % (AGENT, sid))
    files_dir = os.path.join(sdir, "files")
    base_dir = os.path.join(sdir, "base")
    os.makedirs(files_dir, exist_ok=True)
    os.makedirs(base_dir, exist_ok=True)
    touch_session(sdir, event)

    key = file_key(path)
    entry = os.path.join(files_dir, key + ".json")
    if os.path.exists(entry):
        return  # already captured in this session: keep the true original

    record = {"path": path, "existed": False, "blob": None, "size": None, "mtime_ms": None,
              "captured": now_iso(), "tool": event.get("tool_name")}
    blob_abs = None
    if os.path.isfile(path):
        st = os.stat(path)
        record.update(existed=True, size=st.st_size, mtime_ms=st.st_mtime_ns // 1000000)
        if st.st_size <= MAX_COPY_BYTES:
            # Unique name: a losing concurrent writer can never clobber the winner's copy.
            blob = "base/%s-%d-%s" % (key, os.getpid(), uuid.uuid4().hex[:8])
            blob_abs = os.path.join(sdir, *blob.split("/"))
            shutil.copyfile(path, blob_abs)
            record["blob"] = blob

    if not write_exclusive(entry, json.dumps(record, indent=2, ensure_ascii=False).encode("utf-8")):
        if blob_abs:
            os.remove(blob_abs)


def main():
    store = store_dir(sys.argv[1:])
    try:
        data = sys.stdin.buffer.read().decode("utf-8", "replace")
        capture(json.loads(data) if data.strip() else {}, store)
    except Exception as e:  # never fail the agent's edit
        try:
            os.makedirs(store, exist_ok=True)
            with open(os.path.join(store, "hook-errors.log"), "a", encoding="utf-8") as f:
                f.write("%s %s: %s\n" % (now_iso(), type(e).__name__, e))
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
