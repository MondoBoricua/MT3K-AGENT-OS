// Adaptador finito sobre la CLI `herdr` 0.9.x (la app nueva de Herdr; distinta de `hc`, que habla con Herdr Core 0.1.x).
// Ids del panel: `h9:<pane>` con pane = `w1:p3` (workspace + pane; el sufijo del pane puede ser hex: `w1:pA`).
// Solo execFile con argv fijo y ids validados; nunca arranca ni para un servidor ni redimensiona: cada invocación pasa
// antes por un sondeo del socket (`~/.config/herdr/herdr.sock`) y sin servidor vivo no se ejecuta nada.
// Terminales "del panel": `herdr` 0.9 no tiene etiquetas por terminal, así que el panel crea una PESTAÑA con un nombre
// `mt3k-<agente>-<hash>-<sufijo>` y recuerda en memoria el `terminal_id` de lo que creó (ledger). Solo con AMBAS
// condiciones un terminal cuenta como del panel; cualquier otro exige `force` estricto para cerrarse (ver decideKill).
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { posix } from "node:path";
import { PANEL_LABEL_KEY, decideKill, mapAgent, mapStatus, probeUnixSocket } from "./herdr.mjs";

const TIMEOUT_MS = 5000;
const READ_TIMEOUT_MS = 8000;
const RUN_TIMEOUT_MS = 8000;
const MAX_BUFFER = 4 * 1024 * 1024;
const NEGATIVE_CACHE_MS = 2000;
const SEND_MAX_BYTES = 64 * 1024;
const READ_LINES_MAX = 2000;
const KEYS_MAX = 32;
const LEDGER_MAX = 512;
const LEDGER_GRACE_MS = 10000;
const CMD_ARGV_MAX = 64;
const CMD_ARG_MAX_BYTES = 8192;
// C0 salvo \t \n \r (texto pegado en un terminal); en rutas y argv no se admite ninguno
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;
const ANY_CONTROL_RE = /[\u0000-\u001f\u007f]/;
const KEY_RE = /^[A-Za-z0-9+_][A-Za-z0-9+_-]{0,23}$/;

export const H9_PREFIX = "h9:";
const PANE_RE = /^w[0-9]{1,6}:p[0-9A-Za-z]{1,8}$/;
const TAB_RE = /^w[0-9]{1,6}:t[0-9A-Za-z]{1,8}$/;
const TERMINAL_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Nombre de pestaña que crea el panel (ver `launchName` en herdr-launch.mjs). */
export const PANEL_TAB_RE = /^mt3k-[a-z0-9]{1,12}-[0-9a-f]{6}-[a-z0-9]{1,3}$/;

export const isHerdr9Id = (id) => typeof id === "string" && id.startsWith(H9_PREFIX) && PANE_RE.test(id.slice(H9_PREFIX.length));
/** `h9:w1:p3` → `w1:p3`; null si el id no es válido. */
export const paneOf = (id) => (isHerdr9Id(id) ? id.slice(H9_PREFIX.length) : null);

/**
 * El ÚNICO socket que se sondea y contra el que se ejecuta la CLI. Medido (0.9.5): con HERDR_SOCKET_PATH la CLI usa SOLO esa
 * ruta (`herdr status server --json` → "socket":"<ruta>", `pane list` → server_not_running, sin caer al socket por defecto);
 * sin ella usa ~/.config/herdr/herdr.sock. Un HERDR_SOCKET_PATH no absoluto → null (sin endpoint: nada se ejecuta).
 */
export function herdr9SocketPath({ env = process.env, home = homedir() } = {}) {
  const override = env.HERDR_SOCKET_PATH;
  if (override !== undefined && override !== "") return posix.isAbsolute(override) ? override : null;
  const config = env.XDG_CONFIG_HOME && posix.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : posix.join(env.HOME || home, ".config");
  return posix.join(config, "herdr", "herdr.sock");
}

function parseJson(text) {
  try { return JSON.parse(String(text)); } catch { return null; }
}

/** `herdr pane list` → filas normalizadas (mismo formato que `parseHcLs`, más tabId/terminalId). Nunca lanza. */
export function parsePaneList(text) {
  const panes = parseJson(text)?.result?.panes;
  if (!Array.isArray(panes)) return [];
  const rows = [];
  for (const p of panes) {
    if (!p || typeof p.pane_id !== "string" || !PANE_RE.test(p.pane_id)) continue;
    const str = (v) => (typeof v === "string" && v ? v : null);
    const app = str(p.agent);
    rows.push({
      id: `${H9_PREFIX}${p.pane_id}`,
      address: p.pane_id,
      agent: mapAgent(app),
      app,
      status: mapStatus(p.agent_status),
      cwd: str(p.foreground_cwd) ?? str(p.cwd) ?? "", // la carpeta ACTUAL del primer plano; la de lanzamiento solo de reserva
      where: str(p.terminal_title_stripped) ?? str(p.terminal_title),
      name: null,
      turn: 0, // herdr 0.9 no cuenta turnos
      tabId: str(p.tab_id) && TAB_RE.test(p.tab_id) ? p.tab_id : null,
      terminalId: str(p.terminal_id) && TERMINAL_RE.test(p.terminal_id) ? p.terminal_id : null,
      state: "live",
    });
  }
  return rows;
}

/** `herdr tab list` → Map tab_id → etiqueta. */
export function parseTabLabels(text) {
  const tabs = parseJson(text)?.result?.tabs;
  const out = new Map();
  if (!Array.isArray(tabs)) return out;
  for (const t of tabs) if (t && typeof t.tab_id === "string" && typeof t.label === "string") out.set(t.tab_id, t.label);
  return out;
}

/** Resultado de `herdr tab create` → { pane, tab, terminal } o null. */
export function parseTabCreate(text) {
  const r = parseJson(text)?.result;
  const pane = r?.root_pane?.pane_id;
  const tab = r?.tab?.tab_id ?? r?.root_pane?.tab_id;
  const terminal = r?.root_pane?.terminal_id;
  if (typeof pane !== "string" || !PANE_RE.test(pane) || typeof tab !== "string" || !TAB_RE.test(tab)) return null;
  return { pane, tab, terminal: typeof terminal === "string" && TERMINAL_RE.test(terminal) ? terminal : null };
}

/** Código de error de la CLI (`{"error":{"code":…}}`) del stdout/stderr de un fallo; null si no hay. */
export function parseErrorCode(text) {
  const c = parseJson(text)?.error?.code;
  return typeof c === "string" ? c : null;
}

/** Comillas simples POSIX (también válidas en fish): el argv se escribe como UNA línea en el shell del terminal nuevo. */
export const shellQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/** null = válido; si no, el mensaje. Para abrir una pestaña con un comando. */
export function openInputError({ cwd, label, argv }) {
  if (typeof label !== "string" || !PANEL_TAB_RE.test(label)) return "nombre inválido";
  if (typeof cwd !== "string" || !cwd.startsWith("/") || cwd.length > 4096 || ANY_CONTROL_RE.test(cwd)) return "carpeta inválida";
  if (!Array.isArray(argv) || argv.length > CMD_ARGV_MAX) return "comando inválido";
  for (const a of argv) {
    if (typeof a !== "string" || a.length === 0 || ANY_CONTROL_RE.test(a) || Buffer.byteLength(a, "utf8") > CMD_ARG_MAX_BYTES) return "comando inválido";
  }
  return null;
}

function runExec(exec, bin, argv, { timeout, env, maxBuffer = MAX_BUFFER }) {
  if (!bin) return Promise.resolve({ ok: false, code: "ENOENT" });
  return new Promise((resolve) => {
    try {
      exec(bin, argv, { timeout, maxBuffer, windowsHide: true, env: env ? { ...process.env, ...env } : process.env }, (err, stdout, stderr) => {
        if (err) resolve({ ok: false, code: err.code ?? "ERROR", out: String(stdout ?? ""), errOut: String(stderr ?? "") });
        else resolve({ ok: true, out: String(stdout ?? "") });
      });
    } catch (e) {
      resolve({ ok: false, code: e?.code ?? "ERROR" }); // p. ej. NUL en argv: execFile lanza síncrono
    }
  });
}

function validPane(id) {
  const pane = paneOf(id);
  return pane ? { ok: true, pane } : { ok: false, err: "terminal inválido" };
}

/** Fábrica de operaciones sobre `herdr` 0.9; ningún método lanza: siempre { ok } o listas vacías. */
export function createHerdr9({
  herdrPath = null,
  exec = execFile,
  env,
  now = Date.now,
  platform = process.platform,
  probe = probeUnixSocket,
  home = homedir(),
  timeoutMs, // opcional: sustituye TODOS los timeouts (solo para pruebas con un proceso lento real)
  ledger = new Set(), // terminal_id de los terminales que creó este proceso
} = {}) {
  let negative = null;
  let socketPath = null; // el endpoint sondeado por la última alive() positiva: la CLI se ejecuta contra ESTE mismo
  const born = new Map(); // terminal_id → instante de creación (el ledger no se poda durante un margen)
  let health = { ok: true }; // resultado del último `list`: distingue "0 terminales" de "el backend falla"

  /** ¿Acepta conexiones el socket del servidor? Sin caché positiva (≈1 ms); negativa ≤ 2 s. Nunca arranca nada. */
  async function alive() {
    if (platform === "win32" || !herdrPath) return false;
    const t = now();
    if (negative && t - negative.at < NEGATIVE_CACHE_MS) return false;
    const sock = herdr9SocketPath({ env: env ? { ...process.env, ...env } : process.env, home });
    const live = sock !== null && Boolean(await probe(sock));
    negative = live ? null : { at: t };
    socketPath = live ? sock : null;
    return live;
  }

  /** Única vía de ejecución de herdr: sin servidor vivo → NOCORE (nada se ejecuta). */
  async function execH(argv, timeout = TIMEOUT_MS, maxBuffer = MAX_BUFFER) {
    if (!(await alive())) return { ok: false, code: "NOCORE" };
    // HERDR_SOCKET_PATH explícito = el socket que se acaba de sondear (la CLI lo respeta, medido): nunca otro distinto
    return runExec(exec, herdrPath, argv, { timeout: timeoutMs ?? timeout, env: { ...env, HERDR_SOCKET_PATH: socketPath }, maxBuffer });
  }
  const unavailable = (r) => r.code === "ENOENT" || r.code === "NOCORE";
  const NA = "herdr no disponible";

  const remember = (terminal) => {
    if (!terminal) return;
    if (ledger.size >= LEDGER_MAX) { const oldest = ledger.values().next().value; ledger.delete(oldest); born.delete(oldest); }
    ledger.add(terminal);
    born.set(terminal, now());
  };
  const ownedBy = (terminalId, label) => Boolean(terminalId) && ledger.has(terminalId) && typeof label === "string" && PANEL_TAB_RE.test(label);

  function invalidate() { negative = null; }

  /**
   * Olvida los terminales recordados que ya no aparecen en una lista VÁLIDA: un id reutilizado después no hereda "abierto por el
   * panel". Margen tras la creación para que una lista que empezó antes de crear el terminal no lo poda.
   */
  function pruneLedger(rows) {
    const present = new Set(rows.map((r) => r.terminalId).filter(Boolean));
    const t = now();
    for (const id of [...ledger]) {
      if (present.has(id)) continue;
      const at = born.get(id);
      if (at !== undefined && t - at < LEDGER_GRACE_MS) continue;
      ledger.delete(id);
      born.delete(id);
    }
  }

  async function list() {
    if (!(await alive())) return [];
    const [panes, tabs] = await Promise.all([
      execH(["pane", "list"]),
      ledger.size ? execH(["tab", "list"]) : Promise.resolve(null), // sin nada creado por el panel no hace falta leer etiquetas
    ]);
    if (!panes.ok) {
      // NOCORE = el servidor cayó entre el sondeo y el exec: es "no corriendo", no un fallo del backend
      health = panes.code === "NOCORE" ? { ok: true } : { ok: false, err: `herdr pane list falló (${panes.code})` };
      return [];
    }
    if (!Array.isArray(parseJson(panes.out)?.result?.panes)) {
      health = { ok: false, err: "herdr pane list devolvió una salida ilegible" };
      return [];
    }
    const rows = parsePaneList(panes.out);
    pruneLedger(rows);
    // `tab list` fallido = filas degradadas (sin killable) pero el fallo se registra por la misma vía que el de `pane list`
    const tabsBad = tabs !== null && (!tabs.ok ? tabs.code !== "NOCORE" : !Array.isArray(parseJson(tabs.out)?.result?.tabs));
    health = tabsBad ? { ok: false, err: tabs.ok ? "herdr tab list devolvió una salida ilegible" : `herdr tab list falló (${tabs.code})` } : { ok: true };
    const labels = tabs?.ok ? parseTabLabels(tabs.out) : new Map();
    return rows.map((r) => (ownedBy(r.terminalId, labels.get(r.tabId)) ? { ...r, killable: true } : r));
  }

  /** `pane get` + etiqueta de su pestaña → forma de `hc get` (labels[mt3k.panel] = "1" solo si es del panel). */
  async function get(id) {
    const v = validPane(id);
    if (!v.ok) return v;
    const p = await execH(["pane", "get", v.pane]);
    const pane = p.ok ? parseJson(p.out)?.result?.pane : null;
    if (!pane) return { ok: false, err: unavailable(p) ? NA : "get falló" };
    const tabId = typeof pane.tab_id === "string" && TAB_RE.test(pane.tab_id) ? pane.tab_id : null;
    const terminalId = typeof pane.terminal_id === "string" && TERMINAL_RE.test(pane.terminal_id) ? pane.terminal_id : null;
    let tab = null;
    if (tabId) {
      const t = await execH(["tab", "get", tabId]);
      tab = t.ok ? parseJson(t.out)?.result?.tab ?? null : null;
    }
    const owned = ownedBy(terminalId, tab?.label);
    return {
      ok: true,
      state: "live",
      cwd: (typeof pane.foreground_cwd === "string" && pane.foreground_cwd) || (typeof pane.cwd === "string" ? pane.cwd : null),
      cols: null,
      rows: null,
      tabId,
      terminalId,
      labels: owned ? { [PANEL_LABEL_KEY]: "1" } : {},
    };
  }

  /** lines 0 = solo la pantalla visible; > 0 = esa cantidad de líneas recientes. `ansi` conserva el color (solo SGR, medido). */
  async function read(id, { lines = 0, ansi = false } = {}) {
    const v = validPane(id);
    if (!v.ok) return v;
    let n = Number(lines);
    if (!Number.isFinite(n) || n < 0) n = 0;
    n = Math.min(Math.trunc(n), READ_LINES_MAX);
    const argv = ["pane", "read", v.pane, "--source", n > 0 ? "recent" : "visible", ...(n > 0 ? ["--lines", String(n)] : []), ...(ansi ? ["--ansi"] : [])];
    const r = await execH(argv, READ_TIMEOUT_MS);
    if (!r.ok) return { ok: false, err: unavailable(r) ? NA : "lectura falló" };
    return { ok: true, text: String(r.out ?? "") };
  }

  /** Texto + Enter en una llamada (`pane run`); un texto que empieza por "-" se pasa tal cual (con `--` se escribiría literal; medido). */
  async function send(id, text) {
    const v = validPane(id);
    if (!v.ok) return v;
    if (typeof text !== "string" || text.length === 0) return { ok: false, err: "texto vacío" };
    if (Buffer.byteLength(text, "utf8") > SEND_MAX_BYTES) return { ok: false, err: "texto demasiado largo" };
    if (CONTROL_RE.test(text)) return { ok: false, err: "texto inválido" };
    const r = await execH(["pane", "run", v.pane, text]);
    if (r.ok) return { ok: true };
    return { ok: false, err: unavailable(r) ? NA : "envío falló" };
  }

  async function keys(id, keys) {
    const v = validPane(id);
    if (!v.ok) return v;
    const list = Array.isArray(keys) ? keys : [keys];
    if (list.length === 0 || list.length > KEYS_MAX || !list.every((k) => typeof k === "string" && KEY_RE.test(k))) return { ok: false, err: "teclas inválidas" };
    const r = await execH(["pane", "send-keys", v.pane, ...list]);
    if (r.ok) return { ok: true };
    return { ok: false, err: unavailable(r) ? NA : "teclas fallaron" };
  }

  /**
   * Abre una pestaña nueva (sin foco) con nombre del panel y escribe `argv` como una línea en su shell (cada argumento entre
   * comillas simples; sin `exec`: al salir el agente queda el shell). `argv` vacío = solo el shell. Si escribir el comando falla
   * se cierra la pestaña recién creada. { ok, pane, id, tab } | { ok:false, err, code? }.
   */
  async function openTab({ cwd, label, argv = [] } = {}) {
    const bad = openInputError({ cwd, label, argv });
    if (bad) return { ok: false, err: bad };
    const c = await execH(["tab", "create", "--no-focus", "--label", label, "--cwd", cwd], RUN_TIMEOUT_MS);
    if (!c.ok) return { ok: false, err: unavailable(c) ? NA : "no se pudo crear el terminal", code: c.code };
    const made = parseTabCreate(c.out);
    if (!made) return { ok: false, err: "herdr no devolvió el terminal" };
    remember(made.terminal);
    if (argv.length) {
      const r = await execH(["pane", "run", made.pane, argv.map(shellQuote).join(" ")], RUN_TIMEOUT_MS);
      if (!r.ok) {
        await execH(["pane", "close", made.pane]); // el pane es nuestro (recién creado); cerrar su único pane quita la pestaña (medido)
        return { ok: false, err: "no se pudo escribir el comando" };
      }
    }
    return { ok: true, pane: made.pane, id: `${H9_PREFIX}${made.pane}`, tab: made.tab };
  }

  /**
   * Cierra un terminal: relee `get` justo antes. Los del panel (pestaña con nombre del panel Y terminal en el ledger) se cierran;
   * los ajenos solo con `force === true`, si no 409 needsConfirm. SIEMPRE `pane close` del pane pedido: nunca `tab close`, porque
   * la pestaña pudo recibir otro pane entre la lectura y el cierre. Medido (0.9.5): cerrar el único pane de una pestaña la quita sola.
   */
  async function killTerminal(id, { force = false } = {}) {
    const info = await get(id);
    const decision = decideKill(info, force);
    if (!decision.kill) {
      const { kill: _k, ...denied } = decision;
      return { ok: false, ...denied };
    }
    const r = await execH(["pane", "close", paneOf(id)]);
    if (!r.ok) return { ok: false, status: 500, err: unavailable(r) ? NA : "cerrar falló" };
    if (info.terminalId) ledger.delete(info.terminalId);
    invalidate();
    return { ok: true, removed: true, forced: decision.forced };
  }

  /** { ok:true } | { ok:false, err }: estado del último `list` (nunca lanza ni ejecuta nada). */
  const getHealth = () => health;

  return { health: getHealth, running: alive, coreAlive: alive, coreUp: alive, invalidate, list, get, read, send, keys, openTab, killTerminal };
}
