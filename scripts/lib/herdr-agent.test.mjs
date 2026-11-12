import test from "node:test";
import assert from "node:assert/strict";
import { refineAgent } from "./herdr-agent.mjs";

const M = [
  { id: "claude", proc: ["claude"] },
  { id: "hermes", proc: ["hermes"] },
  { id: "junie", proc: ["junie"] },
];
const INLINE = "import sys\nprint('hermes junie claude')";

test("refineAgent: Junie lanzado por el panel (argv de arranque con la ruta del shim)", () => {
  const start = ["/bin/zsh", "-lic", '"$@"; exec "$0" -li', "/bin/zsh", "/usr/bin/env", "COLORTERM=truecolor", "/Users/x/.local/bin/junie", "--brave"];
  assert.equal(refineAgent("shell", start, [], M), "junie");
});

test("refineAgent: Junie por el primer plano (shim bash) gana sobre el arranque", () => {
  assert.equal(refineAgent("shell", ["/bin/zsh"], ["bash", "/Users/x/.local/bin/junie", "--brave"], M), "junie");
  assert.equal(refineAgent("shell", ["/Users/x/bin/claude"], ["bash", "/Users/x/.local/bin/junie"], M), "junie"); // primer plano antes que arranque
});

test("refineAgent: Hermes lanzado por el panel (arranque con .../bin/hermes)", () => {
  assert.equal(refineAgent("shell", ["/Users/x/.local/bin/hermes", "chat"], ["/usr/bin/python3", "-I", "-c", INLINE], M), "hermes");
});

test("refineAgent: Hermes escrito dentro de bash sin nada usable → sigue siendo shell, el script en línea no se examina", () => {
  assert.equal(refineAgent("shell", ["/bin/bash"], ["/usr/bin/python3", "-I", "-c", INLINE], M), "shell");
});

test("refineAgent: opciones y CLAVE=valor se ignoran", () => {
  assert.equal(refineAgent("shell", ["/bin/zsh", "--junie", "-hermes", "AGENT=junie", "X=/a/hermes"], [], M), "shell");
});

test("refineAgent: items con espacios o de 512+ caracteres se saltan (ruta con espacios incluida, a propósito)", () => {
  assert.equal(refineAgent("shell", ["/Applications/IntelliJ IDEA.app/Contents/plugins/junie/bin/worker"], [], M), "shell");
  assert.equal(refineAgent("shell", [`/${"a".repeat(511)}/junie`], [], M), "shell");
  assert.equal(refineAgent("shell", ["/Users/x/plugins/junie/bin/worker"], [], M), "junie"); // misma ruta sin espacios sí coincide por segmento
});

test("refineAgent: nunca degrada un agente real; claude-code se conserva", () => {
  assert.equal(refineAgent("claude", ["/Users/x/.local/bin/junie"], ["junie"], M), "claude");
  assert.equal(refineAgent("deepseek", [], [], []), "deepseek");
});

test("refineAgent: regla de segmento como tmux (igual o prefijo nombre-) y sin falsos positivos", () => {
  assert.equal(refineAgent("shell", ["/opt/claude-code/bin/x"], [], M), "claude");
  assert.equal(refineAgent("shell", ["/opt/junieX/bin/x", "/opt/notjunie"], [], M), "shell");
});

test("refineAgent: entradas raras → shell; no muta los argv", () => {
  assert.equal(refineAgent("shell", null, undefined, M), "shell");
  assert.equal(refineAgent("shell", [42, null, ""], [{}], M), "shell");
  assert.equal(refineAgent("shell", ["/x/junie"], [], undefined), "shell");
  const a = ["/x/junie"];
  const copy = [...a];
  refineAgent("shell", a, [], M);
  assert.deepEqual(a, copy);
});
