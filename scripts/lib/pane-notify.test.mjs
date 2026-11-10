import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { demotedRules, approvalRules, decidePaneNotification, createPaneNotifier } from "./pane-notify.mjs";

const event = { state: "blocked", agentId: "codex", statusSource: "manifest", ruleId: "osc_title_blocked", session: "trial", paneId: "%42" };
test("allowlist agrees with the actual TOML manifests and compiled runtime rules", () => {
  const dir = new URL("../agent-detection/manifests/", import.meta.url);
  const compiled = JSON.parse(readFileSync(new URL("../agent-detection/manifests.json", import.meta.url))).manifests;
  const expected = {};
  for (const name of readdirSync(dir).filter((name) => name.endsWith(".toml"))) {
    const [header, ...blocks] = readFileSync(new URL(name, dir), "utf8").split("[[rules]]");
    const agent = /^id = "([^"]+)"/m.exec(header)[1];
    const rules = blocks.filter((block) => /^state = "blocked"/m.test(block)).map((block) => ({
      id: /^id = "([^"]+)"/m.exec(block)[1],
      actionRequired: /^contains = \["Action Required"\]/m.test(block),
    })).filter(({ id, actionRequired }) => /permission|approval|blocker|trust|action_required|elicitation/i.test(id) || actionRequired).map(({ id }) => id).filter((id) => !(demotedRules[agent] || []).includes(id));
    if (rules.length) expected[agent] = rules;
    for (const id of rules) assert.ok(compiled[agent].rules.some((r) => r.id === id && r.state === "blocked"));
  }
  assert.deepEqual(approvalRules, expected);
});
test("explicit allowlist only, scoped by agent", () => {
  for (const [agentId, rules] of Object.entries(approvalRules)) {
    for (const ruleId of rules) assert.equal(decidePaneNotification({ ...event, agentId, ruleId }, { MT3K_NOTIFY_SKIP_AGENTS: "" }).kind, "needs_approval");
  }
  for (const ruleId of ["question_prompt", "startup_update", "invented_approval", "stillness_45s"]) {
    assert.equal(decidePaneNotification({ ...event, ruleId }, {}).kind, "needs_input");
  }
  assert.equal(decidePaneNotification({ ...event, agentId: "unknown" }, {}).kind, "needs_input");
});
test("heuristic never emits approval even with an approval rule id", () => {
  assert.equal(decidePaneNotification({ ...event, statusSource: "heuristic" }, {}).kind, "needs_input");
});
test("skip defaults and configurable replacement, including mapped names", () => {
  for (const agentId of ["claude", "grok"]) assert.equal(decidePaneNotification({ ...event, agentId }, {}), null);
  assert.ok(decidePaneNotification({ ...event, agentId: "claude" }, { MT3K_NOTIFY_SKIP_AGENTS: "" }));
  assert.equal(decidePaneNotification({ ...event, agentId: "antigravity" }, { MT3K_NOTIFY_SKIP_AGENTS: " agy, cursor " }), null);
  assert.equal(decidePaneNotification(event, { MT3K_NOTIFY_SKIP_AGENTS: "codex" }), null);
});
test("done opt-in and feature switch", () => {
  assert.equal(decidePaneNotification({ ...event, state: "done" }, {}), null);
  assert.equal(decidePaneNotification({ ...event, state: "done" }, { MT3K_NOTIFY_DONE: "1" }).kind, "done");
  assert.equal(decidePaneNotification(event, { MT3K_BRIDGE_NOTIFY: "0" }), null);
  for (const state of ["working", "idle"]) assert.equal(decidePaneNotification({ ...event, state }, {}), null);
});
test("bridge agent names and reason validation", () => {
  for (const [agentId, agent] of [["antigravity", "agy"], ["github-copilot", "copilot"], ["deepseek", "dsh"]]) {
    assert.equal(decidePaneNotification({ ...event, agentId }, {}).agent, agent);
  }
  assert.equal(decidePaneNotification({ ...event, ruleId: "private pane text\n" }, {}), null);
});
test("stub called once, exact arguments, no pane content; nonzero exit is harmless", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pane-notify-"));
  const output = join(dir, "calls.jsonl");
  const bin = join(dir, "bridge-notify");
  writeFileSync(bin, `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2))+'\\n');\nprocess.exit(1);\n`, { mode: 0o755 });
  try {
    const notify = createPaneNotifier({ binDirs: [dir], env: {} });
    assert.doesNotThrow(() => notify({ ...event, screen: "SECRET_PANE_CONTENT", matched: "SECRET_PANE_CONTENT" }));
    for (let i = 0; i < 100; i++) {
      try { if (readFileSync(output, "utf8")) break; } catch {}
      await delay(20);
    }
    await delay(100);
    assert.deepEqual(readFileSync(output, "utf8").trim().split("\n").map(JSON.parse), [["needs_approval", "--agent", "codex", "--session", "trial", "--pane", "%42", "--reason", "osc_title_blocked", "--source", "panel"]]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("missing binary, synchronous spawn failure and asynchronous error never throw", async () => {
  const missing = createPaneNotifier({ binDirs: ["/nonexistent/pane-notify"], env: {} });
  assert.doesNotThrow(() => missing(event));
  const notify = createPaneNotifier({ binDirs: ["/bin"], binaryName: "sh", env: {}, spawn: () => { throw Error("failure"); } });
  assert.doesNotThrow(() => notify(event));
  const realSpawn = (await import("node:child_process")).spawn;
  const vanished = createPaneNotifier({ binDirs: ["/bin"], binaryName: "sh", env: {}, spawn: (_binary, args, opts) => realSpawn("/nonexistent/pane-notify", args, opts) });
  assert.doesNotThrow(() => vanished(event));
  await delay(100);
});
test("cached misses refresh no sooner than five minutes; spawn is detached and unrefed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pane-notify-cache-"));
  let time = 0;
  const calls = [];
  let unrefs = 0;
  const spawn = (...args) => {
    calls.push(args);
    return { on: (event, handler) => { assert.equal(event, "error"); assert.equal(typeof handler, "function"); }, unref: () => unrefs++ };
  };
  try {
    const notify = createPaneNotifier({ binDirs: [dir], env: {}, now: () => time, spawn });
    notify(event);
    await delay(30);
    writeFileSync(join(dir, "bridge-notify"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    time = 299999;
    notify(event);
    await delay(30);
    assert.equal(calls.length, 0);
    time = 300000;
    notify(event);
    for (let i = 0; i < 100 && !calls.length; i++) await delay(10);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0][2], { detached: true, stdio: "ignore", windowsHide: true });
    assert.equal(unrefs, 1);
    const disabled = createPaneNotifier({ binDirs: [dir], env: { MT3K_BRIDGE_NOTIFY: "0" }, spawn });
    disabled(event);
    await delay(30);
    assert.equal(calls.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("ambiguous blocker rules are silent needs_input, not approvals", () => {
  for (const [agentId, rules] of Object.entries(demotedRules)) {
    for (const ruleId of rules) {
      const decision = decidePaneNotification({ state: "blocked", agentId, statusSource: "manifest", ruleId, session: "s", paneId: "%1" }, { MT3K_NOTIFY_SKIP_AGENTS: "" });
      assert.equal(decision.kind, "needs_input");
    }
  }
});
