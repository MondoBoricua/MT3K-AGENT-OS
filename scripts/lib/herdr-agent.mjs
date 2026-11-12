// Atribución de agente para terminales de Herdr. `hc ls` etiqueta por el programa que reconoce; para varios agentes
// (Junie, Hermes...) devuelve el shell. Aquí se afina con el argv de `hc get`, sin llamadas extra ni importar server.mjs.
// Solo cuenta la POSICIÓN DE COMANDO (tras envolturas env / shell -c) y solo el nombre base: ni argumentos ni carpetas.

export const ARGV_ITEM_MAX_CHARS = 512; // parseHcGet trunca a 512: un item de 512 es uno recortado, no se examina
const MAX_PEELS = 6;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const WHITESPACE_RE = /\s/;
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const COMMAND_STRING_FLAGS_RE = /^-[A-Za-z]*c[A-Za-z]*$/; // -c, -lc, -lic, -ic
const PYTHON_RE = /^python[0-9.]*$/;

const baseOf = (item) => item.split("/").pop();
const isString = (x) => typeof x === "string";
const isAssignment = (x) => ENV_ASSIGNMENT_RE.test(x);
const isShellName = (item) => isString(item) && SHELLS.has(baseOf(item).replace(/^-/, "")); // "-zsh" = shell de login

/** ¿Puede ser un comando? Sin espacios (un script en línea nunca), sin recortar, no vacío. */
const isCommandLike = (item) => isString(item) && item.length > 0 && item.length < ARGV_ITEM_MAX_CHARS && !WHITESPACE_RE.test(item);

/** ¿El item es una ruta/nombre de script que sigue a un shell o intérprete? (no opción, no KEY=valor) */
const isScriptItem = (item) => isCommandLike(item) && !item.startsWith("-") && !isAssignment(item);

/**
 * Comando real de un argv: pela envolturas (`env`, `shell -c script $0 args…`) hasta MAX_PEELS veces.
 * Un shell/intérprete con un script como primer argumento → ese script. Devuelve el item o null.
 */
export function commandOf(argv) {
  let args = Array.isArray(argv) ? argv : [];
  for (let peel = 0; peel <= MAX_PEELS; peel++) {
    const first = args[0];
    if (!isCommandLike(first)) return null;
    const base = baseOf(first);
    if (base === "env") {
      let i = 1;
      while (i < args.length && isString(args[i]) && (args[i].startsWith("-") || isAssignment(args[i]))) i++;
      args = args.slice(i);
      continue;
    }
    const second = args[1];
    if (SHELLS.has(base) && isString(second) && COMMAND_STRING_FLAGS_RE.test(second)) {
      // [shell, -…c…, script, $0, ...args]: sin args no hay comando (el texto del script no se interpreta)
      args = args.slice(4);
      continue;
    }
    if ((SHELLS.has(base) || base === "node" || PYTHON_RE.test(base)) && isScriptItem(second)) return second;
    return first;
  }
  return null;
}

// Un nombre coincide solo con el nombre base: igual o `nombre-...` (misma regla de prefijo que procMatches en server.mjs).
function matchCommand(command, matchers) {
  if (!isCommandLike(command)) return null;
  const base = baseOf(command);
  for (const { id, proc } of matchers) {
    if (Array.isArray(proc) && proc.some((name) => isString(name) && name && (base === name || base.startsWith(name + "-")))) return id;
  }
  return null;
}

/**
 * Agente final de un terminal. `mapped` es lo que dio `mapAgent` sobre `hc ls`: si ya es un agente real se respeta.
 * Si es "shell": 1) comando del primer plano; 2) solo si el primer plano está vacío o NO es un shell inactivo
 * (p. ej. el `python3 -I -c …` de Hermes), comando del argv de arranque; 3) "shell". Un `zsh -li` inactivo
 * nunca hereda el agente del arranque. `matchers`: lista inyectada `{ id, proc: [nombres] }`.
 */
export function refineAgent(mapped, startArgv, foregroundArgv, matchers = []) {
  if (mapped && mapped !== "shell") return mapped;
  if (!Array.isArray(matchers) || matchers.length === 0) return "shell";
  const foreground = matchCommand(commandOf(foregroundArgv), matchers);
  if (foreground) return foreground;
  const idleShell = Array.isArray(foregroundArgv) && foregroundArgv.length > 0 && isShellName(foregroundArgv[0]);
  if (idleShell) return "shell";
  return matchCommand(commandOf(startArgv), matchers) ?? "shell";
}
