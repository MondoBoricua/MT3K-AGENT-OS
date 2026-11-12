// Terminales de Herdr (hc) como panes del panel. Solo lectura de la lista, leer pantalla, texto y teclas.
// Nunca toca el ledger, tombstones, notificaciones ni tmux: server.mjs solo llama a estas funciones.
import { PANEL_LABEL_KEY, addressOf, createHerdr as realCreateHerdr, findHc as realFindHc, isHerdrId } from "./herdr.mjs";
import { createHerdrConn as realCreateConn } from "./herdr-conn.mjs";
import { paintToAnsiLines } from "./herdr-paint.mjs";
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
const DETAILS_TTL_MS = 30000; // carpeta actual: refresco máximo cada 30 s por terminal
const DETAILS_MAX_PER_POLL = 5; // `hc get` por ciclo de lista
const SIZE_MAX_AGE_MS = 5000; // el tamaño del snapshot nunca es más viejo que esto
const COLOR_FAIL_LIMIT = 3;
const PAINT_SLOW_MS = 150; // una conversión más lenta cuenta como fallo (bloquearía el servidor)
const COLOR_BACKOFF_MS = 60000;
const HEADLESS = { cols: 200, rows: 120 }; // tamaño al que un attach observer sin espectador mueve el terminal
const NO_VIEWER_PAUSE_MS = 10 * 60 * 1000;

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

/**
 * ¿Hay un terminal de Herdr vivo de este agente en esta carpeta? (ocupación para decidir si reanudar una conversación).
 * `normalize` lleva ambas carpetas a la misma forma (realpath + tilde); una carpeta ilegible no cuenta como ocupada.
 */
export function herdrOccupies(rows, agentId, normalizedCwd, normalize) {
  return rows.some((r) => {
    if (r.agent !== agentId || !r.cwd) return false;
    try { return normalize(r.cwd) === normalizedCwd; } catch { return false; }
  });
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
    ...(row.killable ? { killable: true } : {}), // solo los terminales que abrió el panel (etiqueta mt3k.panel=1)
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
  color = true,
  createConn = (hcPath, opts) => realCreateConn({ hcPath, ...opts }),
  paint = paintToAnsiLines,
  perfNow = () => performance.now(),
  log = (m) => console.warn(m),
} = {}) {
  let conn = null;
  const details = new Map(); // address → { at, where, status, cwd, cols, rows }
  const colorState = new Map(); // address → { fails, until }
  const resizeGuard = new Map(); // address → { verified, pausedUntil }
  let herdr = null;
  let hcPath = null;
  let hcCheckedAt = -Infinity;
  let cache = { at: -Infinity, rows: [] };
  let inflight = null;
  let generation = 0; // sube con cada invalidate(): un resultado de una generación anterior no toca la caché

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
        dropState();
        details.clear();
      }
    }
    return herdr;
  }

  // `hc ls` solo trae la carpeta de LANZAMIENTO; la actual está en `hc get` (foreground.cwd). Se consulta
  // solo si cambió `where`/estado o pasaron 30 s, máx. 5 por ciclo; sin dato se queda la de lanzamiento.
  async function enrich(h, rows) {
    if (typeof h.get !== "function") return rows;
    const alive = new Set(rows.map((r) => r.address));
    for (const k of details.keys()) if (!alive.has(k)) details.delete(k);
    for (const k of colorState.keys()) if (!alive.has(k)) colorState.delete(k);
    if (rows.length > 0) { // solo listas con datos: una lista vacía por core caído no cuenta como ausencia
      for (const [k, g] of resizeGuard) {
        if (g.pausedUntil && g.pausedUntil <= now()) resizeGuard.delete(k);
        else if (alive.has(k)) g.misses = 0;
        else if ((g.misses = (g.misses || 0) + 1) >= 2) resizeGuard.delete(k);
      }
    }
    const t = now();
    const changed = rows.filter((r) => { const d = details.get(r.address); return !d || d.where !== r.where || d.status !== r.status; });
    const stale = rows.filter((r) => { const d = details.get(r.address); return d && !changed.includes(r) && t - d.at >= DETAILS_TTL_MS; });
    await Promise.all([...changed, ...stale].slice(0, DETAILS_MAX_PER_POLL).map(async (r) => {
      const g = await h.get(r.id).catch(() => ({ ok: false }));
      const prev = details.get(r.address);
      const base = { at: now(), where: r.where, status: r.status };
      details.set(r.address, g.ok ? { ...base, cwd: g.cwd, cols: g.cols, rows: g.rows, labels: g.labels || {} } : { ...(prev || { cwd: null, cols: null, rows: null }), ...base });
    }));
    return rows.map((r) => {
      const d = details.get(r.address);
      const killable = d?.labels?.[PANEL_LABEL_KEY] === "1";
      if (!d?.cwd && !killable) return r;
      return { ...r, ...(d.cwd ? { cwd: d.cwd } : {}), ...(killable ? { killable: true } : {}) };
    });
  }

  // Core muerto o cambiado: se cierra el único `hc connect` y se olvida todo el estado derivado del core.
  function dropState() {
    conn?.close();
    conn = null;
    colorState.clear();
    // resizeGuard se conserva: una sonda fallida suelta no debe reiniciar la pausa de 10 min
  }

  /** Lista cacheada ≤ ttlMs (500 ms si se fuerza); una sola consulta en vuelo. */
  async function refresh(force = false) {
    const h = client();
    if (!h) return [];
    if (now() - cache.at < (force ? HERDR_FORCE_MIN_MS : ttlMs)) return cache.rows;
    if (inflight) return inflight;
    const myGen = generation;
    const mine = (async () => {
      let rows = [];
      try { rows = await enrich(h, await h.list()); } catch { rows = []; }
      if (rows.length === 0 && (conn || details.size) && typeof h.coreAlive === "function" && !(await h.coreAlive())) {
        dropState();
        details.clear();
      }
      if (myGen === generation) cache = { at: now(), rows };
      return rows;
    })().finally(() => { if (inflight === mine) inflight = null; });
    inflight = mine;
    return mine;
  }

  /** Olvida la lista cacheada (y las cachés del adaptador): tras crear o cerrar un terminal se lee de nuevo. */
  function invalidate() {
    generation++;
    cache = { at: -Infinity, rows: [] };
    inflight = null; // el siguiente refresh() hace una consulta nueva en vez de reutilizar la anterior
    herdr?.invalidate?.();
  }

  const find = (id) => cache.rows.find((r) => r.id === id) || null;
  const has = async (id, force = false) => {
    await refresh(force);
    return find(id) !== null;
  };

  async function read(id, lines = READ_HISTORY_LINES) {
    const h = client();
    if (!h) return { ok: false, err: "hc no disponible" };
    return h.read(id, { lines });
  }

  // Tamaño ACTUAL del terminal (≤ 5 s de antigüedad); sin él no se pide snapshot (nunca se adivina un tamaño).
  async function currentSize(h, id, address, fresh = false) {
    let d = details.get(address);
    if (fresh || !d || d.cols === null || now() - d.at > SIZE_MAX_AGE_MS) {
      const g = typeof h.get === "function" ? await h.get(id).catch(() => ({ ok: false })) : { ok: false };
      if (!g.ok) return null;
      d = { ...(d || { where: null, status: null }), at: now(), cwd: g.cwd, cols: g.cols, rows: g.rows };
      details.set(address, d);
    }
    return d.cols && d.rows ? { cols: d.cols, rows: d.rows } : null;
  }

  async function colored(h, id, address) {
    if (typeof h.coreAlive === "function" && !(await h.coreAlive())) { dropState(); return null; }
    const st = colorState.get(address) || { fails: 0, until: 0 };
    if (now() < st.until) return null;
    let guard = resizeGuard.get(address);
    if (guard && guard.pausedUntil > now()) return null; // sin visor humano: texto plano hasta que pase la pausa
    if (guard && guard.pausedUntil) { guard = null; resizeGuard.delete(address); }
    // S0: tamaño leído con `hc get` ANTES del primer snapshot de este terminal
    const size = await currentSize(h, id, address, !guard);
    if (!size) return null;
    // fuera de 20..500 x 5..300 el snapshot se pediría con otro tamaño (y movería/ensuciaría la comparación): texto plano
    if (size.cols < 20 || size.cols > 500 || size.rows < 5 || size.rows > 300) return null;
    const headless = size.cols === HEADLESS.cols && size.rows === HEADLESS.rows; // el attach no cambia nada
    conn ||= createConn(hcPath, { canSpawn: () => h.coreAlive() });
    let text = null;
    let resized = false;
    try {
      // OJO: un attach observer SIN espectador humano mueve el terminal al tamaño headless (200x120) pase lo
      // que pase (spike PROTOCOL.md §6; SIGWINCH al programa, persiste tras el detach) e `hc get` no dice si hay
      // visor. Por eso: solo se pide el tamaño ACTUAL, se compara con el tamaño autoritativo de la respuesta del
      // attach (y con un `hc get` tras el primer snapshot) y, si cambió, se pausa la vista en color de ese
      // terminal 10 min. Peor caso aceptado: un resize por terminal sin visor cada 10 min; `MT3K_HERDR_COLOR=0`
      // lo evita por completo.
      const snap = await conn.snapshot(address, { cols: size.cols, rows: size.rows, history: READ_HISTORY_LINES });
      if (snap.ok) {
        if (!headless && (snap.cols !== size.cols || snap.rows !== size.rows)) resized = true;
        if (!headless && !resized && !guard?.verified) {
          const g = await h.get(id).catch(() => ({ ok: false }));
          if (g.ok && (g.cols !== size.cols || g.rows !== size.rows)) resized = true;
        }
        const t0 = perfNow();
        const p = paint(snap.bytes, { cols: snap.cols, rows: snap.rows });
        if (p.complete && p.lines.length > 0 && perfNow() - t0 <= PAINT_SLOW_MS) text = p.lines.join("\n");
      }
    } catch { text = null; }
    if (resized) {
      resizeGuard.set(address, { verified: true, pausedUntil: now() + NO_VIEWER_PAUSE_MS });
      details.delete(address);
      log(`[mt3k] herdr: ${address} sin visor; vista en texto plano`);
    } else if (!guard) resizeGuard.set(address, { verified: true, pausedUntil: 0 });
    if (text !== null) colorState.set(address, { fails: 0, until: 0 });
    else {
      const fails = st.fails + 1;
      colorState.set(address, fails >= COLOR_FAIL_LIMIT ? { fails: 0, until: now() + COLOR_BACKOFF_MS } : { fails, until: 0 });
    }
    return text;
  }

  /** Vista del terminal para /api/pane y SSE: SGR vía snapshot; texto plano de `hc read` si falla o está apagado. */
  async function view(id) {
    const h = client();
    if (!h) return { ok: false, err: "hc no disponible" };
    const address = addressOf(id);
    if (color && address) {
      const text = await colored(h, id, address);
      if (text !== null) return { ok: true, text, colored: true };
    }
    return read(id);
  }

  async function tailOf(id) {
    const r = await read(id, 0); // solo la pantalla: basta para las últimas 12 líneas
    if (!r.ok) return [];
    return r.text.trimEnd().split(/\r?\n/).filter((l) => l.trim().length > 0).slice(-TAIL_LINES);
  }

  const CLIENT_ERRORS = new Set(["texto inválido", "texto vacío", "texto demasiado largo", "teclas inválidas", "terminal inválido"]);
  const failure = (r) => {
    if (r.err === HERDR_BLOCKED) return { status: 409, body: { ok: false, err: HERDR_BLOCKED } };
    return { status: CLIENT_ERRORS.has(r.err) ? 400 : 500, body: { ok: false, err: r.err } };
  };

  return {
    enabled,
    refresh,
    invalidate,
    /** Lista ya cacheada, sin consultar hc (para decisiones que nunca deben tocar el core). */
    cachedRows: () => cache.rows,
    /** Adaptador hc (o null con MT3K_HERDR=0 / sin hc): lo usa el lanzador de lib/herdr-launch.mjs. */
    hc: client,
    has,
    read,
    view,
    /** Cierra el único `hc connect` (rutas de apagado del servidor). */
    close() { conn?.close(); conn = null; },
    connStats() { return conn ? conn.stats() : null; },
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
          const r = await view(id);
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
