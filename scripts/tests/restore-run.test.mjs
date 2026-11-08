import assert from "node:assert/strict";
import test from "node:test";
import { isRestoreRunning, runRestore } from "../lib/restore-run.mjs";

test("runRestore enforces in-process lock and returns 409 on concurrent call", async () => {
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const missing = [{ agentId: "claude", cwd: "~/repo-a", sessionName: "s-1" }];
  const firstPromise = runRestore({
    all: true,
    missing,
    launch: async () => {
      await firstGate;
      return { ok: true, paneId: "%1", resumed: true };
    },
    sleep: async () => {},
  });

  assert.equal(isRestoreRunning(), true);

  const secondResult = await runRestore({
    all: true,
    missing,
    launch: async () => ({ ok: true, paneId: "%2" }),
    sleep: async () => {},
  });

  assert.equal(secondResult.ok, false);
  assert.equal(secondResult.status, 409);
  assert.equal(secondResult.err, "restore en curso");

  releaseFirst();
  const firstResult = await firstPromise;
  assert.equal(firstResult.ok, true);
  assert.equal(firstResult.results.length, 1);
  assert.equal(isRestoreRunning(), false);
});

test("runRestore refuses requested items that are not in missing with reason not-missing without launching", async () => {
  let launches = 0;
  const missing = [
    { agentId: "claude", cwd: "~/repo-a", sessionName: "mt3k-claude-a", name: "revisor" },
  ];

  const res = await runRestore({
    all: false,
    items: [
      { agentId: "codex", cwd: "/arbitrary/path" },
      { agentId: "claude", cwd: "~/repo-a" },
    ],
    missing,
    launch: async (entry) => {
      launches++;
      return { ok: true, paneId: "%10", session: "mt3k-claude-new", resumed: true, entry };
    },
    sleep: async () => {},
  });

  assert.equal(res.ok, true);
  assert.equal(launches, 1);
  assert.equal(res.results.length, 2);
  assert.deepEqual(res.results[0], {
    agentId: "codex",
    cwd: "/arbitrary/path",
    ok: false,
    skipped: true,
    reason: "not-missing",
    err: "esa sesión no está pendiente de restaurar",
  });
  assert.equal(res.results[1].ok, true);
  assert.equal(res.results[1].paneId, "%10");
  assert.equal(res.results[1].name, "revisor");
});

test("runRestore launches sequentially 1.5s apart, caps at 12 items, and skips missing-dir via injected launch", async () => {
  const missing = Array.from({ length: 15 }, (_, i) => ({
    agentId: i === 1 ? "codex" : "claude",
    cwd: `~/repo-${i}`,
    sessionName: `sess-${i}`,
    ...(i === 0 ? { name: "uno" } : {}),
  }));

  const events = [];
  const res = await runRestore({
    all: true,
    missing,
    delayMs: 1500,
    maxItems: 12,
    sleep: async (ms) => {
      events.push(`sleep:${ms}`);
    },
    launch: async (entry) => {
      events.push(`launch:${entry.sessionName}`);
      if (entry.cwd === "~/repo-1") {
        return { ok: false, reason: "missing-dir", err: "la carpeta ya no existe" };
      }
      return { ok: true, paneId: `%${entry.sessionName}`, resumed: false };
    },
  });

  assert.equal(res.ok, true);
  // a missing-dir skip reported by launch() does not use a launch slot: 12 real launches + 1 skip
  assert.equal(res.results.length, 13);
  assert.equal(res.results[0].ok, true);
  assert.equal(res.results[0].name, "uno");
  assert.equal(res.results[1].ok, false);
  assert.equal(res.results[1].reason, "missing-dir");
  assert.equal(res.launched, 12);

  // launch0, sleep, launch1 (skip → no delay after it), launch2, then 10 × (sleep, launch) = 24 events
  assert.equal(events.length, 24);
  assert.equal(events[0], "launch:sess-0");
  assert.equal(events[1], "sleep:1500");
  assert.equal(events[2], "launch:sess-1");
  assert.equal(events[3], "launch:sess-2");
  assert.equal(events[23], "launch:sess-12");
});

test("runRestore precheck skips dead folders without consuming the 12-launch quota (P2 starvation)", async () => {
  const missing = Array.from({ length: 13 }, (_, i) => ({ agentId: "claude", cwd: `~/r${i}`, sessionName: `s${i}` }));
  const launched = [];
  const res = await runRestore({
    all: true,
    missing,
    precheck: async (e) => (e.sessionName === "s12" ? null : { skipped: true, reason: "missing-dir", err: "no existe" }),
    launch: async (e) => {
      launched.push(e.sessionName);
      return { ok: true, paneId: "%9" };
    },
    sleep: async () => {},
  });
  assert.deepEqual(launched, ["s12"]);
  assert.equal(res.launched, 1);
  assert.equal(res.results.length, 13);
  assert.equal(res.results.filter((r) => r.reason === "missing-dir").length, 12);
});

test("runRestore with an explicit sessionName never falls back to another session in the folder (P3)", async () => {
  const A = { agentId: "claude", cwd: "~/repo", sessionName: "already-live-A" };
  const B = { ...A, sessionName: "missing-B" };
  const launches = [];
  const r = await runRestore({
    items: [A],
    missing: [B],
    launch: async (e) => {
      launches.push(e.sessionName);
      return { ok: true };
    },
    sleep: async () => {},
  });
  assert.deepEqual(launches, []);
  assert.equal(r.results[0].reason, "not-missing");
  assert.equal(r.results[0].sessionName, "already-live-A");

  // without sessionName the (agentId, cwd) fallback still applies
  const r2 = await runRestore({
    items: [{ agentId: "claude", cwd: "~/repo" }],
    missing: [B],
    launch: async (e) => {
      launches.push(e.sessionName);
      return { ok: true };
    },
    sleep: async () => {},
  });
  assert.deepEqual(launches, ["missing-B"]);
  assert.equal(r2.launched, 1);
});

test("runRestore relaunches one physical session once and skips ambiguous owners", async () => {
  const launches = [];
  const res = await runRestore({
    all: true,
    missing: [
      { agentId: "claude", cwd: "~/repo", sessionName: "shared" },
      { agentId: "antigravity", cwd: "~/repo", sessionName: "shared" },
      { agentId: "codex", cwd: "~/x", sessionName: "dup-owner", ambiguous: true, claimants: ["codex", "claude"] },
    ],
    launch: async (e) => {
      launches.push(`${e.agentId}:${e.sessionName}`);
      return { ok: true };
    },
    sleep: async () => {},
  });
  assert.deepEqual(launches, ["claude:shared"]);
  assert.equal(res.launched, 1);
  const amb = res.results.find((r) => r.sessionName === "dup-owner");
  assert.equal(amb.reason, "ambiguous-owner");
  assert.equal(amb.skipped, true);
});
