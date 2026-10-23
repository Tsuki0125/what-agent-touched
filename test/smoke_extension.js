'use strict';
// Smoke test of extension.js against a minimal fake `vscode` module:
// node test/smoke_extension.js  (Node >= 16, Python for the hook)
const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

const ROOT = path.dirname(__dirname);
const PY = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const defaults = Object.fromEntries(Object.entries(pkg.contributes.configuration.properties)
  .map(([k, v]) => [k.replace('whatAgentTouched.', ''), v.default]));

const calls = [];
const handlers = {};
class EventEmitter {
  constructor() { this.listeners = []; this.event = (fn) => this.listeners.push(fn); }
  fire(v) { this.listeners.forEach((fn) => fn(v)); }
}
class Uri {
  constructor(scheme, p, query = '') { this.scheme = scheme; this.path = p; this.query = query; }
  get fsPath() { return path.normalize(this.path); }
  toString() { return `${this.scheme}://${this.path}?${this.query}`; }
  static file(p) { return new Uri('file', path.resolve(p)); }
  static from({ scheme, path: p, query }) { return new Uri(scheme, p, query); }
}
class TabInputText { constructor(uri) { this.uri = uri; } }
const group = { viewColumn: 1, tabs: [], activeTab: null };
const workspaceFolders = [];
const statusItem = { show() {}, dispose() {} };
const vscode = {
  EventEmitter, Uri, TabInputText,
  ThemeColor: class { constructor(id) { this.id = id; } },
  FileDecoration: class { constructor(badge, tooltip, color) { Object.assign(this, { badge, tooltip, color }); } },
  TreeItem: class {
    constructor(x, state) { if (x instanceof Uri) this.resourceUri = x; else this.label = x; this.collapsibleState = state; }
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class { constructor(id) { this.id = id; } },
  StatusBarAlignment: { Left: 1 },
  window: {
    createStatusBarItem: () => statusItem,
    createTreeView: () => ({ dispose() {} }),
    registerFileDecorationProvider: () => ({ dispose() {} }),
    showInformationMessage: (m) => calls.push(['info', m]),
    showErrorMessage: (m) => calls.push(['error', m]),
    showTextDocument: (u) => calls.push(['show', u.toString()]),
    onDidChangeActiveTextEditor: (fn) => { handlers.activeEditor = fn; return { dispose() {} }; },
    onDidChangeWindowState: () => ({ dispose() {} }),
    tabGroups: { activeTabGroup: group, close: async (t) => { calls.push(['close', t.input.uri.fsPath]); } },
    activeTextEditor: null,
  },
  workspace: {
    getConfiguration: () => ({ get: (k) => defaults[k] }),
    registerTextDocumentContentProvider: () => ({ dispose() {} }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
    workspaceFolders,
    getWorkspaceFolder: (u) => workspaceFolders.find((f) => u.fsPath.startsWith(f.uri.fsPath + path.sep)),
    asRelativePath: (u) => u.fsPath,
  },
  commands: {
    registerCommand: (id, fn) => { handlers[id] = fn; return { dispose() {} }; },
    executeCommand: async (...a) => { calls.push(['exec', a[0], a[1]?.toString(), a[2]?.toString()]); },
  },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) { return req === 'vscode' ? 'vscode' : origResolve.call(this, req, ...rest); };
require.cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: vscode };

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wat-smoke-'));
  const storeDir = path.join(tmp, 'store');
  process.env.WHAT_AGENT_TOUCHED_HOME = storeDir;
  const ws = path.join(tmp, 'ws');
  fs.mkdirSync(ws);
  workspaceFolders.push({ uri: Uri.file(ws) });
  const file = path.join(ws, 'a.c');
  const outside = path.join(tmp, 'notes.md');
  fs.writeFileSync(file, 'int a;\n');
  const capture = (p, tool) => cp.execFileSync(PY, [path.join(ROOT, 'hooks', 'claude_code.py')],
    { input: JSON.stringify({ session_id: 's', cwd: ws, tool_name: tool, tool_input: { file_path: p } }) });
  capture(file, 'Edit');
  fs.writeFileSync(file, 'int a = 1;\n');
  capture(outside, 'Write');
  fs.writeFileSync(outside, '# outside the workspace\n');

  const ext = require('../extension');
  const subs = [];
  ext.activate({ subscriptions: subs, extensionPath: ROOT });
  const tracker = subs[0];
  await new Promise((r) => setTimeout(r, 300));
  await tracker.refresh();

  const deco = tracker.provideFileDecoration(Uri.file(file));
  assert.strictEqual(deco.badge, 'M');
  assert.strictEqual(deco.color.id, 'whatAgentTouched.modifiedForeground');
  assert.strictEqual(tracker.provideFileDecoration(Uri.file(path.join(tmp, 'other.c'))), undefined);
  // Workspace files at the top level, outside files in a collapsed group; status bar counts the workspace only.
  const kids = tracker.getChildren();
  assert.strictEqual(kids.length, 2);
  assert.strictEqual(tracker.getTreeItem(kids[0]).label, 'a.c');
  const groupItem = tracker.getTreeItem(kids[1]);
  assert.strictEqual(groupItem.label, 'Outside workspace');
  assert.strictEqual(groupItem.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
  assert.strictEqual(groupItem.description, '0M 1A 0D');
  const outKids = tracker.getChildren(kids[1]);
  assert.strictEqual(outKids.length, 1);
  assert.strictEqual(tracker.getTreeItem(outKids[0]).label, 'notes.md');
  assert.strictEqual(statusItem.text, '$(eye) 1M 0A 0D');
  assert.ok(statusItem.tooltip.includes('plus 1 outside it (0M 1A 0D)'), statusItem.tooltip);
  assert.strictEqual(tracker.provideFileDecoration(Uri.file(outside)).badge, 'A');

  // Opening the changed file as a plain tab turns it into a diff once.
  const uri = Uri.file(file);
  const tab = { input: new TabInputText(uri), isPreview: true };
  group.tabs = [tab];
  group.activeTab = tab;
  const editor = { document: { uri, isDirty: false } };
  await handlers.activeEditor(editor);
  const diff = calls.find((c) => c[0] === 'exec' && c[1] === 'vscode.diff');
  assert.ok(diff, 'diff opened');
  assert.ok(calls.some((c) => c[0] === 'close'), 'plain tab replaced');
  const n = calls.length;
  await handlers.activeEditor(editor);
  assert.strictEqual(calls.length, n, 'not reopened for the same version');

  const left = JSON.parse(decodeURIComponent(diff[2].split('?')[1]));
  assert.strictEqual(await tracker.provideTextDocumentContent(Uri.from({ scheme: 'wat-base', path: uri.path, query: JSON.stringify(left) })), 'int a;\n');

  await handlers['whatAgentTouched.clear']();
  assert.strictEqual(tracker.getChildren().length, 0);
  subs.forEach((s) => s.dispose && s.dispose());
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.ok(!calls.some((c) => c[0] === 'error'), JSON.stringify(calls));
  console.log('extension smoke test passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
