/**
 * agents-local.mjs — agentes web externos definidos en data/agents.local.json (solo host).
 * Parser/validador puro: sin I/O de red ni lectura de disco en las funciones exportadas para tests.
 */

import { readFileSync } from "node:fs";

const ID_RE = /^[a-z][a-z0-9-]{1,23}$/;
const LOGO_RE = /^[a-z0-9-]+$/;
const ALLOWED_ADAPTERS = new Set(["web-external"]);

/**
 * Valida una entrada cruda del JSON local y devuelve un def normalizado o null.
 * @param {unknown} raw
 * @returns {Record<string, string>|null}
 */
export function validateLocalAgentEntry(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { id, name, adapter, url, logo } = raw;
  if (typeof id !== "string" || !ID_RE.test(id)) return null;
  if (typeof name !== "string" || !name.trim()) return null;
  if (adapter !== "web-external" || !ALLOWED_ADAPTERS.has(adapter)) return null;
  if (typeof url !== "string") return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  const out = { id, name: name.trim(), adapter: "web-external", url: parsed.href };
  if (logo !== undefined && logo !== null) {
    if (typeof logo !== "string" || !LOGO_RE.test(logo)) return null;
    out.logo = logo;
  }
  return out;
}

/**
 * Parsea el documento agents.local.json (objeto con array `agents`).
 * JSON inválido o estructura mala → [] (nunca lanza).
 * @param {string} text
 * @param {(msg: string) => void} [warn]
 * @returns {Record<string, string>[]}
 */
export function parseAgentsLocalDocument(text, warn = () => {}) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    warn("agents.local.json: JSON inválido — ignorando entradas locales");
    return [];
  }
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.agents)) {
    warn("agents.local.json: falta array agents — ignorando entradas locales");
    return [];
  }
  const out = [];
  for (const entry of doc.agents) {
    const v = validateLocalAgentEntry(entry);
    if (v) out.push(v);
    else warn("agents.local.json: entrada ignorada (validación fallida)");
  }
  return out;
}

/**
 * Fusiona defs de código con locales; ids que ya existen en código se omiten.
 * @param {readonly Record<string, unknown>[]} codeDefs
 * @param {readonly Record<string, unknown>[]} localDefs
 * @param {(msg: string) => void} [warn]
 */
export function mergeLocalAgentDefs(codeDefs, localDefs, warn = () => {}) {
  // ids ya vistos: código + locales ya aceptados (la primera entrada local gana)
  const seenIds = new Set(codeDefs.map((d) => d.id));
  const merged = [...codeDefs];
  for (const def of localDefs) {
    if (seenIds.has(def.id)) {
      const inCode = codeDefs.some((d) => d.id === def.id);
      warn(
        inCode
          ? `agents.local.json: id "${def.id}" ya está en AGENT_DEFS — omitido`
          : `agents.local.json: id "${def.id}" duplicado en locales — omitido`,
      );
      continue;
    }
    seenIds.add(def.id);
    merged.push(def);
  }
  return merged;
}

/**
 * Lee el archivo local una vez (solo uso en servidor).
 * @param {string} path
 * @param {(msg: string) => void} [warn]
 */
export function readAgentsLocalFile(path, warn = () => {}) {
  try {
    const text = readFileSync(path, "utf8");
    return parseAgentsLocalDocument(text, warn);
  } catch (e) {
    if (e && typeof e === "object" && "code" in e && e.code === "ENOENT") return [];
    warn("agents.local.json: no se pudo leer — ignorando entradas locales");
    return [];
  }
}
