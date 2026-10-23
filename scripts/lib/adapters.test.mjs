import test from "node:test";
import assert from "node:assert/strict";
import {
  inferAdapter,
  capabilitiesFor,
  normalizeAgentDefs,
  describeAgent,
  ADAPTER_PROTOCOL_VERSION,
} from "./adapters.mjs";

const claude = { id: "claude", name: "Claude Code", bins: ["claude"], paths: ["~/.claude"], proc: ["claude"] };
const deepseek = { id: "deepseek", name: "DeepSeek", bins: ["dsh"], paths: ["~/.dsh"], proc: [], web: 3080 };
const shell = { id: "shell", name: "Terminal", bins: [], paths: [], proc: [] };

test("inferAdapter: claude → cli-tmux", () => {
  assert.equal(inferAdapter(claude), "cli-tmux");
});

test("inferAdapter: deepseek → web-local", () => {
  assert.equal(inferAdapter(deepseek), "web-local");
});

test("inferAdapter: shell → terminal", () => {
  assert.equal(inferAdapter(shell), "terminal");
});

test("inferAdapter: def con url → web-external", () => {
  assert.equal(inferAdapter({ ...claude, url: "https://muse.ai" }), "web-external");
});

test("inferAdapter: adapter explícito gana", () => {
  assert.equal(inferAdapter({ ...claude, adapter: "web-external" }), "web-external");
});

test("capabilitiesFor cli-tmux con tmux: operaciones tmux true, resume true para claude", () => {
  const c = capabilitiesFor(claude, { hasTmux: true, platform: "darwin" });
  assert.equal(c.launch.supported, true);
  assert.equal(c.resume.supported, true);
  assert.equal(c.discover.supported, true);
});

test("capabilitiesFor cli-tmux sin tmux: launch/view/send/keys/resume/kill false", () => {
  const c = capabilitiesFor(claude, { hasTmux: false, platform: "win32" });
  for (const k of ["launch", "view", "send", "keys", "resume", "kill"]) {
    assert.equal(c[k].supported, false);
    assert.equal(c[k].reason, "no tmux");
  }
  assert.equal(c.discover.supported, true);
  assert.equal(c.status.supported, true);
});

test("capabilitiesFor web-local: send/keys/resume no soportados", () => {
  const c = capabilitiesFor(deepseek, { hasTmux: true, platform: "darwin" });
  assert.equal(c.launch.supported, true);
  assert.equal(c.kill.supported, true);
  assert.equal(c.send.supported, false);
  assert.equal(c.resume.supported, false);
});

test("capabilitiesFor terminal: resume false", () => {
  const c = capabilitiesFor(shell, { hasTmux: true, platform: "darwin" });
  assert.equal(c.resume.supported, false);
  assert.equal(c.launch.supported, true);
});

test("normalizeAgentDefs no muta el original", () => {
  const orig = [{ id: "x", bins: ["a"], proc: ["a"] }];
  const frozen = JSON.parse(JSON.stringify(orig));
  const out = normalizeAgentDefs(orig);
  assert.deepEqual(orig, frozen);
  assert.notEqual(out, orig);
  assert.equal(out[0].adapter, "cli-tmux");
  assert.equal(orig[0].adapter, undefined);
});

test("describeAgent forma del DTO", () => {
  const d = describeAgent(claude, { hasTmux: true, platform: "linux" });
  assert.equal(d.adapter, "cli-tmux");
  assert.equal(d.adapterVersion, ADAPTER_PROTOCOL_VERSION);
  assert.equal(typeof d.capabilities, "object");
  assert.equal(d.capabilities.send.supported, true);
});
