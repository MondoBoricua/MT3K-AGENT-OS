import assert from "node:assert/strict";
import test from "node:test";
import {
  clampTimeout,
  conditionMet,
  parseWaitBaseline,
  parseWaitCondition,
  parseWaitTimeout,
  promptWaitGateOpen,
} from "../lib/wait-until.mjs";

test("conditionMet evaluates blocked, idle, done, not-working, changed, sawWorking, and unknown", () => {
  assert.equal(conditionMet("blocked", "blocked"), true);
  assert.equal(conditionMet("blocked", "idle"), false);
  assert.equal(conditionMet("idle", "idle"), true);
  assert.equal(conditionMet("idle", "done"), false);
  assert.equal(conditionMet("done", "done"), true);
  assert.equal(conditionMet("done", "working"), false);
  assert.equal(conditionMet("done", "idle", undefined, { sawWorking: false }), false);
  assert.equal(conditionMet("done", "idle", undefined, { sawWorking: true }), true);

  assert.equal(conditionMet("not-working", "working"), false);
  assert.equal(conditionMet("not-working", "idle"), true);
  assert.equal(conditionMet("not-working", "done"), true);
  assert.equal(conditionMet("not-working", "blocked"), true);
  assert.equal(conditionMet(undefined, "idle"), true);
  assert.equal(conditionMet(undefined, "working"), false);

  // "unknown" satisfies NO condition, not even not-working or changed
  assert.equal(conditionMet("not-working", "unknown"), false);
  assert.equal(conditionMet("idle", "unknown"), false);
  assert.equal(conditionMet("changed", "unknown", "idle"), false);
  assert.equal(conditionMet("changed", "idle", "unknown"), false);

  assert.equal(conditionMet("changed", "working", "working"), false);
  assert.equal(conditionMet("changed", "idle", "working"), true);
  assert.equal(conditionMet("changed", "done", "idle"), true);
  assert.equal(conditionMet("changed", "idle", undefined), false);

  assert.equal(conditionMet("unknown", "idle", "working"), false);
  assert.equal(conditionMet("idle", ""), false);
});

test("clampTimeout defaults to 180 and clamps to [1, 600]", () => {
  assert.equal(clampTimeout(undefined), 180);
  assert.equal(clampTimeout(null), 180);
  assert.equal(clampTimeout(""), 180);
  assert.equal(clampTimeout("   "), 180);
  assert.equal(clampTimeout("abc"), 180);
  assert.equal(clampTimeout(false), 180);
  assert.equal(clampTimeout(NaN), 180);
  assert.equal(clampTimeout("30"), 30);
  assert.equal(clampTimeout(45.9), 45);
  assert.equal(clampTimeout(0), 1);
  assert.equal(clampTimeout(-20), 1);
  assert.equal(clampTimeout(9999), 600);
});

test("parseWaitCondition and parseWaitTimeout reject bad params and accept valid ones", () => {
  assert.deepEqual(parseWaitCondition(undefined), { ok: true, until: "not-working" });
  assert.deepEqual(parseWaitCondition(""), { ok: true, until: "not-working" });
  assert.deepEqual(parseWaitCondition("changed"), { ok: true, until: "changed" });
  assert.equal(parseWaitCondition("bogus").ok, false);

  assert.deepEqual(parseWaitTimeout(undefined), { ok: true, timeout: 180 });
  assert.deepEqual(parseWaitTimeout("20"), { ok: true, timeout: 20 });
  assert.deepEqual(parseWaitTimeout("1200"), { ok: true, timeout: 600 });
  assert.equal(parseWaitTimeout("abc").ok, false);
  assert.equal(parseWaitTimeout("0").ok, false);
  assert.equal(parseWaitTimeout("-5").ok, false);
});

test("promptWaitGateOpen waits until manifest working is seen or 10s elapsed", () => {
  assert.equal(promptWaitGateOpen({ sawWorking: false, elapsedMs: 0 }), false);
  assert.equal(promptWaitGateOpen({ sawWorking: false, elapsedMs: 9999 }), false);
  assert.equal(promptWaitGateOpen({ sawWorking: false, elapsedMs: 10000 }), true);
  assert.equal(promptWaitGateOpen({ sawWorking: true, elapsedMs: 500 }), true);
  assert.equal(promptWaitGateOpen({ sawWorking: true, statusSource: "manifest", elapsedMs: 500 }), true);
  assert.equal(promptWaitGateOpen({ sawWorking: true, statusSource: "heuristic", elapsedMs: 500 }), false);
  assert.equal(promptWaitGateOpen({ sawWorking: true, statusSource: "heuristic", elapsedMs: 10000 }), true);

  assert.deepEqual(parseWaitBaseline(undefined), { ok: true, baseline: null });
  assert.deepEqual(parseWaitBaseline("working"), { ok: true, baseline: "working" });
  assert.equal(parseWaitBaseline("bogus").ok, false);
});
