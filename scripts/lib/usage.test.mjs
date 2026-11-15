import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUsageReader, normalizeUsage, runUsageCli } from "./usage.mjs";

const RAW = {
  claude: {
    windows: [
      { bucket: "five_hour", window: "5 horas", used_pct: null, resets_at: null, state: "unknown", reason: "ventana null/ausente: no medida", applicable: false },
      { bucket: "seven_day", window: "7 días", used_pct: 28.04, resets_at: "2026-11-15T11:59:59.879907-04:00", state: "available", reason: "" },
      { bucket: "extra_usage", window: "extra (informativo)", used_pct: 3, state: "unknown", informational: true },
    ],
  },
  "agy-bro": { windows: [{ bucket: "Gemini Models", window: "5 horas", used_pct: 0, resets_at: "2026-11-15T16:35:04-04:00", state: "available" }] },
  codex: { plan: "prolite", windows: [{ bucket: "codex", window: "7 días", used_pct: 155, resets_at: "not a date", state: "Weird State!" }] },
  zai: { windows: [{ bucket: "unknown", window: "unknown", used_pct: null, state: "unknown", reason: "sin fuente local verificable" }] },
};

test("normalizeUsage keeps measured windows and maps accounts to panel agents", () => {
  const accounts = normalizeUsage(RAW);
  assert.deepEqual(accounts.map((a) => [a.id, a.agentId]), [["claude", "claude"], ["agy-bro", "antigravity"], ["codex", "codex"], ["zai", "zcode"]]);
  const claude = accounts[0];
  assert.equal(claude.windows.length, 1, "inapplicable and informational windows are dropped");
  assert.deepEqual(claude.windows[0], { bucket: "seven_day", window: "7 días", usedPct: 28, resetsAt: "2026-11-15T15:59:59.879Z", state: "available" });
});

test("normalizeUsage clamps percentages and rejects bad dates and states", () => {
  const codex = normalizeUsage(RAW).find((a) => a.id === "codex");
  assert.equal(codex.plan, "prolite");
  assert.deepEqual(codex.windows[0], { bucket: "codex", window: "7 días", usedPct: 100, resetsAt: null, state: "unknown" });
});

test("normalizeUsage explains an account with nothing measured", () => {
  const zai = normalizeUsage(RAW).find((a) => a.id === "zai");
  assert.deepEqual(zai.windows, []);
  assert.equal(zai.note, "sin fuente local verificable");
});

test("normalizeUsage survives input that is not the expected shape", () => {
  for (const bad of [null, undefined, "x", 3, [], [{}]]) assert.deepEqual(normalizeUsage(bad), []);
  const odd = normalizeUsage({ "bad id!": { windows: [] }, ok: null, fine: { windows: "nope" }, deep: { windows: [null, 3, { used_pct: "40" }] } });
  assert.deepEqual(odd, [{ id: "fine", agentId: "fine", windows: [] }, { id: "deep", agentId: "deep", windows: [] }]);
});

test("normalizeUsage bounds accounts, windows and label length", () => {
  const many = {};
  for (let i = 0; i < 60; i++) many[`a${i}`] = { windows: Array.from({ length: 40 }, () => ({ bucket: "b".repeat(500), window: "w", used_pct: 1 })) };
  const accounts = normalizeUsage(many);
  assert.equal(accounts.length, 24);
  assert.equal(accounts[0].windows.length, 12);
  assert.equal(accounts[0].windows[0].bucket.length, 60);
});

function harness({ bin = "/bin/agent-usage", outputs }) {
  const state = { t: 1_000_000, runs: 0, bin };
  const queue = [...outputs];
  const pending = [];
  const reader = createUsageReader({
    findBin: () => state.bin,
    exec: () => {
      state.runs++;
      const next = queue.shift();
      if (next === "hold") return new Promise((resolve) => pending.push(resolve));
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next);
    },
    now: () => state.t,
    ttlMs: 300_000,
    minRefreshMs: 60_000,
  });
  return { state, reader, pending };
}
const good = (pct) => ({ ok: true, out: JSON.stringify({ codex: { windows: [{ bucket: "codex", window: "7 días", used_pct: pct, state: "available" }] } }) });
const pctOf = (r) => r.accounts[0]?.windows[0]?.usedPct;
const settle = () => new Promise((r) => setImmediate(r));

test("reader reports unavailable without the CLI and never runs it", async () => {
  const { reader, state } = harness({ bin: null, outputs: [] });
  assert.deepEqual(await reader.read(), { ok: true, available: false, observedAt: null, accounts: [], refreshing: false });
  assert.equal(state.runs, 0);
});

test("the first read answers at once and measures in the background", async () => {
  const { reader, state } = harness({ outputs: [good(10)] });
  const first = await reader.read();
  assert.deepEqual([first.available, first.accounts, first.refreshing, first.observedAt], [true, [], true, null]);
  await settle();
  const second = await reader.read();
  assert.equal(pctOf(second), 10);
  assert.equal(second.refreshing, false);
  assert.equal(state.runs, 1);
});

test("reader caches within the TTL", async () => {
  const { reader, state } = harness({ outputs: [good(10), good(20)] });
  await reader.read({ fresh: true });
  state.t += 299_000;
  assert.equal(pctOf(await reader.read()), 10);
  assert.equal(state.runs, 1);
});

test("an expired cache answers at once and refreshes in the background", async () => {
  const { reader, state } = harness({ outputs: [good(10), good(20)] });
  await reader.read({ fresh: true });
  state.t += 300_000;
  const stale = await reader.read();
  assert.equal(pctOf(stale), 10);
  assert.equal(stale.refreshing, true);
  await settle();
  assert.equal(pctOf(await reader.read()), 20);
  assert.equal(state.runs, 2);
});

test("fresh waits for a new run but respects the floor between runs", async () => {
  const { reader, state } = harness({ outputs: [good(10), good(20), good(30)] });
  assert.equal(pctOf(await reader.read({ fresh: true })), 10);
  state.t += 59_000;
  assert.equal(pctOf(await reader.read({ fresh: true })), 10, "floor not reached: cached answer");
  assert.equal(state.runs, 1);
  state.t += 1_000;
  assert.equal(pctOf(await reader.read({ fresh: true })), 20);
  assert.equal(state.runs, 2);
});

test("concurrent reads share one run, and fresh joins the run in flight", async () => {
  const { reader, state, pending } = harness({ outputs: ["hold"] });
  const a = await reader.read();
  const b = await reader.read();
  assert.deepEqual([a.refreshing, b.refreshing], [true, true]);
  const c = reader.read({ fresh: true });
  await settle();
  assert.equal(state.runs, 1);
  pending[0](good(42));
  assert.equal(pctOf(await c), 42);
});

test("a failed run keeps the last good data and reports the error", async () => {
  const { reader, state } = harness({ outputs: [good(10), { ok: false, out: "boom" }, new Error("spawn")] });
  await reader.read({ fresh: true });
  state.t += 60_000;
  const afterBadJson = await reader.read({ fresh: true });
  assert.equal(pctOf(afterBadJson), 10);
  assert.equal(afterBadJson.err, "agent-usage no devolvió JSON");
  state.t += 60_000;
  const afterThrow = await reader.read({ fresh: true });
  assert.equal(pctOf(afterThrow), 10);
  assert.equal(afterThrow.err, "agent-usage falló");
});

test("a non-zero exit with valid JSON still counts (one account failing does not hide the rest)", async () => {
  const { reader } = harness({ outputs: [{ ...good(77), ok: false }] });
  const r = await reader.read({ fresh: true });
  assert.equal(pctOf(r), 77);
  assert.equal(r.err, undefined);
});

test("a first run that fails does not hammer the CLI on every read", async () => {
  const { reader, state } = harness({ outputs: [{ ok: false, out: "" }, good(5)] });
  const first = await reader.read({ fresh: true });
  assert.deepEqual(first.accounts, []);
  assert.equal(first.err, "agent-usage no devolvió JSON");
  await reader.read();
  await reader.read({ fresh: true });
  assert.equal(state.runs, 1, "reads inside the floor do not run again");
  state.t += 60_000;
  assert.equal(pctOf(await reader.read({ fresh: true })), 5);
});

test("an exec that throws synchronously does not leave the reader stuck", async () => {
  const state = { t: 1_000_000, calls: 0 };
  const reader = createUsageReader({
    findBin: () => "/bin/agent-usage",
    exec: () => { state.calls++; if (state.calls === 1) throw new Error("sync"); return Promise.resolve(good(9)); },
    now: () => state.t,
  });
  const first = await reader.read({ fresh: true });
  assert.deepEqual([first.refreshing, first.err], [false, "agent-usage falló"]);
  state.t += 60_000;
  assert.equal(pctOf(await reader.read({ fresh: true })), 9);
});

const POSIX = process.platform !== "win32";
function script(body) {
  const dir = mkdtempSync(join(tmpdir(), "usage-cli-"));
  const file = join(dir, "fake-usage");
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return { dir, file };
}
const alive = (marker) => { try { return execFileSync("pgrep", ["-f", marker]).toString().trim().split("\n").filter(Boolean).length; } catch { return 0; } };

test("runUsageCli returns stdout and the exit status", { skip: !POSIX }, async () => {
  const ok = script(`echo '{"a":1}'; echo noise >&2`);
  const bad = script(`echo partial; exit 3`);
  try {
    assert.deepEqual(await runUsageCli(ok.file, []), { ok: true, out: '{"a":1}', err: "" });
    assert.deepEqual(await runUsageCli(bad.file, []), { ok: false, out: "partial", err: "" });
    assert.equal((await runUsageCli(join(ok.dir, "missing"), [])).ok, false);
  } finally { rmSync(ok.dir, { recursive: true, force: true }); rmSync(bad.dir, { recursive: true, force: true }); }
});

test("runUsageCli kills the whole process group on timeout", { skip: !POSIX }, async () => {
  const marker = `usage-test-sleep-${process.pid}-${Date.now()}`;
  const s = script(`sh -c 'exec -a ${marker} sleep 60' &\nsh -c 'exec -a ${marker} sleep 60' &\nwait`);
  try {
    const started = Date.now();
    const pending = runUsageCli(s.file, [], { timeoutMs: 900 });
    await new Promise((res) => setTimeout(res, 500));
    assert.equal(alive(marker), 2, "the descendants are running before the timeout");
    assert.deepEqual(await pending, { ok: false, out: "", err: "timeout" });
    assert.ok(Date.now() - started < 3_000, "resolves on close, not on the grace timer");
    assert.equal(alive(marker), 0, "no descendant survives");
  } finally { try { execFileSync("pkill", ["-f", marker]); } catch { /* none left */ } rmSync(s.dir, { recursive: true, force: true }); }
});

test("runUsageCli stops a CLI that prints too much", { skip: !POSIX }, async () => {
  const s = script(`while :; do echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; done`);
  try {
    const r = await runUsageCli(s.file, [], { maxBytes: 64 * 1024, timeoutMs: 10_000 });
    assert.deepEqual(r, { ok: false, out: "", err: "salida demasiado grande" });
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test("runUsageCli keeps multi-byte characters that arrive split across chunks", { skip: !POSIX }, async () => {
  // "í" is C3 AD: the two bytes are written half a second apart
  const s = script(`printf '{"w":"d\\303'; sleep 0.5; printf '\\255as"}'`);
  try {
    assert.deepEqual(await runUsageCli(s.file, []), { ok: true, out: '{"w":"días"}', err: "" });
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});
