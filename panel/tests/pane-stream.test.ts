import assert from "node:assert/strict";
import test from "node:test";
import { applyPaneEvent } from "../src/lib/pane-stream.ts";

test("full captures replace old content and preserve blank and trailing lines", () => {
  assert.deepEqual(applyPaneEvent(["old"], "first\n\nlast\n"), ["first", "", "last", ""]);
  assert.deepEqual(applyPaneEvent(["old"], ""), [""]);
});

test("diffs replace a suffix without mutating the previous frame", () => {
  const previous = Object.freeze(["keep", "old", "tail"]);
  assert.deepEqual(applyPaneEvent(previous, { from: 1, lines: ["new", "tail"] }), ["keep", "new", "tail"]);
  assert.deepEqual(previous, ["keep", "old", "tail"]);
});

test("diffs grow, shrink, clear, or replace the entire capture", () => {
  assert.deepEqual(applyPaneEvent(["keep"], { from: 1, lines: ["more", ""] }), ["keep", "more", ""]);
  assert.deepEqual(applyPaneEvent(["keep", "old", "tail"], { from: 1, lines: [] }), ["keep"]);
  assert.deepEqual(applyPaneEvent(["old"], { from: 0, lines: [] }), []);
  assert.deepEqual(applyPaneEvent(["old"], { from: 0, lines: ["new"] }), ["new"]);
});

test("successive held diffs accumulate before display and polling can replace them", () => {
  let latest = applyPaneEvent([], "first\nold");
  latest = applyPaneEvent(latest, { from: 1, lines: ["updated"] });
  latest = applyPaneEvent(latest, { from: 2, lines: ["appended"] });
  assert.deepEqual(latest, ["first", "updated", "appended"]);
  assert.deepEqual(applyPaneEvent(latest, "poll\n"), ["poll", ""]);
});
