import assert from "node:assert/strict";
import test from "node:test";
import { filterEvents, groupByDay, kindCounts, kindOf, mergeRecent, NOISY_KINDS, OTHER_KIND, parseLogs } from "../src/lib/activity.ts";

const LOGS = [
  { date: "2026-11-14", content: "# log\n- 21:59:41 — send · hc:t20 · \"verifica los logs\"\n- 22:02:54 — key · hc:t20 · SendNow\nnot an event\n" },
  { date: "2026-11-15", content: "- 08:28:59 — key · hc:t20 · Tab\n- 09:48:29 — uploads-sweep · 2 screenshots borrados (>7d)\n- 10:00:00 — launch · codex · /Users/x/repo\n" },
];

test("kindOf reads the first field and falls back to otros", () => {
  assert.equal(kindOf("send · hc:t20 · hola"), "send");
  assert.equal(kindOf("uploads-sweep · 2 screenshots"), "uploads-sweep");
  assert.equal(kindOf("Launch · x"), "launch");
  assert.equal(kindOf("restore"), "restore");
  assert.equal(kindOf("una frase sin separador"), OTHER_KIND);
  assert.equal(kindOf("· vacío"), OTHER_KIND);
  assert.equal(kindOf(""), OTHER_KIND);
});

test("parseLogs returns events newest first whatever order the days arrive in", () => {
  const expected = ["2026-11-15 10:00:00", "2026-11-15 09:48:29", "2026-11-15 08:28:59", "2026-11-14 22:02:54", "2026-11-14 21:59:41"];
  assert.deepEqual(parseLogs(LOGS).map((e) => `${e.date} ${e.time}`), expected);
  assert.deepEqual(parseLogs([...LOGS].reverse()).map((e) => `${e.date} ${e.time}`), expected);
  assert.deepEqual(parseLogs(LOGS)[0], { date: "2026-11-15", time: "10:00:00", kind: "launch", text: "launch · codex · /Users/x/repo" });
});

test("parseLogs does not mutate its input and accepts nothing", () => {
  const input = [...LOGS].reverse();
  const before = input.map((l) => l.date);
  parseLogs(input);
  assert.deepEqual(input.map((l) => l.date), before);
  assert.deepEqual(parseLogs([]), []);
});

test("kindCounts orders by frequency, then by name", () => {
  assert.deepEqual(kindCounts(parseLogs(LOGS)), [
    { kind: "key", count: 2 },
    { kind: "launch", count: 1 },
    { kind: "send", count: 1 },
    { kind: "uploads-sweep", count: 1 },
  ]);
});

test("filterEvents hides kinds and searches text or date", () => {
  const events = parseLogs(LOGS);
  assert.equal(filterEvents(events, new Set(), ""), events, "no filter returns the same array");
  assert.deepEqual(filterEvents(events, new Set(NOISY_KINDS), "").map((e) => e.kind), ["launch", "send"]);
  assert.deepEqual(filterEvents(events, new Set(), "  HC:T20 ").map((e) => e.time), ["08:28:59", "22:02:54", "21:59:41"]);
  assert.deepEqual(filterEvents(events, new Set(["key"]), "hc:t20").map((e) => e.kind), ["send"]);
  assert.equal(filterEvents(events, new Set(), "2026-11-14").length, 2);
  assert.deepEqual(filterEvents(events, new Set(), "nada que coincida"), []);
});

test("groupByDay keeps the order and splits on each change of day", () => {
  const groups = groupByDay(parseLogs(LOGS));
  assert.deepEqual(groups.map((g) => [g.date, g.events.length]), [["2026-11-15", 3], ["2026-11-14", 2]]);
  assert.deepEqual(groupByDay([]), []);
});

test("mergeRecent replaces the polled days and keeps the older ones", () => {
  const all = parseLogs(LOGS);
  const today = parseLogs([{ date: "2026-11-15", content: LOGS[1].content + "- 11:00:00 — kill · %3\n" }]);
  const merged = mergeRecent(all, today);
  assert.deepEqual(merged.map((e) => `${e.date} ${e.time}`), ["2026-11-15 11:00:00", "2026-11-15 10:00:00", "2026-11-15 09:48:29", "2026-11-15 08:28:59", "2026-11-14 22:02:54", "2026-11-14 21:59:41"]);
  assert.equal(all.length, 5, "the full list is not mutated");
});

test("mergeRecent adds a new day, tolerates an empty poll and a full answer from an older server", () => {
  const all = parseLogs(LOGS);
  const tomorrow = parseLogs([{ date: "2026-11-16", content: "- 00:00:05 — launch · codex\n" }]);
  assert.deepEqual(mergeRecent(all, tomorrow).map((e) => e.date), ["2026-11-16", "2026-11-15", "2026-11-15", "2026-11-15", "2026-11-14", "2026-11-14"]);
  assert.equal(mergeRecent(all, []), all);
  assert.deepEqual(mergeRecent(all, parseLogs(LOGS)), all);
  assert.deepEqual(mergeRecent([], tomorrow), tomorrow);
});
