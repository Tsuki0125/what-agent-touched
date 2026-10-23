'use strict';
// What Agent Touched: shows which files AI agent sessions changed.
// Agent hooks (hooks/*.py) save each file's original content right before the
// agent first writes it; this extension compares those originals with the
// files on disk:
//   - explorer badges/colors: M yellow, A green, D red
//   - opening a changed text file shows a diff against the original
//   - "What Agent Touched" list in the explorer, status bar summary

const vscode = require('vscode');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store, defaultStoreDir, fileKey } = require('./store');

const BASE_SCHEME = 'wat-base';
const LABEL = { M: 'Modified', A: 'Added', D: 'Deleted' };
const COLOR = {
  M: 'whatAgentTouched.modifiedForeground',
  A: 'whatAgentTouched.addedForeground',
  D: 'whatAgentTouched.deletedForeground',
};

const cfg = () => vscode.workspace.getConfiguration('whatAgentTouched');
const HOUR = 3600 * 1000;
const OUTSIDE = { group: 'outside' };

function counts(list) {
  const n = { M: 0, A: 0, D: 0 };
  for (const { status } of list) n[status]++;
  return n;
}

const fmtCounts = (n) => `${n.M}M ${n.A}A ${n.D}D`;

function tildify(p) {
  const home = os.homedir();
  return p === home || p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

class Tracker {
  constructor(ctx) {
    this.ctx = ctx;
    this.store = new Store(this.storeDir());
    this.changes = new Map();     // fileKey -> change (see Store.changes)
    this.sessionNames = [];
    this.autoDiffed = new Map();  // fileKey -> change.version already auto-opened
    this.running = false;
    this.decoEmitter = new vscode.EventEmitter();
    this.treeEmitter = new vscode.EventEmitter();
    this.onDidChangeFileDecorations = this.decoEmitter.event;
    this.onDidChangeTreeData = this.treeEmitter.event;
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.status.command = 'whatAgentTouched.menu';
    this.status.show();
    this.view = null;
    this.timer = null;
  }

  storeDir() {
    const d = cfg().get('storeDir');
    return d ? path.resolve(d.replace(/^~(?=$|[\\/])/, os.homedir())) : defaultStoreDir();
  }

  lookbackMs() {
    return (cfg().get('lookbackHours') || 24) * HOUR;
  }

  start() {
    clearInterval(this.timer);
    this.timer = setInterval(() => this.refresh(), Math.max(500, cfg().get('pollIntervalMs') || 2000));
    this.store.gc((cfg().get('retentionDays') || 7) * 24 * HOUR).finally(() => this.refresh());
  }

  async refresh() {
    if (this.running) return;
    this.running = true;
    try {
      const old = this.changes;
      const next = await this.store.changes(this.lookbackMs());
      this.sessionNames = this.store.lastSessions.map((s) => s.name);
      this.changes = next;
      const touched = [];
      for (const k of new Set([...old.keys(), ...next.keys()])) {
        const a = old.get(k);
        const b = next.get(k);
        if (a?.status !== b?.status) touched.push(vscode.Uri.file((a || b).path));
      }
      const changedList = touched.length || old.size !== next.size ||
        [...next].some(([k, c]) => old.get(k)?.version !== c.version);
      if (touched.length) this.decoEmitter.fire(touched);
      if (changedList) this.treeEmitter.fire();
      this.updateStatus();
    } catch (e) {
      console.error(`what-agent-touched: refresh failed: ${e.message}`);
    } finally {
      this.running = false;
    }
  }

  // Changes split by whether the file lies in an open workspace folder.
  split() {
    const inside = [];
    const outside = [];
    for (const c of [...this.changes.values()].sort((a, b) => a.path.localeCompare(b.path))) {
      (vscode.workspace.getWorkspaceFolder(vscode.Uri.file(c.path)) ? inside : outside).push(c);
    }
    return { inside, outside };
  }

  updateStatus() {
    const { inside, outside } = this.split();
    const n = counts(inside);
    this.status.text = `$(eye) ${n.M}M ${n.A}A ${n.D}D`;
    this.status.tooltip = `What Agent Touched: ${inside.length} file(s) in this workspace changed by ` +
      `${this.sessionNames.length} agent session(s) in the last ${cfg().get('lookbackHours') || 24}h` +
      `${outside.length ? `, plus ${outside.length} outside it (${fmtCounts(counts(outside))})` : ''}. Click for actions.`;
    if (this.view) {
      this.view.message = this.changes.size ? undefined
        : this.sessionNames.length ? 'Agent sessions touched no files that still differ.'
          : 'No agent edits recorded yet. Run "What Agent Touched: Install Claude Code Hook" once, then start a new Claude Code session.';
    }
  }

  // ---- explorer decorations ---------------------------------------------

  provideFileDecoration(uri) {
    if (uri.scheme !== 'file') return undefined;
    const c = this.changes.get(fileKey(uri.fsPath));
    if (!c) return undefined;
    const d = new vscode.FileDecoration(c.status, `Agent: ${LABEL[c.status]}`, new vscode.ThemeColor(COLOR[c.status]));
    d.propagate = true;
    return d;
  }

  // ---- list view -----------------------------------------------------------

  // Elements: fileKey strings for files, OUTSIDE for the outside-workspace group.
  getChildren(el) {
    const { inside, outside } = this.split();
    if (el === OUTSIDE) return outside.map((c) => fileKey(c.path));
    if (el) return [];
    return [...inside.map((c) => fileKey(c.path)), ...(outside.length ? [OUTSIDE] : [])];
  }

  getTreeItem(k) {
    if (k === OUTSIDE) {
      const { outside } = this.split();
      const group = new vscode.TreeItem('Outside workspace', vscode.TreeItemCollapsibleState.Collapsed);
      group.id = 'whatAgentTouched.outside';
      group.iconPath = new vscode.ThemeIcon('link-external');
      group.description = fmtCounts(counts(outside));
      group.tooltip = `${outside.length} file(s) outside the open workspace folders changed by agent sessions`;
      return group;
    }
    const c = this.changes.get(k);
    const uri = vscode.Uri.file(c ? c.path : k);
    const item = new vscode.TreeItem(uri);
    item.label = path.basename(uri.fsPath);
    const rel = vscode.workspace.asRelativePath(uri, false);
    item.description = path.isAbsolute(rel) ? tildify(path.dirname(rel)) : path.dirname(rel);
    if (c) {
      item.tooltip = `${LABEL[c.status]}: ${c.path}\nsession: ${c.session}`;
      item.command = { command: 'whatAgentTouched.openDiff', title: 'Open Diff', arguments: [uri] };
    }
    return item;
  }

  // ---- diff ----------------------------------------------------------------

  baseUri(fileUri, c) {
    return vscode.Uri.from({ scheme: BASE_SCHEME, path: fileUri.path, query: JSON.stringify({ blob: c.blobPath }) });
  }

  async provideTextDocumentContent(uri) {
    const { blob } = JSON.parse(uri.query);
    if (!blob) return '';
    try {
      return await fs.promises.readFile(blob, 'utf8');
    } catch {
      return '';
    }
  }

  async openDiff(uri, opts = {}) {
    uri = uri || vscode.window.activeTextEditor?.document.uri;
    if (!uri) return false;
    const c = this.changes.get(fileKey(uri.fsPath));
    if (!c) {
      if (!opts.quiet) vscode.window.showInformationMessage('What Agent Touched: no agent changes in this file.');
      return false;
    }
    if (c.status !== 'A' && !c.blobPath) {
      if (!opts.quiet) vscode.window.showInformationMessage('What Agent Touched: file was too large to keep its original.');
      return false;
    }
    const left = this.baseUri(uri, c);
    if (c.status === 'D') {
      await vscode.window.showTextDocument(left, { preview: true });
      return true;
    }
    await vscode.commands.executeCommand('vscode.diff', left, uri, `${path.basename(uri.fsPath)} (before agent ↔ now)`,
      { preview: opts.preview ?? true, viewColumn: opts.viewColumn });
    return true;
  }

  async maybeAutoDiff(editor) {
    if (!editor || !cfg().get('autoOpenDiff')) return;
    const uri = editor.document.uri;
    if (uri.scheme !== 'file') return;
    const group = vscode.window.tabGroups.activeTabGroup;
    const tab = group.activeTab;
    // Only plain text tabs; the sides of a diff editor are text editors too.
    if (!tab || !(tab.input instanceof vscode.TabInputText) || tab.input.uri.toString() !== uri.toString()) return;
    const k = fileKey(uri.fsPath);
    const c = this.changes.get(k);
    if (!c || c.status === 'D' || this.autoDiffed.get(k) === c.version) return;
    this.autoDiffed.set(k, c.version);
    const opened = await this.openDiff(uri, { viewColumn: group.viewColumn, preview: tab.isPreview, quiet: true });
    if (!opened || editor.document.isDirty) return;
    const plain = group.tabs.find((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === uri.toString());
    if (plain) await vscode.window.tabGroups.close(plain, true).then(undefined, () => {});
  }

  // ---- commands ------------------------------------------------------------

  async clear() {
    await this.store.clear(this.sessionNames);
    this.autoDiffed.clear();
    await this.refresh();
  }

  async installHook(uninstall = false) {
    const installer = path.join(this.ctx.extensionPath, 'hooks', 'install_claude_code_hook.py');
    const args = [installer, ...(uninstall ? ['--uninstall'] : [])];
    if (cfg().get('storeDir')) args.push('--store', this.storeDir());
    const configured = cfg().get('pythonPath');
    const candidates = configured ? [[configured]]
      : process.platform === 'win32' ? [['py', '-3'], ['python'], ['python3']] : [['python3'], ['python']];
    let lastErr = null;
    for (const [exe, ...pre] of candidates) {
      try {
        const out = await new Promise((resolve, reject) => cp.execFile(exe, [...pre, ...args], (err, stdout, stderr) =>
          (err ? reject(Object.assign(err, { stderr })) : resolve(stdout))));
        vscode.window.showInformationMessage(`What Agent Touched: ${out.trim().split('\n').slice(-2).join(' ')}`);
        return;
      } catch (e) {
        lastErr = e;
        if (e.code !== 'ENOENT') break; // python ran but failed: report it
      }
    }
    vscode.window.showErrorMessage(`What Agent Touched: hook ${uninstall ? 'uninstall' : 'install'} failed: ` +
      `${lastErr?.stderr || lastErr?.message || 'no Python found'} (set whatAgentTouched.pythonPath)`);
  }

  async menu() {
    const pick = await vscode.window.showQuickPick([
      { label: '$(list-flat) Show changed files', id: 'show' },
      { label: '$(clear-all) Clear (start a new round)', description: 'forget recorded originals; files are not touched', id: 'clear' },
      { label: '$(refresh) Refresh', id: 'refresh' },
    ], { placeHolder: `What Agent Touched — ${this.changes.size} changed file(s)` });
    if (pick?.id === 'show') await vscode.commands.executeCommand('whatAgentTouched.changes.focus');
    else if (pick?.id === 'clear') await this.clear();
    else if (pick?.id === 'refresh') await this.refresh();
  }

  dispose() {
    clearInterval(this.timer);
    this.status.dispose();
  }
}

function activate(ctx) {
  const t = new Tracker(ctx);
  t.view = vscode.window.createTreeView('whatAgentTouched.changes', { treeDataProvider: t });
  ctx.subscriptions.push(
    t,
    t.view,
    vscode.window.registerFileDecorationProvider(t),
    vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, t),
    vscode.commands.registerCommand('whatAgentTouched.refresh', () => t.refresh()),
    vscode.commands.registerCommand('whatAgentTouched.clear', () => t.clear()),
    vscode.commands.registerCommand('whatAgentTouched.openDiff', (uri) => t.openDiff(uri)),
    vscode.commands.registerCommand('whatAgentTouched.menu', () => t.menu()),
    vscode.commands.registerCommand('whatAgentTouched.installHook', () => t.installHook(false)),
    vscode.commands.registerCommand('whatAgentTouched.uninstallHook', () => t.installHook(true)),
    vscode.window.onDidChangeActiveTextEditor((ed) => t.maybeAutoDiff(ed)),
    vscode.window.onDidChangeWindowState((s) => { if (s.focused) t.refresh(); }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { t.treeEmitter.fire(); t.updateStatus(); }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('whatAgentTouched')) return;
      t.store = new Store(t.storeDir());
      t.start();
    }),
  );
  t.start();
}

function deactivate() {}

module.exports = { activate, deactivate };
