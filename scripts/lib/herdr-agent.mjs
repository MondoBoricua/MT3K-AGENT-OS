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
// Guion de envoltura de lanzamiento puro (`"$@"; exec "$0" -li` de la app, o `command $argv[2..]` en fish): solo reenvía los argumentos.
const PASS_THROUGH_SCRIPT_RE = /^(?:exec\s+)?"\$@"|^command\s+\$argv\[2\.\.\]/;
const ENV_OPERAND_FLAGS = new Set(["-u", "--unset", "-C", "--chdir"]); // consumen un operando (las formas --x=v son un solo item)
const isEnvSplitFlag = (item) => item === "--split-string" || item.startsWith("--split-string=") || /^-[^-]*S/.test(item);

/** ¿Puede ser un comando? Sin espacios (un script en línea nunca), sin recortar, no vacío. */
const isCommandLike = (item) => isString(item) && item.length > 0 && item.length < ARGV_ITEM_MAX_CHARS && !WHITESPACE_RE.test(item);

/** ¿El item es una ruta/nombre de script que sigue a un shell o intérprete? (no opción, no KEY=valor) */
const isScriptItem = (item) => isCommandLike(item) && !item.startsWith("-") && !isAssignment(item);

/** Argumentos que quedan tras `env` y sus opciones; null si no hay comando analizable (`-S`: no se parsean cadenas). */
function peelEnv(args) {
  let i = 1;
  while (i < args.length && isString(args[i])) {
    const item = args[i];
    if (item === "--") { i++; break; }
    if (isEnvSplitFlag(item)) return null;
    if (ENV_OPERAND_FLAGS.has(item)) i += 2;
    else if (item.startsWith("-") || isAssignment(item)) i++;
    else break;
  }
  return args.slice(i);
}

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
      const rest = peelEnv(args);
      if (rest === null) return null;
      args = rest;
      continue;
    }
    const second = args[1];
    if (SHELLS.has(base) && isString(second) && COMMAND_STRING_FLAGS_RE.test(second)) {
      // [shell, -…c…, script, $0, ...args]: solo se pela una envoltura de lanzamiento pura; otro texto no se interpreta
      if (!isString(args[2]) || !PASS_THROUGH_SCRIPT_RE.test(args[2].trim())) return null;
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
 * Si es "shell": 1) comando del primer plano; 2) el argv de arranque SOLO si el primer plano está vacío o es un
 * intérprete (node, python) que no se llama por el agente (p. ej. el `python3 -I -c …` de Hermes); cualquier otro
 * primer plano (vim, ssh, un shell inactivo, `env zsh -li`) → "shell"; 3) "shell".
 * `matchers`: lista inyectada `{ id, proc: [nombres] }`.
 */
export function refineAgent(mapped, startArgv, foregroundArgv, matchers = []) {
  if (mapped && mapped !== "shell") return mapped;
  if (!Array.isArray(matchers) || matchers.length === 0) return "shell";
  const foregroundCommand = commandOf(foregroundArgv);
  const foreground = matchCommand(foregroundCommand, matchers);
  if (foreground) return foreground;
  const noForeground = !Array.isArray(foregroundArgv) || foregroundArgv.length === 0;
  const unnamedInterpreter = isCommandLike(foregroundCommand) && (baseOf(foregroundCommand) === "node" || PYTHON_RE.test(baseOf(foregroundCommand)));
  if (!noForeground && !unnamedInterpreter) return "shell";
  return matchCommand(commandOf(startArgv), matchers) ?? "shell";
}
