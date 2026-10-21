import { createHash } from "node:crypto";
import { readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
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

const historyChecks = {
  claude: (dir, home, realDir) => readdirSync(join(home, ".claude", "projects", realDir(dir).replace(/[^A-Za-z0-9]/g, "-"))).some((f) => f.endsWith(".jsonl")),
  grok: (dir, home, realDir) => hasSubdirectory(join(home, ".grok", "sessions", encodeURIComponent(realDir(dir)))),
  cursor: (dir, home, realDir) => {
    const hasChats = (p) => hasSubdirectory(join(home, ".cursor", "chats", createHash("md5").update(p).digest("hex")));
    let real = null; try { real = realDir(dir); } catch { /* unresolvable path: fall back to the lexical one */ }
    return (real !== null && hasChats(real)) || hasChats(dir);
  },
};

export function hasResumableHistory(agentId, dir, { home = homedir(), realDir = realpathSync } = {}) {
  if (!Object.hasOwn(historyChecks, agentId)) return true;
  try { return historyChecks[agentId](dir, home, realDir); }
  catch { return false; }
}
