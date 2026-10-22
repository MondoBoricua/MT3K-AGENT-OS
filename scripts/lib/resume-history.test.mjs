import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideResume, hasResumableHistory } from "./resume-history.mjs";

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
  // row under the REAL cwd → true, also through a symlink pointing at it
  seed([real]);
  assert.equal(hasResumableHistory("zcode", dir, { home }), true);
  assert.equal(hasResumableHistory("zcode", alias, { home }), true);
  rmSync(db);
  // row under the LEXICAL cwd (the symlink path itself) → true too
  seed([alias]);
  assert.equal(hasResumableHistory("zcode", alias, { home }), true);
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
