import test from "node:test";
import assert from "node:assert/strict";
import { missingHooks } from "../lib/tmux-hooks.mjs";

test("without hooks both sizing hooks are missing", () => {
  assert.deepEqual(missingHooks(""), ["client-attached", "client-session-changed"]);
});

test("recognizes a normalized command at a nonzero index", () => {
  assert.deepEqual(missingHooks("client-attached[2] set-option -w window-size latest\n"), ["client-session-changed"]);
});

test("both hooks accept set and set-option", () => {
  assert.deepEqual(missingHooks("client-attached[0] set -w window-size latest\nclient-session-changed[3] set-option -w window-size latest"), []);
});

test("unrelated hooks and different commands do not count", () => {
  assert.deepEqual(missingHooks("client-attached[0] display-message hello\nclient-session-changed[1] set -w window-size manual\nafter-select-window[0] set -w window-size latest\nclient-attached[1] set -w window-size latest ; display-message hello"), ["client-attached", "client-session-changed"]);
});
