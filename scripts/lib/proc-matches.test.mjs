import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { paneBelongsTo, procMatches, strongProcNames } from "./proc-matches.mjs";

const MAC_HERMES = "/Users/x/.hermes/tools/python-3.14.9+20261021-darwin-arm64/bin/python3";
const hermesProc = () => {
  const src = readFileSync(fileURLToPath(new URL("../server.mjs", import.meta.url)), "utf8");
  const line = src.split("\n").find((l) => /^\s*\{ id: "hermes"/.test(l));
  return JSON.parse(line.match(/proc: (\[[^\]]*\])/)[1]);
};
const isHermes = (comm) => hermesProc().some((name) => procMatches(comm, name));

test("regla base: segmento exacto o con prefijo `nombre-`, en cualquier parte de la ruta", () => {
  assert.equal(procMatches("hermes", "hermes"), true);
  assert.equal(procMatches("/usr/local/bin/codex", "codex"), true);
  assert.equal(procMatches("/x/codex-aarch64-apple-darwin", "codex"), true);
  assert.equal(procMatches("/Users/x/.local/share/cursor-agent/versions/1.2/node", "cursor-agent"), true);
  assert.equal(procMatches("/Users/x/.local/share/junie/versions/1/Applications/junie.app/Contents/MacOS/junie", "junie"), true);
  assert.equal(procMatches("/opt/hermesx/bin/tool", "hermes"), false);
  assert.equal(procMatches("/Users/x/projects/my-hermes-notes/run", "hermes"), false);
  assert.equal(procMatches("", "hermes"), false);
  assert.equal(procMatches(undefined, "hermes"), false);
});

test("una carpeta con punto NO cuenta para los demás agentes (la regla no cambió para ellos)", () => {
  for (const [comm, proc] of [
    ["/Users/x/.claude/local/node_modules/.bin/tool", "claude"],
    ["/Users/x/.codex/skills/bin/helper", "codex"],
    ["/Users/x/.cursor/extensions/x/bin/rg", "cursor-agent"],
    ["/Users/x/.junie/tools/rg", "junie"],
    ["/Users/x/.opencode/bin/bun", "opencode"],
    ["/Users/x/.zcode/runtime/node", "zcode"],
    [MAC_HERMES, "hermes"],
  ]) assert.equal(procMatches(comm, proc), false, `${proc} ← ${comm}`);
});

test("Hermes: su lista proc cubre el comm de macOS (bajo ~/.hermes) y el de Linux", () => {
  assert.deepEqual(hermesProc(), ["hermes", ".hermes"]);
  assert.equal(isHermes(MAC_HERMES), true);
  assert.equal(isHermes("hermes"), true);
  assert.equal(isHermes("/usr/local/lib/hermes-agent/bin/python3"), true); // instalación de Linux: prefijo `hermes-`
});

test("Hermes: nada con «hermes» dentro de otra palabra, ni carpetas parecidas a ~/.hermes", () => {
  for (const comm of ["/opt/hermesx/bin/tool", "/Users/x/projects/my-hermes-notes/run", "/Users/x/.hermesrc.d/bin/x", "/Users/x/notes.hermes/run", "/usr/bin/python3", "bash"]) {
    assert.equal(isHermes(comm), false, comm);
  }
});

const HERMES = { id: "hermes", proc: ["hermes", ".hermes"] };
const CODEX = { id: "codex", proc: ["codex"] };
const CLAUDE = { id: "claude", proc: ["claude"] };
const DEFS = [CLAUDE, CODEX, HERMES, { id: "shell", proc: [] }];

test("paneBelongsTo: Hermes solo en un pane (macOS y Linux) es de Hermes y de nadie más", () => {
  for (const comms of [["zsh", MAC_HERMES], ["bash", "hermes"]]) {
    assert.equal(paneBelongsTo(comms, HERMES, DEFS), true);
    assert.equal(paneBelongsTo(comms, CODEX, DEFS), false);
    assert.equal(paneBelongsTo(comms, CLAUDE, DEFS), false);
  }
});

test("paneBelongsTo: otro agente que lanza algo que vive bajo ~/.hermes sigue siendo solo de ese agente", () => {
  const comms = ["zsh", "codex", "/Users/x/.hermes/tools/bin/python3"];
  assert.equal(paneBelongsTo(comms, CODEX, DEFS), true);
  assert.equal(paneBelongsTo(comms, HERMES, DEFS), false);
  assert.equal(paneBelongsTo(["zsh", "/tmp/.hermes-backup/bin/tool", "claude"], HERMES, DEFS), false);
});

test("paneBelongsTo: un nombre fuerte de Hermes gana aunque haya otro agente en el pane (regla de siempre)", () => {
  const comms = ["zsh", "codex", "hermes"];
  assert.equal(paneBelongsTo(comms, HERMES, DEFS), true);
  assert.equal(paneBelongsTo(comms, CODEX, DEFS), true);
});

test("paneBelongsTo: agentes sin nombres débiles se comportan como la regla original; entradas raras no rompen", () => {
  assert.equal(paneBelongsTo(["zsh", "/x/codex-aarch64-apple-darwin"], CODEX, DEFS), true);
  assert.equal(paneBelongsTo(["zsh", "/Users/x/.codex/skills/bin/helper"], CODEX, DEFS), false);
  assert.equal(paneBelongsTo(["zsh"], { id: "shell", proc: [] }, DEFS), false);
  assert.equal(paneBelongsTo(undefined, HERMES, DEFS), false);
  assert.equal(paneBelongsTo(["hermes"], { id: "x" }, DEFS), false);
  assert.equal(paneBelongsTo([MAC_HERMES], HERMES), true); // sin lista de agentes: no hay con quién comparar
});

test("strongProcNames: quita los nombres de carpeta (los matchers de Herdr comparan nombres de ejecutable)", () => {
  assert.deepEqual(strongProcNames(["hermes", ".hermes"]), ["hermes"]);
  assert.deepEqual(strongProcNames(["codex"]), ["codex"]);
  assert.deepEqual(strongProcNames(undefined), []);
});
