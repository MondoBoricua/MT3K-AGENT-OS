// Decide si un agente cuenta como "running" en GET /api/agents.
//
// Por defecto basta con que su binario aparezca en cualquier proceso (`running`, el set de
// segmentos de comm). Los agentes con `paneOnly` además corren un demonio permanente con el
// mismo nombre de proceso (Hermes: `hermes … gateway run`, PPID 1, sin tty): para ellos solo
// cuenta una instancia interactiva dentro de un panel de tmux.

/**
 * @param {{ proc?: string[], paneOnly?: boolean }} def
 * @param {{ installed: boolean, running: Set<string>, agentPanes: unknown[] }} state
 * @returns {boolean}
 */
export function isAgentRunning(def, { installed, running, agentPanes }) {
  if (!installed) return false;
  if (def.paneOnly) return agentPanes.length > 0;
  return (def.proc || []).some((name) => running.has(name));
}
