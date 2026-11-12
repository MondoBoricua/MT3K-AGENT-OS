import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAgentRunning } from "./agent-live.mjs";
import { buildRunningSet } from "./running-set.mjs";

const HERMES = { id: "hermes", proc: ["hermes"], paneOnly: true };
const OPENCODE = { id: "opencode", proc: ["opencode"] };
const rows = (arr) => arr.map(([pid, ppid, comm]) => ({ pid, ppid, comm }));
const pane = { paneId: "%3", label: "mt3k-hermes-1:0.0" };

// Forma real medida en Linux (`ps -axo pid=,ppid=,comm=`): gateway PPID 1 e interactivo, ambos comm `hermes`
const LINUX_ROWS = rows([
  [1, 0, "systemd"],
  [2432371, 1, "hermes"], // gateway run: sin tty, siempre vivo
  [2498817, 1, "bash"],
  [2498962, 2498817, "hermes"], // interactivo
]);
// Forma macOS: comm con ruta completa
const MAC_ROWS = rows([
  [1, 0, "/sbin/launchd"],
  [500, 1, "/Users/x/.hermes/tools/python-3.14/bin/python3"],
  [501, 1, "/Users/x/.local/bin/hermes"],
]);

test("paneOnly: el gateway (comm hermes, PPID 1) sin panel NO cuenta como running", () => {
  const running = buildRunningSet(LINUX_ROWS);
  assert.ok(running.has("hermes"), "premisa: el set de procesos sí lo ve");
  assert.equal(isAgentRunning(HERMES, { installed: true, running, agentPanes: [] }), false);
});

test("paneOnly: un Hermes interactivo en un panel de tmux sí cuenta", () => {
  const running = buildRunningSet(LINUX_ROWS);
  assert.equal(isAgentRunning(HERMES, { installed: true, running, agentPanes: [pane] }), true);
});

test("paneOnly: comm con ruta completa de macOS sin panel tampoco cuenta", () => {
  const running = buildRunningSet(MAC_ROWS);
  assert.equal(isAgentRunning(HERMES, { installed: true, running, agentPanes: [] }), false);
});

test("no instalado nunca es running, ni con panel", () => {
  const running = buildRunningSet(LINUX_ROWS);
  assert.equal(isAgentRunning(HERMES, { installed: false, running, agentPanes: [pane] }), false);
});

test("agentes sin paneOnly conservan la regla por proceso", () => {
  const running = buildRunningSet(rows([[1, 0, "/sbin/launchd"], [9, 1, "/opt/homebrew/bin/opencode"]]));
  assert.equal(isAgentRunning(OPENCODE, { installed: true, running, agentPanes: [] }), true);
  assert.equal(isAgentRunning(OPENCODE, { installed: true, running: new Set(["bash"]), agentPanes: [] }), false);
});

test("no muta sus entradas", () => {
  const running = buildRunningSet(LINUX_ROWS);
  const snapshot = [...running];
  const panes = [pane];
  isAgentRunning(HERMES, { installed: true, running, agentPanes: panes });
  assert.deepEqual([...running], snapshot);
  assert.deepEqual(panes, [pane]);
});

test("server.mjs declara hermes en AGENT_DEFS con paneOnly y proc exacto", () => {
  const src = readFileSync(fileURLToPath(new URL("../server.mjs", import.meta.url)), "utf8");
  const line = src.split("\n").find((l) => /^\s*\{ id: "hermes"/.test(l));
  assert.ok(line, "falta la entrada hermes");
  assert.match(line, /bins: \["hermes"\]/);
  assert.match(line, /paths: \["~\/\.hermes"\]/);
  assert.match(line, /proc: \["hermes"\]/);
  assert.match(line, /paneOnly: true/);
});

test("el logo existe en public/logos", () => {
  const svg = readFileSync(fileURLToPath(new URL("../../panel/public/logos/hermes.svg", import.meta.url)), "utf8");
  assert.match(svg, /^<svg /);
});
