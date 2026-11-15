import assert from "node:assert/strict";
import test from "node:test";
import { accountTag, bucketName, fmtReset, highCrossings, isExpired, usageByAgent, usageTone, windowLabel, worstWindow, type UsageAccount, type UsageWindow } from "../src/lib/usage.ts";

const NOW = Date.parse("2026-11-15T15:35:00.000Z");
const win = (over: Partial<UsageWindow> = {}): UsageWindow => ({ bucket: "seven_day", window: "7 días", usedPct: 10, resetsAt: null, state: "available", ...over });
const acct = (id: string, agentId: string, windows: UsageWindow[]): UsageAccount => ({ id, agentId, windows });

test("usageTone follows the 50 and 85 bands", () => {
  assert.equal(usageTone(0), "emerald");
  assert.equal(usageTone(49.9), "emerald");
  assert.equal(usageTone(50), "amber");
  assert.equal(usageTone(84.9), "amber");
  assert.equal(usageTone(85), "red");
  assert.equal(usageTone(100), "red");
});

test("isExpired is true only for a reset in the past", () => {
  assert.equal(isExpired(win({ resetsAt: null }), NOW), false);
  assert.equal(isExpired(win({ resetsAt: "2026-11-15T15:34:59.000Z" }), NOW), true);
  assert.equal(isExpired(win({ resetsAt: "2026-11-15T15:35:00.000Z" }), NOW), true);
  assert.equal(isExpired(win({ resetsAt: "2026-11-15T15:35:01.000Z" }), NOW), false);
  assert.equal(isExpired(win({ resetsAt: "garbage" }), NOW), false);
});

test("worstWindow picks the highest current window and skips expired ones", () => {
  const a = acct("agy", "antigravity", [
    win({ bucket: "Gemini Models", usedPct: 1 }),
    win({ bucket: "Gemini 4 Argon", usedPct: 36, resetsAt: "2026-11-21T16:51:12.000Z" }),
    win({ bucket: "Old", usedPct: 99, resetsAt: "2026-11-15T04:00:00.000Z" }),
  ]);
  assert.equal(worstWindow(a, NOW)?.bucket, "Gemini 4 Argon");
  assert.equal(worstWindow(acct("x", "x", []), NOW), null);
  assert.equal(worstWindow(acct("x", "x", [win({ resetsAt: "2026-11-01T00:00:00.000Z" })]), NOW), null);
});

test("windowLabel hides identifier-like buckets and keeps real names", () => {
  assert.equal(windowLabel({ bucket: "seven_day", window: "7 días" }), "7 días");
  assert.equal(windowLabel({ bucket: "codex", window: "7 días" }), "7 días");
  assert.equal(windowLabel({ bucket: "Gemini Models", window: "5 horas" }), "Gemini Models · 5 horas");
  assert.equal(windowLabel({ bucket: "Included", window: "" }), "Included");
  assert.equal(windowLabel({ bucket: "premium_interactions", window: "" }), "premium_interactions");
  assert.equal(windowLabel({ bucket: "", window: "mes" }), "mes");
  assert.equal(windowLabel({ bucket: "", window: "" }), "");
});

test("bucketName is empty only when an identifier bucket has a window to show instead", () => {
  assert.equal(bucketName({ bucket: "seven_day", window: "7 días" }), "");
  assert.equal(bucketName({ bucket: "Gemini 4 Argon", window: "7 días" }), "Gemini 4 Argon");
  assert.equal(bucketName({ bucket: "premium_interactions", window: "" }), "premium_interactions");
  assert.equal(bucketName({ bucket: "", window: "mes" }), "");
});

test("fmtReset words the time left", () => {
  const at = (ms: number) => new Date(NOW + ms).toISOString();
  assert.equal(fmtReset(null, NOW), "");
  assert.equal(fmtReset("garbage", NOW), "");
  assert.equal(fmtReset(at(-1), NOW), "reinicio vencido");
  assert.equal(fmtReset(at(20_000), NOW), "en 1 min");
  assert.equal(fmtReset(at(25 * 60_000), NOW), "en 25 min");
  assert.equal(fmtReset(at(5 * 3_600_000), NOW), "en 5 h");
  assert.equal(fmtReset("2026-11-18T16:12:31.000Z", NOW, "America/Puerto_Rico"), "mié 12:12");
});

test("accountTag names only secondary accounts", () => {
  assert.equal(accountTag("claude"), "");
  assert.equal(accountTag("claude-work"), "work");
  assert.equal(accountTag("agy-bro"), "bro");
  assert.equal(accountTag("-odd"), "");
});

test("usageByAgent groups accounts under their panel agent", () => {
  const by = usageByAgent([acct("claude", "claude", []), acct("codex", "codex", []), acct("claude-work", "claude", [])]);
  assert.deepEqual(by.claude.map((a) => a.id), ["claude", "claude-work"]);
  assert.deepEqual(Object.keys(by), ["claude", "codex"]);
});

test("highCrossings announces nothing on the first report", () => {
  const r = highCrossings(null, [acct("codex", "codex", [win({ usedPct: 95 })])], NOW);
  assert.deepEqual(r.crossings, []);
  assert.deepEqual(r.next, { "codex|seven_day|7 días": 95 });
});

test("highCrossings announces a window once when it reaches 85", () => {
  const first = highCrossings(null, [acct("codex", "codex", [win({ usedPct: 80 })])], NOW);
  const second = highCrossings(first.next, [acct("codex", "codex", [win({ usedPct: 86 })])], NOW);
  assert.deepEqual(second.crossings.map((c) => [c.accountId, c.window.usedPct]), [["codex", 86]]);
  const third = highCrossings(second.next, [acct("codex", "codex", [win({ usedPct: 90 })])], NOW);
  assert.deepEqual(third.crossings, []);
});

test("highCrossings treats a new window as starting from zero and ignores expired ones", () => {
  const prev = { "codex|seven_day|7 días": 10 };
  const r = highCrossings(prev, [
    acct("agy", "antigravity", [win({ bucket: "Gemini 4 Argon", usedPct: 88 })]),
    acct("cursor", "cursor", [win({ usedPct: 99, resetsAt: "2026-11-15T04:00:00.000Z" })]),
  ], NOW);
  assert.deepEqual(r.crossings.map((c) => c.accountId), ["agy"]);
  assert.deepEqual(r.next, { "codex|seven_day|7 días": 10, "agy|Gemini 4 Argon|7 días": 88 });
});

test("highCrossings does not repeat the warning when a window disappears and comes back", () => {
  const high = highCrossings({ "codex|seven_day|7 días": 80 }, [acct("codex", "codex", [win({ usedPct: 90 })])], NOW);
  assert.equal(high.crossings.length, 1);
  const failed = highCrossings(high.next, [acct("codex", "codex", [])], NOW);
  const back = highCrossings(failed.next, [acct("codex", "codex", [win({ usedPct: 90 })])], NOW);
  assert.deepEqual([failed.crossings.length, back.crossings.length], [0, 0]);
  assert.notEqual(failed.next, high.next, "the previous map is not mutated");
});

test("highCrossings announces again after the window resets and climbs back", () => {
  const high = highCrossings({ "codex|seven_day|7 días": 80 }, [acct("codex", "codex", [win({ usedPct: 90 })])], NOW);
  const reset = highCrossings(high.next, [acct("codex", "codex", [win({ usedPct: 2 })])], NOW);
  const again = highCrossings(reset.next, [acct("codex", "codex", [win({ usedPct: 85 })])], NOW);
  assert.equal(reset.crossings.length, 0);
  assert.equal(again.crossings.length, 1);
});
