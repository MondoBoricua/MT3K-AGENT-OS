// Terminales de Herdr (hc) como panes del panel. Solo lectura de la lista, leer pantalla, texto y teclas.
// Nunca toca el ledger, tombstones, notificaciones ni tmux: server.mjs solo llama a estas funciones.
import { createHerdr as realCreateHerdr, findHc as realFindHc, isHerdrId } from "./herdr.mjs";
import { runWait } from "./wait-loop.mjs";

export const HERDR_UNAVAILABLE = "no disponible para sesiones de Herdr";
export const HERDR_BLOCKED = "bloqueado: requiere a la persona";
export const HERDR_LIST_TTL_MS = 2000;
export const HERDR_STREAM_MIN_TICK_MS = 1000;
const HERDR_FORCE_MIN_MS = 500;
const HC_LOOKUP_MS = 30000;
const READ_HISTORY_LINES = 1000;
const TAIL_LINES = 12;
const STREAM_MISS_LIMIT = 2;

/** Cuerpo 400 uniforme de los endpoints que Herdr no soporta. */
export const herdrUnavailableBody = () => ({ ok: false, err: HERDR_UNAVAILABLE });

/** Teclas del panel (lib/keys.mjs) → argumentos de `hc keys`; null = no soportada. */
const KEY_TABLE = {
  Up: ["up"], Down: ["down"], Left: ["left"], Right: ["right"],
  Enter: ["enter"], Escape: ["esc"], Tab: ["tab"], ShiftTab: ["shift+tab"],
  Space: ["space"], BSpace: ["backspace"],
  PageUp: ["pageup"], PageDown: ["pagedown"], Home: ["home"], End: ["end"],
  SendNow: ["ctrl+x", "ctrl+s"],
};
export function herdrKeyArgs(name) {
  if (typeof name !== "string" || !Object.hasOwn(KEY_TABLE, name)) return null;
  return [...KEY_TABLE[name]];
}

/** ¿Algún string del valor (profundidad acotada) es un id de Herdr? Para rechazar bodies de /api/restore. */
export function containsHerdrId(value, depth = 0) {
  if (typeof value === "string") return isHerdrId(value);
  if (depth > 4 || value === null || typeof value !== "object") return false;
  return Object.values(value).some((v) => containsHerdrId(v, depth + 1));
}

/** Fila normalizada de `list()` → pane del panel. Los panes tmux no llevan `backend` (ausencia = tmux). */
export function toPane(row, tildify = (p) => p) {
  const status = row.status ?? "idle";
  return {
    paneId: row.id,
    label: row.where || row.name || row.address,
    window: row.address,
    cwd: tildify(row.cwd || ""),
    backend: "herdr",
    status,
    waiting: status === "blocked",
    statusRule: "herdr",
    statusSource: "herdr",
  };
}

/** Copia de `agentRows` con los terminales de Herdr añadidos; nunca muta las filas de entrada. */
export function mergeHerdrPanes(agentRows, terminals, tildify) {
  if (!terminals.length) return agentRows;
  const known = new Set(agentRows.map((r) => r.id));
  const byAgent = new Map();
  for (const t of terminals) {
    const target = known.has(t.agent) ? t.agent : "shell";
    if (!known.has(target)) continue;
    byAgent.set(target, [...(byAgent.get(target) || []), toPane(t, tildify)]);
  }
  return agentRows.map((row) => {
    const extra = byAgent.get(row.id);
    if (!extra) return row;
    const panes = [...(row.panes || []), ...extra];
    return { ...row, panes, running: true, waiting: panes.some((p) => p.waiting) };
  });
}

/** Un fotograma: misma forma que el SSE de tmux (cadena completa primero; con fmt=lines luego diffs). */
export function streamFrame(last, text, lineDiffs) {
  const lines = text.split("\n");
  let from = 0;
  while (last !== null && from < last.length && from < lines.length && last[from] === lines[from]) from++;
  if (last !== null && from === last.length && from === lines.length) return { same: true, lines };
  const payload = last === null || !lineDiffs
    ? JSON.stringify(text)
    : JSON.stringify({ from, lines: lines.slice(from), alt: false, mouse_sgr: false });
  return { same: false, lines, payload };
}

export function createHerdrPanes({
  enabled = true,
  tildify = (p) => p,
  findHc = realFindHc,
  createHerdr = realCreateHerdr,
  now = Date.now,
  ttlMs = HERDR_LIST_TTL_MS,
} = {}) {
  let herdr = null;
  let hcPath = null;
  let hcCheckedAt = -Infinity;
  let cache = { at: -Infinity, rows: [] };
  let inflight = null;

  // Con MT3K_HERDR=0 ni se busca hc. Con hc ausente tampoco hay trabajo (se reintenta cada 30 s).
  function client() {
    if (!enabled) return null;
    const t = now();
    if (t - hcCheckedAt >= HC_LOOKUP_MS) {
      hcCheckedAt = t;
      const found = findHc();
      if (found !== hcPath) {
        hcPath = found;
        herdr = found ? createHerdr({ hcPath: found }) : null;
        cache = { at: -Infinity, rows: [] };
      }
    }
    return herdr;
  }

  /** Lista cacheada ≤ ttlMs (500 ms si se fuerza); una sola consulta en vuelo. */
  async function refresh(force = false) {
    const h = client();
    if (!h) return [];
    if (now() - cache.at < (force ? HERDR_FORCE_MIN_MS : ttlMs)) return cache.rows;
    if (inflight) return inflight;
    inflight = (async () => {
      let rows = [];
      try { rows = await h.list(); } catch { rows = []; }
      cache = { at: now(), rows };
      return rows;
    })().finally(() => { inflight = null; });
    return inflight;
  }

  const find = (id) => cache.rows.find((r) => r.id === id) || null;
  const has = async (id, force = false) => {
    await refresh(force);
    return find(id) !== null;
  };

  async function read(id) {
    const h = client();
    if (!h) return { ok: false, err: "hc no disponible" };
    return h.read(id, { lines: READ_HISTORY_LINES });
  }

  async function tailOf(id) {
    const r = await read(id);
    if (!r.ok) return [];
    return r.text.trimEnd().split(/\r?\n/).filter((l) => l.trim().length > 0).slice(-TAIL_LINES);
  }

  const CLIENT_ERRORS = new Set(["texto vacío", "texto demasiado largo", "teclas inválidas", "terminal inválido"]);
  const failure = (r) => {
    if (r.err === HERDR_BLOCKED) return { status: 409, body: { ok: false, err: HERDR_BLOCKED } };
    return { status: CLIENT_ERRORS.has(r.err) ? 400 : 500, body: { ok: false, err: r.err } };
  };

  return {
    enabled,
    refresh,
    has,
    read,
    tailOf,
    failure,
    /** Terminales vivos de Herdr para añadir a /api/agents. */
    async applyTo(agentRows) {
      const terminals = await refresh();
      return mergeHerdrPanes(agentRows, terminals, tildify);
    },
    async send(id, text) {
      const h = client();
      return h ? h.send(id, text) : { ok: false, err: "hc no disponible" };
    },
    async keys(id, panelKey) {
      const args = herdrKeyArgs(panelKey);
      if (!args) return { ok: false, err: "tecla no permitida", status: 400 };
      const h = client();
      return h ? h.keys(id, args) : { ok: false, err: "hc no disponible" };
    },
    async explain(id) {
      const row = find(id);
      if (!row) return null;
      return {
        ok: true,
        paneId: id,
        agent: row.agent,
        source: "herdr",
        state: row.status ?? "idle",
        ruleId: "herdr",
        region: null,
        matched: null,
        title: row.where || row.name || row.address,
        tail: await tailOf(id),
      };
    },
    /** Espera por estado con la lista cacheada de Herdr (runWait compartido con tmux). */
    async wait({ id, until, timeoutSec, baseline = null, sawWorkingBefore = false, isPromptWait = false, sentAt = null, onAbort }) {
      await refresh(true); // la primera evaluación no debe leer una lista vieja
      return runWait({
        cond: until,
        timeoutMs: timeoutSec * 1000,
        baseline,
        sawWorkingBefore,
        isPromptWait,
        sentAt,
        refresh: () => refresh(true),
        // la detección propia de Herdr hace el papel de manifest en la compuerta de prompt-wait
        readStatus: () => {
          const row = find(id);
          return row ? { status: row.status ?? "idle", statusRule: "herdr", source: "manifest", sampledAt: cache.at } : null;
        },
        isAlive: () => find(id) !== null,
        onAbort,
        now,
      });
    },
    /** SSE: lee a ≥ 1 s; `gone` si el terminal desaparece de la lista o la lectura falla dos veces. */
    startStream({ id, tickMs, lineDiffs, write, end, minTickMs = HERDR_STREAM_MIN_TICK_MS }) {
      const interval = Math.max(minTickMs, tickMs || 0);
      let last = null;
      let closed = false;
      let altSent = false;
      let misses = 0;
      let readFails = 0;
      let timer = null;
      const stop = () => {
        closed = true;
        if (timer) clearTimeout(timer);
        timer = null;
      };
      const gone = () => {
        write("event: gone\ndata: {}\n\n");
        stop();
        end();
      };
      const tick = async () => {
        timer = null;
        try {
          if (!(await has(id))) {
            if (closed) return;
            if (++misses >= STREAM_MISS_LIMIT) return gone();
            return;
          }
          misses = 0;
          const r = await read(id);
          if (closed) return;
          if (!r.ok) {
            if (++readFails >= STREAM_MISS_LIMIT) return gone();
            return;
          }
          readFails = 0;
          const frame = streamFrame(last, r.text, lineDiffs);
          if (!altSent) {
            altSent = true;
            write(`event: alt\ndata: ${JSON.stringify({ alt: false, mouse_sgr: false })}\n\n`);
          }
          if (frame.same) return;
          write(`data: ${frame.payload}\n\n`);
          last = frame.lines;
        } finally {
          if (!closed) timer = setTimeout(tick, interval);
        }
      };
      tick();
      return { stop };
    },
  };
}
