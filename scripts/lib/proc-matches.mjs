// ¿El `comm` de un proceso (ruta completa o nombre) pertenece al nombre de proceso `proc` de un agente?
// El comm se parte por "/" y basta con que un segmento sea exactamente `proc` o empiece por `proc + "-"`
// ("codex-aarch64-apple-darwin", ".../cursor-agent/versions/x.y/node"). No hay más reglas: un agente cuyo
// proceso vive bajo una carpeta con otro nombre (p. ej. Hermes en macOS, bajo `~/.hermes`) declara ese
// segmento en su propia lista `proc`, para no cambiar la atribución de los demás agentes.
export function procMatches(comm, proc) {
  return String(comm ?? "").split("/").some((segment) => segment === proc || segment.startsWith(proc + "-"));
}
