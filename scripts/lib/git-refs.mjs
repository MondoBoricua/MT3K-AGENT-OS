// Read-only git branch listing for the panel's terminal links (GET /api/git/refs).
// Never touches the network (no fetch / ls-remote), never uses a shell: git is run with execFile and a
// fixed argv; the only caller-controlled value is the process cwd, validated first.
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";

const GIT_TIMEOUT_MS = 3000;
const GIT_MAX_BUFFER = 1024 * 1024;
const MAX_BRANCHES = 500;

/** absolute, NUL-free, existing directory -> the path; anything else -> null */
export function validateCwd(cwd) {
  if (typeof cwd !== "string" || !cwd || cwd.includes("\0") || !isAbsolute(cwd)) return null;
  try { return statSync(cwd).isDirectory() ? cwd : null; } catch { return null; }
}

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

const runGit = (args, cwd) => new Promise((resolve) => {
  execFile("git", args, {
    cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, windowsHide: true,
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
  if (!top.ok) return top.code === 128 ? { ok: true, root: null, branches: [] } : { ok: false, err: "git no disponible" };
  const root = top.out.trim();
  if (!root) return { ok: true, root: null, branches: [] };
  const [refs, wts, remote] = await Promise.all([
    run(["for-each-ref", "--format=%(refname)%09%(HEAD)", "refs/heads", "refs/remotes/origin"], dir),
    run(["worktree", "list", "--porcelain"], dir),
    run(["config", "--get", "remote.origin.url"], dir),
  ]);
  if (!refs.ok) return { ok: false, err: "git falló" };
  return buildRefs({ root, forEachRef: refs.out, worktrees: wts.ok ? wts.out : "", remoteUrl: remote.ok ? remote.out : "" });
}
