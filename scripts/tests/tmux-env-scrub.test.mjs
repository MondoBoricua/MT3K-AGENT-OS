import test from "node:test";
import assert from "node:assert/strict";
import {
  parseTmuxGlobalEnv,
  tmuxGlobalKeysToUnset,
  needsGlobalColortermTruecolor,
} from "../lib/adapters/cli-tmux.mjs";

test("parseTmuxGlobalEnv ignora líneas -VAR sin valor", () => {
  const env = parseTmuxGlobalEnv("-CLAUDE_CODE_CHILD_SESSION\nNO_COLOR=1\nCOLORTERM=\nPATH=/bin");
  assert.equal(env.get("NO_COLOR"), "1");
  assert.equal(env.get("COLORTERM"), "");
  assert.equal(env.get("PATH"), "/bin");
  assert.equal(env.has("CLAUDE_CODE_CHILD_SESSION"), false);
});

test("tmuxGlobalKeysToUnset: lista fija + prefijos CODEX_/CURSOR_/ZCODE_", () => {
  const sample = parseTmuxGlobalEnv(
    "NO_COLOR=1\nCODEX_CI=1\nCODEX_SHELL=1\nCURSOR_AGENT=1\nZCODE_FOO=bar\nHOME=/Users/x\nPATH=/bin",
  );
  const keys = tmuxGlobalKeysToUnset(sample);
  assert.ok(keys.includes("NO_COLOR"));
  assert.ok(keys.includes("CODEX_CI"));
  assert.ok(keys.includes("CODEX_SHELL"));
  assert.ok(keys.includes("CURSOR_AGENT"));
  assert.ok(keys.includes("ZCODE_FOO"));
  assert.ok(!keys.includes("HOME"));
  assert.ok(!keys.includes("PATH"));
});

test("needsGlobalColortermTruecolor cuando falta o está vacío", () => {
  assert.equal(needsGlobalColortermTruecolor(parseTmuxGlobalEnv("")), true);
  assert.equal(needsGlobalColortermTruecolor(parseTmuxGlobalEnv("COLORTERM=")), true);
  assert.equal(needsGlobalColortermTruecolor(parseTmuxGlobalEnv("COLORTERM=truecolor")), false);
});

test("parseTmuxGlobalEnv tolerates psmux: Path= capitalization and CRLF", () => {
  const env = parseTmuxGlobalEnv("ALLUSERSPROFILE=C:\\ProgramData\r\nComSpec=C:\\Windows\\system32\\cmd.exe\r\nPath=C:\\Windows;C:\\Tools\r\nCODEX_CI=1\r\n");
  assert.equal(env.get("Path"), "C:\\Windows;C:\\Tools");
  assert.equal(env.get("CODEX_CI"), "1");
});

test("tmuxGlobalKeysToUnset never touches Windows system variables", () => {
  const env = parseTmuxGlobalEnv("ALLUSERSPROFILE=C:\\ProgramData\nAPPDATA=C:\\x\nComSpec=cmd\nPath=C:\\Windows\nUSERNAME=mondo\nCURSOR_AGENT=1");
  const keys = tmuxGlobalKeysToUnset(env);
  for (const k of ["ALLUSERSPROFILE", "APPDATA", "ComSpec", "Path", "USERNAME"]) assert.ok(!keys.includes(k), k);
  assert.ok(keys.includes("CURSOR_AGENT"));
});
