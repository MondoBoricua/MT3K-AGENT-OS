import assert from "node:assert/strict";
import test from "node:test";
import { clampTick, paneStatusFor } from "../lib/pane-status.mjs";

test("paneStatusFor returns idle when watch is null or undefined", () => {
  assert.equal(paneStatusFor(undefined, 10000), "idle");
  assert.equal(paneStatusFor(null, 10000), "idle");
});

test("paneStatusFor returns blocked when waiting is true, regardless of changedAt", () => {
  assert.equal(paneStatusFor({ waiting: true, changedAt: 9900 }, 10000), "blocked");
  assert.equal(paneStatusFor({ waiting: true, changedAt: 0 }, 10000), "blocked");
});

test("paneStatusFor returns working when changed within workingMs and not waiting", () => {
  assert.equal(paneStatusFor({ waiting: false, changedAt: 10000 }, 10000), "working");
  assert.equal(paneStatusFor({ waiting: false, changedAt: 5001 }, 10000), "working");
  assert.equal(paneStatusFor({ waiting: false, changedAt: 8500 }, 10000, { workingMs: 2000 }), "working");
});

test("paneStatusFor returns idle when elapsed >= workingMs", () => {
  assert.equal(paneStatusFor({ waiting: false, changedAt: 5000 }, 10000), "idle");
  assert.equal(paneStatusFor({ waiting: false, changedAt: 1000 }, 10000), "idle");
  assert.equal(paneStatusFor({ waiting: false, changedAt: 8000 }, 10000, { workingMs: 2000 }), "idle");
});

test("paneStatusFor honors manifest state and 2s working smoothing", () => {
  assert.equal(paneStatusFor({ source: "manifest", state: "blocked", changedAt: 10000 }, 10000), "blocked");
  assert.equal(paneStatusFor({ source: "manifest", state: "working", changedAt: 0 }, 10000), "working");
  assert.equal(paneStatusFor({ source: "manifest", state: "idle", changedAt: 8001 }, 10000), "working");
  assert.equal(paneStatusFor({ source: "manifest", state: "idle", changedAt: 8000 }, 10000), "idle");
});

test("paneStatusFor reports done for manifest entries while doneAt > seenAt", () => {
  assert.equal(
    paneStatusFor({ source: "manifest", state: "idle", changedAt: 0, doneAt: 5000, seenAt: 0 }, 10000),
    "done"
  );
  assert.equal(
    paneStatusFor({ source: "manifest", state: "idle", changedAt: 0, doneAt: 5000, seenAt: 4999 }, 10000),
    "done"
  );
  assert.equal(
    paneStatusFor({ source: "manifest", state: "idle", changedAt: 0, doneAt: 5000, seenAt: 5000 }, 10000),
    "idle"
  );
  assert.equal(
    paneStatusFor({ source: "manifest", state: "idle", changedAt: 0, doneAt: 5000, seenAt: 6000 }, 10000),
    "idle"
  );
  assert.equal(paneStatusFor({ waiting: false, changedAt: 0, doneAt: 9000, seenAt: 0 }, 10000), "idle");
});

test("clampTick returns fallback for non-numeric inputs", () => {
  assert.equal(clampTick(null), 500);
  assert.equal(clampTick(undefined), 500);
  assert.equal(clampTick(""), 500);
  assert.equal(clampTick("   "), 500);
  assert.equal(clampTick("abc"), 500);
  assert.equal(clampTick(NaN), 500);
  assert.equal(clampTick(Infinity), 500);
  assert.equal(clampTick(false), 500);
  assert.equal(clampTick("nope", { fallback: 1000 }), 1000);
});

test("clampTick clamps numeric inputs into [min, max] as integers", () => {
  assert.equal(clampTick("1000"), 1000);
  assert.equal(clampTick(1000), 1000);
  assert.equal(clampTick("750.9"), 750);
  assert.equal(clampTick("10"), 250);
  assert.equal(clampTick(0), 250);
  assert.equal(clampTick(-100), 250);
  assert.equal(clampTick("99999"), 3000);
  assert.equal(clampTick(5000, { min: 100, max: 2000 }), 2000);
  assert.equal(clampTick(50, { min: 100, max: 2000 }), 100);
});

test("paneStatusFor: an explicit heuristic source ignores a stale manifest state string", () => {
  // the pane changed hands (manifest agent → shell): the entry was reset by the watcher, but even a
  // leftover `state` must not short-circuit the heuristic
  assert.equal(paneStatusFor({ source: "heuristic", state: "working", waiting: true, changedAt: 0 }, 100000), "blocked");
  assert.equal(paneStatusFor({ source: "heuristic", state: "working", waiting: false, changedAt: 0 }, 100000), "idle");
  assert.equal(paneStatusFor({ source: "heuristic", state: "done", doneAt: 5, seenAt: 1, waiting: false, changedAt: 99000 }, 100000), "working");
});
