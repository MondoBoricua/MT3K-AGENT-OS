/**
 * cli-tmux.mjs — helpers puros del camino tmux (nombres de sesión, launch.json, paneId).
 * La ejecución real de tmux/run() sigue en server.mjs.
 */

/** Regex que usa el servidor para IDs de pane de tmux (%0, %12, …). */
export const PANE_ID_RE = /^%\d+$/;

/**
 * Binario tmux a invocar. POSIX: "tmux" por PATH (como siempre). win32: ruta absoluta de tmux,
 * con psmux de respaldo (psmux.exe es el clon nativo de tmux).
 * @param {{ platform?: string, absBin: (name: string) => string | null }} opts
 */
export function resolveTmuxBin({ platform = process.platform, absBin }) {
  if (platform !== "win32") return "tmux";
  return absBin("tmux") || absBin("psmux") || "tmux";
}

/** El host tiene tmux (POSIX: solo tmux) o psmux (win32). */
export function hasTmuxBinary({ platform = process.platform, absBin }) {
  return platform === "win32" ? !!(absBin("tmux") || absBin("psmux")) : !!absBin("tmux");
}

/** psmux (win32): sesión:ventana.pane, p.ej. mt3k-claude-mondo-zvv:0.0 (sus %N se repiten entre sesiones). */
export const WIN32_PANE_KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9_.@-]*:\d+\.\d+$/;

/** Largo máximo de cualquier paneId (uniforme en POSIX y win32). */
export const PANE_ID_MAX_LEN = 120;

/**
 * Valida paneId con la misma semántica que los endpoints /api/pane*, /api/send, etc.
 * @param {unknown} paneId
 * @returns {{ ok: true, paneId: string } | { ok: false, err: string }}
 */
export function validatePaneId(paneId, platform = process.platform) {
  // psmux reescribe tokens que empiezan por "-" como flags y trata "@" como window-id: la clave
  // win32 debe empezar por [A-Za-z0-9_]
  const valid = typeof paneId === "string"
    && paneId.length <= PANE_ID_MAX_LEN
    && (PANE_ID_RE.test(paneId) || (platform === "win32" && WIN32_PANE_KEY_RE.test(paneId)));
  if (!valid) {
    return { ok: false, err: "paneId inválido" };
  }
  return { ok: true, paneId };
}

/**
 * Slug legible a partir del basename del cwd (misma regla que /api/launch).
 * @param {string} cwdBasename
 */
export function dirSlugFromBasename(cwdBasename) {
  return (cwdBasename || "home")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 20) || "home";
}

/**
 * Nombre de sesión mt3k-<agente>-<slug>-<sufijo> (sufijo = 3 chars base36 del timestamp).
 * @param {string} agentId
 * @param {string} cwdBasename
 * @param {number} [nowMs]
 */
export function mt3kSessionName(agentId, cwdBasename, nowMs = Date.now()) {
  const dirSlug = dirSlugFromBasename(cwdBasename);
  const suffix = nowMs.toString(36).slice(-3);
  return `mt3k-${agentId}-${dirSlug}-${suffix}`;
}

/**
 * Parsea una entrada de data/launch.json (solo strings; ignora basura).
 * @param {Record<string, unknown> | null | undefined} lc
 */
export function parseLaunchConfig(lc) {
  if (!lc) return { envPairs: [], args: [], resumeArgs: [] };
  const envPairs = Object.entries(lc.env || {})
    .filter(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === "string")
    .map(([k, v]) => `${k}=${v}`);
  const args = (Array.isArray(lc.args) ? lc.args : []).filter((a) => typeof a === "string");
  const resumeArgs = (Array.isArray(lc.resumeArgs) ? lc.resumeArgs : []).filter((a) => typeof a === "string");
  return { envPairs, args, resumeArgs };
}

/**
 * Arma el argv que tmux ejecutará: bin + args, con /usr/bin/env si hay env o un solo token.
 * En win32 (psmux) no existe /usr/bin/env: el env va como flags `-e` del new-session
 * (envPairsToTmuxFlags) y un solo word se ejecuta directo. Un shim .ps1 no se puede lanzar
 * directo (CreateProcess error 193) → se envuelve en powershell -File.
 * @param {{ bin: string, envPairs?: string[], args?: string[], platform?: string }} opts
 */
export function composeTmuxArgv({ bin, envPairs = [], args = [], platform = process.platform }) {
  if (platform === "win32") {
    if (/\.ps1$/i.test(bin)) return ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", bin, ...args];
    return [bin, ...args];
  }
  let cmd;
  if (envPairs.length) cmd = ["/usr/bin/env", ...envPairs, bin, ...args];
  else cmd = [bin, ...args];
  // tmux con UN solo word usa $SHELL -c; con 2+ hace exec directo — forzamos 2+.
  if (cmd.length === 1) cmd = ["/usr/bin/env", ...cmd];
  return cmd;
}

/** ["K=V", …] → ["-e", "K=V", …] para `new-session` (camino win32, donde no hay /usr/bin/env). */
export function envPairsToTmuxFlags(envPairs = []) {
  return envPairs.flatMap((pair) => ["-e", pair]);
}

// tmux hereda el env del proceso que levantó el servidor; Codex/Cursor dejan basura en el global.
const TMUX_GLOBAL_SCRUB_EXACT = new Set([
  "CLAUDE_CODE_CHILD_SESSION",
  "NO_COLOR",
  "CODEX_CI",
  "CODEX_SHELL",
  "CODEX_SESSION_ID",
  "CODEX_THREAD_ID",
]);
const TMUX_GLOBAL_SCRUB_PREFIXES = ["CODEX_", "CURSOR_", "ZCODE_"];

/** Parsea `tmux show-environment -g` (solo vars con valor; ignora líneas `-VAR` ya unset). */
export function parseTmuxGlobalEnv(text) {
  const out = new Map();
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line || (line.startsWith("-") && !line.includes("="))) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    out.set(line.slice(0, eq), line.slice(eq + 1));
  }
  return out;
}

/** Claves a quitar del global antes de cada `new-session` del panel. */
export function tmuxGlobalKeysToUnset(globalEnv) {
  const keys = new Set(TMUX_GLOBAL_SCRUB_EXACT);
  for (const name of globalEnv.keys()) {
    if (TMUX_GLOBAL_SCRUB_PREFIXES.some((p) => name.startsWith(p))) keys.add(name);
  }
  return [...keys].sort();
}

/** Si COLORTERM falta o está vacío en el global, el launch lo fija a truecolor. */
export function needsGlobalColortermTruecolor(globalEnv) {
  const v = globalEnv.get("COLORTERM");
  return v === undefined || v === "";
}
