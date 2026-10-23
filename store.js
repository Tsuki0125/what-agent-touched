'use strict';
// Reads the What Agent Touched store written by the agent hooks (see
// hooks/claude_code.py) and works out, per file, whether it now differs from
// the original the agent first saw. No VS Code dependency, so it can be
// tested with plain Node.

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const STORE_ENV = 'WHAT_AGENT_TOUCHED_HOME';

function defaultStoreDir() {
  return process.env[STORE_ENV] || path.join(os.homedir(), '.what-agent-touched');
}

// Map key for a file path; Windows paths are case-insensitive.
function fileKey(p) {
  const n = path.normalize(p);
  return process.platform === 'win32' ? n.toLowerCase() : n;
}

async function statFile(p) {
  try {
    const st = await fsp.stat(p);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

async function sameBytes(a, b) {
  const [x, y] = await Promise.all([fsp.readFile(a), fsp.readFile(b)]);
  return x.equals(y);
}

class Store {
  constructor(dir) {
    this.dir = dir;
    this.entries = new Map();  // entry json path -> parsed record (entries are immutable)
    this.statuses = new Map(); // fileKey|sessionDir -> { sig, status }
    this.lastSessions = [];    // sessions seen by the last changes() call
  }

  sessionsDir() {
    return path.join(this.dir, 'sessions');
  }

  // Sessions active within lookbackMs, each with its file entries.
  async sessions(lookbackMs, now = Date.now()) {
    let names = [];
    try { names = await fsp.readdir(this.sessionsDir()); } catch { /* no store yet */ }
    const seen = new Set();
    const out = [];
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const dir = path.join(this.sessionsDir(), name);
      const meta = await statFile(path.join(dir, 'session.json'));
      if (!meta || now - meta.mtimeMs > lookbackMs) continue;
      let files = [];
      try { files = await fsp.readdir(path.join(dir, 'files')); } catch { /* none yet */ }
      const entries = [];
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const full = path.join(dir, 'files', f);
        seen.add(full);
        let rec = this.entries.get(full);
        if (!rec) {
          try {
            rec = JSON.parse(await fsp.readFile(full, 'utf8'));
          } catch {
            continue; // still being written; retry on the next poll
          }
          this.entries.set(full, rec);
        }
        entries.push(rec);
      }
      out.push({ name, dir, lastActive: meta.mtimeMs, entries });
    }
    for (const k of this.entries.keys()) if (!seen.has(k)) this.entries.delete(k);
    return out;
  }

  // fileKey -> { path, status: 'M'|'A'|'D', blobPath, session, version }.
  // When several sessions touched a file, the earliest original wins.
  async changes(lookbackMs) {
    const first = new Map();
    this.lastSessions = await this.sessions(lookbackMs);
    for (const s of this.lastSessions) {
      for (const rec of s.entries) {
        const k = fileKey(rec.path);
        const prev = first.get(k);
        if (!prev || rec.captured < prev.rec.captured) first.set(k, { rec, session: s });
      }
    }
    const out = new Map();
    await Promise.all([...first].map(async ([k, { rec, session }]) => {
      const cur = await statFile(rec.path);
      const status = await this.status(k, rec, session.dir, cur);
      if (!status) return;
      out.set(k, {
        path: rec.path,
        status,
        blobPath: rec.blob ? path.join(session.dir, ...rec.blob.split('/')) : null,
        session: session.name,
        version: cur ? `${cur.size}:${cur.mtimeMs}` : 'deleted',
      });
    }));
    return out;
  }

  async status(k, rec, sessionDir, cur) {
    const sig = `${rec.blob}|${cur ? `${cur.size}:${cur.mtimeMs}` : '-'}`;
    const ck = `${k}|${sessionDir}`;
    const cached = this.statuses.get(ck);
    if (cached && cached.sig === sig) return cached.status;
    let status = null;
    if (!rec.existed) {
      status = cur ? 'A' : null;
    } else if (!cur) {
      status = 'D';
    } else if (!rec.blob) {
      // Too large to copy: fall back to size / mtime.
      status = cur.size !== rec.size || Math.abs(cur.mtimeMs - rec.mtime_ms) > 1 ? 'M' : null;
    } else {
      const blob = path.join(sessionDir, ...rec.blob.split('/'));
      const bst = await statFile(blob);
      status = !bst || bst.size !== cur.size || !(await sameBytes(blob, rec.path)) ? 'M' : null;
    }
    this.statuses.set(ck, { sig, status });
    return status;
  }

  // Forget sessions (start a new round). Only the store is touched, never
  // the tracked files. A session that keeps editing starts a fresh record.
  async clear(sessionNames) {
    const stamp = Date.now();
    await Promise.all(sessionNames.map(async (name) => {
      const dir = path.join(this.sessionsDir(), name);
      const trash = path.join(this.sessionsDir(), `.cleared-${stamp}-${name}`);
      try {
        await fsp.rename(dir, trash);
      } catch {
        return;
      }
      await fsp.rm(trash, { recursive: true, force: true }).catch(() => {});
    }));
    this.statuses.clear();
  }

  // Drop sessions idle for longer than retentionMs and leftovers of clear().
  async gc(retentionMs, now = Date.now()) {
    let names = [];
    try { names = await fsp.readdir(this.sessionsDir()); } catch { return; }
    for (const name of names) {
      const dir = path.join(this.sessionsDir(), name);
      let stale = name.startsWith('.cleared-');
      if (!stale) {
        const meta = await statFile(path.join(dir, 'session.json'));
        stale = !!meta && now - meta.mtimeMs > retentionMs;
      }
      if (stale) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

module.exports = { Store, defaultStoreDir, fileKey };
