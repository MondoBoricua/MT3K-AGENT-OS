// Atribución de agente para terminales de Herdr. `hc ls` etiqueta por el programa que reconoce; para varios agentes
// (Junie, Hermes...) devuelve el shell. Aquí se afina con el argv de `hc get`, sin llamadas extra ni importar server.mjs.

export const ARGV_ITEM_MAX_CHARS = 512; // un item más largo (p. ej. un script en línea) nunca se examina
const WHITESPACE_RE = /\s/;
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** ¿Parece una ruta de ejecutable o un nombre de comando? Sin opciones, `CLAVE=valor`, espacios ni textos largos. */
function isCommandLike(item) {
  return typeof item === "string"
    && item.length > 0
    && item.length < ARGV_ITEM_MAX_CHARS // parseHcGet trunca a 512: un item de 512 es uno recortado, no se examina
    && !item.startsWith("-")
    && !ENV_ASSIGNMENT_RE.test(item)
    && !WHITESPACE_RE.test(item); // una ruta con espacios (p. ej. "/Applications/IntelliJ IDEA.app/...") se descarta a propósito
}

// Misma regla que `procMatches` de server.mjs para los panes de tmux: segmento igual al nombre o `nombre-...`.
const segmentMatches = (item, name) => item.split("/").some((segment) => segment === name || segment.startsWith(name + "-"));

function matchArgv(argv, matchers) {
  if (!Array.isArray(argv)) return null;
  for (const item of argv) {
    if (!isCommandLike(item)) continue;
    for (const { id, proc } of matchers) {
      if (Array.isArray(proc) && proc.some((name) => typeof name === "string" && name && segmentMatches(item, name))) return id;
    }
  }
  return null;
}

/**
 * Agente final de un terminal. `mapped` es lo que dio `mapAgent` sobre `hc ls`: si ya es un agente real se respeta
 * (nunca se degrada). Si es "shell", se busca primero en el argv del primer plano y luego en el de arranque.
 * `matchers`: lista inyectada `{ id, proc: [nombres] }`. Sin coincidencia → "shell".
 */
export function refineAgent(mapped, startArgv, foregroundArgv, matchers = []) {
  if (mapped && mapped !== "shell") return mapped;
  if (!Array.isArray(matchers) || matchers.length === 0) return "shell";
  return matchArgv(foregroundArgv, matchers) ?? matchArgv(startArgv, matchers) ?? "shell";
}
