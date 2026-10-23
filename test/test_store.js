'use strict';
// node test/test_store.js  (Node >= 16; drives the real Python hook)
const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store, fileKey } = require('../store');

const ROOT = path.dirname(__dirname);
const HOOK = path.join(ROOT, 'hooks', 'claude_code.py');
const PY = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const DAY = 24 * 3600 * 1000;

function hook(store, file, sid = 's1', tool = 'Edit') {
  const ev = JSON.stringify({ session_id: sid, cwd: path.dirname(file), tool_name: tool, tool_input: { file_path: file } });
  cp.execFileSync(PY, [HOOK, '--store', store], { input: ev });
}

async function statuses(store) {
  const out = {};
  for (const c of (await store.changes(DAY)).values()) out[path.basename(c.path)] = c.status;
  return out;
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wat-test-'));
  const ws = path.join(tmp, 'ws');
  const storeDir = path.join(tmp, 'store');
  fs.mkdirSync(ws);
  const f = (name) => path.join(ws, name);
  fs.writeFileSync(f('mod.c'), 'int a;\n');
  fs.writeFileSync(f('del.c'), 'gone\n');
  fs.writeFileSync(f('same.c'), 'unchanged\n');
  const store = new Store(storeDir);

  assert.deepStrictEqual(await statuses(store), {}, 'empty store');

  // Agent session: hook runs before each write.
  hook(storeDir, f('mod.c'));
  fs.writeFileSync(f('mod.c'), 'int a = 1;\n');
  hook(storeDir, f('new.py'), 's1', 'Write');
  fs.writeFileSync(f('new.py'), 'print(1)\n');
  hook(storeDir, f('del.c'));
  fs.unlinkSync(f('del.c'));
  hook(storeDir, f('same.c')); // e.g. edit denied by the user: file stays the same
  hook(storeDir, f('never.py'), 's1', 'Write'); // write denied: file never created
  assert.deepStrictEqual(await statuses(store), { 'mod.c': 'M', 'new.py': 'A', 'del.c': 'D' });

  const ch = (await store.changes(DAY)).get(fileKey(f('mod.c')));
  assert.strictEqual(fs.readFileSync(ch.blobPath, 'utf8'), 'int a;\n', 'blob holds the original');

  // Reverting to the original drops the mark; the status cache follows mtime/size.
  fs.writeFileSync(f('mod.c'), 'int a;\n');
  assert.ok(!('mod.c' in await statuses(store)), 'reverted file is no longer marked');
  fs.writeFileSync(f('mod.c'), 'int a = 2;\n');
  assert.strictEqual((await statuses(store))['mod.c'], 'M');

  // A second session touching the same file later: the earliest original wins.
  hook(storeDir, f('mod.c'), 's2');
  fs.writeFileSync(f('mod.c'), 'int a = 3;\n');
  const both = (await store.changes(DAY)).get(fileKey(f('mod.c')));
  assert.strictEqual(fs.readFileSync(both.blobPath, 'utf8'), 'int a;\n');
  assert.strictEqual(both.session, 'claude-code-s1');

  // A half-written entry is skipped, then picked up once complete.
  const files = path.join(storeDir, 'sessions', 'claude-code-s1', 'files');
  fs.writeFileSync(path.join(files, 'partial.json'), '{"path":');
  await store.changes(DAY);
  fs.unlinkSync(path.join(files, 'partial.json'));

  // Lookback hides idle sessions.
  const old = new Date(Date.now() - 2 * DAY);
  for (const s of ['s1', 's2']) fs.utimesSync(path.join(storeDir, 'sessions', `claude-code-${s}`, 'session.json'), old, old);
  assert.deepStrictEqual(await statuses(store), {}, 'idle sessions hidden');
  const now = new Date();
  for (const s of ['s1', 's2']) fs.utimesSync(path.join(storeDir, 'sessions', `claude-code-${s}`, 'session.json'), now, now);

  // Clear = new round: originals forgotten, tracked files untouched.
  await store.changes(DAY);
  await store.clear(store.lastSessions.map((s) => s.name));
  assert.deepStrictEqual(await statuses(store), {});
  assert.strictEqual(fs.readFileSync(f('mod.c'), 'utf8'), 'int a = 3;\n');
  hook(storeDir, f('mod.c')); // same session keeps editing after the clear
  fs.writeFileSync(f('mod.c'), 'int a = 4;\n');
  const fresh = (await store.changes(DAY)).get(fileKey(f('mod.c')));
  assert.strictEqual(fs.readFileSync(fresh.blobPath, 'utf8'), 'int a = 3;\n', 'new round baseline');

  // GC removes sessions idle past retention.
  fs.utimesSync(path.join(storeDir, 'sessions', 'claude-code-s1', 'session.json'), old, old);
  await store.gc(DAY);
  assert.deepStrictEqual(fs.readdirSync(path.join(storeDir, 'sessions')), []);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('store tests passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
