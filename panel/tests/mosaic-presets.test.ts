import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRow, PaneRef } from "../src/lib/api.ts";
import {
  MOSAIC_SLOTS,
  removePreset,
  resolveSlots,
  slotsFrom,
  upsertPreset,
  type MosaicPreset,
  type Session,
} from "../src/lib/mosaic-presets.ts";

function makeSession(id: string, paneId: string, cwd: string, host?: string, name?: string): Session {
  const pane: PaneRef = { paneId, label: `s:${paneId}`, window: "w", cwd, ...(name ? { name } : {}) };
  const agent: AgentRow = { id, name: id, online: true, running: true, host, panes: [pane] };
  return { agent, pane };
}

test("resolveSlots matches by name only within the same agentKey and before unnamed cwd fallback", () => {
  const s1 = makeSession("claude", "%1", "~/repo-a", undefined, "ejecutor");
  const s2 = makeSession("claude", "%2", "~/repo-a", undefined, "revisor");
  const s3 = makeSession("codex", "%3", "~/repo-b", undefined, "revisor");
  const slots = [
    { agentKey: "local:claude", cwd: "~/repo-a" },
    { agentKey: "local:claude", cwd: "~/repo-a", name: "ejecutor" },
    { agentKey: "local:claude", cwd: "~/other-dir", name: "revisor" },
    { agentKey: "local:claude", cwd: "~/other-dir", name: "solo-en-codex" },
  ];
  // Rename s3 to "solo-en-codex" to verify cross-agent name match does NOT happen
  s3.pane.name = "solo-en-codex";

  const resolved = resolveSlots(slots, [s1, s2, s3]);
  // Named slots (index 1 -> s1 "ejecutor", index 2 -> s2 "revisor") resolve first;
  // index 0 (unnamed local:claude in ~/repo-a) does not steal s1 before index 1 gets it.
  assert.equal(resolved[0], null);
  assert.equal(resolved[1], s1);
  assert.equal(resolved[2], s2);
  // Index 3 asks for local:claude named "solo-en-codex", which only exists on local:codex -> null
  assert.equal(resolved[3], null);

  const saved = slotsFrom(resolved);
  assert.equal(saved[0], null);
  assert.deepEqual(saved[1], { agentKey: "local:claude", cwd: "~/repo-a", name: "ejecutor" });
  assert.deepEqual(saved[2], { agentKey: "local:claude", cwd: "~/repo-a", name: "revisor" });
});

test("resolveSlots resolves matching sessions without reusing the same pane twice", () => {
  const s1 = makeSession("claude", "%1", "~/repo-a");
  const s2 = makeSession("claude", "%2", "~/repo-a");
  const s3 = makeSession("codex", "%3", "~/repo-b", "mondo");
  const slots = [
    { agentKey: "local:claude", cwd: "~/repo-a" },
    { agentKey: "local:claude", cwd: "~/repo-a" },
    { agentKey: "local:claude", cwd: "~/repo-a" },
    { agentKey: "mondo:codex", cwd: "~/repo-b" },
  ];
  const resolved = resolveSlots(slots, [s1, s2, s3]);
  assert.equal(resolved.length, MOSAIC_SLOTS);
  assert.equal(resolved[0], s1);
  assert.equal(resolved[1], s2);
  assert.equal(resolved[2], null);
  assert.equal(resolved[3], s3);
});

test("slotsFrom converts sessions into 4 MosaicSlot entries", () => {
  const s1 = makeSession("claude", "%1", "~/repo-a");
  const s2 = makeSession("codex", "%2", "~/repo-b", "speedzz");
  const slots = slotsFrom([s1, null, s2, null]);
  assert.deepEqual(slots, [
    { agentKey: "local:claude", cwd: "~/repo-a" },
    null,
    { agentKey: "speedzz:codex", cwd: "~/repo-b" },
    null,
  ]);
});

test("upsertPreset trims names, updates existing case-sensitively, is immutable, and caps at 12", () => {
  const initial: MosaicPreset[] = [];
  const p1 = upsertPreset(initial, {
    name: "  equipo A  ",
    slots: [{ agentKey: "local:claude", cwd: "~" }, null, null, null],
  });
  assert.equal(initial.length, 0);
  assert.equal(p1.length, 1);
  assert.equal(p1[0].name, "equipo A");
  assert.equal(p1[0].slots.length, 4);

  // update in place with same trimmed name
  const p2 = upsertPreset(p1, {
    name: "equipo A",
    slots: [null, { agentKey: "local:codex", cwd: "~/x" }, null, null],
  });
  assert.equal(p2.length, 1);
  assert.deepEqual(p2[0].slots[1], { agentKey: "local:codex", cwd: "~/x" });

  // case-sensitive: "Equipo A" is distinct
  const p3 = upsertPreset(p2, { name: "Equipo A", slots: [null, null, null, null] });
  assert.equal(p3.length, 2);

  // max 12 presets
  let many = p3;
  for (let i = 0; i < 15; i++) {
    many = upsertPreset(many, { name: `p-${i}`, slots: [null, null, null, null] });
  }
  assert.equal(many.length, 12);
  assert.equal(many[many.length - 1].name, "p-14");
});

test("removePreset removes matching trimmed name immutably", () => {
  const list: MosaicPreset[] = [
    { name: "uno", slots: [null, null, null, null] },
    { name: "dos", slots: [null, null, null, null] },
  ];
  const next = removePreset(list, " uno ");
  assert.equal(list.length, 2);
  assert.deepEqual(next.map((p) => p.name), ["dos"]);
});
