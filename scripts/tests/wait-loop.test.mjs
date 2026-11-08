import assert from "node:assert/strict";
import test from "node:test";
import { runWait } from "../lib/wait-loop.mjs";

function makeFakeClock(initialMs = 1_000_000) {
  let currentMs = initialMs;
  let activeTimers = 0;
  const now = () => currentMs;
  const sleep = (ms, registerCancel) =>
    new Promise((resolve) => {
      activeTimers++;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        activeTimers--;
        resolve();
      };
      if (typeof registerCancel === "function") {
        registerCancel(finish);
      }
      queueMicrotask(() => {
        if (!settled) {
          currentMs += ms;
          finish();
        }
      });
    });
  return {
    now,
    sleep,
    getActiveTimers: () => activeTimers,
    advance: (ms) => {
      currentMs += ms;
    },
  };
}

test("runWait resolves immediately when condition is already reached", async () => {
  const clock = makeFakeClock();
  let refreshes = 0;
  const res = await runWait({
    cond: "not-working",
    timeoutMs: 10_000,
    refresh: async () => {
      refreshes++;
    },
    readStatus: () => ({ status: "idle", statusRule: "prompt", source: "manifest" }),
    isAlive: () => true,
    sleep: clock.sleep,
    now: clock.now,
  });

  assert.equal(res.reason, "reached");
  assert.equal(res.status, "idle");
  assert.equal(res.statusRule, "prompt");
  assert.equal(res.waitedMs, 0);
  assert.equal(refreshes, 0);
});

test("runWait polls until timeout when condition is never reached", async () => {
  const clock = makeFakeClock();
  let refreshes = 0;
  const res = await runWait({
    cond: "not-working",
    timeoutMs: 5_000,
    refresh: async () => {
      refreshes++;
    },
    readStatus: () => ({ status: "working", statusRule: "spinner", source: "manifest" }),
    isAlive: () => true,
    sleep: clock.sleep,
    now: clock.now,
    pollIntervalMs: 2_000,
  });

  assert.equal(res.reason, "timeout");
  assert.equal(res.status, "working");
  assert.equal(res.waitedMs, 5_000);
  assert.equal(res.sawWorking, true);
  assert.equal(refreshes, 3);
  assert.equal(clock.getActiveTimers(), 0);
});

test("runWait returns gone when pane disappears on a poll tick", async () => {
  const clock = makeFakeClock();
  let tick = 0;
  const res = await runWait({
    cond: "idle",
    timeoutMs: 10_000,
    refresh: async () => {
      tick++;
    },
    readStatus: () => ({ status: "working", statusRule: "spinner", source: "manifest" }),
    isAlive: () => tick < 2,
    sleep: clock.sleep,
    now: clock.now,
    pollIntervalMs: 2_000,
  });

  assert.equal(res.reason, "gone");
  assert.equal(res.waitedMs, 4_000);
});

test("runWait stops immediately on abort and clears pending sleep timer", async () => {
  let currentMs = 0;
  let activeTimers = 0;
  let abortCb = null;
  let refreshes = 0;

  const sleep = (ms, registerCancel) =>
    new Promise((resolve) => {
      activeTimers++;
      const id = setTimeout(() => {
        activeTimers--;
        currentMs += ms;
        resolve();
      }, 60_000);
      if (typeof registerCancel === "function") {
        registerCancel(() => {
          clearTimeout(id);
          activeTimers--;
          resolve();
        });
      }
    });

  const waitPromise = runWait({
    cond: "idle",
    timeoutMs: 120_000,
    refresh: async () => {
      refreshes++;
    },
    readStatus: () => ({ status: "working", statusRule: "spinner", source: "manifest" }),
    isAlive: () => true,
    sleep,
    now: () => currentMs,
    onAbort: (cb) => {
      abortCb = cb;
      return () => {
        abortCb = null;
      };
    },
  });

  // Yield until runWait enters sleep
  await new Promise((r) => setImmediate(r));
  assert.equal(activeTimers, 1);
  assert.equal(typeof abortCb, "function");

  currentMs = 3_000;
  abortCb();

  const res = await waitPromise;
  assert.equal(res.reason, "aborted");
  assert.equal(res.waitedMs, 3_000);
  assert.equal(activeTimers, 0);
  assert.equal(refreshes, 0);
});

test("runWait tracks changed baseline from first evaluation or caller-supplied baseline", async () => {
  const clock = makeFakeClock();
  const states = ["working", "working", "idle"];
  let idx = 0;

  const res1 = await runWait({
    cond: "changed",
    timeoutMs: 10_000,
    refresh: async () => {
      idx = Math.min(states.length - 1, idx + 1);
    },
    readStatus: () => ({ status: states[idx], statusRule: "r", source: "manifest" }),
    isAlive: () => true,
    sleep: clock.sleep,
    now: clock.now,
  });

  assert.equal(res1.reason, "reached");
  assert.equal(res1.baseline, "working");
  assert.equal(res1.status, "idle");
  assert.equal(res1.waitedMs, 4_000);

  // With explicit baseline="working" when current status is already "idle" (chunk 2 boundary)
  const res2 = await runWait({
    cond: "changed",
    baseline: "working",
    timeoutMs: 10_000,
    refresh: async () => {},
    readStatus: () => ({ status: "idle", statusRule: "r", source: "manifest" }),
    isAlive: () => true,
    sleep: clock.sleep,
    now: clock.now,
  });
  assert.equal(res2.reason, "reached");
  assert.equal(res2.waitedMs, 0);
  assert.equal(res2.baseline, "working");
});

test("runWait satisfies until=done when status===done OR (sawWorking and status===idle)", async () => {
  const clock = makeFakeClock();
  // A viewed pane starts idle, transitions to working, then goes straight back to idle (skipping done)
  const seq = ["idle", "working", "idle"];
  let idx = 0;
  const res = await runWait({
    cond: "done",
    timeoutMs: 10_000,
    refresh: async () => {
      idx = Math.min(seq.length - 1, idx + 1);
    },
    readStatus: () => ({ status: seq[idx], statusRule: "rule", source: "manifest" }),
    isAlive: () => true,
    sleep: clock.sleep,
    now: clock.now,
  });

  assert.equal(res.reason, "reached");
  assert.equal(res.status, "idle");
  assert.equal(res.sawWorking, true);
  assert.equal(res.waitedMs, 4_000);
});

test("runWait forces refresh when readStatus returns null and treats still-null as unknown", async () => {
  const clock = makeFakeClock();
  let refreshes = 0;

  // Always null -> status is "unknown", satisfies NO condition (not even not-working) -> times out
  const resTimeout = await runWait({
    cond: "not-working",
    timeoutMs: 4_000,
    refresh: async () => {
      refreshes++;
    },
    readStatus: () => null,
    isAlive: () => true,
    sleep: clock.sleep,
    now: clock.now,
  });
  assert.equal(resTimeout.reason, "timeout");
  assert.equal(resTimeout.status, "unknown");
  assert.ok(refreshes >= 3);

  // Null before first refresh, then populated after forced refresh
  let populated = false;
  const resPopulated = await runWait({
    cond: "not-working",
    timeoutMs: 4_000,
    refresh: async () => {
      populated = true;
    },
    readStatus: () => (populated ? { status: "idle", statusRule: "prompt", source: "manifest" } : null),
    isAlive: () => true,
    sleep: clock.sleep,
    now: clock.now,
  });
  assert.equal(resPopulated.reason, "reached");
  assert.equal(resPopulated.status, "idle");
  assert.equal(resPopulated.waitedMs, 0);
});

test("runWait prompt-wait gate opens only on manifest working or after 10s grace", async () => {
  const clock = makeFakeClock();
  // Heuristic working at t=0 followed by idle at t=2s,4s,6s,8s must NOT resolve until t=10s
  const states = [
    { status: "working", statusRule: "screen-changing", source: "heuristic" },
    { status: "idle", statusRule: "still-4s", source: "heuristic" },
  ];
  let tick = 0;
  const resHeuristic = await runWait({
    cond: "not-working",
    timeoutMs: 20_000,
    isPromptWait: true,
    refresh: async () => {
      tick++;
    },
    readStatus: () => states[Math.min(1, tick)],
    isAlive: () => true,
    sleep: clock.sleep,
    now: clock.now,
  });
  assert.equal(resHeuristic.reason, "reached");
  assert.equal(resHeuristic.waitedMs, 10_000);

  // Manifest working at t=2s opens the gate so idle at t=4s resolves immediately at 4s
  const mStates = [
    { status: "idle", statusRule: "prompt", source: "manifest" },
    { status: "working", statusRule: "spinner", source: "manifest" },
    { status: "idle", statusRule: "prompt", source: "manifest" },
  ];
  let mTick = 0;
  const resManifest = await runWait({
    cond: "not-working",
    timeoutMs: 20_000,
    isPromptWait: true,
    refresh: async () => {
      mTick = Math.min(mStates.length - 1, mTick + 1);
    },
    // each manifest sample carries the time it was taken (post-send samples open the gate)
    readStatus: () => ({ ...mStates[mTick], sampledAt: clock.now() }),
    isAlive: () => true,
    sleep: clock.sleep,
    now: clock.now,
  });
  assert.equal(resManifest.reason, "reached");
  assert.equal(resManifest.waitedMs, 4_000);
});

test("runWait prompt-wait ignores a cached manifest working sampled before the send (P5)", async () => {
  const clock = makeFakeClock();
  const sentAt = clock.now();
  const staleSampledAt = sentAt - 3_000; // previous turn's working sample still cached
  let cached = { status: "working", statusRule: "spinner", source: "manifest", sampledAt: staleSampledAt };
  let refreshes = 0;
  const r = await runWait({
    cond: "not-working",
    isPromptWait: true,
    sentAt,
    timeoutMs: 12_000,
    now: clock.now,
    sleep: clock.sleep,
    isAlive: () => true,
    readStatus: () => cached,
    refresh: async () => {
      refreshes++;
      cached = { status: "idle", statusRule: "prompt", source: "manifest", sampledAt: clock.now() };
    },
  });
  assert.equal(r.reason, "reached");
  assert.equal(r.waitedMs, 10_000); // only the 10 s grace opens the gate
  assert.ok(refreshes >= 5);

  // a working sample taken AFTER the send opens the gate at once
  const clock2 = makeFakeClock();
  const sent2 = clock2.now();
  let n = 0;
  const r2 = await runWait({
    cond: "not-working",
    isPromptWait: true,
    sentAt: sent2,
    timeoutMs: 12_000,
    now: clock2.now,
    sleep: clock2.sleep,
    isAlive: () => true,
    readStatus: () =>
      n === 0
        ? { status: "working", source: "manifest", sampledAt: sent2 - 1 }
        : n === 1
          ? { status: "working", source: "manifest", sampledAt: clock2.now() }
          : { status: "idle", source: "manifest", sampledAt: clock2.now() },
    refresh: async () => {
      n++;
    },
  });
  assert.equal(r2.reason, "reached");
  assert.equal(r2.waitedMs, 4_000);
});

test("runWait returns timeout when the deadline passes during an awaited refresh (P4)", async () => {
  let t = 0;
  let status = "working";
  const late = await runWait({
    cond: "not-working",
    timeoutMs: 1000,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    isAlive: () => true,
    readStatus: () => ({ status, source: "manifest" }),
    refresh: async () => {
      t += 3000;
      status = "idle";
    },
  });
  assert.equal(late.reason, "timeout");
  assert.equal(late.status, "idle");
  assert.equal(late.waitedMs, 4000);
});

test("runWait honours sawWorkingBefore from an earlier chunk for until=done", async () => {
  const clock = makeFakeClock();
  const base = {
    cond: "done",
    timeoutMs: 4_000,
    refresh: async () => {},
    readStatus: () => ({ status: "idle", statusRule: "rule", source: "manifest" }),
    isAlive: () => true,
    sleep: clock.sleep,
    now: clock.now,
  };
  const fresh = await runWait(base);
  assert.equal(fresh.reason, "timeout");
  assert.equal(fresh.sawWorking, false);

  const chained = await runWait({ ...base, sawWorkingBefore: true });
  assert.equal(chained.reason, "reached");
  assert.equal(chained.status, "idle");
  assert.equal(chained.sawWorking, true);
});

test("runWait forces a refresh before reporting gone for a pane missing from a stale pane list", async () => {
  const clock = makeFakeClock();
  let known = false;
  const forced = [];
  const res = await runWait({
    cond: "not-working",
    timeoutMs: 10_000,
    refresh: async (force) => {
      forced.push(Boolean(force));
      if (force) known = true; // the fresh list-panes now contains the new pane
    },
    readStatus: () => (known ? { status: "working", statusRule: "recent_output", source: "heuristic" } : null),
    isAlive: () => known,
    sleep: clock.sleep,
    now: clock.now,
    pollIntervalMs: 2_000,
  });
  assert.equal(res.reason, "timeout");
  assert.equal(res.status, "working");
  assert.equal(forced[0], true);

  const gone = await runWait({
    cond: "not-working",
    timeoutMs: 10_000,
    refresh: async () => {},
    readStatus: () => null,
    isAlive: () => false,
    sleep: clock.sleep,
    now: clock.now,
  });
  assert.equal(gone.reason, "gone");
});

test("R1: a late INITIAL forced refresh past the deadline reports timeout, not reached", async () => {
  let t = 0;
  const r = await runWait({
    cond: "idle",
    timeoutMs: 1000,
    now: () => t,
    isAlive: () => true,
    refresh: async () => { t = 3000; },
    readStatus: () => (t ? { status: "idle" } : null),
  });
  assert.equal(r.reason, "timeout");
  assert.equal(r.status, "idle");
  assert.equal(r.waitedMs, 3000);
});

test("an initial evaluation that reaches the condition within the deadline still succeeds", async () => {
  let t = 0;
  const r = await runWait({
    cond: "idle",
    timeoutMs: 5000,
    now: () => t,
    isAlive: () => true,
    refresh: async () => { t = 3000; },
    readStatus: () => (t ? { status: "idle" } : null),
  });
  assert.equal(r.reason, "reached");
});
