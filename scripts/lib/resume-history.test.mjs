import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideResume, hasResumableHistory, __zcodeProbeForTests } from "./resume-history.mjs";

for (const [reason, input] of [
  ["no-args", { resumeArgs: [], fresh: true, alreadyOpen: true, hasHistory: false }],
  ["fresh", { resumeArgs: ["--resume"], fresh: true, alreadyOpen: true, hasHistory: false }],
  ["already-open", { resumeArgs: ["--resume"], alreadyOpen: true, hasHistory: false }],
  ["no-history", { resumeArgs: ["--resume"], alreadyOpen: false, hasHistory: false }],
  ["ok", { resumeArgs: ["--resume"], alreadyOpen: false, hasHistory: true }],
]) {
  test(`decideResume returns ${reason} in priority order`, () => {
    assert.deepEqual(decideResume(input), { resume: reason === "ok", reason });
  });
}

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "resume-history-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const dir = join(home, "project.with spaces");
  mkdirSync(dir);
  return { home, dir, real: realpathSync(dir) };
}

test("Claude requires a jsonl transcript under the encoded real cwd", (t) => {
  const { home, dir, real } = fixture(t);
  const history = join(home, ".claude", "projects", real.replace(/[^A-Za-z0-9]/g, "-"));
  assert.equal(hasResumableHistory("claude", dir, { home }), false);
  mkdirSync(history, { recursive: true });
  writeFileSync(join(history, "notes.txt"), "");
  assert.equal(hasResumableHistory("claude", dir, { home }), false);
  writeFileSync(join(history, "session.jsonl"), "");
  assert.equal(hasResumableHistory("claude", dir, { home }), true);
});

test("Grok requires a session subdirectory under the URI-encoded real cwd", (t) => {
  const { home, dir, real } = fixture(t);
  const history = join(home, ".grok", "sessions", encodeURIComponent(real));
  assert.equal(hasResumableHistory("grok", dir, { home }), false);
  mkdirSync(history, { recursive: true });
  assert.equal(hasResumableHistory("grok", dir, { home }), false);
  writeFileSync(join(history, "notes.txt"), "");
  assert.equal(hasResumableHistory("grok", dir, { home }), false);
  mkdirSync(join(history, "session-uuid"));
  assert.equal(hasResumableHistory("grok", dir, { home }), true);
});

for (const lexical of [false, true]) {
  test(`Cursor detects chats using the ${lexical ? "lexical" : "real"} cwd hash`, (t) => {
    const { home, dir, real } = fixture(t);
    const alias = join(home, "alias");
    symlinkSync(dir, alias, "dir");
    const hash = (p) => createHash("md5").update(p).digest("hex");
    const history = join(home, ".cursor", "chats", hash(lexical ? alias : real));
    assert.equal(hasResumableHistory("cursor", alias, { home }), false);
    mkdirSync(history, { recursive: true });
    assert.equal(hasResumableHistory("cursor", alias, { home }), false);
    writeFileSync(join(history, "store.db"), "");
    assert.equal(hasResumableHistory("cursor", alias, { home }), false);
    if (lexical) mkdirSync(join(home, ".cursor", "chats", hash(real)), { recursive: true });
    mkdirSync(join(history, "chat-uuid"));
    assert.equal(hasResumableHistory("cursor", alias, { home }), true);
  });
}

// the zcode fixture db is seeded through the sqlite3 CLI, exactly like a real ~/.zcode db
const sqlite3Available = (() => { try { execFileSync("sqlite3", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();

test("ZCode requires a session row for the real or lexical cwd", { skip: !sqlite3Available && "sqlite3 CLI no disponible" }, (t) => {
  const { home, dir, real } = fixture(t);
  const alias = join(home, "alias");
  symlinkSync(dir, alias, "dir");
  const db = join(home, ".zcode", "cli", "db", "db.sqlite");
  const seed = (rows) => execFileSync("sqlite3", [db,
    "CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL);",
    ...rows.map((row, i) => `INSERT INTO session VALUES ('s${i}', '${row.replace(/'/g, "''")}');`),
  ]);
  // db absent → false
  assert.equal(hasResumableHistory("zcode", dir, { home }), false);
  mkdirSync(join(home, ".zcode", "cli", "db"), { recursive: true });
  seed([]);
  // db present but no row → false
  assert.equal(hasResumableHistory("zcode", dir, { home }), false);
  rmSync(db);
  __zcodeProbeForTests.reset(); // each re-seed must be seen, not served from the probe cache
  // row under the REAL cwd → true, also through a symlink pointing at it
  seed([real]);
  assert.equal(hasResumableHistory("zcode", dir, { home }), true);
  assert.equal(hasResumableHistory("zcode", alias, { home }), true);
  rmSync(db);
  __zcodeProbeForTests.reset();
  // row under the LEXICAL cwd (the symlink path itself) → true too
  seed([alias]);
  assert.equal(hasResumableHistory("zcode", alias, { home }), true);
});

test("ZCode probe is cached per (home, dir) and re-queries when the db's mtime moves", { skip: !sqlite3Available && "sqlite3 CLI no disponible" }, (t) => {
  const { home, dir, real } = fixture(t);
  mkdirSync(join(home, ".zcode", "cli", "db"), { recursive: true });
  const db = join(home, ".zcode", "cli", "db", "db.sqlite");
  execFileSync("sqlite3", [db,
    "CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL);",
    `INSERT INTO session VALUES ('s0', '${real.replace(/'/g, "''")}');`,
  ]);
  __zcodeProbeForTests.reset();
  assert.equal(hasResumableHistory("zcode", dir, { home }), true);
  assert.equal(__zcodeProbeForTests.count(), 1);
  // same (home, dir, mtime) within the TTL → served from the cache, no new query
  assert.equal(hasResumableHistory("zcode", dir, { home }), true);
  assert.equal(__zcodeProbeForTests.count(), 1);
  // a new session rewrites the db → different mtime → queried again even inside the TTL
  const st = statSync(db);
  utimesSync(db, st.atime, new Date(st.mtimeMs + 2000));
  assert.equal(hasResumableHistory("zcode", dir, { home }), true);
  assert.equal(__zcodeProbeForTests.count(), 2);
});

test("ZCode falls back to the sqlite3 CLI when node:sqlite is skipped", { skip: !sqlite3Available && "sqlite3 CLI no disponible" }, (t) => {
  const { home, dir, real } = fixture(t);
  mkdirSync(join(home, ".zcode", "cli", "db"), { recursive: true });
  const db = join(home, ".zcode", "cli", "db", "db.sqlite");
  execFileSync("sqlite3", [db,
    "CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL);",
    `INSERT INTO session VALUES ('s0', '${real.replace(/'/g, "''")}');`,
  ]);
  __zcodeProbeForTests.reset();
  // useNodeSqlite:false forces the CLI branch — the same one a Node without node:sqlite takes
  assert.equal(hasResumableHistory("zcode", dir, { home, useNodeSqlite: false }), true);
  assert.equal(hasResumableHistory("zcode", join(home, "nowhere"), { home, useNodeSqlite: false }), false);
  assert.equal(__zcodeProbeForTests.count(), 2);
});

test("ZCode returns false without throwing when neither node:sqlite nor the sqlite3 CLI can answer", { skip: !sqlite3Available && "sqlite3 CLI no disponible" }, (t) => {
  const { home, dir, real } = fixture(t);
  mkdirSync(join(home, ".zcode", "cli", "db"), { recursive: true });
  const db = join(home, ".zcode", "cli", "db", "db.sqlite");
  execFileSync("sqlite3", [db,
    "CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL);",
    `INSERT INTO session VALUES ('s0', '${real.replace(/'/g, "''")}');`,
  ]);
  __zcodeProbeForTests.reset();
  __zcodeProbeForTests.withoutSqlite3Cli(() => {
    // the row exists (either reader would answer true), but no reader is reachable → false, no throw
    assert.equal(hasResumableHistory("zcode", dir, { home, useNodeSqlite: false }), false);
  });
});

test("agents without a history requirement always allow resume", (t) => {
  const { home } = fixture(t);
  for (const agent of ["codex", "opencode", "antigravity", "unknown", "constructor", "__proto__"]) {
    assert.equal(hasResumableHistory(agent, join(home, "missing"), { home }), true);
  }
});

test("missing cwd and filesystem errors return false without throwing", (t) => {
  const { home, dir } = fixture(t);
  writeFileSync(join(home, "not-a-directory"), "");
  for (const agent of ["claude", "grok", "cursor", "zcode"]) {
    assert.equal(hasResumableHistory(agent, join(home, "missing"), { home }), false);
    assert.equal(hasResumableHistory(agent, dir, {
      home, realDir() { throw new Error("unavailable cwd"); },
    }), false);
    assert.equal(hasResumableHistory(agent, dir, { home: join(home, "not-a-directory") }), false);
  }
});

test("uses the supplied realDir resolver", (t) => {
  const { home, dir, real } = fixture(t);
  const history = join(home, ".grok", "sessions", encodeURIComponent(real));
  mkdirSync(join(history, "session-uuid"), { recursive: true });
  let resolved;
  assert.equal(hasResumableHistory("grok", dir, {
    home, realDir(p) { resolved = p; return real; },
  }), true);
  assert.equal(resolved, dir);
});

// ── Junie tests ──

function junieFixture(t) {
  const home = mkdtempSync(join(tmpdir(), "resume-history-junie-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const dir = join(home, "project");
  mkdirSync(dir);
  const sessionsDir = join(home, ".junie", "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const indexPath = join(sessionsDir, "index.jsonl");
  return { home, dir, sessionsDir, indexPath, real: realpathSync(dir) };
}

function writeJunieIndex(indexPath, lines) {
  writeFileSync(indexPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

function makeSession(sessionsDir, id) {
  mkdirSync(join(sessionsDir, id), { recursive: true });
}

test("Junie returns false when index.jsonl does not exist", (t) => {
  const { home, dir } = junieFixture(t);
  // sessions dir exists but no index.jsonl
  assert.equal(hasResumableHistory("junie", dir, { home }), false);
});

test("Junie returns false when index.jsonl is empty", (t) => {
  const { home, dir, indexPath } = junieFixture(t);
  writeFileSync(indexPath, "");
  assert.equal(hasResumableHistory("junie", dir, { home }), false);
});

test("Junie returns true when a matching session exists with valid directory", (t) => {
  const { home, dir, indexPath, sessionsDir, real } = junieFixture(t);
  makeSession(sessionsDir, "session-001");
  writeJunieIndex(indexPath, [
    { sessionId: "session-001", projectDir: real, createdAt: 1, updatedAt: 2, taskName: "test", lastPromptAt: 1 },
  ]);
  assert.equal(hasResumableHistory("junie", dir, { home }), true);
});

test("Junie returns false when session directory was deleted (pruned session)", (t) => {
  const { home, dir, indexPath, sessionsDir, real } = junieFixture(t);
  // create then delete the session directory
  makeSession(sessionsDir, "session-001");
  rmSync(join(sessionsDir, "session-001"), { recursive: true });
  writeJunieIndex(indexPath, [
    { sessionId: "session-001", projectDir: real, createdAt: 1, updatedAt: 2, taskName: "test", lastPromptAt: 1 },
  ]);
  assert.equal(hasResumableHistory("junie", dir, { home }), false);
});

test("Junie handles symlink equivalence via realDir", (t) => {
  const { home, sessionsDir, indexPath, real } = junieFixture(t);
  const realDir = join(home, "realDir");
  const linkDir = join(home, "linkDir");
  mkdirSync(realDir);
  symlinkSync(realDir, linkDir, "dir");
  makeSession(sessionsDir, "session-002");
  // recorded projectDir is the real path
  writeJunieIndex(indexPath, [
    { sessionId: "session-002", projectDir: realDir, createdAt: 1, updatedAt: 2, taskName: "test", lastPromptAt: 1 },
  ]);
  // querying through the symlink must resolve to the same real path → true
  assert.equal(hasResumableHistory("junie", linkDir, { home }), true);
});

test("Junie does not match parent folder", (t) => {
  const { home, indexPath, sessionsDir, real } = junieFixture(t);
  const childDir = join(home, "project", "child");
  mkdirSync(childDir, { recursive: true });
  makeSession(sessionsDir, "session-003");
  writeJunieIndex(indexPath, [
    { sessionId: "session-003", projectDir: real, createdAt: 1, updatedAt: 2, taskName: "test", lastPromptAt: 1 },
  ]);
  assert.equal(hasResumableHistory("junie", childDir, { home }), false);
});

test("Junie does not match child folder", (t) => {
  const { home, dir, indexPath, sessionsDir } = junieFixture(t);
  // dir is the parent; session recorded for a child of dir
  makeSession(sessionsDir, "session-004");
  const childDir = join(dir, "child");
  mkdirSync(childDir);
  const childReal = realpathSync(childDir);
  writeJunieIndex(indexPath, [
    { sessionId: "session-004", projectDir: childReal, createdAt: 1, updatedAt: 2, taskName: "test", lastPromptAt: 1 },
  ]);
  // querying the parent must not match
  assert.equal(hasResumableHistory("junie", dir, { home }), false);
});

test("Junie does not match prefix-only folder", (t) => {
  const { home, indexPath, sessionsDir, real } = junieFixture(t);
  const similarDir = join(home, "project-extra");
  mkdirSync(similarDir);
  makeSession(sessionsDir, "session-005");
  writeJunieIndex(indexPath, [
    { sessionId: "session-005", projectDir: real, createdAt: 1, updatedAt: 2, taskName: "test", lastPromptAt: 1 },
  ]);
  assert.equal(hasResumableHistory("junie", similarDir, { home }), false);
});

test("Junie skips corrupt JSON lines", (t) => {
  const { home, dir, indexPath, sessionsDir, real } = junieFixture(t);
  makeSession(sessionsDir, "session-006");
  // first line is corrupt, second is valid and matches
  writeFileSync(indexPath, '{"sessionId":"bad"}\n' + JSON.stringify({ sessionId: "session-006", projectDir: real, createdAt: 1, updatedAt: 2, taskName: "test", lastPromptAt: 1 }) + "\n");
  assert.equal(hasResumableHistory("junie", dir, { home }), true);
});

test("Junie skips lines with partial JSON (truncated)", (t) => {
  const { home, dir, indexPath, sessionsDir, real } = junieFixture(t);
  makeSession(sessionsDir, "session-007");
  // truncated JSON on first line, valid on second
  writeFileSync(indexPath, '{"sessionId":"session-007","projectDir":"' + real.slice(0, 5) + '\n' + JSON.stringify({ sessionId: "session-007", projectDir: real, createdAt: 1, updatedAt: 2, taskName: "test", lastPromptAt: 1 }) + "\n");
  assert.equal(hasResumableHistory("junie", dir, { home }), true);
});

test("Junie skips entries with wrong projectDir type", (t) => {
  const { home, dir, indexPath, sessionsDir, real } = junieFixture(t);
  makeSession(sessionsDir, "session-008");
  writeJunieIndex(indexPath, [
    { sessionId: "session-008", projectDir: 12345, createdAt: 1, updatedAt: 2, taskName: "test", lastPromptAt: 1 },
  ]);
  assert.equal(hasResumableHistory("junie", dir, { home }), false);
});

test("Junie skips entries with wrong sessionId type", (t) => {
  const { home, dir, indexPath, sessionsDir, real } = junieFixture(t);
  makeSession(sessionsDir, "session-009");
  writeJunieIndex(indexPath, [
    { sessionId: 12345, projectDir: real, createdAt: 1, updatedAt: 2, taskName: "test", lastPromptAt: 1 },
  ]);
  assert.equal(hasResumableHistory("junie", dir, { home }), false);
});

test("Junie skips entries with missing projectDir", (t) => {
  const { home, dir, indexPath, sessionsDir } = junieFixture(t);
  makeSession(sessionsDir, "session-010");
  writeJunieIndex(indexPath, [
    { sessionId: "session-010", createdAt: 1, updatedAt: 2, taskName: "test", lastPromptAt: 1 },
  ]);
  assert.equal(hasResumableHistory("junie", dir, { home }), false);
});

test("Junie returns false for huge index.jsonl (>1 MiB)", (t) => {
  const { home, dir, indexPath } = junieFixture(t);
  // write a file larger than 1 MiB
  const big = "x".repeat(1_048_577);
  writeFileSync(indexPath, big);
  assert.equal(hasResumableHistory("junie", dir, { home }), false);
});

test("Junie returns false when recorded projectDir no longer exists (realDir throws)", (t) => {
  const { home, dir, indexPath, sessionsDir, real } = junieFixture(t);
  const goneDir = join(home, "gone");
  mkdirSync(goneDir);
  const goneReal = realpathSync(goneDir);
  rmSync(goneDir, { recursive: true });
  makeSession(sessionsDir, "session-011");
  writeJunieIndex(indexPath, [
    { sessionId: "session-011", projectDir: goneReal, createdAt: 1, updatedAt: 2, taskName: "test", lastPromptAt: 1 },
  ]);
  // the recorded folder is gone → realDir throws → skip → false
  assert.equal(hasResumableHistory("junie", dir, { home }), false);
});

test("Junie returns false when index.jsonl is not readable", (t) => {
  const { home, dir, indexPath, sessionsDir, real } = junieFixture(t);
  makeSession(sessionsDir, "session-unreadable");
  writeJunieIndex(indexPath, [{ sessionId: "session-unreadable", projectDir: real }]);
  assert.equal(hasResumableHistory("junie", dir, { home }), true); // control: readable → the entry counts
  chmodSync(indexPath, 0o000);
  t.after(() => { try { chmodSync(indexPath, 0o600); } catch { /* gone */ } });
  assert.equal(hasResumableHistory("junie", dir, { home }), false);
});

test("Junie returns false when .junie directory is not a directory", (t) => {
  const { home, dir } = junieFixture(t);
  // replace .junie with a file
  rmSync(join(home, ".junie"), { recursive: true, force: true });
  writeFileSync(join(home, ".junie"), "not a dir");
  assert.equal(hasResumableHistory("junie", dir, { home }), false);
});

test("Junie handles realDir throwing for the query dir", (t) => {
  const { home, dir, indexPath, sessionsDir, real } = junieFixture(t);
  makeSession(sessionsDir, "session-resolver");
  writeJunieIndex(indexPath, [{ sessionId: "session-resolver", projectDir: real }]);
  assert.equal(hasResumableHistory("junie", dir, { home }), true); // control: with a working resolver it matches
  assert.equal(hasResumableHistory("junie", dir, {
    home, realDir() { throw new Error("unavailable"); },
  }), false);
});

test("Junie matches when recorded projectDir uses symlink path but resolves to same real path", (t) => {
  const { home, sessionsDir, indexPath } = junieFixture(t);
  const realDir = join(home, "actual");
  const linkDir = join(home, "link");
  mkdirSync(realDir);
  symlinkSync(realDir, linkDir, "dir");
  makeSession(sessionsDir, "session-012");
  // recorded via the symlink path
  writeJunieIndex(indexPath, [
    { sessionId: "session-012", projectDir: linkDir, createdAt: 1, updatedAt: 2, taskName: "test", lastPromptAt: 1 },
  ]);
  // querying via the real path must still match
  assert.equal(hasResumableHistory("junie", realDir, { home }), true);
});

test("Junie skips binary / non-utf8 content gracefully", (t) => {
  const { home, dir, indexPath, sessionsDir, real } = junieFixture(t);
  makeSession(sessionsDir, "session-013");
  // write binary bytes followed by a valid line
  const buf = Buffer.alloc(16);
  buf.fill(0xFF);
  const valid = JSON.stringify({ sessionId: "session-013", projectDir: real, createdAt: 1, updatedAt: 2, taskName: "test", lastPromptAt: 1 });
  // binary line will parse as JSON (invalid chars) → skip; valid line matches
  writeFileSync(indexPath, buf.toString() + "\n" + valid + "\n");
  assert.equal(hasResumableHistory("junie", dir, { home }), true);
});

// Update the "missing cwd" test to include junie
test("missing cwd and filesystem errors return false without throwing (includes junie)", (t) => {
  const { home, dir } = junieFixture(t);
  writeFileSync(join(home, "not-a-directory"), "");
  for (const agent of ["claude", "grok", "cursor", "zcode", "junie"]) {
    assert.equal(hasResumableHistory(agent, join(home, "missing"), { home }), false);
    assert.equal(hasResumableHistory(agent, dir, {
      home, realDir() { throw new Error("unavailable cwd"); },
    }), false);
    assert.equal(hasResumableHistory(agent, dir, { home: join(home, "not-a-directory") }), false);
  }
});

// ── Regression tests for four reported bugs ──

test("Junie skips null JSON lines and still finds a later valid entry", (t) => {
  const { home, dir, indexPath, sessionsDir, real } = junieFixture(t);
  makeSession(sessionsDir, "session-020");
  // First line parses to null, second is a valid matching entry
  writeFileSync(indexPath, "null\n" + JSON.stringify({ sessionId: "session-020", projectDir: real, createdAt: 1, updatedAt: 2, taskName: "test", lastPromptAt: 1 }) + "\n");
  assert.equal(hasResumableHistory("junie", dir, { home }), true);
});

test("Junie rejects sessionId with path traversal (../../) even if target exists", (t) => {
  const { home, dir, indexPath, sessionsDir, real } = junieFixture(t);
  // Create a directory outside sessions that the traversal could reach
  mkdirSync(join(home, "other"), { recursive: true });
  // sessionId tries to escape sessionsDir via ../..
  writeJunieIndex(indexPath, [
    { sessionId: "../../other", projectDir: real, createdAt: 1, updatedAt: 2, taskName: "test", lastPromptAt: 1 },
  ]);
  assert.equal(hasResumableHistory("junie", dir, { home }), false);
});

test("Junie rejects sessionId that names a regular file inside sessions folder", (t) => {
  const { home, dir, indexPath, sessionsDir, real } = junieFixture(t);
  // Create a file (not directory) inside sessionsDir
  writeFileSync(join(sessionsDir, "session-021"), "");
  writeJunieIndex(indexPath, [
    { sessionId: "session-021", projectDir: real, createdAt: 1, updatedAt: 2, taskName: "test", lastPromptAt: 1 },
  ]);
  assert.equal(hasResumableHistory("junie", dir, { home }), false);
});

test("Junie rejects empty sessionId", (t) => {
  const { home, dir, indexPath, sessionsDir, real } = junieFixture(t);
  writeJunieIndex(indexPath, [
    { sessionId: "", projectDir: real, createdAt: 1, updatedAt: 2, taskName: "test", lastPromptAt: 1 },
  ]);
  // Empty sessionId would stat the sessionsDir itself → must be false
  assert.equal(hasResumableHistory("junie", dir, { home }), false);
});

test("Junie skips non-object JSON values (array, number, string) and finds later valid entry", (t) => {
  const { home, dir, indexPath, sessionsDir, real } = junieFixture(t);
  makeSession(sessionsDir, "session-022");
  // Array, number, and string lines before a valid matching entry
  const valid = JSON.stringify({ sessionId: "session-022", projectDir: real, createdAt: 1, updatedAt: 2, taskName: "test", lastPromptAt: 1 });
  writeFileSync(indexPath, JSON.stringify([1, 2]) + "\n" + "42\n" + '"hello"\n' + valid + "\n");
  assert.equal(hasResumableHistory("junie", dir, { home }), true);
});

test("Junie rejects session ids that are not a plain folder name ('.', leading dot, spaces, too long)", (t) => {
  const { home, dir, indexPath, real } = junieFixture(t);
  for (const sessionId of [".", ".hidden", "a b", "x".repeat(129), "sess\u0000ion"]) {
    writeJunieIndex(indexPath, [{ sessionId, projectDir: real, createdAt: 1, updatedAt: 2, taskName: "test" }]);
    assert.equal(hasResumableHistory("junie", dir, { home }), false, JSON.stringify(sessionId));
  }
});

test("Junie: a symlink in the sessions folder never counts as a session (outside target or the folder itself)", (t) => {
  const { home, dir, indexPath, sessionsDir, real } = junieFixture(t);
  symlinkSync(home, join(sessionsDir, "Escape"), "dir");
  symlinkSync(sessionsDir, join(sessionsDir, "Self"), "dir");
  writeJunieIndex(indexPath, [{ sessionId: "Escape", projectDir: real }, { sessionId: "Self", projectDir: real }]);
  assert.equal(hasResumableHistory("junie", dir, { home }), false);
});

test("Junie: an index over the size cap reads as no history even with a valid first entry", (t) => {
  const { home, dir, indexPath, sessionsDir, real } = junieFixture(t);
  makeSession(sessionsDir, "session-big");
  const valid = JSON.stringify({ sessionId: "session-big", projectDir: real });
  writeFileSync(indexPath, valid + "\n" + "x".repeat(1_048_576) + "\n");
  assert.equal(hasResumableHistory("junie", dir, { home }), false);
  writeFileSync(indexPath, valid + "\n" + "x".repeat(1_048_576 - valid.length - 2) + "\n"); // exactly at the cap
  assert.equal(hasResumableHistory("junie", dir, { home }), true);
});

test("Junie: each distinct recorded folder is resolved once per call", (t) => {
  const { home, dir, indexPath, sessionsDir, real } = junieFixture(t);
  const other = join(home, "other");
  mkdirSync(other);
  makeSession(sessionsDir, "session-last");
  writeJunieIndex(indexPath, [
    ...Array.from({ length: 200 }, (_, i) => ({ sessionId: `session-gone-${i}`, projectDir: other })),
    { sessionId: "session-last", projectDir: real },
  ]);
  let calls = 0;
  const realDir = (p) => { calls++; return realpathSync(p); };
  assert.equal(hasResumableHistory("junie", dir, { home, realDir }), true);
  assert.equal(calls, 3); // the query folder + two distinct recorded folders
});
