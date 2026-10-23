import test from "node:test";
import assert from "node:assert/strict";
import {
  validatePaneId,
  dirSlugFromBasename,
  mt3kSessionName,
  parseLaunchConfig,
  composeTmuxArgv,
} from "./cli-tmux.mjs";

test("validatePaneId acepta %N y rechaza basura", () => {
  assert.deepEqual(validatePaneId("%0"), { ok: true, paneId: "%0" });
  assert.deepEqual(validatePaneId("%12"), { ok: true, paneId: "%12" });
  assert.equal(validatePaneId("pane-1").ok, false);
  assert.equal(validatePaneId(42).ok, false);
  assert.equal(validatePaneId("%0").err, undefined);
  assert.equal(validatePaneId("x").err, "paneId inválido");
});

test("dirSlugFromBasename normaliza como /api/launch", () => {
  assert.equal(dirSlugFromBasename("OnVacation!!"), "onvacation");
  assert.equal(dirSlugFromBasename(""), "home");
});

test("mt3kSessionName fija el sufijo con nowMs", () => {
  const nowMs = 1_234_567_890_000;
  assert.equal(mt3kSessionName("claude", "proj", nowMs), `mt3k-claude-proj-${nowMs.toString(36).slice(-3)}`);
});

test("parseLaunchConfig filtra env/args/resumeArgs", () => {
  const parsed = parseLaunchConfig({
    env: { OK: "1", bad: 2, "9bad": "x" },
    args: ["--a", 1],
    resumeArgs: ["--resume", null],
  });
  assert.deepEqual(parsed.envPairs, ["OK=1"]);
  assert.deepEqual(parsed.args, ["--a"]);
  assert.deepEqual(parsed.resumeArgs, ["--resume"]);
});

test("composeTmuxArgv fuerza /usr/bin/env con un solo binario", () => {
  assert.deepEqual(composeTmuxArgv({ bin: "/bin/claude" }), ["/usr/bin/env", "/bin/claude"]);
  assert.deepEqual(composeTmuxArgv({ bin: "/bin/claude", envPairs: [], args: [] }), ["/usr/bin/env", "/bin/claude"]);
  assert.deepEqual(
    composeTmuxArgv({ bin: "/bin/claude", envPairs: ["FOO=bar"], args: ["--yolo"] }),
    ["/usr/bin/env", "FOO=bar", "/bin/claude", "--yolo"],
  );
});
