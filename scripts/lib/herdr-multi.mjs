// Fachada sobre los DOS backends de Herdr que el panel entiende, detectados de forma independiente:
//   hc     → Herdr Core 0.1.x (`hc`, ids `hc:tN`)            · lib/herdr-panes.mjs
//   herdr9 → app/CLI `herdr` 0.9.x (ids `h9:w1:p3`)           · lib/herdr9-panes.mjs
// Un host puede tener uno, los dos o ninguno. Cada llamada se enruta por el prefijo del id; las listas se unen.
import { isHerdrId as isHcId } from "./herdr.mjs";
import { isHerdr9Id } from "./herdr9.mjs";

/** ¿Es un id de Herdr de cualquiera de los dos backends? */
export const isHerdrId = (id) => isHcId(id) || isHerdr9Id(id);

/** ¿Algún string del valor (profundidad acotada) es un id de Herdr? Para rechazar bodies de /api/restore. */
export function containsHerdrId(value, depth = 0) {
  if (typeof value === "string") return isHerdrId(value);
  if (depth > 4 || value === null || typeof value !== "object") return false;
  return Object.values(value).some((v) => containsHerdrId(v, depth + 1));
}

/** Qué backends hay instalados (cada uno por su cuenta): { hc, herdr9 }. */
export function detectBackends({ hcPanes, h9Panes }) {
  return { hc: Boolean(hcPanes?.hc?.()), herdr9: Boolean(h9Panes?.herdr9?.()) };
}

/** Panes de Herdr de ambos backends con la misma superficie que createHerdrPanes. `hcPanes`/`h9Panes` ya construidos. */
export function createHerdrMulti({ hcPanes, h9Panes }) {
  const pick = (id) => (isHerdr9Id(id) ? h9Panes : hcPanes);
  const both = [hcPanes, h9Panes];
  return {
    enabled: hcPanes.enabled || h9Panes.enabled,
    async refresh(force) {
      return (await Promise.all(both.map((p) => p.refresh(force)))).flat();
    },
    invalidate: () => both.forEach((p) => p.invalidate()),
    cachedRows: () => both.flatMap((p) => p.cachedRows()),
    /** Adaptador hc (compatibilidad con quien aún lo pide); el de herdr 0.9 está en `herdr9()`. */
    hc: () => hcPanes.hc(),
    herdr9: () => h9Panes.herdr9(),
    has: (id, force) => pick(id).has(id, force),
    read: (id, lines) => pick(id).read(id, lines),
    view: (id) => pick(id).view(id),
    tailOf: (id) => pick(id).tailOf(id),
    send: (id, text) => pick(id).send(id, text),
    keys: (id, key) => pick(id).keys(id, key),
    explain: (id) => pick(id).explain(id),
    wait: (opts) => pick(opts.id).wait(opts),
    startStream: (opts) => pick(opts.id).startStream(opts),
    failure: (r) => hcPanes.failure(r),
    close: () => both.forEach((p) => p.close()),
    connStats: () => hcPanes.connStats?.() ?? null,
    async applyTo(agentRows) {
      return h9Panes.applyTo(await hcPanes.applyTo(agentRows));
    },
    /** Cierra un terminal en SU backend; mismo contrato que `killTerminal` de cada adaptador. */
    async kill(id, { force = false } = {}) {
      let closed;
      if (isHerdr9Id(id)) closed = await h9Panes.killTerminal(id, { force });
      else {
        const hc = hcPanes.hc();
        closed = hc ? await hc.killTerminal(id, { force }) : { ok: false, status: 400, err: "hc no disponible" };
      }
      pick(id).invalidate();
      return closed;
    },
  };
}

/**
 * Lanzador de ambos backends. Con los dos presentes se prefiere `hc` si su core está vivo (comportamiento histórico);
 * si no, herdr 0.9 si su servidor está vivo. Razones de fallo: "not-installed" solo si NINGUNO está instalado.
 */
export function createHerdrMultiLauncher({ hcLauncher, h9Launcher }) {
  return {
    async status() {
      const [a, b] = await Promise.all([hcLauncher.status(), h9Launcher.status()]);
      return { installed: a.installed || b.installed, running: a.running || b.running, app: a.app };
    },
    async launch(input) {
      const [a, b] = await Promise.all([hcLauncher.status(), h9Launcher.status()]);
      if (!a.installed && !b.installed) return { ok: false, reason: "not-installed" };
      if (a.running) return hcLauncher.launch(input);
      if (b.running) return h9Launcher.launch(input);
      return { ok: false, reason: "no-core" };
    },
  };
}
