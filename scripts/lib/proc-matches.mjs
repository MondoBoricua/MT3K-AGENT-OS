// ¿El `comm` de un proceso (ruta completa o nombre) pertenece al nombre de proceso `proc` de un agente?
// El comm se parte por "/" y basta con que un segmento sea exactamente `proc` o empiece por `proc + "-"`
// ("codex-aarch64-apple-darwin", ".../cursor-agent/versions/x.y/node"). No hay más reglas: un agente cuyo
// proceso vive bajo una carpeta con otro nombre (p. ej. Hermes en macOS, bajo `~/.hermes`) declara ese
// segmento en su propia lista `proc`, para no cambiar la atribución de los demás agentes.
export function procMatches(comm, proc) {
  return String(comm ?? "").split("/").some((segment) => segment === proc || segment.startsWith(proc + "-"));
}

// Nombres "débiles": empiezan por "." y nombran una CARPETA del agente (p. ej. `.hermes`), no su ejecutable.
// Bajo esa carpeta pueden vivir herramientas que otro agente lanza, así que por sí solos no bastan.
const isWeakName = (name) => typeof name === "string" && name.startsWith(".");
const matchesAny = (comms, names) => comms.some((comm) => names.some((name) => procMatches(comm, name)));

/**
 * ¿El pane (lista de `comm` de su árbol de procesos) es de este agente?
 * - Un nombre fuerte de `def.proc` que coincida basta (regla de siempre).
 * - Un nombre débil solo cuenta si NINGÚN otro agente coincide en ese pane por un nombre fuerte: así un Codex que
 *   lanza una herramienta que vive bajo `~/.hermes` sigue siendo solo de Codex.
 */
export function paneBelongsTo(comms, def, allDefs = []) {
  const list = Array.isArray(comms) ? comms : [];
  const names = Array.isArray(def?.proc) ? def.proc : [];
  const strong = names.filter((n) => !isWeakName(n));
  if (matchesAny(list, strong)) return true;
  const weak = names.filter(isWeakName);
  if (!weak.length || !matchesAny(list, weak)) return false;
  return !allDefs.some((other) => other && other.id !== def.id && Array.isArray(other.proc)
    && matchesAny(list, other.proc.filter((n) => !isWeakName(n))));
}

/** Nombres de proceso que sirven para reconocer un ejecutable por su nombre (sin los de carpeta). */
export const strongProcNames = (proc) => (Array.isArray(proc) ? proc.filter((n) => !isWeakName(n)) : []);
