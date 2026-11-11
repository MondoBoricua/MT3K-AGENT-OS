import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRefs, createGitResolver, expandHome, findGit, githubBranchUrl, gitRefs, parseForEachRef, parseGithubRemote, parseWorktrees, runGitWith, validateCwd,
} from "./git-refs.mjs";

const FER = [
  "refs/heads/master\t*",
  "refs/heads/feat/panel-links\t ",
  "refs/heads/feat/panel-motion\t ",
  "refs/remotes/origin/HEAD\t ",
  "refs/remotes/origin/master\t ",
  "refs/remotes/origin/feat/panel-motion\t ",
  "refs/remotes/origin/only-remote\t ",
].join("\n");

const WT = [
  "worktree /repo",
  "HEAD aaaa",
  "branch refs/heads/master",
  "",
  "worktree /repo.worktrees/panel-links",
  "HEAD bbbb",
  "branch refs/heads/feat/panel-links",
  "",
  "worktree /repo.worktrees/detached",
  "HEAD cccc",
  "detached",
  "",
].join("\n");

test("for-each-ref: heads, current marker, origin set, origin/HEAD ignored, slashes kept", () => {
  const { heads, remotes } = parseForEachRef(FER);
  assert.deepEqual(heads.map((h) => h.name), ["master", "feat/panel-links", "feat/panel-motion"]);
  assert.deepEqual(heads.map((h) => h.current), [true, false, false]);
  assert.deepEqual([...remotes].sort(), ["feat/panel-motion", "master", "only-remote"]);
});

test("worktree porcelain: branch -> path, detached skipped", () => {
  const m = parseWorktrees(WT);
  assert.equal(m.get("master"), "/repo");
  assert.equal(m.get("feat/panel-links"), "/repo.worktrees/panel-links");
  assert.equal(m.size, 2);
});

test("remote URL forms: https, ssh scp-like, ssh://, credentials, non-GitHub", () => {
  const want = { owner: "MondoBoricua", repo: "MT3K-AGENT-OS" };
  assert.deepEqual(parseGithubRemote("https://github.com/MondoBoricua/MT3K-AGENT-OS.git"), want);
  assert.deepEqual(parseGithubRemote("https://github.com/MondoBoricua/MT3K-AGENT-OS"), want);
  assert.deepEqual(parseGithubRemote("https://tok:x@github.com/MondoBoricua/MT3K-AGENT-OS.git\n"), want);
  assert.deepEqual(parseGithubRemote("git@github.com:MondoBoricua/MT3K-AGENT-OS.git"), want);
  assert.deepEqual(parseGithubRemote("ssh://git@github.com/MondoBoricua/MT3K-AGENT-OS.git"), want);
  assert.equal(parseGithubRemote("https://gitlab.com/o/r.git"), null);
  assert.equal(parseGithubRemote("git@github.com.evil.io:o/r.git"), null);
  assert.equal(parseGithubRemote("https://evilgithub.com/o/r"), null);
  assert.equal(parseGithubRemote("/local/path/repo.git"), null);
  assert.equal(parseGithubRemote(""), null);
});

test("branch URL keeps slashes and encodes the rest", () => {
  const gh = { owner: "o", repo: "r" };
  assert.equal(githubBranchUrl(gh, "feat/panel-links"), "https://github.com/o/r/tree/feat/panel-links");
  assert.equal(githubBranchUrl(gh, "fix/a b#c"), "https://github.com/o/r/tree/fix/a%20b%23c");
});

test("buildRefs: pushed needs origin ref, url needs pushed + GitHub, worktree from porcelain", () => {
  const r = buildRefs({ root: "/repo", forEachRef: FER, worktrees: WT, remoteUrl: "git@github.com:o/r.git" });
  const by = Object.fromEntries(r.branches.map((b) => [b.name, b]));
  assert.equal(r.root, "/repo");
  assert.deepEqual(by.master, { name: "master", current: true, pushed: true, url: "https://github.com/o/r/tree/master", worktree: "/repo" });
  assert.deepEqual(by["feat/panel-links"], { name: "feat/panel-links", current: false, pushed: false, url: null, worktree: "/repo.worktrees/panel-links" });
  assert.equal(by["feat/panel-motion"].url, "https://github.com/o/r/tree/feat/panel-motion");
  assert.equal(by["feat/panel-motion"].worktree, null);
  const gitlab = buildRefs({ root: "/repo", forEachRef: FER, worktrees: "", remoteUrl: "https://gitlab.com/o/r.git" });
  assert.ok(gitlab.branches.every((b) => b.url === null));
  assert.equal(gitlab.branches.find((b) => b.name === "master").pushed, true);
});

test("validateCwd rejects relative, missing, file, NUL, non-string; accepts a directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "git-refs-"));
  const file = join(dir, "f.txt");
  writeFileSync(file, "x");
  assert.equal(validateCwd(dir), dir);
  assert.equal(validateCwd("relative/dir"), null);
  assert.equal(validateCwd("."), null);
  assert.equal(validateCwd(join(dir, "nope")), null);
  assert.equal(validateCwd(file), null);
  assert.equal(validateCwd(`${dir}\0`), null);
  assert.equal(validateCwd(undefined), null);
  assert.equal(validateCwd(""), null);
});

test("gitRefs: bad cwd never reaches git; non-repo (exit 128) is an empty ok; other failures are generic", async () => {
  const dir = mkdtempSync(join(tmpdir(), "git-refs-"));
  let calls = 0;
  const never = async () => { calls++; return { ok: true, out: "" }; };
  assert.deepEqual(await gitRefs("relative", never), { ok: false, err: "cwd inválido" });
  assert.deepEqual(await gitRefs(join(dir, "missing"), never), { ok: false, err: "cwd inválido" });
  assert.equal(calls, 0);
  assert.deepEqual(await gitRefs(dir, async () => ({ ok: false, code: 128 })), { ok: true, root: null, branches: [] });
  assert.deepEqual(await gitRefs(dir, async () => ({ ok: false, code: "ENOENT" })), { ok: false, err: "git no disponible" });
});

test("gitRefs: argv are fixed arrays and cwd is only the process cwd", async () => {
  const dir = mkdtempSync(join(tmpdir(), "git-refs-"));
  const seen = [];
  const run = async (args, cwd) => {
    seen.push({ args, cwd });
    if (args[0] === "rev-parse") return { ok: true, out: "/repo\n" };
    if (args[0] === "for-each-ref") return { ok: true, out: FER.split("\n").filter((l) => l.startsWith(args.includes("refs/heads") ? "refs/heads" : "refs/remotes")).join("\n") };
    if (args[0] === "worktree") return { ok: true, out: WT };
    return { ok: true, out: "https://github.com/o/r.git\n" };
  };
  const r = await gitRefs(dir, run);
  assert.equal(r.root, "/repo");
  assert.equal(r.branches.length, 3);
  assert.ok(seen.every((s) => s.cwd === dir && !s.args.some((a) => a.includes(dir))));
});

test("gitRefs against this real repo returns the current branch", async () => {
  const r = await gitRefs(process.cwd());
  assert.equal(r.ok, true);
  if (r.root) assert.ok(r.branches.some((b) => b.current));
});

test("findGit: first absolute PATH hit wins; empty, '.', and relative entries are ignored (planted git never chosen)", () => {
  const seen = [];
  const exists = (p) => { seen.push(p); return p === "/planted/cwd/git" || p === "relative/bin/git" || p === "./git" || p === "/usr/bin/git"; };
  const pathEnv = [".", "", "relative/bin", "/nowhere", "/usr/bin"].join(":");
  assert.equal(findGit({ pathEnv, platform: "linux", exists, sep: ":" }), "/usr/bin/git");
  assert.ok(!seen.some((p) => p.startsWith(".") || p.startsWith("relative") || p.startsWith("/planted")), seen.join(","));
  assert.equal(findGit({ pathEnv: ".:relative/bin", platform: "linux", exists, sep: ":" }), null);
  assert.equal(findGit({ pathEnv: "", platform: "linux", exists: () => true, sep: ":" }), null);
});

test("findGit on win32: drive-letter entries only, .exe then .com, never .cmd or the bare name", () => {
  const seen = [];
  const exists = (p) => { seen.push(p); return p.endsWith("git.com"); };
  const r = findGit({ pathEnv: "C:\\Tools;.;D:\\More", platform: "win32", exists });
  assert.equal(r, "C:\\Tools\\git.com");
  assert.deepEqual(seen, ["C:\\Tools\\git.exe", "C:\\Tools\\git.com"]);
  assert.equal(findGit({ pathEnv: '"C:\\Program Files\\Git\\cmd";C:\\x', platform: "win32", exists: () => true }), "C:\\Program Files\\Git\\cmd\\git.exe");
  assert.equal(findGit({ pathEnv: "C:/Git/cmd", platform: "win32", exists: () => true }), "C:\\Git\\cmd\\git.exe");
});

test("findGit on win32 rejects drive-less roots and UNC (cross-drive: \\tools would exec as D:\\tools under a D: cwd)", () => {
  const seen = [];
  const exists = (p) => { seen.push(p); return true; };
  for (const entry of ["\\tools", "/tools", "\\\\host\\share", "//host/share", "tools", "C:tools"]) {
    assert.equal(findGit({ pathEnv: `${entry};C:\\trusted`, platform: "win32", exists }), "C:\\trusted\\git.exe", entry);
  }
  assert.ok(!seen.some((p) => !/^C:\\trusted/.test(p)), seen.join(","));
  assert.equal(findGit({ pathEnv: "\\tools;/tools", platform: "win32", exists: () => true }), null);
});

test("findGit on POSIX: a non-executable git earlier in PATH is skipped", () => {
  const exec = new Set(["/usr/bin/git"]);
  assert.equal(findGit({ pathEnv: "/blocked:/usr/bin", platform: "linux", exists: (p) => exec.has(p) }), "/usr/bin/git");
});

test("default POSIX lookup requires the execute bit", () => {
  const dir = mkdtempSync(join(tmpdir(), "git-bin-"));
  const f = join(dir, "git");
  writeFileSync(f, "#!/bin/sh\n");
  chmodSync(f, 0o644);
  assert.equal(findGit({ pathEnv: dir, platform: "linux" }), null);
  chmodSync(f, 0o755);
  assert.equal(findGit({ pathEnv: dir, platform: "linux" }), f);
});

test("createGitResolver: hit cached, miss re-tried after the TTL, invalidate forces a lookup", () => {
  let t = 0; let calls = 0; let answer = null;
  const r = createGitResolver({ find: () => { calls++; return answer; }, now: () => t, ttl: 60_000 });
  assert.equal(r.get(), null); assert.equal(r.get(), null); assert.equal(calls, 1);
  answer = "/usr/bin/git"; t = 59_999; assert.equal(r.get(), null);
  t = 60_000; assert.equal(r.get(), "/usr/bin/git"); assert.equal(calls, 2);
  assert.equal(r.get(), "/usr/bin/git"); assert.equal(calls, 2);
  r.invalidate(); answer = "/opt/git"; assert.equal(r.get(), "/opt/git");
});

test("runGitWith: ENOENT/EACCES on the cached path re-resolves once and retries; other errors do not", async () => {
  const mk = (paths) => { let i = 0; return { get: () => paths[Math.min(i, paths.length - 1)], invalidate: () => { i++; } }; };
  const tried = [];
  const exec = (bin, args, opts, cb) => { tried.push(bin); if (bin === "/old/git") cb(Object.assign(new Error("x"), { code: "EACCES" })); else cb(null, "out"); };
  assert.deepEqual(await runGitWith(mk(["/old/git", "/new/git"]), exec, ["status"], "/", undefined, () => false), { ok: true, out: "out" });
  assert.deepEqual(tried, ["/old/git", "/new/git"]);
  const exec2 = (bin, a, o, cb) => cb(Object.assign(new Error("x"), { code: 1 }));
  assert.deepEqual(await runGitWith(mk(["/a", "/b"]), exec2, [], "/"), { ok: false, code: 1 });
  assert.deepEqual(await runGitWith(mk([null]), exec2, [], "/"), { ok: false, code: "ENOENT" });
});

test("validateCwd on win32: drive-letter cwd accepted; UNC and drive-less roots rejected", () => {
  const isDir = () => true;
  assert.equal(validateCwd("C:\\work\\repo", { platform: "win32", isDir }), "C:\\work\\repo");
  assert.equal(validateCwd("\\\\host\\share\\x", { platform: "win32", isDir }), null);
  assert.equal(validateCwd("//host/share/x", { platform: "win32", isDir }), null);
  assert.equal(validateCwd("\\work", { platform: "win32", isDir }), null);
  assert.equal(validateCwd("/work", { platform: "win32", isDir }), null);
  assert.equal(validateCwd("C:work", { platform: "win32", isDir }), null);
  assert.equal(validateCwd("~\\proj", { platform: "win32", home: "C:\\Users\\m", isDir }), "C:\\Users\\m\\proj");
  assert.equal(validateCwd("C:\\work", { platform: "linux", isDir }), null);
});

test("expandHome: only a leading ~ or ~/ (and ~\\ on win32); ~user stays", () => {
  assert.equal(expandHome("~", "/h", "linux"), "/h");
  assert.equal(expandHome("~/MT3K-AGENT-OS", "/h", "linux"), "/h/MT3K-AGENT-OS");
  assert.equal(expandHome("~\\x", "/h", "linux"), "~\\x");
  assert.equal(expandHome("~\\x", "C:\\h", "win32"), "C:\\h\\x");
  assert.equal(expandHome("~root/x", "/h", "linux"), "~root/x");
  assert.equal(expandHome("/a/~/b", "/h", "linux"), "/a/~/b");
});

test("validateCwd expands ~ to the given home; rejects ~user and UNC on win32", () => {
  const home = mkdtempSync(join(tmpdir(), "git-refs-home-"));
  const sub = join(home, "proj");
  mkdirSync(sub);
  assert.equal(validateCwd("~/proj", { home }), sub);
  assert.equal(validateCwd("~", { home }), home);
  assert.equal(validateCwd("~/nope", { home }), null);
  assert.equal(validateCwd("~root", { home }), null);
  assert.equal(validateCwd("\\\\host\\share\\x", { platform: "win32" }), null);
  assert.equal(validateCwd("//host/share/x", { platform: "win32" }), null);
});

test("gitRefs: heads survive a failed origin listing; git missing vs git failed are told apart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "git-refs-"));
  const run = async (args) => {
    if (args[0] === "rev-parse") return { ok: true, out: "/repo\n" };
    if (args[0] === "for-each-ref") return args.includes("refs/remotes/origin") ? { ok: false, code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" } : { ok: true, out: "refs/heads/master\t*\n" };
    return { ok: false, code: 1 };
  };
  const r = await gitRefs(dir, run);
  assert.deepEqual(r.branches, [{ name: "master", current: true, pushed: false, url: null, worktree: null }]);
  assert.deepEqual(await gitRefs(dir, async () => ({ ok: false, code: 1 })), { ok: false, err: "git falló" });
  assert.deepEqual(await gitRefs(dir, async () => ({ ok: false, code: "ENOENT" })), { ok: false, err: "git no disponible" });
});

test("runGitWith: EACCES/ENOENT caused by a bad cwd does not drop the cached git; a vanished binary re-resolves once", async () => {
  let invalidations = 0;
  const res = { get: () => (invalidations ? "/new/git" : "/old/git"), invalidate: () => { invalidations++; } };
  const badCwd = (bin, a, o, cb) => cb(Object.assign(new Error("x"), { code: "ENOENT" }));
  assert.deepEqual(await runGitWith(res, badCwd, [], "/gone", undefined, () => true), { ok: false, code: "ENOENT" });
  assert.equal(invalidations, 0);
  const vanished = (bin, a, o, cb) => (bin === "/old/git" ? cb(Object.assign(new Error("x"), { code: "ENOENT" })) : cb(null, "ok"));
  assert.deepEqual(await runGitWith(res, vanished, [], "/", undefined, (p) => p !== "/old/git"), { ok: true, out: "ok" });
  assert.equal(invalidations, 1);
});
