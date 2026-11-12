import test from "node:test";
import assert from "node:assert/strict";
import { LAUNCH_BACKENDS, parseLaunchBackend } from "./launch-backend.mjs";

test("parseLaunchBackend: valores válidos", () => {
  assert.deepEqual(LAUNCH_BACKENDS, ["tmux", "herdr"]);
  assert.equal(parseLaunchBackend('{"backend":"herdr"}'), "herdr");
  assert.equal(parseLaunchBackend('{"backend":"tmux"}'), "tmux");
});

test("parseLaunchBackend: ausente, corrupto o fuera de la lista → tmux", () => {
  for (const raw of [undefined, null, "", "{", "nope", "null", "[]", '{"backend":"screen"}', '{"backend":"HERDR"}', '{"backend":1}', '{"backend":null}', "{}", '{"backend":["herdr"]}']) {
    assert.equal(parseLaunchBackend(raw), "tmux", String(raw));
  }
});
