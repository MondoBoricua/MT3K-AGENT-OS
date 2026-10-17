import test from "node:test";
import assert from "node:assert/strict";
import { keyArgs } from "../lib/keys.mjs";

test("SendNow expands to the ordered Claude send-now chord", () => {
  assert.deepEqual(keyArgs("SendNow"), ["C-x", "C-s"]);
});

test("existing allowed keys remain single arguments", () => {
  for (const key of ["Up", "Down", "Left", "Right", "Enter", "Escape", "Tab", "Space", "BSpace", "PageUp", "PageDown", "Home", "End"]) {
    assert.deepEqual(keyArgs(key), [key]);
  }
});

test("rejects arbitrary keys and non-string input", () => {
  for (const key of ["C-s", "C-x", "C-x C-s", "sendnow", "SendNow ", "", "-l", "__proto__", "constructor", null, undefined, 1, ["SendNow"], {}]) {
    assert.equal(keyArgs(key), null);
  }
});
