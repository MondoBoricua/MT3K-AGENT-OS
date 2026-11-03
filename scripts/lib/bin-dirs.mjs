// nvm-installed npm globals (opencode, dsh, …) live in the bin dir of the node version they were
// installed with — usually nvm's default alias, not necessarily the node running this server.
import { join } from "node:path";

const VERSIONS_SUBDIR = "versions/node";
const DEFAULT_ALIAS_FILE = "alias/default";
const MAX_ALIAS_HOPS = 5;

const parseVersion = (name) => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(name);
  return m ? m.slice(1).map(Number) : null;
};

const compareDesc = (a, b) => {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  for (let i = 0; i < 3; i++) if (va[i] !== vb[i]) return vb[i] - va[i];
  return 0;
};

/** Resolve an nvm alias value ("22.23.2", "v22.23.2", "22", "node", "lts/*") to one installed version dir name, or null. */
function resolveAlias(alias, installed, readAlias, hops = 0) {
  const value = String(alias || "").trim();
  if (!value || hops > MAX_ALIAS_HOPS) return null;
  const exact = installed.find((v) => v === value || v === `v${value}`);
  if (exact) return exact;
  // partial version ("22", "22.23") → newest installed with that prefix
  const partial = /^v?(\d+(?:\.\d+)?)$/.exec(value);
  if (partial) {
    const prefix = `v${partial[1]}.`;
    return installed.find((v) => v.startsWith(prefix)) ?? null;
  }
  // "node"/"stable" → newest installed; other aliases (lts/*, custom) may chain to another alias file
  if (value === "node" || value === "stable") return installed[0] ?? null;
  const next = readAlias(value);
  return next ? resolveAlias(next, installed, readAlias, hops + 1) : null;
}

/**
 * Existing `<nvm>/versions/node/<v>/bin` dirs, nvm's default alias first, the rest by version descending.
 * Pure: all filesystem access is injected. No nvm installed → [].
 */
export function nvmBinDirs({ home, env = {}, exists, readdir, readFile }) {
  const nvmDir = env.NVM_DIR || join(home, ".nvm");
  const versionsDir = join(nvmDir, VERSIONS_SUBDIR);
  if (!exists(versionsDir)) return [];
  let names;
  try { names = readdir(versionsDir); } catch { return []; }
  const installed = names.filter((n) => parseVersion(n)).sort(compareDesc)
    .filter((n) => exists(join(versionsDir, n, "bin")));
  if (!installed.length) return [];
  const readAlias = (name) => { try { return readFile(join(nvmDir, "alias", name)); } catch { return null; } };
  let defaultAlias = null;
  try { defaultAlias = readFile(join(nvmDir, DEFAULT_ALIAS_FILE)); } catch { /* no default alias */ }
  const preferred = resolveAlias(defaultAlias, installed, readAlias);
  const ordered = preferred ? [preferred, ...installed.filter((v) => v !== preferred)] : installed;
  return ordered.map((v) => join(versionsDir, v, "bin"));
}
