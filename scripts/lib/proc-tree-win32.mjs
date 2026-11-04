/**
 * proc-tree-win32.mjs — process snapshot for Windows (no `ps` there).
 * Source: PowerShell + CIM, one line per process: `pid ppid <ExecutablePath or Name>`.
 * The comm is normalized so the POSIX matching code (split on "/", compare segments, see
 * running-set.mjs and procMatches in server.mjs) works unchanged: `\` → `/` and the
 * .exe/.cmd/.bat/.ps1 extension of the last segment is dropped (claude.exe → claude).
 */

export const WIN32_PS_COMMAND = [
  "powershell",
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $(if ($_.ExecutablePath) { $_.ExecutablePath } else { $_.Name })" }',
];

/** Each CIM query costs ~0.85 s on the Ally: reuse the snapshot for this long. */
export const WIN32_PROC_TTL_MS = 3000;

const EXEC_EXT_RE = /\.(exe|cmd|bat|ps1)$/i;

/** `C:\Users\x\.local\bin\claude.exe` → `C:/Users/x/.local/bin/claude`. */
export function normalizeWin32Comm(comm) {
  const slashed = String(comm || "").trim().replace(/\\/g, "/");
  const cut = slashed.lastIndexOf("/");
  const head = slashed.slice(0, cut + 1);
  return head + slashed.slice(cut + 1).replace(EXEC_EXT_RE, "");
}

/** @returns {{pid:number, ppid:number, comm:string}[]} */
export function parseWin32ProcessList(text) {
  const rows = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    rows.push({ pid: +m[1], ppid: +m[2], comm: normalizeWin32Comm(m[3]) });
  }
  return rows;
}

/**
 * Rows for buildRunningSet: Store/desktop apps under C:\Program Files\WindowsApps (e.g. the Codex desktop app)
 * must not read as "the CLI is running", the same way macOS drops anything inside a .app bundle.
 * Their pids stay in the tree used for pane descendants; only the running set ignores them.
 */
export function withoutWindowsApps(rows) {
  return rows.filter((row) => !/\/program files\/windowsapps\//i.test(row.comm));
}

/**
 * Cached snapshot loader. `exec` runs the PowerShell command and resolves to its stdout.
 * Concurrent callers share one in-flight query.
 */
export function createWin32ProcessSource({ exec, ttlMs = WIN32_PROC_TTL_MS, now = Date.now }) {
  let cache = { at: -Infinity, rows: [] };
  let pending = null;
  return async function loadRows() {
    if (now() - cache.at < ttlMs) return cache.rows;
    if (!pending) {
      pending = (async () => {
        let rows = [];
        try { rows = parseWin32ProcessList(await exec()); } catch { /* keep previous snapshot */ }
        // success replaces the snapshot; failure keeps the old rows but still waits the TTL before retrying
        cache = { at: now(), rows: rows.length ? rows : cache.rows };
        return cache.rows;
      })().finally(() => { pending = null; });
    }
    return pending;
  };
}
