// Read-only git branch listing for the panel's terminal links (GET /api/git/refs).
// Never touches the network (no fetch / ls-remote), never uses a shell: git is run with execFile and a
// fixed argv; the only caller-controlled value is the process cwd, validated first.
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute } from "node:path";

const GIT_TIMEOUT_MS = 3000;
const GIT_MAX_BUFFER = 1024 * 1024;
const MAX_BRANCHES = 500;

/** leading `~` / `~/…` (and `~\…` on win32) -> home; `~user` and everything else untouched */
export function expandHome(cwd, home = homedir(), platform = process.platform) {
  if (typeof cwd !== "string") return cwd;
  if (cwd === "~") return home;
  if (cwd.startsWith("~/") || (platform === "win32" && cwd.startsWith("~\\"))) return home + cwd.slice(1);
  return cwd;
}

/** `~`-expanded, absolute, NUL-free, existing directory (UNC rejected on win32) -> the path; anything else -> null */
export function validateCwd(cwd, { home = homedir(), platform = process.platform } = {}) {
  if (typeof cwd !== "string" || !cwd) return null;
  const dir = expandHome(cwd, home, platform);
  if (dir.includes("\0") || !isAbsolute(dir)) return null;
  if (platform === "win32" && /^[\\/]{2}/.test(dir)) return null; // \\host\share: no network paths
  try { return statSync(dir).isDirectory() ? dir : null; } catch { return null; }
}

/**
 * Absolute path of git, searched in PATH entries only: empty, "." and relative entries are skipped, and the
 * request cwd is never consulted (on Windows libuv would otherwise run a git.exe planted in the cwd).
 * win32 accepts .exe/.com only (execFile cannot run .cmd without a shell).
 */
export function findGit({ pathEnv = process.env.PATH || "", platform = process.platform, exists = isFile, sep = delimiter } = {}) {
  const names = platform === "win32" ? ["git.exe", "git.com"] : ["git"];
  for (const entry of pathEnv.split(sep)) {
    const dir = entry.trim().replace(/^"(.*)"$/, "$1");
    if (!dir || dir === "." || !isAbsolute(dir)) continue;
    for (const name of names) {
      const full = platform === "win32" ? `${dir.replace(/[\\/]+$/, "")}\\${name}` : `${dir.replace(/\/+$/, "")}/${name}`;
      if (exists(full)) return full;
    }
  }
  return null;
}
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
let gitPath; // undefined = not looked up yet, null = not found
const resolveGit = () => (gitPath === undefined ? (gitPath = findGit()) : gitPath);

/**
 * `git for-each-ref --format=%(refname)%09%(HEAD) refs/heads refs/remotes/origin` output ->
 * { heads: [{ name, current }], remotes: Set<name under origin> }. origin/HEAD is not a branch.
 */
export function parseForEachRef(out) {
  const heads = [];
  const remotes = new Set();
  for (const line of String(out).split("\n")) {
    if (!line) continue;
    const [ref, head] = line.split("\t");
    if (ref.startsWith("refs/heads/")) heads.push({ name: ref.slice("refs/heads/".length), current: head === "*" });
    else if (ref.startsWith("refs/remotes/origin/")) {
      const name = ref.slice("refs/remotes/origin/".length);
      if (name && name !== "HEAD") remotes.add(name);
    }
  }
  return { heads, remotes };
}

/** `git worktree list --porcelain` output -> Map<branch name, checked-out path> */
export function parseWorktrees(out) {
  const map = new Map();
  for (const block of String(out).split(/\n\s*\n/)) {
    let path = null;
    let branch = null;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
      else if (line.startsWith("branch refs/heads/")) branch = line.slice("branch refs/heads/".length);
    }
    if (path && branch && !map.has(branch)) map.set(branch, path);
  }
  return map;
}

const SEGMENT = "[A-Za-z0-9_.-]+";
const GITHUB_REMOTE_RES = [
  new RegExp(`^https?://(?:[^/@\\s]+@)?github\\.com/(${SEGMENT})/(${SEGMENT}?)(?:\\.git)?/?$`, "i"), // https (credentials, if any, are ignored)
  new RegExp(`^(?:ssh://)?git@github\\.com[:/](${SEGMENT})/(${SEGMENT}?)(?:\\.git)?/?$`, "i"), // git@github.com:o/r.git, ssh://git@github.com/o/r.git
];

/** remote URL -> { owner, repo } for github.com, else null */
export function parseGithubRemote(url) {
  const u = String(url || "").trim();
  for (const re of GITHUB_REMOTE_RES) {
    const m = re.exec(u);
    if (m && m[2] !== "." && m[2] !== "..") return { owner: m[1], repo: m[2] };
  }
  return null;
}

/** https://github.com/<owner>/<repo>/tree/<name>; each path segment encoded, the slashes of feat/x kept */
export function githubBranchUrl(gh, name) {
  return `https://github.com/${gh.owner}/${gh.repo}/tree/${name.split("/").map(encodeURIComponent).join("/")}`;
}

/** pure assembly of the endpoint payload */
export function buildRefs({ root, forEachRef, worktrees, remoteUrl }) {
  const { heads, remotes } = parseForEachRef(forEachRef);
  const wt = parseWorktrees(worktrees);
  const gh = parseGithubRemote(remoteUrl);
  const branches = heads.slice(0, MAX_BRANCHES).map(({ name, current }) => {
    const pushed = remotes.has(name);
    return { name, current, pushed, url: pushed && gh ? githubBranchUrl(gh, name) : null, worktree: wt.get(name) ?? null };
  });
  return { ok: true, root, branches };
}

// every call: absolute git, fixed argv (nothing request-controlled), fsmonitor off, no stderr kept
const runGit = (args, cwd, maxBuffer = GIT_MAX_BUFFER) => new Promise((resolve) => {
  const git = resolveGit();
  if (!git) return resolve({ ok: false, code: "ENOENT" });
  execFile(git, ["-c", "core.fsmonitor=false", ...args], {
    cwd, timeout: GIT_TIMEOUT_MS, maxBuffer, windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
  }, (err, stdout) => resolve(err ? { ok: false, code: err.code } : { ok: true, out: stdout }));
});

/**
 * Branch info for the repo containing `cwd`.
 * Bad cwd -> { ok:false, err }; not a repo -> { ok:true, root:null, branches:[] }; git trouble -> { ok:false, err } (generic).
 * `run` is injectable for tests.
 */
export async function gitRefs(cwd, run = runGit) {
  const dir = validateCwd(cwd);
  if (!dir) return { ok: false, err: "cwd inválido" };
  const top = await run(["rev-parse", "--show-toplevel"], dir);
  if (!top.ok) {
    if (top.code === 128) return { ok: true, root: null, branches: [] };
    return { ok: false, err: top.code === "ENOENT" ? "git no disponible" : "git falló" };
  }
  const root = top.out.trim();
  if (!root) return { ok: true, root: null, branches: [] };
  // heads and origin refs are separate calls: a repo with > 1 MiB of remote refs overflows only the second
  // (pushed then reads false) and still returns the local branches
  const [heads, remotes, wts, remote] = await Promise.all([
    run(["for-each-ref", "--format=%(refname)%09%(HEAD)", "refs/heads"], dir),
    run(["for-each-ref", "--format=%(refname)%09%(HEAD)", "refs/remotes/origin"], dir),
    run(["worktree", "list", "--porcelain"], dir),
    run(["config", "--get", "remote.origin.url"], dir),
  ]);
  if (!heads.ok) return { ok: false, err: "git falló" };
  return buildRefs({
    root, forEachRef: `${heads.out}\n${remotes.ok ? remotes.out : ""}`,
    worktrees: wts.ok ? wts.out : "", remoteUrl: remote.ok ? remote.out : "",
  });
}
