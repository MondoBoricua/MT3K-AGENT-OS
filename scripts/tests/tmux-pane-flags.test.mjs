import assert from "node:assert/strict";
import test from "node:test";
import { parseAlternateMouseSgr, TMUX_ALT_MOUSE_DISPLAY } from "../lib/tmux-pane-flags.mjs";

test("parseAlternateMouseSgr lee alternate y mouse_sgr", () => {
  assert.deepEqual(parseAlternateMouseSgr("1 1"), { alternate: true, mouse_sgr: true });
  assert.deepEqual(parseAlternateMouseSgr("0 0"), { alternate: false, mouse_sgr: false });
  assert.deepEqual(parseAlternateMouseSgr("1 0"), { alternate: true, mouse_sgr: false });
});

test("TMUX_ALT_MOUSE_DISPLAY pide ambos flags en un display", () => {
  assert.match(TMUX_ALT_MOUSE_DISPLAY, /alternate_on/);
  assert.match(TMUX_ALT_MOUSE_DISPLAY, /mouse_sgr_flag/);
});
