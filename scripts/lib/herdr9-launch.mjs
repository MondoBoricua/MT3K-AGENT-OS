// Crear sesiones NUEVAS en `herdr` 0.9 desde el panel: una pestaña sin foco con nombre del panel y el comando escrito en su shell.
// Nunca arranca un servidor: sin servidor vivo devuelve { reason: "no-core" } y el servidor abre en tmux (o en el otro backend).
import { launchName } from "./herdr-launch.mjs";

export function createHerdr9Launcher({ getHerdr9 = () => null, nameSuffix } = {}) {
  /** { installed: la CLI existe, running: servidor con socket vivo, app: false (herdr 0.9 no tiene herdr-app). */
  async function status() {
    const h = getHerdr9();
    if (!h) return { installed: false, running: false, app: false };
    const running = await h.coreUp().catch(() => false);
    const health = h.health?.() ?? { ok: true };
    // `error` solo con el servidor vivo: sin servidor no hay "lista que falla" (contrato de errors en herdr-multi.mjs)
    return { installed: true, running, app: false, ...(running && !health.ok ? { error: health.err } : {}) };
  }

  /** { ok:true, paneId, address, via, name } | { ok:false, reason: "not-installed" | "no-core" | "error", err? } */
  async function launch({ agentId, cwd, argv }) {
    const h = getHerdr9();
    if (!h) return { ok: false, reason: "not-installed" };
    if (!(await h.coreUp())) return { ok: false, reason: "no-core" };
    const name = launchName(agentId, cwd, nameSuffix);
    const r = await h.openTab({ cwd, label: name, argv });
    if (!r.ok) return { ok: false, reason: r.code === "NOCORE" ? "no-core" : "error", err: r.err };
    h.invalidate();
    return { ok: true, paneId: r.id, address: r.pane, via: "core", name };
  }

  return { status, launch };
}
