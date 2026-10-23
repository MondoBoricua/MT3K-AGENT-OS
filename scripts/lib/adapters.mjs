/**
 * adapters.mjs — contrato v1 de adaptadores (solo tipos/capacidades; sin transporte ni UI).
 * Normaliza AGENT_DEFS y describe qué puede hacer cada agente según el adaptador inferido.
 */

export const ADAPTER_PROTOCOL_VERSION = 1;

// Agentes con comprobador explícito en resume-history.mjs (historyChecks).
// El resto de CLI en tmux se consideran “retoman solos” (hasResumableHistory devuelve true sin probe).
const RESUME_HISTORY_AGENT_IDS = new Set(["claude", "grok", "cursor", "zcode"]);

/** @typedef {{ supported: boolean, reason?: string }} Capability */
/** @typedef {{ discover: Capability, status: Capability, launch: Capability, view: Capability, send: Capability, keys: Capability, resume: Capability, kill: Capability }} Capabilities */

const cap = (supported, reason) => (reason && !supported ? { supported, reason } : { supported });

/**
 * Infiere el adaptador a partir de la definición (respeta def.adapter si viene explícito).
 * @param {Record<string, unknown>} def
 * @returns {"cli-tmux"|"web-local"|"web-external"|"terminal"}
 */
export function inferAdapter(def) {
  if (def.adapter && typeof def.adapter === "string") return def.adapter;
  if (def.url) return "web-external";
  if (def.web) return "web-local";
  const proc = def.proc || [];
  const bins = def.bins || [];
  if (proc.length === 0 && bins.length === 0) return "terminal";
  if (proc.length > 0 && !def.web) return "cli-tmux";
  return "cli-tmux";
}

/**
 * Regla resume (cli-tmux): supported=true si el id está en historyChecks (claude, grok, cursor, zcode)
 * o si no está en ese mapa (codex, opencode, … retoman solos — ver hasResumableHistory en resume-history.mjs:104).
 * La comprobación por cwd sigue en el servidor; aquí solo declaramos capacidad del adaptador.
 * @param {string} agentId
 */
function cliTmuxResumeCapability(agentId) {
  return RESUME_HISTORY_AGENT_IDS.has(agentId) || !RESUME_HISTORY_AGENT_IDS.has(agentId);
}

/**
 * Matriz de capacidades por adaptador y entorno del host.
 * @param {Record<string, unknown>} def
 * @param {{ hasTmux: boolean, platform: string }} env
 * @returns {Capabilities}
 */
export function capabilitiesFor(def, env) {
  const adapter = inferAdapter(def);
  const noTmux = cap(false, "no tmux");
  const external = cap(false, "external web UI");
  const webLocalNoTui = cap(false, "web-local UI");

  if (adapter === "web-external") {
    return {
      discover: cap(true),
      status: cap(true),
      launch: external,
      view: cap(true),
      send: external,
      keys: external,
      resume: external,
      kill: external,
    };
  }

  if (adapter === "web-local") {
    return {
      discover: cap(true),
      status: cap(true),
      launch: cap(true),
      view: cap(true),
      send: webLocalNoTui,
      keys: webLocalNoTui,
      resume: webLocalNoTui,
      kill: cap(true),
    };
  }

  if (adapter === "terminal") {
    const tmuxOps = env.hasTmux
      ? { launch: cap(true), view: cap(true), send: cap(true), keys: cap(true), kill: cap(true) }
      : { launch: noTmux, view: noTmux, send: noTmux, keys: noTmux, kill: noTmux };
    return {
      discover: cap(true),
      status: cap(true),
      ...tmuxOps,
      resume: cap(false, "terminal shell"),
    };
  }

  // cli-tmux
  if (!env.hasTmux) {
    return {
      discover: cap(true),
      status: cap(true),
      launch: noTmux,
      view: noTmux,
      send: noTmux,
      keys: noTmux,
      resume: noTmux,
      kill: noTmux,
    };
  }
  const resumeOk = cliTmuxResumeCapability(def.id);
  return {
    discover: cap(true),
    status: cap(true),
    launch: cap(true),
    view: cap(true),
    send: cap(true),
    keys: cap(true),
    resume: cap(resumeOk),
    kill: cap(true),
  };
}

/**
 * Copia inmutable de defs con `adapter` rellenado (no muta el array/objetos originales).
 * @param {readonly Record<string, unknown>[]} defs
 */
export function normalizeAgentDefs(defs) {
  return defs.map((d) => ({ ...d, adapter: inferAdapter(d) }));
}

/**
 * Metadatos de adaptador para anexar a cada fila de GET /api/agents.
 * @param {Record<string, unknown>} def
 * @param {{ hasTmux: boolean, platform: string }} env
 */
export function describeAgent(def, env) {
  return {
    adapter: inferAdapter(def),
    adapterVersion: ADAPTER_PROTOCOL_VERSION,
    capabilities: capabilitiesFor(def, env),
  };
}
