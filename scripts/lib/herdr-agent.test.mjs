import test from "node:test";
import assert from "node:assert/strict";
import { commandOf, refineAgent } from "./herdr-agent.mjs";

const M = [
  { id: "claude", proc: ["claude"] },
  { id: "codex", proc: ["codex"] },
  { id: "opencode", proc: ["opencode"] },
  { id: "grok", proc: ["grok"] },
  { id: "hermes", proc: ["hermes"] },
  { id: "junie", proc: ["junie"] },
];
const INLINE = "import sys\nprint('hermes junie claude')";
const wrapper = (...tail) => ["/bin/zsh", "-lic", '"$@"; exec "$0" -li', "/bin/zsh", ...tail];
const JUNIE_START = wrapper("/usr/bin/env", "COLORTERM=truecolor", "/Users/x/.local/bin/junie", "--brave");
const HERMES_FG = ["/Users/x/.hermes/tools/python-3.14/bin/python3", "-I", "-c", INLINE];

test("junie lanzado por el panel: arranque con envoltura zsh -lic + env, primer plano con el shim bash", () => {
  assert.equal(refineAgent("shell", JUNIE_START, ["bash", "/Users/x/.local/bin/junie", "--brave"], M), "junie");
  assert.equal(refineAgent("shell", JUNIE_START, [], M), "junie"); // sin primer plano: se usa el arranque
});

test("junie: binario real en el primer plano (basename junie)", () => {
  const fg = ["/Users/x/.local/share/junie/versions/1/Applications/junie.app/Contents/MacOS/junie", "--brave"];
  assert.equal(refineAgent("shell", ["/bin/zsh"], fg, M), "junie");
});

test("hermes: python3 -I -c <script> en primer plano + arranque con hermes → hermes; arranque /bin/bash → shell", () => {
  assert.equal(refineAgent("shell", wrapper("/usr/bin/env", "COLORTERM=truecolor", "/Users/x/.local/bin/hermes"), HERMES_FG, M), "hermes");
  assert.equal(refineAgent("shell", ["/bin/bash"], HERMES_FG, M), "shell");
});

test("estilo hc run: env PATH=… env MT3K_X=1 …/codex, primer plano vacío → codex", () => {
  const start = ["/usr/bin/env", "PATH=/a:/b", "COLORTERM=truecolor", "/usr/bin/env", "MT3K_X=1", "/Users/x/.nvm/versions/node/v22/bin/codex", "--flag"];
  assert.equal(refineAgent("shell", start, [], M), "codex");
});

test("falsos positivos de argumentos y carpetas → shell", () => {
  for (const fg of [
    ["vim", "junie"],
    ["ssh", "host", "claude"],
    ["git", "clone", "https://example.test/x/opencode"],
    ["bash", "/Users/x/projects/junie/run.sh"],
    ["/opt/grok-tools/bin/x"],
    ["node", "/Users/x/code/junie/server.js"],
    ["bash", "-c", "junie --brave"], // el texto del script no se interpreta
    ["/usr/bin/env", "FOO=bar", "zsh"],
  ]) assert.equal(refineAgent("shell", [], fg, M), "shell", JSON.stringify(fg));
});

test("un shell inactivo en el primer plano (zsh -li tras salir el agente) no hereda el agente del arranque", () => {
  assert.equal(refineAgent("shell", JUNIE_START, ["zsh", "-li"], M), "shell");
  assert.equal(refineAgent("shell", JUNIE_START, ["-zsh"], M), "shell");
  assert.equal(refineAgent("shell", JUNIE_START, ["/bin/bash"], M), "shell");
});

test("prefijo nombre-… solo sobre el nombre base", () => {
  assert.equal(refineAgent("shell", [], ["codex-aarch64-apple-darwin"], M), "codex");
  assert.equal(refineAgent("shell", [], ["/opt/claude-code/bin/x"], M), "shell"); // antes coincidía por carpeta
  assert.equal(refineAgent("shell", [], ["/opt/junieX/bin/notjunie"], M), "shell");
});

test("ruta con espacios, 512+ caracteres, opciones y KEY=valor nunca son comando", () => {
  assert.equal(refineAgent("shell", [], ["/Applications/IntelliJ IDEA.app/Contents/plugins/junie/bin/worker"], M), "shell");
  assert.equal(refineAgent("shell", [], [`/${"a".repeat(510)}/junie`], M), "shell");
  assert.equal(refineAgent("shell", [], ["--junie"], M), "shell");
  assert.equal(refineAgent("shell", [], ["junie=1"], M), "shell");
});

test("nunca degrada un agente real de hc ls; claude-code se conserva", () => {
  assert.equal(refineAgent("claude", JUNIE_START, ["junie"], M), "claude");
  assert.equal(refineAgent("deepseek", [], [], []), "deepseek");
});

test("commandOf: envolturas acotadas (6 pelados), entradas raras → null, sin mutar", () => {
  assert.equal(commandOf(["env", "env", "env", "env", "env", "env", "env", "env", "x/junie"]), null);
  assert.equal(commandOf(["env", "env", "env", "x/junie"]), "x/junie");
  assert.equal(commandOf(null), null);
  assert.equal(commandOf([42, "junie"]), null);
  assert.equal(commandOf(["bash", "-lc", "x"]), null);
  assert.equal(commandOf(["python3.12", "/a/b.py"]), "/a/b.py");
  const a = ["/usr/bin/env", "A=1", "/x/junie"];
  const copy = [...a];
  commandOf(a);
  assert.deepEqual(a, copy);
  assert.equal(refineAgent("shell", null, undefined, M), "shell");
  assert.equal(refineAgent("shell", ["/x/junie"], [], undefined), "shell");
});
