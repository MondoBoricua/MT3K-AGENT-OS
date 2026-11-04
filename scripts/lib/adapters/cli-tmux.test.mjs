import test from "node:test";
import assert from "node:assert/strict";
import {
  validatePaneId,
  dirSlugFromBasename,
  mt3kSessionName,
  parseLaunchConfig,
  composeTmuxArgv,
  envPairsToTmuxFlags,
  resolveTmuxBin,
  hasTmuxBinary,
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

test("composeTmuxArgv win32: sin /usr/bin/env, un solo word directo", () => {
  const exe = "C:\\Users\\mondo\\.local\\bin\\claude.exe";
  assert.deepEqual(composeTmuxArgv({ bin: exe, platform: "win32" }), [exe]);
  assert.deepEqual(composeTmuxArgv({ bin: exe, args: ["--yolo"], platform: "win32" }), [exe, "--yolo"]);
  const cmd = "C:\\Users\\mondo\\.local\\bin\\codex.cmd";
  assert.deepEqual(composeTmuxArgv({ bin: cmd, platform: "win32" }), [cmd]);
});

test("composeTmuxArgv win32: envPairs no entran al argv (van como -e)", () => {
  const exe = "C:\\bin\\agy.exe";
  assert.deepEqual(composeTmuxArgv({ bin: exe, envPairs: ["FOO=bar"], args: ["-x"], platform: "win32" }), [exe, "-x"]);
});

test("composeTmuxArgv win32: .ps1 se envuelve en powershell -File", () => {
  const ps1 = "C:\\Users\\mondo\\AppData\\Local\\cursor-agent\\cursor-agent.ps1";
  const head = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1];
  assert.deepEqual(composeTmuxArgv({ bin: ps1, platform: "win32" }), head);
  assert.deepEqual(composeTmuxArgv({ bin: ps1, args: ["--resume"], platform: "win32" }), [...head, "--resume"]);
  assert.deepEqual(composeTmuxArgv({ bin: ps1.toUpperCase(), platform: "win32" }).slice(0, 5), head.slice(0, 5));
});

test("composeTmuxArgv POSIX no cambia con platform explícito", () => {
  assert.deepEqual(composeTmuxArgv({ bin: "/bin/claude", platform: "darwin" }), ["/usr/bin/env", "/bin/claude"]);
  assert.deepEqual(composeTmuxArgv({ bin: "/bin/x.ps1", envPairs: ["A=1"], platform: "linux" }), ["/usr/bin/env", "A=1", "/bin/x.ps1"]);
});

test("envPairsToTmuxFlags: K=V -> -e K=V", () => {
  assert.deepEqual(envPairsToTmuxFlags(["A=1", "B=x y"]), ["-e", "A=1", "-e", "B=x y"]);
  assert.deepEqual(envPairsToTmuxFlags([]), []);
  assert.deepEqual(envPairsToTmuxFlags(), []);
});

test("validatePaneId win32 acepta sesion:ventana.pane y %N", () => {
  for (const id of ["mt3k-claude-mondo-zvv:0.0", "ai-zai-zai-6d4ada17b7-yolo:0.0", "%1", "s:12.3"]) {
    assert.deepEqual(validatePaneId(id, "win32"), { ok: true, paneId: id }, id);
  }
});

test("validatePaneId win32 rechaza targets peligrosos", () => {
  for (const id of ["mt3k x:0.0", "a:b", "../x:0.0", "`x:0.0`", "a".repeat(200) + ":0.0", "x:0.0;ls", ":0.0", "a:b:0.0"]) {
    assert.equal(validatePaneId(id, "win32").ok, false, id);
  }
});

test("validatePaneId POSIX sigue rechazando sesion:ventana.pane", () => {
  assert.equal(validatePaneId("mt3k-claude-mondo-zvv:0.0", "darwin").ok, false);
  assert.equal(validatePaneId("mt3k-claude-mondo-zvv:0.0", "linux").ok, false);
  assert.equal(validatePaneId("%1", "linux").ok, true);
});

test("resolveTmuxBin: POSIX siempre 'tmux' por PATH aunque absBin encuentre otra ruta", () => {
  const absBin = (n) => `/opt/homebrew/bin/${n}`;
  assert.equal(resolveTmuxBin({ platform: "darwin", absBin }), "tmux");
  assert.equal(resolveTmuxBin({ platform: "linux", absBin }), "tmux");
});

test("resolveTmuxBin win32: ruta absoluta, psmux de respaldo, 'tmux' si nada", () => {
  assert.equal(resolveTmuxBin({ platform: "win32", absBin: (n) => `C:\\bin\\${n}.exe` }), "C:\\bin\\tmux.exe");
  assert.equal(resolveTmuxBin({ platform: "win32", absBin: (n) => (n === "psmux" ? "C:\\bin\\psmux.exe" : null) }), "C:\\bin\\psmux.exe");
  assert.equal(resolveTmuxBin({ platform: "win32", absBin: () => null }), "tmux");
});

test("hasTmuxBinary: psmux solo cuenta en win32", () => {
  const onlyPsmux = (n) => (n === "psmux" ? "/x/psmux" : null);
  assert.equal(hasTmuxBinary({ platform: "linux", absBin: onlyPsmux }), false);
  assert.equal(hasTmuxBinary({ platform: "win32", absBin: onlyPsmux }), true);
  assert.equal(hasTmuxBinary({ platform: "darwin", absBin: (n) => (n === "tmux" ? "/x/tmux" : null) }), true);
});

test("validatePaneId win32: la clave debe empezar por [A-Za-z0-9_]", () => {
  for (const id of ["-tfoo:0.0", "@foo:0.0", ".foo:0.0"]) assert.equal(validatePaneId(id, "win32").ok, false, id);
  assert.equal(validatePaneId("mt3k-claude-mondo-fyf:0.0", "win32").ok, true);
  assert.equal(validatePaneId("_x:1.2", "win32").ok, true);
});

test("validatePaneId: maximo 120 chars tambien para %N (win32 y POSIX)", () => {
  const long = "%" + "1".repeat(200);
  for (const platform of ["win32", "linux"]) {
    assert.equal(validatePaneId(long, platform).ok, false);
    assert.equal(validatePaneId("%1", platform).ok, true);
  }
});
