#!/usr/bin/env python3
"""Install / uninstall the What Agent Touched hook for Claude Code.

    python3 install_claude_code_hook.py              # Linux / macOS
    py install_claude_code_hook.py                   # Windows
    ... --uninstall                                  # remove it again
    ... --settings PATH   Claude settings file (default: $CLAUDE_CONFIG_DIR
                          or ~/.claude, then settings.json)
    ... --store DIR       store directory (default ~/.what-agent-touched)

Copies claude_code.py to <store>/hooks/wat_claude_code_hook.py (a stable
path that survives repo moves and extension upgrades) and merges one
PreToolUse entry into the settings file. Everything else in the settings file
is preserved; a timestamped backup is written next to it first. Running it
again replaces the previous entry instead of adding a second one.
"""

import argparse
import json
import os
import shutil
import sys
from datetime import datetime

HOOK_NAME = "wat_claude_code_hook.py"
MATCHER = "Edit|Write|MultiEdit|NotebookEdit"
DEFAULT_STORE = os.path.join(os.path.expanduser("~"), ".what-agent-touched")


def default_settings():
    base = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")
    return os.path.join(base, "settings.json")


def shell_path(p):
    # Forward slashes and no quotes unless needed: valid in bash, cmd and PowerShell alike.
    p = p.replace("\\", "/") if os.name == "nt" else p
    return '"%s"' % p if " " in p else p


def is_ours(hook):
    return isinstance(hook, dict) and HOOK_NAME in str(hook.get("command", ""))


def strip_ours(settings):
    groups = settings.get("hooks", {}).get("PreToolUse", [])
    kept = []
    for g in groups:
        hooks = [h for h in g.get("hooks", []) if not is_ours(h)] if isinstance(g, dict) else g
        if not isinstance(g, dict) or hooks:
            kept.append(dict(g, hooks=hooks) if isinstance(g, dict) else g)
    if "hooks" in settings:
        if kept:
            settings["hooks"]["PreToolUse"] = kept
        else:
            settings["hooks"].pop("PreToolUse", None)
        if not settings["hooks"]:
            settings.pop("hooks")
    return settings


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--uninstall", action="store_true")
    ap.add_argument("--settings", default=default_settings())
    ap.add_argument("--store", default=DEFAULT_STORE)
    args = ap.parse_args()
    settings_path = os.path.abspath(os.path.expanduser(args.settings))
    store = os.path.abspath(os.path.expanduser(args.store))

    settings = {}
    if os.path.exists(settings_path):
        with open(settings_path, encoding="utf-8") as f:
            text = f.read()
        try:
            settings = json.loads(text) if text.strip() else {}
        except ValueError as e:
            sys.exit("error: %s is not valid JSON (%s); not touching it" % (settings_path, e))
        if not isinstance(settings, dict):
            sys.exit("error: %s does not contain a JSON object; not touching it" % settings_path)
        backup = "%s.wat-backup-%s" % (settings_path, datetime.now().strftime("%Y%m%d-%H%M%S"))
        shutil.copyfile(settings_path, backup)
        print("backup:   %s" % backup)

    settings = strip_ours(settings)
    if not args.uninstall:
        hook_dst = os.path.join(store, "hooks", HOOK_NAME)
        os.makedirs(os.path.dirname(hook_dst), exist_ok=True)
        shutil.copyfile(os.path.join(os.path.dirname(os.path.abspath(__file__)), "claude_code.py"), hook_dst)
        command = "%s %s" % (shell_path(sys.executable), shell_path(hook_dst))
        if os.path.normcase(store) != os.path.normcase(DEFAULT_STORE):
            command += " --store %s" % shell_path(store)
        settings.setdefault("hooks", {}).setdefault("PreToolUse", []).append(
            {"matcher": MATCHER, "hooks": [{"type": "command", "command": command, "timeout": 10}]})
        print("hook:     %s" % hook_dst)
        print("command:  %s" % command)

    os.makedirs(os.path.dirname(settings_path), exist_ok=True)
    tmp = settings_path + ".wat-tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(settings, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, settings_path)
    print("%s: %s" % ("uninstalled" if args.uninstall else "installed", settings_path))
    print("Takes effect in new Claude Code sessions (restart a running one if its edits are not recorded).")


if __name__ == "__main__":
    main()
