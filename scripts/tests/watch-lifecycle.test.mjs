// Lifecycle of the pane state watcher in scripts/server.mjs (done / boot grace / pending turn marks).
// The watcher is not exported: the block between `const PROMPT_RE =` and `// fast loop:` is run
// in a VM with Date.now, tmux capture and notifications substituted. Keep those two markers.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";
import { detectState, loadManifests } from "../lib/agent-detect.mjs";
import { paneStatusFor } from "../lib/pane-status.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVER = readFileSync(join(ROOT, "scripts", "server.mjs"), "utf8");
const START = SERVER.indexOf("const PROMPT_RE =");
const END = SERVER.indexOf("// fast loop:");
assert.ok(START > 0 && END > START, "watcher markers missing in server.mjs");
const FRAGMENT = SERVER.slice(START, END);
const MANIFESTS = loadManifests(JSON.parse(readFileSync(join(ROOT, "scripts", "agent-detection", "manifests.json"), "utf8")));

const WORKING = "Working (3s • esc to interrupt)\n› ";
const IDLE = "› ";
const PANE = { paneId: "%42", agentId: "codex", agentName: "Codex", cwd: "~", title: "" };

function harness() {
  let now = 1_000_000;
  let screen = IDLE;
  const notifications = [];
  const ctx = vm.createContext({
    Date: { now: () => now },
    AGENT_MANIFESTS: MANIFESTS,
    detectState,
    TMUX_BIN: "mock",
    ROOT: ".",
    run: async () => ({ ok: true, out: screen }),
    notifyWaiting: () => notifications.push("blocked"),
    notifyDone: () => notifications.push("done"),
  });
  vm.runInContext(`${FRAGMENT}\nglobalThis.api = { sampleWatch, paneWatch, markPaneLaunched, markPaneTurnStarted, markPaneSeen, pendingTurnMarks, recentlyLaunched };`, ctx);
  const api = ctx.api;
  return {
    api,
    notifications,
    tick: (ms) => { now += ms; },
    show: (s) => { screen = s; },
    sample: (panes = [PANE]) => api.sampleWatch(panes, false),
    status: () => paneStatusFor(api.paneWatch.get(PANE.paneId), now),
  };
}

test("send on an existing entry: working → idle becomes done and notifies once", async () => {
  const h = harness();
  await h.sample();
  h.api.markPaneSeen(PANE.paneId);
  h.api.markPaneTurnStarted(PANE.paneId);
  h.tick(2000); h.show(WORKING); await h.sample();
  assert.equal(h.status(), "working");
  h.tick(5000); h.show(IDLE); await h.sample();
  assert.equal(h.status(), "done");
  assert.deepEqual(h.notifications, ["done"]);
  h.tick(1000); h.api.markPaneSeen(PANE.paneId);
  assert.equal(h.status(), "idle");
});

test("a prompt sent before the first sample is consumed into the entry and still yields done", async () => {
  const h = harness();
  h.api.markPaneLaunched(PANE.paneId);
  h.api.markPaneTurnStarted(PANE.paneId);
  assert.equal(h.api.pendingTurnMarks.size, 1);
  await h.sample();
  const st = h.api.paneWatch.get(PANE.paneId);
  assert.equal(h.api.pendingTurnMarks.size, 0);
  assert.equal(st.turnRequested, true);
  assert.ok(st.pendingTurnAt > 0);
  h.tick(3000); h.show(WORKING); await h.sample();
  h.tick(5000); h.show(IDLE); await h.sample();
  assert.equal(h.status(), "done");
});

test("a launch's boot spinner is not done, but a later prompt is", async () => {
  const h = harness();
  h.api.markPaneLaunched(PANE.paneId);
  h.show(WORKING); await h.sample(); // boot
  h.tick(4000); h.show(IDLE); await h.sample();
  h.tick(2500); // past the 2 s post-working smoothing (idle fallback right after working reads as working)
  assert.equal(h.status(), "idle");
  assert.deepEqual(h.notifications, []);
  h.api.markPaneTurnStarted(PANE.paneId);
  h.tick(2000); h.show(WORKING); await h.sample();
  h.tick(6000); h.show(IDLE); await h.sample();
  assert.equal(h.status(), "done");
});

test("a transient attribution change resets detector state but keeps the turn bookkeeping", async () => {
  const h = harness();
  h.api.markPaneLaunched(PANE.paneId);
  await h.sample();
  h.api.markPaneTurnStarted(PANE.paneId);
  h.tick(1000); h.show(WORKING); await h.sample();
  h.tick(1000); await h.sample([{ ...PANE, agentId: "shell" }]); // glitch: looks like a shell for one sample
  assert.equal(h.api.paneWatch.get(PANE.paneId).source, "heuristic");
  h.tick(1000); h.show(WORKING); await h.sample();
  h.tick(1000); h.show(IDLE); await h.sample();
  assert.equal(h.api.paneWatch.get(PANE.paneId).turnRequested, true);
  assert.equal(h.status(), "done");
});

test("manifest agent replaced by a shell: no stale done/blocked, heuristic decides", async () => {
  const h = harness();
  h.show(WORKING); await h.sample();
  h.tick(5000); h.show("$ "); await h.sample([{ ...PANE, agentId: "shell" }]);
  h.tick(60000); await h.sample([{ ...PANE, agentId: "shell" }]);
  const st = h.api.paneWatch.get(PANE.paneId);
  assert.equal(st.source, "heuristic");
  assert.equal(st.doneAt, 0);
  assert.notEqual(paneStatusFor(st, 1_000_000 + 65000), "done");
});

test("stale marks and launch records expire with the grace on a full sample", async () => {
  const h = harness();
  for (let i = 0; i < 50; i++) { h.api.markPaneTurnStarted(`%${i}`); h.api.markPaneLaunched(`%${i}`); }
  h.tick(90001);
  await h.sample([]);
  assert.equal(h.api.pendingTurnMarks.size, 0);
  assert.equal(h.api.recentlyLaunched.size, 0);
});

test("a queued mark first discovered as a shell still reaches the agent and yields done", async () => {
  const h = harness();
  h.api.markPaneLaunched(PANE.paneId);
  h.api.markPaneTurnStarted(PANE.paneId);
  h.show("$ "); await h.sample([{ ...PANE, agentId: "shell" }]); // first attribution: a shell
  const shellEntry = h.api.paneWatch.get(PANE.paneId);
  assert.equal(shellEntry.turnRequested, true);
  assert.ok(shellEntry.pendingTurnAt > 0);
  h.tick(2000); h.show(WORKING); await h.sample(); // now attributed to codex, working
  h.tick(5000); h.show(IDLE); await h.sample();
  assert.equal(h.status(), "done");
});

test("an attribution glitch before working keeps the fast-sampling window", async () => {
  const h = harness();
  await h.sample();
  h.api.markPaneTurnStarted(PANE.paneId);
  const before = h.api.paneWatch.get(PANE.paneId).pendingTurnAt;
  h.tick(500); await h.sample([{ ...PANE, agentId: "shell" }]);
  assert.equal(h.api.paneWatch.get(PANE.paneId).pendingTurnAt, before);
  h.tick(500); h.show(IDLE); await h.sample();
  assert.equal(h.api.paneWatch.get(PANE.paneId).pendingTurnAt, before);
  assert.equal(h.api.paneWatch.get(PANE.paneId).turnRequested, true);
});

test("a different known agent taking over the pane does not inherit the old prompt exemption", async () => {
  const h = harness();
  h.api.markPaneLaunched(PANE.paneId);
  await h.sample();
  h.api.markPaneTurnStarted(PANE.paneId); // codex was asked something
  h.tick(1000); h.show("$ "); await h.sample([{ ...PANE, agentId: "shell" }]);
  const agy = { ...PANE, agentId: "antigravity", agentName: "Antigravity" };
  h.tick(1000); h.show("─── esc to cancel"); await h.sample([agy]); // antigravity boot footer = working
  h.tick(3000); h.show("ready"); await h.sample([agy]);
  const st = h.api.paneWatch.get(PANE.paneId);
  assert.equal(st.agentId, "antigravity");
  assert.equal(st.turnRequested, false);
  assert.equal(st.doneAt, 0);
  assert.deepEqual(h.notifications, []);
});
