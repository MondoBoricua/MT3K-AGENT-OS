import assert from "node:assert/strict";
import test from "node:test";
import { createKillTombstones } from "../lib/kill-tombstones.mjs";

const row = (id, panes) => ({ id, panes });

test("a stale echo of the killed generation is dropped from snapshot writes (P6)", () => {
  let now = 100_000;
  const t = createKillTombstones({ now: () => now });
  t.mark("same-name", ["%5"]);
  now += 1000;
  // stale in-flight detect still lists the dead pane
  const stale = t.filter({ sessions: [{ sessionName: "same-name" }] }, [row("claude", [{ paneId: "%5", label: "same-name:0.0" }])]);
  assert.deepEqual(stale.sessions, []);
  // ledger-only entry (no live pane) is dropped too
  assert.deepEqual(t.filter({ sessions: [{ sessionName: "same-name" }] }, []).sessions, []);
  // the hold expires and the map is pruned
  now += 61_000;
  assert.deepEqual(t.filter({ sessions: [{ sessionName: "same-name" }] }, []).sessions, [{ sessionName: "same-name" }]);
  assert.equal(t.size(), 0);
});

test("a new generation with the same session name is accepted and clears the tombstone", () => {
  let now = 100_000;
  const t = createKillTombstones({ now: () => now });
  t.mark("same-name", ["%5"]);
  now += 1000;
  const fresh = t.filter(
    { sessions: [{ sessionName: "same-name", firstSeen: "new-session" }] },
    [row("codex", [{ paneId: "%40", label: "same-name:0.0" }])]
  );
  assert.deepEqual(fresh.sessions, [{ sessionName: "same-name", firstSeen: "new-session" }]);
  assert.equal(t.size(), 0);
});

test("sibling sessions are never suppressed; only the tombstoned name is", () => {
  const t = createKillTombstones({ now: () => 0 });
  t.mark("dead", ["%1"]);
  const out = t.filter(
    { sessions: [{ sessionName: "dead" }, { sessionName: "alive" }] },
    [row("claude", [{ paneId: "%2", label: "alive:0.0" }])]
  );
  assert.deepEqual(out.sessions, [{ sessionName: "alive" }]);
});

test("clear() (a panel relaunch under the same name) lifts the tombstone", () => {
  const t = createKillTombstones({ now: () => 0 });
  t.mark("x", ["%1"]);
  t.clear("x");
  assert.deepEqual(t.filter({ sessions: [{ sessionName: "x" }] }, []).sessions, [{ sessionName: "x" }]);
});

test("R6: an old scan listing a sibling killed earlier cannot resurrect the session", () => {
  const t = createKillTombstones({ now: () => 0 });
  // scan #3 saw both panes; %1 was killed later (session survived), then %2 (session died) at counter 5
  t.observe([row("claude", [{ paneId: "%1", label: "same:0.0" }, { paneId: "%2", label: "same:0.1" }])], 3);
  t.observe([row("claude", [{ paneId: "%2", label: "same:0.1" }])], 4);
  t.mark("same", ["%2"], { killedAtSeq: 5 });
  assert.deepEqual(t.get("same").paneIds.sort(), ["%1", "%2"]);
  const staleRows = [row("claude", [{ paneId: "%1", label: "same:0.0" }, { paneId: "%2", label: "same:0.1" }])];
  // the stale writer (scan #5, started before the kill) is dropped by generation alone
  assert.deepEqual(t.filter({ sessions: [{ sessionName: "same" }] }, staleRows, 5).sessions, []);
  // even without a seq, %1 is in the accumulated history: not new-generation evidence
  assert.deepEqual(t.filter({ sessions: [{ sessionName: "same" }] }, staleRows).sessions, []);
  assert.equal(t.size(), 1);
});

test("R3: Windows same-label recreation with a new pane_pid is accepted as a new generation", () => {
  const t = createKillTombstones({ now: () => 0 });
  t.observe([row("claude", [{ paneId: "same:0.0", label: "same:0.0", panePid: 100 }])], 1);
  t.mark("same", ["same:0.0"], { killedAtSeq: 1, panePids: { "same:0.0": 100 } });
  // the same label with the old pid is the stale echo
  const echo = t.filter({ sessions: [{ sessionName: "same" }] }, [row("claude", [{ paneId: "same:0.0", label: "same:0.0", panePid: 100 }])], 2);
  assert.deepEqual(echo.sessions, []);
  // the same label with a new pid (recreated session) is kept and clears the tombstone
  const fresh = t.filter(
    { sessions: [{ sessionName: "same", firstSeen: "NEW" }] },
    [row("claude", [{ paneId: "same:0.0", label: "same:0.0", panePid: 200 }])],
    2
  );
  assert.deepEqual(fresh.sessions, [{ sessionName: "same", firstSeen: "NEW" }]);
  assert.equal(t.size(), 0);
});

test("a new pane id from a scan that began after the kill is still accepted (seq aware)", () => {
  const t = createKillTombstones({ now: () => 0 });
  t.mark("same", ["%5"], { killedAtSeq: 7 });
  // same evidence from a scan that began before the kill is ignored
  assert.deepEqual(t.filter({ sessions: [{ sessionName: "same" }] }, [row("codex", [{ paneId: "%40", label: "same:0.0" }])], 7).sessions, []);
  const fresh = t.filter({ sessions: [{ sessionName: "same" }] }, [row("codex", [{ paneId: "%40", label: "same:0.0" }])], 8);
  assert.deepEqual(fresh.sessions, [{ sessionName: "same" }]);
  assert.equal(t.size(), 0);
});
