// Terminales de `herdr` 0.9 como panes del panel: listar, leer (con color), escribir y teclas. Misma superficie que
// createHerdrPanes (hc) para que herdr-multi.mjs los trate igual. Nunca toca el ledger de tmux ni notificaciones.
import { createHerdr9 as realCreateHerdr9 } from "./herdr9.mjs";
import { findHerdrCli } from "./herdr.mjs";
import { HERDR_LIST_TTL_MS, herdrFailure, mergeHerdrPanes } from "./herdr-panes.mjs";
import { startHerdrStream } from "./herdr-stream.mjs";
import { runWait } from "./wait-loop.mjs";

const FORCE_MIN_MS = 500;
const MAX_REPOLLS = 3;
const LOOKUP_MS = 30000;
const HISTORY_LINES = 1000;
const TAIL_LINES = 12;
const NA = "herdr no disponible";

/** Teclas del panel (lib/keys.mjs) → nombres de `herdr pane send-keys`; null = no soportada (medido en 0.9.5: sin Home/End/PageUp/PageDown). */
const KEY_TABLE = {
  Up: ["up"], Down: ["down"], Left: ["left"], Right: ["right"],
  Enter: ["enter"], Escape: ["esc"], Tab: ["tab"], ShiftTab: ["shift+tab"],
  Space: ["space"], BSpace: ["backspace"],
  SendNow: ["ctrl+x", "ctrl+s"],
};
export function herdr9KeyArgs(name) {
  if (typeof name !== "string" || !Object.hasOwn(KEY_TABLE, name)) return null;
  return [...KEY_TABLE[name]];
}

export function createHerdr9Panes({
  enabled = true,
  tildify = (p) => p,
  findCli = findHerdrCli,
  createHerdr9 = realCreateHerdr9,
  now = Date.now,
  ttlMs = HERDR_LIST_TTL_MS,
  color = true,
} = {}) {
  let herdr = null;
  let cliPath = null;
  let checkedAt = -Infinity;
  let cache = { at: -Infinity, rows: [] };
  let loop = null;
  let generation = 0;

  // Con MT3K_HERDR=0 / MT3K_HERDR9=0 ni se busca la CLI; ausente se reintenta cada 30 s.
  function client() {
    if (!enabled) return null;
    const t = now();
    if (t - checkedAt >= LOOKUP_MS) {
      checkedAt = t;
      const found = findCli();
      if (found !== cliPath) {
        cliPath = found;
        herdr = found ? createHerdr9({ herdrPath: found }) : null;
        cache = { at: -Infinity, rows: [] };
      }
    }
    return herdr;
  }

  // Una sola consulta a la vez; si hubo invalidate() mientras corría se repite (hasta MAX_REPOLLS) para entregar una lista posterior.
  function startLoop(h) {
    const token = {};
    const p = (async () => {
      let rows = [];
      try {
        for (let i = 0; i <= MAX_REPOLLS; i++) {
          const gen = generation;
          rows = await h.list().catch(() => []);
          if (gen === generation) { cache = { at: now(), rows }; break; }
        }
        return rows;
      } finally {
        if (loop?.token === token) loop = null;
      }
    })();
    loop = { token, p };
    return p;
  }

  async function refresh(force = false) {
    const h = client();
    if (!h) return [];
    if (now() - cache.at < (force ? FORCE_MIN_MS : ttlMs)) return cache.rows;
    return loop ? loop.p : startLoop(h);
  }

  function invalidate() {
    generation++;
    cache = { at: -Infinity, rows: [] };
    herdr?.invalidate?.();
  }

  const find = (id) => cache.rows.find((r) => r.id === id) || null;
  const has = async (id, force = false) => {
    await refresh(force);
    return find(id) !== null;
  };

  async function read(id, lines = HISTORY_LINES) {
    const h = client();
    return h ? h.read(id, { lines }) : { ok: false, err: NA };
  }

  /** SGR de `pane read --ansi`; si falla o está apagado, texto plano. */
  async function view(id) {
    const h = client();
    if (!h) return { ok: false, err: NA };
    if (color) {
      const r = await h.read(id, { lines: HISTORY_LINES, ansi: true });
      if (r.ok && r.text.length > 0) return { ok: true, text: r.text, colored: true };
    }
    return read(id);
  }

  async function tailOf(id) {
    const r = await read(id, 0);
    if (!r.ok) return [];
    return r.text.trimEnd().split(/\r?\n/).filter((l) => l.trim().length > 0).slice(-TAIL_LINES);
  }

  return {
    enabled,
    refresh,
    invalidate,
    cachedRows: () => cache.rows,
    /** Adaptador herdr 0.9 (o null con MT3K_HERDR=0 / MT3K_HERDR9=0 / sin la CLI): lo usa el lanzador. */
    herdr9: client,
    has,
    read,
    view,
    close() {},
    tailOf,
    failure: herdrFailure,
    async applyTo(agentRows) {
      return mergeHerdrPanes(agentRows, await refresh(), tildify);
    },
    async send(id, text) {
      const h = client();
      return h ? h.send(id, text) : { ok: false, err: NA };
    },
    async keys(id, panelKey) {
      const args = herdr9KeyArgs(panelKey);
      if (!args) return { ok: false, err: "tecla no permitida", status: 400 };
      const h = client();
      return h ? h.keys(id, args) : { ok: false, err: NA };
    },
    async killTerminal(id, opts) {
      const h = client();
      return h ? h.killTerminal(id, opts) : { ok: false, status: 400, err: NA };
    },
    async explain(id) {
      const row = find(id);
      if (!row) return null;
      return { ok: true, paneId: id, agent: row.agent, source: "herdr", state: row.status ?? "idle", ruleId: "herdr", region: null, matched: null, title: row.where || row.name || row.address, tail: await tailOf(id) };
    },
    async wait({ id, until, timeoutSec, baseline = null, sawWorkingBefore = false, isPromptWait = false, sentAt = null, onAbort }) {
      await refresh(true);
      return runWait({
        cond: until,
        timeoutMs: timeoutSec * 1000,
        baseline,
        sawWorkingBefore,
        isPromptWait,
        sentAt,
        refresh: () => refresh(true),
        readStatus: () => {
          const row = find(id);
          return row ? { status: row.status ?? "idle", statusRule: "herdr", source: "manifest", sampledAt: cache.at } : null;
        },
        isAlive: () => find(id) !== null,
        onAbort,
        now,
      });
    },
    startStream: (opts) => startHerdrStream({ has, view, ...opts }),
  };
}
