import { test } from "node:test";
import assert from "node:assert/strict";
import { createUsageReader, normalizeUsage } from "./usage.mjs";

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
