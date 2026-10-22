import test from "node:test";
import assert from "node:assert/strict";
import { buildRunningSet } from "./running-set.mjs";

const rows = (arr) => arr.map(([pid, ppid, comm]) => ({ pid, ppid, comm }));

test("indexes every path segment of regular processes", () => {
  const running = buildRunningSet(rows([
    [1, 0, "/sbin/launchd"],
    [100, 1, "/Users/x/.local/bin/zcode"],
    [101, 100, "zcode-cli"],
  ]));
  for (const seg of ["launchd", "Users", "x", ".local", "bin", "zcode", "zcode-cli"]) assert.ok(running.has(seg), seg);
});

test("GUI-app executables stay out of running (unchanged behavior)", () => {
  const running = buildRunningSet(rows([
    [1, 0, "/sbin/launchd"],
    [200, 1, "/Applications/Codex.app/Contents/MacOS/Codex"],
  ]));
  assert.ok(!running.has("Codex"));
  assert.ok(!running.has("Codex.app"));
  assert.deepEqual([...running].sort(), ["launchd", "sbin"]); // nothing of the bundle leaked
});

test("descendants of .app/ processes are excluded even when re-titled", () => {
  const running = buildRunningSet(rows([
    [1, 0, "/sbin/launchd"],
    [210, 1, "/Applications/Antigravity.app/Contents/MacOS/Antigravity"],
    [211, 210, "antigravity-worker"],
  ]));
  assert.ok(!running.has("antigravity-worker"));
});

test("workers of a re-titled Electron main are excluded (ZCode desktop case)", () => {
  // measured tree: ZCode main re-titles itself (no .app/ in comm), its Helper children keep
  // the bundle path, and the CLI-named workers live under a re-titled host process
  const running = buildRunningSet(rows([
    [1, 0, "/sbin/launchd"],
    [300, 1, "ZCode"],
    [301, 300, "/Applications/ZCode.app/Contents/Frameworks/ZCode Helper.app/Contents/MacOS/ZCode Helper"],
    [302, 300, "zcode-host-local-1"],
    [303, 302, "zcode-cli"],
    [304, 303, "zcode-node-repl-mcp"],
  ]));
  assert.ok(!running.has("zcode-cli"));
  assert.ok(!running.has("zcode-node-repl-mcp"));
  assert.ok(!running.has("zcode-host-local-1"));
  assert.ok(!running.has("ZCode"));
});

test("launchd never becomes a bundle launcher via its .app/ children", () => {
  const running = buildRunningSet(rows([
    [1, 0, "/sbin/launchd"],
    [400, 1, "/Applications/X.app/Contents/Frameworks/X Helper.app/Helpers/crashpad"],
    [401, 1, "claude"],
  ]));
  assert.ok(!running.has("crashpad"));
  assert.ok(running.has("claude"));
  assert.ok(running.has("launchd"));
});

test("a real CLI session under tmux/shell keeps counting", () => {
  const running = buildRunningSet(rows([
    [1, 0, "/sbin/launchd"],
    [500, 1, "tmux"],
    [501, 500, "/bin/zsh"],
    [502, 501, "/Users/x/.local/bin/zcode"],
    [503, 502, "zcode-cli"],
  ]));
  assert.ok(running.has("zcode-cli"));
  assert.ok(running.has("tmux"));
});

test("spawning a .app/-resident helper binary does not mark the spawner (MCP case)", () => {
  // measured: claude launches Pencil's MCP server, whose comm carries "/Applications/Pencil.app/…"
  const running = buildRunningSet(rows([
    [1, 0, "/sbin/launchd"],
    [500, 1, "tmux"],
    [501, 500, "/bin/zsh"],
    [502, 501, "/Users/x/.local/bin/claude"],
    [503, 502, "/Applications/Pencil.app/Contents/Resources/app.asar.unpacked/out/mcp-server-darwin-arm64"],
    [504, 502, "zcode-cli"],
  ]));
  assert.ok(running.has("claude"));
  assert.ok(running.has("zcode-cli")); // the CLI below claude keeps counting
  assert.ok(!running.has("mcp-server-darwin-arm64")); // the .app/ binary itself stays out
});

test("a re-titled main must match its child's bundle name, not merely own one", () => {
  const running = buildRunningSet(rows([
    [1, 0, "/sbin/launchd"],
    [510, 1, "/bin/zsh"],
    [511, 510, "/Applications/Foo.app/Contents/MacOS/Foo"],
    [512, 510, "grok"],
  ]));
  assert.ok(!running.has("Foo"));
  assert.ok(running.has("grok")); // zsh spawned a bundle binary, not became its main
});

test("ppid cycles and orphan parents resolve without hanging", () => {
  const running = buildRunningSet(rows([
    [1, 0, "/sbin/launchd"],
    [600, 601, "loop-a"],
    [601, 600, "loop-b"],
    [602, 99999, "orphan-worker"],
  ]));
  assert.ok(running.has("loop-a"));
  assert.ok(running.has("orphan-worker"));
});
