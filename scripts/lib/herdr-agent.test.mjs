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

test("env: operandos de -u/--unset y -C/--chdir se consumen; -- termina opciones; -S no se parsea", () => {
  assert.equal(refineAgent("shell", [], ["env", "-u", "NODE_OPTIONS", "junie"], M), "junie");
  assert.equal(commandOf(["env", "-u", "NODE_OPTIONS", "junie"]), "junie");
  assert.equal(refineAgent("shell", [], ["env", "-u", "junie", "vim"], M), "shell");
  assert.equal(refineAgent("shell", [], ["env", "--unset", "junie", "vim"], M), "shell");
  assert.equal(refineAgent("shell", [], ["env", "-C", "/w", "junie"], M), "junie");
  assert.equal(refineAgent("shell", [], ["env", "--chdir", "junie", "vim"], M), "shell");
  assert.equal(refineAgent("shell", [], ["env", "--unset=X", "--chdir=/w", "-i", "-0", "-v", "-z", "junie"], M), "junie");
  assert.equal(refineAgent("shell", [], ["env", "--", "junie"], M), "junie");
  assert.equal(commandOf(["env", "-S", "junie --brave"]), null);
  assert.equal(commandOf(["env", "-iS", "junie"]), null);
  assert.equal(commandOf(["env", "--split-string=junie"]), null);
  assert.equal(commandOf(["env", "--split-string", "junie"]), null);
});

test("shell -c: solo se pela una envoltura de paso puro; otro texto → sin comando", () => {
  assert.equal(refineAgent("shell", [], ["bash", "-c", 'printf "%s\\n" "$1"', "bash", "junie"], M), "shell");
  assert.equal(commandOf(["bash", "-c", 'printf "%s\\n" "$1"', "bash", "junie"]), null);
  assert.equal(commandOf(["bash", "-c", 'exec "$@"', "bash", "/x/junie"]), "/x/junie");
  assert.equal(commandOf(["fish", "-c", "command $argv[2..]", "fish", "/x/junie"]), "/x/junie");
  assert.equal(commandOf(["bash", "-c", '  "$@"; exec "$0" -li', "bash", "/x/junie"]), "/x/junie");
  assert.equal(commandOf(["bash", "-c", 'echo "$@"', "bash", "/x/junie"]), null);
});

test("arranque: solo con primer plano vacío o un intérprete sin nombre de agente; vim, ssh, shells y env zsh -li → shell", () => {
  assert.equal(refineAgent("shell", JUNIE_START, ["vim", "README.md"], M), "shell");
  assert.equal(refineAgent("shell", JUNIE_START, ["env", "zsh", "-li"], M), "shell");
  assert.equal(refineAgent("shell", JUNIE_START, ["ssh", "host"], M), "shell");
  assert.equal(refineAgent("shell", JUNIE_START, ["git", "status"], M), "shell");
  assert.equal(refineAgent("shell", JUNIE_START, [], M), "junie");
  assert.equal(refineAgent("shell", wrapper("/usr/bin/env", "/Users/x/.local/bin/hermes"), HERMES_FG, M), "hermes");
  assert.equal(refineAgent("shell", JUNIE_START, ["node", "/Users/x/app/server.js"], M), "shell"); // el comando es el script, no el intérprete
  assert.equal(refineAgent("shell", JUNIE_START, ["node", "-e", "setInterval(()=>{},1)"], M), "junie"); // intérprete sin nombre (script en línea)
});

test("env con opciones agrupadas que acaban en -u/-C: el operando no es el comando", () => {
  assert.equal(refineAgent("shell", [], ["env", "-iu", "junie", "vim"], M), "shell");
  assert.equal(refineAgent("shell", [], ["env", "-iu", "NODE_OPTIONS", "junie"], M), "junie");
  assert.equal(refineAgent("shell", [], ["env", "-iC", "/tmp/junie", "vim"], M), "shell");
  assert.equal(refineAgent("shell", [], ["env", "-i", "junie"], M), "junie");
});

test("shell -c: solo se pela si el guion ENTERO es la envoltura; texto extra tras \"$@\" no se interpreta", () => {
  for (const script of ['"$@"suffix', '"$@" && rm -rf x', 'exec "$@" extra', '"$@"; exec "$0" -li; echo', "command $argv[2..] x"]) {
    assert.equal(refineAgent("shell", [], ["bash", "-c", script, "bash", "junie"], M), "shell", script);
  }
  for (const script of ['"$@"', 'exec "$@"', '"$@"; exec "$0" -li', ' "$@" ;  exec "$0" -l -i ', "command $argv[2..]", "command $argv[2..]; exec $argv[1] -li"]) {
    assert.equal(refineAgent("shell", [], ["bash", "-c", script, "bash", "junie"], M), "junie", script);
  }
});
