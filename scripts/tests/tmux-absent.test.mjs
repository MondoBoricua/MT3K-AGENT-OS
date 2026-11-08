import test from "node:test";
import assert from "node:assert/strict";
import { tmuxServerAbsent } from "../lib/tmux-absent.mjs";

const CASES = [
  // P1 inputs (review-codex.md)
  ["error connecting to /tmp/tmux-x/default (No such file or directory)", true],
  ["error connecting to /tmp/tmux-x/default (Permission denied)", false],
  ["error connecting to /tmp/tmux-x/default (Connection refused)", false],
  ["error connecting to /tmp/tmux-x/default (Resource temporarily unavailable)", false],
  ["error connecting to /tmp/tmux-x/default (Connection timed out)", false],
  ["[timeout]", false],
  ["psmux: no sessions found", false],
  // measured tmux 3.8 shapes
  ["no server running on /tmp/m3kSpQp/stale", true],
  ["error connecting to /tmp/m3kSpQp/plain (Socket operation on non-socket)", false],
  ["error connecting to /tmp/a/very/long/path (File name too long)", false],
  // a timeout after partial stderr is never "absent"
  ["no server running on /tmp/x\n[timeout]", false],
  ["error connecting to /tmp/x (No such file or directory)\n[timeout]", false],
  ["  no server running on /private/tmp/tmux-501/default  ", true],
  ["", false],
  [undefined, false],
  [null, false],
  ["no server running", false],
  ["something else: no server running on /tmp/x", false],
];

for (const [input, expected] of CASES) {
  test(`tmuxServerAbsent(${JSON.stringify(input)}) === ${expected}`, () => {
    assert.equal(tmuxServerAbsent(input), expected);
  });
}
