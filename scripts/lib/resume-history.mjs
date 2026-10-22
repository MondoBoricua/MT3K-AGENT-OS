import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, realpathSync } from "node:fs";
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
let zcodeDatabaseSync;
function zcodeNodeSqlite() {
  if (zcodeDatabaseSync !== undefined) return zcodeDatabaseSync;
  try { zcodeDatabaseSync = createRequire(import.meta.url)("node:sqlite").DatabaseSync; }
  catch { zcodeDatabaseSync = null; }
  return zcodeDatabaseSync;
}

function zcodeHasSession(dbPath, dirs) {
  const DatabaseSync = zcodeNodeSqlite();
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
      execFileSync("sqlite3", [uri, "-noheader", `SELECT 1 FROM session WHERE directory = '${dir.replace(/'/g, "''")}' LIMIT 1;`], { stdio: ["ignore", "pipe", "ignore"] }).length > 0);
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
  zcode: (dir, home, realDir) => {
    const db = join(home, ".zcode", "cli", "db", "db.sqlite");
    if (!existsSync(db)) return false;
    // `directory` stores the cwd as zcode saw it — real (/private/tmp) or lexical (/tmp): query both
    let real = null; try { real = realDir(dir); } catch { /* unresolvable path: fall back to the lexical one */ }
    return zcodeHasSession(db, real === null || real === dir ? [dir] : [real, dir]);
  },
};

export function hasResumableHistory(agentId, dir, { home = homedir(), realDir = realpathSync } = {}) {
  if (!Object.hasOwn(historyChecks, agentId)) return true;
  try { return historyChecks[agentId](dir, home, realDir); }
  catch { return false; }
}
