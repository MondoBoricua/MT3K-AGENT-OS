import test from "node:test";
import assert from "node:assert/strict";
import {
  WIN32_PS_COMMAND,
  normalizeWin32Comm,
  parseWin32ProcessList,
  withoutWindowsApps,
  createWin32ProcessSource,
} from "./proc-tree-win32.mjs";
import { buildRunningSet } from "./running-set.mjs";

const CODEX = "C:\\Users\\mondo\\.codex\\packages\\standalone\\releases\\0.166.0-x86_64-pc-windows-msvc\\bin\\codex.exe";
const CURSOR_NODE = "C:\\Users\\mondo\\AppData\\Local\\cursor-agent\\versions\\2026.10.22-27dcf5f\\node.exe";
const sample = [
  "324 100 cmd.exe",
  `3776 324 ${CODEX}`,
  "3800 3776 node.exe",
  "3801 3776 node_repl.exe",
  "30916 1 C:\\Users\\mondo\\.local\\bin\\claude.exe",
  "500 1 powershell.exe",
  `501 500 ${CURSOR_NODE}`,
  "502 501 node.exe",
  "503 502 cmd.exe",
].join("\r\n");

test("normalizeWin32Comm: slashes and extension of the last segment only", () => {
  assert.equal(normalizeWin32Comm("C:\\Users\\mondo\\.local\\bin\\claude.exe"), "C:/Users/mondo/.local/bin/claude");
  assert.equal(normalizeWin32Comm("C:\\Users\\mondo\\.local\\bin\\codex.cmd"), "C:/Users/mondo/.local/bin/codex");
  assert.equal(normalizeWin32Comm("cursor-agent.ps1"), "cursor-agent");
  assert.equal(normalizeWin32Comm("C:\\x\\opencode.bat"), "C:/x/opencode");
  assert.equal(normalizeWin32Comm("C:\\a.exe\\b\\node.EXE"), "C:/a.exe/b/node");
  assert.equal(normalizeWin32Comm("System"), "System");
});

test("parseWin32ProcessList parses the measured trees (CRLF, spaces in paths)", () => {
  const rows = parseWin32ProcessList(`${sample}\r\n9 4 C:\\Program Files\\Git\\bin\\bash.exe\r\nbasura\r\n`);
  assert.equal(rows.length, 10);
  assert.deepEqual(rows[1], { pid: 3776, ppid: 324, comm: "C:/Users/mondo/.codex/packages/standalone/releases/0.166.0-x86_64-pc-windows-msvc/bin/codex" });
  assert.deepEqual(rows[4], { pid: 30916, ppid: 1, comm: "C:/Users/mondo/.local/bin/claude" });
  assert.equal(rows[9].comm, "C:/Program Files/Git/bin/bash");
  assert.deepEqual(parseWin32ProcessList(""), []);
});

test("running set sees codex, claude and cursor-agent from the Windows trees", () => {
  const running = buildRunningSet(withoutWindowsApps(parseWin32ProcessList(sample)));
  for (const seg of ["codex", "claude", "cursor-agent", "node", "cmd"]) assert.ok(running.has(seg), seg);
});

test("the Codex desktop app under WindowsApps does not count as the CLI running", () => {
  const text = [
    "10 1 C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1.0.0_x64__abc\\app\\ChatGPT.exe",
    "11 10 C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1.0.0_x64__abc\\app\\resources\\codex.exe",
  ].join("\n");
  const rows = parseWin32ProcessList(text);
  assert.ok(buildRunningSet(rows).has("codex"), "unfiltered it would leak");
  const running = buildRunningSet(withoutWindowsApps(rows));
  assert.ok(!running.has("codex"));
  assert.ok(!running.has("ChatGPT"));
});

test("WIN32_PS_COMMAND is the measured PowerShell invocation", () => {
  assert.deepEqual(WIN32_PS_COMMAND.slice(0, 4), ["powershell", "-NoProfile", "-NonInteractive", "-Command"]);
  assert.match(WIN32_PS_COMMAND[4], /Get-CimInstance Win32_Process/);
});

test("createWin32ProcessSource caches for the TTL and shares in-flight queries", async () => {
  let calls = 0;
  let t = 1000;
  const load = createWin32ProcessSource({ exec: async () => { calls++; return "1 0 C:\\a\\x.exe"; }, ttlMs: 3000, now: () => t });
  const [a, b] = await Promise.all([load(), load()]);
  assert.equal(calls, 1);
  assert.deepEqual(a, b);
  t += 2999;
  await load();
  assert.equal(calls, 1);
  t += 2;
  await load();
  assert.equal(calls, 2);
});

test("createWin32ProcessSource keeps the last snapshot when a query returns nothing", async () => {
  let t = 0;
  let out = "1 0 C:\\a\\x.exe";
  const load = createWin32ProcessSource({ exec: async () => out, ttlMs: 10, now: () => t });
  const first = await load();
  out = "";
  t += 100;
  assert.deepEqual(await load(), first);
});

test("fallo repetido: una sola llamada a exec dentro del TTL, conserva el snapshot", async () => {
  let calls = 0, t = 0, out = "1 0 C:\\a\\x.exe";
  const load = createWin32ProcessSource({ exec: async () => { calls++; return out; }, ttlMs: 3000, now: () => t });
  const first = await load();
  out = ""; t += 3001;
  assert.deepEqual(await load(), first);
  assert.equal(calls, 2);
  t += 100;
  assert.deepEqual(await load(), first);
  t += 100;
  await load();
  assert.equal(calls, 2);
  t += 3000;
  await load();
  assert.equal(calls, 3);
});

test("excepcion de exec no se propaga: devuelve las filas previas (o [] la primera vez)", async () => {
  let t = 0, boom = true;
  const load = createWin32ProcessSource({ exec: async () => { if (boom) throw new Error("x"); return "1 0 C:\\a\\x.exe"; }, ttlMs: 10, now: () => t });
  assert.deepEqual(await load(), []);
  boom = false; t += 20;
  const ok = await load();
  assert.equal(ok.length, 1);
  boom = true; t += 20;
  assert.deepEqual(await load(), ok);
});

test("withoutWindowsApps solo filtra Program Files\\WindowsApps", () => {
  const rows = parseWin32ProcessList([
    "1 0 C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1_x64__abc\\app\\ChatGPT.exe",
    "2 0 C:\\PROGRAM FILES\\WINDOWSAPPS\\X\\codex.exe",
    "3 0 C:\\Users\\mondo\\AppData\\Local\\Microsoft\\WindowsApps\\claude.exe",
  ].join("\n"));
  assert.deepEqual(withoutWindowsApps(rows).map((r) => r.pid), [3]);
  assert.equal(withoutWindowsApps(rows)[0].comm, "C:/Users/mondo/AppData/Local/Microsoft/WindowsApps/claude");
});
