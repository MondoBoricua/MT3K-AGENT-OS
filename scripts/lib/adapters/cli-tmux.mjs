/**
 * cli-tmux.mjs — helpers puros del camino tmux (nombres de sesión, launch.json, paneId).
 * La ejecución real de tmux/run() sigue en server.mjs.
 */

/** Regex que usa el servidor para IDs de pane de tmux (%0, %12, …). */
export const PANE_ID_RE = /^%\d+$/;

/**
 * Valida paneId con la misma semántica que los endpoints /api/pane*, /api/send, etc.
 * @param {unknown} paneId
 * @returns {{ ok: true, paneId: string } | { ok: false, err: string }}
 */
export function validatePaneId(paneId) {
  if (typeof paneId !== "string" || !PANE_ID_RE.test(paneId)) {
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
 * @param {{ bin: string, envPairs: string[], args: string[] }} opts
 */
export function composeTmuxArgv({ bin, envPairs = [], args = [] }) {
  let cmd;
  if (envPairs.length) cmd = ["/usr/bin/env", ...envPairs, bin, ...args];
  else cmd = [bin, ...args];
  // tmux con UN solo word usa $SHELL -c; con 2+ hace exec directo — forzamos 2+.
  if (cmd.length === 1) cmd = ["/usr/bin/env", ...cmd];
  return cmd;
}
