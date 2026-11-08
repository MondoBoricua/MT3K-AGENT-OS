import assert from "node:assert/strict";
import test from "node:test";
import { createLedgerStore } from "../lib/ledger-store.mjs";
import { createKillTombstones } from "../lib/kill-tombstones.mjs";
import { buildSnapshot, dismissSnapshotSessions, removeSnapshotSession } from "../lib/session-snapshot.mjs";

const entry = (sessionName, extra = {}) => ({ sessionName, agentId: "claude", cwd: "/repo", ...extra });
const missing = (sessionName) => entry(sessionName, { missingSince: new Date().toISOString() });
const names = (snap) => (snap?.sessions || []).map((s) => s.sessionName).sort();
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

// in-memory "disk": writeSnapshot is the only way state reaches it
function memStore(initial) {
  const disk = { value: structuredClone(initial), writes: 0 };
  const logs = [];
  const store = createLedgerStore({
    file: "mem",
    readSnapshot: () => structuredClone(disk.value),
    writeSnapshot: (_f, s) => { disk.value = structuredClone(s); disk.writes++; },
    log: (m) => logs.push(m),
  });
  return { store, disk, logs };
}

// the server's dismiss flow: discovery first, then one mutation on the latest ledger
async function dismissFlow(store, discover, dismiss) {
  const liveRows = await discover();
  let dismissed = 0;
  const out = await store.mutate("dismiss", (cur) => {
    const r = dismissSnapshotSessions(cur, { dismiss, liveRows, liveSessionNames: new Set() });
    dismissed = r.dismissed;
    return r.snapshot;
  });
  return { ...out, dismissed };
}

const launchMutation = (sessionName) => (cur) => ({
  ...cur,
  sessions: [...(cur?.sessions || []), entry(sessionName, { launched: true })],
});

test("R4 kill during dismiss: the killed entry stays gone and the dismissed one is removed", async () => {
  const { store, disk } = memStore({ sessions: [missing("dismiss-me"), missing("killed")] });
  const gate = deferred();
  const pending = dismissFlow(store, () => gate.promise, ["dismiss-me"]);
  await store.mutate("kill", (cur) => removeSnapshotSession(cur, "killed"), { killSeq: 1 });
  assert.deepEqual(names(store.get()), ["dismiss-me"]);
  gate.resolve([]);
  const res = await pending;
  assert.equal(res.dismissed, 1);
  assert.deepEqual(names(store.get()), []);
  assert.deepEqual(names(disk.value), []);
});

test("R4 launch during dismiss: the fresh launch survives the dismiss", async () => {
  const { store, disk } = memStore({ sessions: [missing("dismiss-me"), missing("killed")] });
  const gate = deferred();
  const pending = dismissFlow(store, () => gate.promise, ["dismiss-me"]);
  await store.mutate("launch", launchMutation("new-launch"));
  gate.resolve([]);
  await pending;
  assert.deepEqual(names(store.get()), ["killed", "new-launch"]);
  assert.deepEqual(names(disk.value), ["killed", "new-launch"]);
});

test("mutations run one at a time, each against the result of the previous one", async () => {
  const { store } = memStore({ sessions: [] });
  const order = [];
  const results = await Promise.all(
    ["a", "b", "c"].map((n) =>
      store.mutate(n, (cur) => {
        order.push([n, names(cur).join(",")]);
        return { ...cur, sessions: [...cur.sessions, entry(n)] };
      })
    )
  );
  assert.deepEqual(order, [["a", ""], ["b", "a"], ["c", "a,b"]]);
  assert.ok(results.every((r) => r.applied));
  assert.deepEqual(names(store.get()), ["a", "b", "c"]);
});

test("stale writer after kill: a scan that began before the kill is rejected (no-op + log)", async () => {
  const { store, disk, logs } = memStore({ sessions: [entry("same"), entry("other")] });
  const tomb = createKillTombstones({ now: () => 0 });
  const staleRows = [{ id: "claude", panes: [
    { paneId: "%1", label: "same:0.0", cwd: "/repo" },
    { paneId: "%2", label: "same:0.1", cwd: "/repo" },
    { paneId: "%3", label: "other:0.0", cwd: "/repo" },
  ] }];
  const writer = (rows, seq) => store.mutate(
    "writer",
    (cur) => tomb.filter(buildSnapshot(rows, cur, new Date().toISOString(), {}), rows, seq),
    { scanSeq: seq }
  );
  // scan #4 starts; kill happens while it is in flight (counter = 4)
  tomb.mark("same", ["%2"], { killedAtSeq: 4 });
  await store.mutate("kill", (cur) => removeSnapshotSession(cur, "same"), { killSeq: 4 });
  const writesBefore = disk.writes;
  const stale = await writer(staleRows, 4);
  assert.equal(stale.applied, false);
  assert.equal(stale.reason, "stale-scan");
  assert.equal(disk.writes, writesBefore);
  assert.match(logs.join("\n"), /writer rechazado: escaneo #4 anterior al kill #4/);
  assert.deepEqual(names(store.get()), ["other"]);
  // a scan that began after the kill (seq 5) and no longer lists the dead session writes normally
  const fresh = await writer([{ id: "claude", panes: [{ paneId: "%3", label: "other:0.0", cwd: "/repo" }] }], 5);
  assert.equal(fresh.applied, true);
  assert.deepEqual(names(store.get()), ["other"]);
});

test("a throwing mutation does not break the queue nor change the state", async () => {
  const { store } = memStore({ sessions: [entry("a")] });
  const bad = await store.mutate("bad", () => { throw new Error("boom"); });
  assert.equal(bad.reason, "error");
  const ok = await store.mutate("ok", (cur) => ({ ...cur, sessions: [...cur.sessions, entry("b")] }));
  assert.equal(ok.applied, true);
  assert.deepEqual(names(store.get()), ["a", "b"]);
});

test("returning the same object or null is a no-op without a write", async () => {
  const { store, disk } = memStore({ sessions: [entry("a")] });
  const w = disk.writes;
  assert.equal((await store.mutate("same", (cur) => cur)).applied, false);
  assert.equal((await store.mutate("null", () => null)).applied, false);
  assert.equal(disk.writes, w);
});

test("a failed write keeps the previous state, queues a retry intent and projects it for readers", async () => {
  const disk = { value: { sessions: [entry("killed"), entry("other")] }, fail: true, writes: 0 };
  const logs = [];
  const store = createLedgerStore({
    file: "mem",
    readSnapshot: () => structuredClone(disk.value),
    writeSnapshot: (_f, snap) => { if (disk.fail) throw new Error("EACCES injected"); disk.value = structuredClone(snap); disk.writes++; },
    log: (m) => logs.push(m),
  });
  const iso = new Date().toISOString();
  const r = await store.mutate("kill", (cur) => removeSnapshotSession(cur, "killed", iso), { killSeq: 1, retry: true });
  assert.equal(r.applied, false);
  assert.equal(r.reason, "error");
  assert.equal(r.queued, true);
  assert.deepEqual(names(store.get()), ["killed", "other"]); // disk and current state untouched
  assert.deepEqual(names(store.projected()), ["other"]); // but planning never sees the killed one
  assert.equal(store.pendingCount(), 1);
  assert.ok(logs.some((l) => /kill falló.*reintento pendiente/.test(l)));
  disk.fail = false;
  const r2 = await store.mutate("launch", (cur) => ({ ...cur, sessions: [...cur.sessions, entry("new")] }));
  assert.equal(r2.applied, true);
  assert.deepEqual(names(store.get()), ["new", "other"]);
  assert.deepEqual(names(disk.value), ["new", "other"]);
  assert.equal(store.pendingCount(), 0);
});

test("a failed write without retry is reported and not queued", async () => {
  const store = createLedgerStore({ file: "mem", readSnapshot: () => ({ sessions: [entry("a")] }), writeSnapshot: () => { throw new Error("ENOSPC"); } });
  const r = await store.mutate("writer", (cur) => ({ ...cur, savedAt: "x" }));
  assert.equal(r.applied, false);
  assert.equal(r.queued, false);
  assert.equal(store.pendingCount(), 0);
  assert.deepEqual(names(store.projected()), ["a"]);
});
