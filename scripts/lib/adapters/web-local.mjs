/**
 * web-local.mjs — decisiones puras del camino web-local (dsh, etc.).
 * Tokens de log: reutilizamos lastWebToken de web-session.mjs (no duplicar regex).
 */
import { lastWebToken } from "../web-session.mjs";

/** Re-export con nombre del adaptador; el texto del log es el único input puro. */
export function webTokenFromLogText(text) {
  return lastWebToken(text);
}

/**
 * Elige cómo arrancar la UI web en ESTE host (sin ejecutar nada).
 * Misma prioridad que startWebTool en server.mjs: systemd → task Windows → spawn.
 * @param {Record<string, unknown>} def
 * @param {string} platform — process.platform
 * @param {boolean} serviceUnitExists — p.ej. existsSync(`/etc/systemd/system/${def.webService}.service`)
 * @returns {"systemd"|"task"|"spawn"|null}
 */
export function pickWebStarter(def, platform, serviceUnitExists) {
  if (platform !== "win32" && def.webService && serviceUnitExists) return "systemd";
  if (platform === "win32" && def.webTask) return "task";
  if (def.webCmd && Array.isArray(def.webCmd) && def.webCmd.length) return "spawn";
  return null;
}
