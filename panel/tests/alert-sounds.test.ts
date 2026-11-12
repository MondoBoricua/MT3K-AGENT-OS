import assert from "node:assert/strict";
import test from "node:test";
import {
  ALERT_COOLDOWN_MS, DEFAULT_SOUND_SETTINGS, SOUND_SETTINGS_KEY, diffAlerts, loadSoundSettings, resetSoundSettingsMemory, saveSoundSettings, summarizeAlerts,
  type StatusMap,
} from "../src/lib/alert-sounds.ts";

const A = "local:claude|%1";
const B = "local:codex|%2";
const T0 = 1_000_000;

const first = (m: StatusMap) => diffAlerts(null, m, T0).state;

test("first snapshot never alerts", () => {
  const r = diffAlerts(null, { [A]: "blocked", [B]: "done" }, T0);
  assert.deepEqual(r.events, []);
});

test("a pane that appears later does not alert", () => {
  const s = first({ [A]: "working" });
  const r = diffAlerts(s, { [A]: "working", [B]: "blocked" }, T0 + 1000);
  assert.deepEqual(r.events, []);
});

test("any -> blocked alerts once", () => {
  for (const before of ["working", "idle", "done", "unknown"] as const) {
    const s = first({ [A]: before });
    const r = diffAlerts(s, { [A]: "blocked" }, T0 + 1000);
    assert.deepEqual(r.events, [{ key: A, kind: "blocked" }], before);
    const again = diffAlerts(r.state, { [A]: "blocked" }, T0 + 2000);
    assert.deepEqual(again.events, [], "staying blocked is silent");
  }
});

test("working -> done and working -> idle alert done", () => {
  for (const after of ["done", "idle"] as const) {
    const r = diffAlerts(first({ [A]: "working" }), { [A]: after }, T0 + 1000);
    assert.deepEqual(r.events, [{ key: A, kind: "done" }], after);
  }
});

test("unknown -> done and idle -> done do not alert", () => {
  for (const before of ["unknown", "idle"] as const) {
    const r = diffAlerts(first({ [A]: before }), { [A]: "done" }, T0 + 1000);
    assert.deepEqual(r.events, [], before);
  }
});

test("cooldown suppresses a repeat within 30 s and allows it after", () => {
  let s = first({ [A]: "working" });
  let r = diffAlerts(s, { [A]: "done" }, T0 + 1000);
  assert.equal(r.events.length, 1);
  r = diffAlerts(r.state, { [A]: "working" }, T0 + 2000);
  r = diffAlerts(r.state, { [A]: "done" }, T0 + 3000);
  assert.deepEqual(r.events, [], "within cooldown");
  r = diffAlerts(r.state, { [A]: "working" }, T0 + 4000);
  r = diffAlerts(r.state, { [A]: "done" }, T0 + 1000 + ALERT_COOLDOWN_MS);
  assert.equal(r.events.length, 1, "after cooldown");
  s = r.state;
  assert.ok(s);
});

test("cooldown is per kind: blocked right after done still alerts", () => {
  let r = diffAlerts(first({ [A]: "working" }), { [A]: "done" }, T0 + 1000);
  r = diffAlerts(r.state, { [A]: "blocked" }, T0 + 2000);
  assert.deepEqual(r.events, [{ key: A, kind: "blocked" }]);
});

test("a disappeared pane is forgotten and re-appearing does not alert", () => {
  let r = diffAlerts(first({ [A]: "working", [B]: "working" }), { [B]: "working" }, T0 + 1000);
  assert.deepEqual(Object.keys(r.state.statuses), [B]);
  assert.ok(!Object.keys(r.state.lastAlert).some((k) => k.startsWith(A)));
  r = diffAlerts(r.state, { [A]: "blocked", [B]: "working" }, T0 + 2000);
  assert.deepEqual(r.events, []);
});

test("focusedKey suppresses done but not blocked", () => {
  const s = first({ [A]: "working", [B]: "working" });
  const done = diffAlerts(s, { [A]: "done", [B]: "done" }, T0 + 1000, { focusedKey: A });
  assert.deepEqual(done.events, [{ key: B, kind: "done" }]);
  const blocked = diffAlerts(s, { [A]: "blocked" }, T0 + 1000, { focusedKey: A });
  assert.deepEqual(blocked.events, [{ key: A, kind: "blocked" }]);
});

test("inputs are not mutated", () => {
  const prev = first({ [A]: "working" });
  const next: StatusMap = { [A]: "done" };
  const snapPrev = JSON.stringify(prev);
  const snapNext = JSON.stringify(next);
  const r = diffAlerts(prev, next, T0 + 1000);
  assert.equal(JSON.stringify(prev), snapPrev);
  assert.equal(JSON.stringify(next), snapNext);
  assert.notEqual(r.state.statuses, next);
});

function fakeStorage(initial?: string) {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set(SOUND_SETTINGS_KEY, initial);
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
}

test("settings: defaults for missing, corrupt or wrong-shaped values", () => {
  assert.deepEqual(loadSoundSettings(fakeStorage()), DEFAULT_SOUND_SETTINGS);
  assert.deepEqual(loadSoundSettings(fakeStorage("{not json")), DEFAULT_SOUND_SETTINGS);
  assert.deepEqual(loadSoundSettings(fakeStorage("null")), DEFAULT_SOUND_SETTINGS);
  assert.deepEqual(loadSoundSettings(fakeStorage("42")), DEFAULT_SOUND_SETTINGS);
  assert.deepEqual(loadSoundSettings(fakeStorage('{"enabled":"yes","volume":"loud","blocked":1,"done":null}')), DEFAULT_SOUND_SETTINGS);
  assert.deepEqual(loadSoundSettings(null), DEFAULT_SOUND_SETTINGS);
  const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  assert.deepEqual(loadSoundSettings(throwing), DEFAULT_SOUND_SETTINGS);
  assert.doesNotThrow(() => saveSoundSettings(DEFAULT_SOUND_SETTINGS, throwing));
  resetSoundSettingsMemory(); // el guardado fallido deja copia en memoria: no filtrarla a otros tests
});

test("settings: volume is clamped and values round-trip", () => {
  assert.equal(loadSoundSettings(fakeStorage('{"volume":7}')).volume, 1);
  assert.equal(loadSoundSettings(fakeStorage('{"volume":-3}')).volume, 0);
  const st = fakeStorage();
  saveSoundSettings({ enabled: true, volume: 2, blocked: false, done: true }, st);
  assert.deepEqual(loadSoundSettings(st), { enabled: true, volume: 1, blocked: false, done: true });
});

test("flapping blocked -> working -> blocked inside the cooldown alerts once; after it, alerts again", () => {
  let r = diffAlerts(first({ [A]: "working" }), { [A]: "blocked" }, T0 + 1000);
  assert.equal(r.events.length, 1);
  r = diffAlerts(r.state, { [A]: "working" }, T0 + 2000);
  r = diffAlerts(r.state, { [A]: "blocked" }, T0 + 3000);
  assert.deepEqual(r.events, []);
  r = diffAlerts(r.state, { [A]: "working" }, T0 + 4000);
  r = diffAlerts(r.state, { [A]: "blocked" }, T0 + 1000 + ALERT_COOLDOWN_MS);
  assert.deepEqual(r.events, [{ key: A, kind: "blocked" }]);
});

test("settings: a storage whose setItem throws keeps the last value in memory", () => {
  resetSoundSettingsMemory();
  const broken = { getItem: () => null, setItem: () => { throw new Error("private mode"); } };
  saveSoundSettings({ enabled: true, volume: 0.3, blocked: false, done: true }, broken);
  assert.deepEqual(loadSoundSettings(broken), { enabled: true, volume: 0.3, blocked: false, done: true });
  assert.deepEqual(loadSoundSettings(null), { enabled: true, volume: 0.3, blocked: false, done: true });
  const ok = fakeStorage();
  saveSoundSettings({ enabled: false, volume: 0.5, blocked: true, done: true }, ok);
  assert.equal(loadSoundSettings(ok).volume, 0.5, "a successful save clears the in-memory copy");
  resetSoundSettingsMemory();
});

const describe = (k: string) => ({ who: k.startsWith("local:claude") ? "Claude" : "Codex", where: "proj" });
const both = { blocked: true, done: true };
const ev = (key: string, kind: "blocked" | "done") => ({ key, kind });

test("summarizeAlerts: none, one, many, mixed, kind disabled", () => {
  assert.deepEqual(summarizeAlerts([], both, describe), { cues: [], toasts: [] });
  assert.deepEqual(summarizeAlerts([ev(A, "blocked")], both, describe), {
    cues: ["blocked"], toasts: [{ kind: "blocked", text: "Claude necesita input · proj" }],
  });
  assert.deepEqual(summarizeAlerts([ev(B, "done")], both, describe).toasts, [{ kind: "done", text: "Codex terminó · proj" }]);
  const many = summarizeAlerts([ev(A, "blocked"), ev(B, "blocked"), ev("x|%3", "blocked")], both, describe);
  assert.deepEqual(many.cues, ["blocked"]);
  assert.deepEqual(many.toasts, [{ kind: "blocked", text: "3 agentes necesitan input" }]);
  const doneMany = summarizeAlerts([ev(A, "done"), ev(B, "done")], both, describe);
  assert.equal(doneMany.toasts[0].text, "2 agentes terminaron");
  const mixed = summarizeAlerts([ev(B, "done"), ev(A, "blocked"), ev("x|%3", "done")], both, describe);
  assert.deepEqual(mixed.cues, ["blocked", "done"]);
  assert.deepEqual(mixed.toasts.map((t) => t.text), ["Claude necesita input · proj", "2 agentes terminaron"]);
  const off = summarizeAlerts([ev(A, "blocked"), ev(B, "done")], { blocked: false, done: true }, describe);
  assert.deepEqual(off.cues, ["done"]);
  assert.equal(off.toasts.length, 1);
});
