import assert from "node:assert/strict";
import test from "node:test";
import { childPath, destinationDir } from "../src/lib/file-manager.ts";

test("an expanded folder can become the destination instead of the tree root", () => {
  assert.equal(destinationDir("/workspace", "/workspace/src"), "/workspace/src");
  assert.equal(destinationDir("/workspace", ""), "/workspace");
});

test("new files are joined to the selected destination without breaking root", () => {
  assert.equal(childPath("/workspace/src", "new.ts"), "/workspace/src/new.ts");
  assert.equal(childPath("/", "new.ts"), "/new.ts");
});
