# What Agent Touched

See which files your AI agent changed, right in the VS Code explorer.

- **Explorer colors**: **M** yellow (modified), **A** green (added), **D** red
  (deleted; shown on parent folders and in the list).
- **Open a changed file -> automatic diff** of *original before the agent
  touched it* vs *now* (once per change; the editor title diff button reopens it).
- **"What Agent Touched" list** in the explorer and a status bar summary
  (`👁 3M 1A 0D`) of the files in the open workspace. Files the agent changed
  outside the workspace (e.g. its own config or memory) are kept in a collapsed
  **Outside workspace** group with their own counts. **Clear** starts a new round.
- Works in any permission mode, including fully automatic ones. No review
  workflow, no Keep/Undo: it only shows.
- Cost is proportional to the files the agent touches. Nothing is scanned, so
  huge workspaces and network file systems are fine.

Supported agents: **Claude Code** (VS Code extension and terminal CLI alike).
The store format is agent-neutral, so other agents only need a hook adapter.

## How it works

```
Claude Code (CLI / VS Code)          VS Code extension
        |                                  ^
  PreToolUse hook (Edit/Write/...)          | polls the store, compares
  copies the file's original the            | originals with files on disk
  first time a session touches it           |
        v                                  |
  ~/.what-agent-touched/sessions/<agent>-<session_id>/
      session.json      files/<key>.json      base/<original bytes>
```

This is Cursor-style copy-on-write: the original is saved right before the
agent's first write to a file, so diffs are exact without any baseline
snapshot. A round is one agent session; files touched by several sessions are
compared with the earliest original. A file whose content returns to its
original drops off the list.

**Not covered**: files changed through shell commands (`sed -i`, scripts,
`make`, ...). Like Claude Code's own checkpoints, only the file editing tools
are hooked. Your own manual edits to a touched file do show up in its diff.

## Install

Requirements: VS Code 1.80+, Python 3.6+ (hook, standard library only).

1. Install the extension (`.vsix`, see *Build*):
   `code --install-extension what-agent-touched-<version>.vsix`
   With Remote-SSH / WSL, run it in the remote terminal so it installs where
   the agent runs.
2. Install the Claude Code hook, either with the command palette:
   **What Agent Touched: Install Claude Code Hook**, or by hand:

   ```sh
   python3 hooks/install_claude_code_hook.py     # Linux / macOS
   py hooks\install_claude_code_hook.py          # Windows
   ```

   It copies the hook to `~/.what-agent-touched/hooks/` and adds one
   `PreToolUse` entry to `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR`),
   keeping everything else and writing a timestamped backup first. Re-running
   it replaces the entry; `--uninstall` removes it.
3. Start a new Claude Code session. Edits show up within the poll interval.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `whatAgentTouched.autoOpenDiff` | `true` | Diff when opening a changed file |
| `whatAgentTouched.lookbackHours` | `24` | Show sessions active within this window |
| `whatAgentTouched.retentionDays` | `7` | Delete originals of sessions idle longer |
| `whatAgentTouched.pollIntervalMs` | `2000` | Re-check interval |
| `whatAgentTouched.storeDir` | `~/.what-agent-touched` | Store location (also `$WHAT_AGENT_TOUCHED_HOME`) |
| `whatAgentTouched.pythonPath` | auto | Python for the install/uninstall commands |

Colors can be changed through `workbench.colorCustomizations`:
`whatAgentTouched.modifiedForeground`, `.addedForeground`, `.deletedForeground`.

## Build and test

Plain JavaScript, no build step, no dependencies.

```sh
python3 scripts/package_vsix.py              # -> what-agent-touched-<version>.vsix
python3 -m unittest discover -s test         # hook + installer
node test/test_store.js                      # store logic (drives the real hook)
node test/smoke_extension.js                 # extension against a fake vscode API
```

Set `PYTHON=...` for the Node tests if `python3` (`python` on Windows) is not
the right interpreter.

## Adding another agent

Write a hook that, right before the agent writes a file, creates
`sessions/<agent>-<session_id>/files/<sha1(normcase(path))>.json` with
`O_EXCL` (first capture wins) containing
`{"path", "existed", "blob", "size", "mtime_ms", "captured"}`, copies the
original to `base/` and touches `session.json`. See `hooks/claude_code.py`.

## License

MIT
