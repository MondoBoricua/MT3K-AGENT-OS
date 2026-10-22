// The `running` set answers "is this agent CLI alive anywhere?" (detectAgents' isRunning):
// every path segment of every process comm goes in — except anything belonging to a macOS
// .app bundle, whose internals must never read as "the CLI is running". Three signals mark
// a process as part of a bundle:
//   1. its own comm carries a bundle path (".app/", e.g. "/Applications/Codex.app/…"),
//   2. an ancestor up the ppid chain does (helpers/workers keep re-titled names but sit
//      below a Helper that still shows the bundle path),
//   3. it is a re-titled bundle main: its comm is exactly the bundle's name and some direct
//      child carries that same bundle's path — an Electron main re-titles itself ("ZCode"),
//      yet its Helper children still expose "/Applications/ZCode.app/…". The name must
//      match the child's bundle ("claude" spawning Pencil's ".app/-resident" MCP binary is
//      a spawner, not a main) and launchd (pid 1) never counts: every app on the machine
//      is its child.
// All three walk the same pid→ppid tree, memoized and depth-capped so a snapshot of
// thousands of processes stays ~O(n).
const bundleName = (comm) => (comm.match(/([^/]+)\.app\//) || [])[1] || null; // "…/ZCode.app/…" → "ZCode"

export function bundlePids(rows) {
  const proc = new Map(), childrenOf = new Map();
  for (const row of rows) {
    if (typeof row?.pid !== "number" || typeof row?.ppid !== "number" || typeof row.comm !== "string") continue;
    proc.set(row.pid, { ppid: row.ppid, comm: row.comm });
    if (!childrenOf.has(row.ppid)) childrenOf.set(row.ppid, []);
    childrenOf.get(row.ppid).push(row.pid);
  }
  const memo = new Map(); // pid → resolved verdict; negatives included, or long chains go O(n²)
  const inProgress = new Set(); // ppid cycles: the loop itself counts as "not a bundle"
  const inBundle = (pid, depth = 0) => {
    if (depth > 32 || !proc.has(pid)) return false; // root, orphaned parent or absurd depth → not a bundle
    if (memo.has(pid)) return memo.get(pid);
    if (inProgress.has(pid)) return false;
    inProgress.add(pid);
    const { ppid, comm } = proc.get(pid);
    const base = comm.split("/").pop();
    const hit = comm.includes(".app/")
      || (pid !== 1 && (childrenOf.get(pid) || []).some((ch) => {
        const c = proc.get(ch)?.comm || "";
        return c.includes(".app/") && bundleName(c) === base;
      }))
      || inBundle(ppid, depth + 1);
    inProgress.delete(pid);
    memo.set(pid, hit);
    return hit;
  };
  const bundle = new Set();
  for (const pid of proc.keys()) if (inBundle(pid)) bundle.add(pid);
  return bundle;
}

export function buildRunningSet(rows) {
  const skip = bundlePids(rows);
  const running = new Set();
  for (const row of rows) {
    if (typeof row?.pid !== "number" || typeof row.comm !== "string" || skip.has(row.pid)) continue;
    for (const seg of row.comm.split("/")) if (seg) running.add(seg);
  }
  return running;
}
