import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";

export function decideResume({ resumeArgs, alreadyOpen, hasHistory, fresh }) {
  if (!resumeArgs?.length) return { resume: false, reason: "no-args" };
  if (fresh) return { resume: false, reason: "fresh" };
  if (alreadyOpen) return { resume: false, reason: "already-open" };
  if (!hasHistory) return { resume: false, reason: "no-history" };
  return { resume: true, reason: "ok" };
}

function hasSubdirectory(dir) {
  try { return readdirSync(dir, { withFileTypes: true }).some((entry) => entry.isDirectory()); }
  catch { return false; }
}

// zcode keeps every project's sessions in one SQLite db (~/.zcode/cli/db/db.sqlite, table
// `session`, column `directory` = the session's absolute cwd). node:sqlite's DatabaseSync
// keeps the check synchronous; it needs no flag on this Node (only a warning). Without it
// (or when the open fails, e.g. a locked db), the sqlite3 CLI reads the same file read-only;
// with neither available there is simply no resumable history — never an error thrown.
// Every probe's answer is cached per (home, real, dir) for 5 s and while the db's mtime
// stays put — /api/resumable (debounced 300 ms) and /api/launch re-ask about the same
// folder constantly, while a new session bumps the mtime and is seen at once.
let zcodeDatabaseSync;
function zcodeNodeSqlite() {
  if (zcodeDatabaseSync !== undefined) return zcodeDatabaseSync;
  try { zcodeDatabaseSync = createRequire(import.meta.url)("node:sqlite").DatabaseSync; }
  catch { zcodeDatabaseSync = null; }
  return zcodeDatabaseSync;
}

const ZCODE_PROBE_TTL_MS = 5_000;
const zcodeProbes = new Map(); // `${home}\0${real}\0${dir}\0${cli-only}` → { at, mtimeMs, value }
let zcodeProbeCount = 0;

// the sqlite3 CLI call, swappable in tests to simulate the CLI missing from PATH
let runSqlite3 = (uri, sql) =>
  execFileSync("sqlite3", [uri, "-noheader", sql], { stdio: ["ignore", "pipe", "ignore"] });

// test-only hooks (probe counter/cache reset + a missing-sqlite3 simulation); the server never imports this
export const __zcodeProbeForTests = {
  count: () => zcodeProbeCount,
  reset: () => { zcodeProbes.clear(); zcodeProbeCount = 0; },
  withoutSqlite3Cli(fn) {
    const prev = runSqlite3;
    runSqlite3 = () => { throw new Error("spawn sqlite3 ENOENT"); };
    try { fn(); } finally { runSqlite3 = prev; }
  },
};

function zcodeHasSession(dbPath, dirs, useNodeSqlite) {
  zcodeProbeCount++;
  const DatabaseSync = useNodeSqlite === false ? null : zcodeNodeSqlite();
  if (DatabaseSync) {
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const row = db.prepare("SELECT 1 FROM session WHERE directory = ? LIMIT 1");
        return dirs.some((dir) => row.get(dir) !== undefined);
      } finally { db.close(); }
    } catch { /* unreadable db (locked, mid-migration) → still try the CLI */ }
  }
  try {
    // file:…?mode=ro opens read-only (no -wal/-shm writes); ' doubled inside the SQL literal
    const uri = `file:${dbPath.replace(/[?#%]/g, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`)}?mode=ro`;
    return dirs.some((dir) =>
      runSqlite3(uri, `SELECT 1 FROM session WHERE directory = '${dir.replace(/'/g, "''")}' LIMIT 1;`).length > 0);
  } catch { return false; }
}

const historyChecks = {
  claude: (dir, home, realDir) => readdirSync(join(home, ".claude", "projects", realDir(dir).replace(/[^A-Za-z0-9]/g, "-"))).some((f) => f.endsWith(".jsonl")),
  grok: (dir, home, realDir) => hasSubdirectory(join(home, ".grok", "sessions", encodeURIComponent(realDir(dir)))),
  cursor: (dir, home, realDir) => {
    const hasChats = (p) => hasSubdirectory(join(home, ".cursor", "chats", createHash("md5").update(p).digest("hex")));
    let real = null; try { real = realDir(dir); } catch { /* unresolvable path: fall back to the lexical one */ }
    return (real !== null && hasChats(real)) || hasChats(dir);
  },
  zcode: (dir, home, realDir, opts) => {
    const db = join(home, ".zcode", "cli", "db", "db.sqlite");
    let mtimeMs; try { mtimeMs = statSync(db).mtimeMs; } catch { return false; } // no db → no cache to consult
    // `directory` stores the cwd as zcode saw it — real (/private/tmp) or lexical (/tmp): query both
    let real = null; try { real = realDir(dir); } catch { /* unresolvable path: fall back to the lexical one */ }
    const key = `${home}\0${real ?? dir}\0${dir}\0${opts?.useNodeSqlite === false ? 1 : 0}`;
    const now = Date.now();
    const cached = zcodeProbes.get(key);
    if (cached && now - cached.at < ZCODE_PROBE_TTL_MS && cached.mtimeMs === mtimeMs) return cached.value;
    const value = zcodeHasSession(db, real === null || real === dir ? [dir] : [real, dir], opts?.useNodeSqlite);
    if (zcodeProbes.size >= 64) { // bound the cache across months of folder switches
      for (const [k, v] of zcodeProbes) if (now - v.at >= ZCODE_PROBE_TTL_MS) zcodeProbes.delete(k);
      if (zcodeProbes.size >= 64) zcodeProbes.clear();
    }
    zcodeProbes.set(key, { at: now, mtimeMs, value });
    return value;
  },
};

export function hasResumableHistory(agentId, dir, { home = homedir(), realDir = realpathSync, useNodeSqlite } = {}) {
  if (!Object.hasOwn(historyChecks, agentId)) return true;
  try { return historyChecks[agentId](dir, home, realDir, { useNodeSqlite }); }
  catch { return false; }
}
