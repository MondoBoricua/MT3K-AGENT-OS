// Adaptador finito sobre `hc`: listar, leer y escribir en terminales Herdr que ya existen.
// Crear (`run`) y cerrar (`killTerminal`) solo con core vivo; cerrar uno sin la marca `mt3k.panel=1` exige `force` estricto.
// Nunca redimensiona ni arranca un core por su cuenta; solo execFile con argv fijo.
import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

const HC_TIMEOUT_MS = 5000;
const HC_READ_TIMEOUT_MS = 8000;
const HC_MAX_BUFFER = 4 * 1024 * 1024;
const RUNNING_CACHE_MS = 5000;
const SOCKET_PROBE_TIMEOUT_MS = 300;
const NEGATIVE_CACHE_MS = 2000;
// C0 salvo \t \n \r: execFile lanza con NUL y el resto no tiene sentido pegado en un terminal
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;
const SEND_MAX_BYTES = 64 * 1024;
const READ_LINES_MAX = 2000;
const KEYS_MAX = 32;
// sin "-" inicial: `hc keys t1 -h` lo toma como opción; además se pasa tras `--`
const KEY_RE = /^[A-Za-z0-9+_][A-Za-z0-9+_-]{0,23}$/;
const ADDRESS_RE = /^t[0-9]{1,6}[a-z]?$/;
const HERDR_ID_RE = /^hc:t[0-9]{1,6}[a-z]?$/;
const HC_RUN_TIMEOUT_MS = 8000;
const RUN_MAX_BUFFER = 256 * 1024;
const RUN_ARGV_MAX = 64;
const RUN_ARG_MAX_BYTES = 8192;
const RUN_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/; // `hc run --name`: 1-32 de a-z 0-9 - _
/** Etiqueta con la que el panel marca los terminales que él mismo creó (única condición para poder cerrarlos). */
export const PANEL_LABEL_KEY = "mt3k.panel";
export const PANEL_LABEL = `${PANEL_LABEL_KEY}=1`;

const pathFor = (platform) => (platform === "win32" ? win32 : posix);
const WIN_QUALIFIED = /^[A-Za-z]:[\\/]/;

const isSocketFile = (p) => { try { return statSync(p).isSocket(); } catch { return false; } };
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
const isExecutableFile = (p) => {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * Ruta absoluta de un binario de Herdr: primero la ubicación conocida, luego PATH con las mismas reglas de confianza
 * que findGit (solo entradas absolutas, nunca "." ni el directorio actual).
 */
function findBinary({ name, winBundled, pathEnv, platform, home, localAppData, exists, sep }) {
  const P = pathFor(platform);
  const ok = exists ?? (platform === "win32" ? isFile : isExecutableFile);
  if (platform === "win32") {
    if (localAppData) {
      const bundled = P.join(localAppData, ...winBundled);
      if (ok(bundled)) return bundled;
    }
  } else {
    const bundled = posix.join(home, ".local", "bin", name);
    if (ok(bundled)) return bundled;
  }
  const names = platform === "win32" ? [`${name}.exe`] : [name];
  for (const entry of pathEnv.split(sep ?? P.delimiter)) {
    const dir = entry.trim().replace(/^"(.*)"$/, "$1");
    if (!dir || dir === ".") continue;
    if (platform === "win32" ? !WIN_QUALIFIED.test(dir) : !P.isAbsolute(dir)) continue;
    for (const n of names) {
      const full = P.join(dir, n);
      if (ok(full)) return full;
    }
  }
  return null;
}

const finderDefaults = () => ({
  pathEnv: process.env.PATH || "",
  platform: process.platform,
  home: homedir(),
  localAppData: process.env.LOCALAPPDATA || "",
});

/** Ruta absoluta de `hc`: ubicaciones conocidas y luego PATH. */
export function findHc(opts = {}) {
  return findBinary({ name: "hc", winBundled: ["Programs", "herdr-core", "hc.exe"], ...finderDefaults(), ...opts });
}

/** Ruta absoluta de `herdr-app` (la ventana de escritorio de Herdr), con las mismas reglas de confianza que `findHc`. */
export function findHerdrApp(opts = {}) {
  return findBinary({ name: "herdr-app", winBundled: ["Programs", "herdr-app", "herdr-app.exe"], ...finderDefaults(), ...opts });
}

/**
 * Sockets unix donde puede escuchar el core en POSIX. Medido en esta Mac (hc 0.1.20):
 * sin XDG_RUNTIME_DIR → ${XDG_STATE_HOME:-~/.local/state}/herdr-core/<s>/<s>.sock; con XDG_RUNTIME_DIR
 * → $XDG_RUNTIME_DIR/herdr-core/<s>.sock. `core.json` solo trae id/name/machine_id (sin pid).
 */
export function coreSocketCandidates({ env = process.env, home = homedir(), isSocket = isSocketFile } = {}) {
  const session = env.HC_SESSION || "default";
  const state = env.XDG_STATE_HOME || posix.join(env.HOME || home, ".local", "state");
  const out = [posix.join(state, "herdr-core", session, `${session}.sock`)];
  if (env.XDG_RUNTIME_DIR) out.unshift(posix.join(env.XDG_RUNTIME_DIR, "herdr-core", `${session}.sock`));
  // HC_SOCKET: se respeta solo si es una ruta absoluta a un socket que existe; si no, se ignora.
  if (env.HC_SOCKET && posix.isAbsolute(env.HC_SOCKET) && isSocket(env.HC_SOCKET)) out.unshift(env.HC_SOCKET);
  return out;
}

/** ¿Alguien acepta conexiones en este socket unix? ENOENT/ECONNREFUSED/timeout → false. Nunca lanza. */
export function probeUnixSocket(sockPath, timeoutMs = SOCKET_PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value, sock) => {
      if (done) return;
      done = true;
      try { sock?.destroy(); } catch { /* ya cerrado */ }
      resolve(value);
    };
    let sock;
    try {
      sock = netConnect({ path: sockPath });
    } catch {
      resolve(false);
      return;
    }
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true, sock));
    sock.once("timeout", () => finish(false, sock));
    sock.once("error", () => finish(false, sock));
  });
}

/** Nombre de app/agente de Herdr → id de agente que entiende el panel */
export function mapAgent(app) {
  const a = app == null ? "" : String(app).toLowerCase();
  if (a === "claude-code" || a === "claude") return "claude";
  if (a === "codex") return "codex";
  if (a === "opencode") return "opencode";
  if (a === "grok") return "grok";
  if (a === "cursor" || a === "cursor-agent" || a === "agent") return "cursor";
  if (a === "agy" || a === "antigravity") return "antigravity";
  if (a === "copilot") return "copilot";
  if (a === "zcode") return "zcode";
  if (a === "dsh" || a === "deepseek") return "deepseek";
  return "shell";
}

/** Estado de Herdr (string en `ls`, objeto en `get`) → estado del panel */
export function mapStatus(status) {
  if (status == null) return null;
  let raw;
  if (typeof status === "string") raw = status;
  else if (typeof status === "object" && status.state != null) raw = String(status.state);
  else return null;
  const s = raw.toLowerCase();
  if (s === "error") return "blocked";
  if (s === "working" || s === "idle" || s === "done" || s === "blocked") return s;
  return null;
}

export function isHerdrId(id) {
  return typeof id === "string" && HERDR_ID_RE.test(id);
}

/** `hc:t9` → `t9` si el id es válido; si no, null */
export function addressOf(id) {
  if (!isHerdrId(id)) return null;
  return id.slice(3);
}

/** JSON de `hc ls --json` → filas normalizadas para el panel (solo parseo puro, para tests) */
export function parseHcLs(jsonText) {
  let data;
  try {
    data = JSON.parse(String(jsonText));
  } catch {
    return [];
  }
  const terms = Array.isArray(data?.terminals) ? data.terminals : [];
  const out = [];
  for (const t of terms) {
    if (!t || t.state !== "live") continue;
    const address = typeof t.address === "string" ? t.address : "";
    if (!ADDRESS_RE.test(address)) continue;
    const app = t.agent ?? null;
    out.push({
      id: `hc:${address}`,
      address,
      agent: mapAgent(app),
      app: app ?? null,
      status: mapStatus(t.status),
      cwd: typeof t.cwd === "string" ? t.cwd : "",
      where: typeof t.where === "string" ? t.where : null,
      name: typeof t.name === "string" ? t.name : t.name == null ? null : String(t.name),
      turn: typeof t.turn === "number" && Number.isFinite(t.turn) ? t.turn : 0,
      parent: typeof t.parent === "string" && ADDRESS_RE.test(t.parent) ? t.parent : null,
      state: "live",
    });
  }
  return out;
}

/**
 * `hc get <t> --json` → carpeta ACTUAL y tamaño. Medido (t9, hc 0.1.20): `foreground.cwd` es la carpeta del
 * proceso en primer plano (la de `cwd` es la de lanzamiento); `cols`/`rows` de primer nivel son el tamaño actual.
 */
export function parseHcGet(jsonText) {
  let d;
  try { d = JSON.parse(String(jsonText)); } catch { return null; }
  if (!d || typeof d !== "object") return null;
  const fg = typeof d.foreground?.cwd === "string" && d.foreground.cwd ? d.foreground.cwd : null;
  const launch = typeof d.cwd === "string" && d.cwd ? d.cwd : null;
  const size = (n) => (Number.isInteger(n) && n > 0 && n < 10000 ? n : null);
  const labels = {};
  if (d.labels && typeof d.labels === "object" && !Array.isArray(d.labels)) {
    for (const [k, v] of Object.entries(d.labels)) if (typeof v === "string") labels[k] = v;
  }
  return {
    cwd: fg || launch,
    cols: size(d.cols),
    rows: size(d.rows),
    where: typeof d.labels?.where === "string" ? d.labels.where : null,
    labels,
    state: typeof d.state === "string" ? d.state : null,
  };
}

/** Respuesta de `hc server status --json` → ¿hay un core con sesiones reales? (sin contar autostart vacío) */
export function coreRunningFromStatus(jsonText) {
  try {
    const data = JSON.parse(String(jsonText));
    const live = Number(data?.live);
    if (Number.isFinite(live) && live > 0) return true;
    return data?.holder?.current === true;
  } catch {
    return false;
  }
}

function validateAddressFromId(id) {
  if (!isHerdrId(id)) return { ok: false, err: "terminal inválido" };
  const address = addressOf(id);
  if (!address || !ADDRESS_RE.test(address)) return { ok: false, err: "terminal inválido" };
  if (address.startsWith("-")) return { ok: false, err: "terminal inválido" };
  return { ok: true, address };
}

function runExec(exec, hcPath, argv, { timeout, env, maxBuffer = HC_MAX_BUFFER }) {
  if (!hcPath) return Promise.resolve({ ok: false, code: "ENOENT" });
  const mergedEnv = env ? { ...process.env, ...env } : process.env;
  return new Promise((resolve) => {
    try {
      exec(hcPath, argv, {
        timeout,
        maxBuffer,
        windowsHide: true,
        env: mergedEnv,
      }, (err, stdout) => {
        if (err) resolve({ ok: false, code: err.code ?? "ERROR", out: stdout });
        else resolve({ ok: true, out: stdout });
      });
    } catch (e) {
      resolve({ ok: false, code: e?.code ?? "ERROR" }); // p. ej. NUL en argv: execFile lanza síncrono
    }
  });
}

/** Valida lo que `run` recibe; null = válido, si no el mensaje. Todo va tras `--`, pero NUL/tamaños se cortan aquí. */
function runInputError({ argv, cwd, name }) {
  if (typeof name !== "string" || !RUN_NAME_RE.test(name)) return "nombre inválido";
  if (typeof cwd !== "string" || cwd.length === 0 || cwd.length > 4096 || cwd.includes("\0") || !(cwd.startsWith("/") || WIN_QUALIFIED.test(cwd))) return "carpeta inválida";
  if (!Array.isArray(argv) || argv.length > RUN_ARGV_MAX) return "comando inválido";
  for (const a of argv) {
    if (typeof a !== "string" || a.length === 0 || a.includes("\0") || Buffer.byteLength(a, "utf8") > RUN_ARG_MAX_BYTES) return "comando inválido";
  }
  return null;
}

export const KILL_NEEDS_CONFIRM = "esta terminal no la abrió el panel; confirma para cerrarla";

/**
 * Decisión pura de cierre sobre el resultado de `get`: solo un terminal VIVO se cierra; uno del panel
 * (mt3k.panel=1) siempre, uno ajeno solo con force === true (booleano estricto).
 */
export function decideKill(info, force) {
  if (!info || info.ok !== true) {
    return info?.err === "terminal inválido" ? { kill: false, status: 400, err: info.err } : { kill: false, status: 404, err: "ese pane ya no existe" };
  }
  if (info.state !== "live") return { kill: false, status: 404, err: "ese pane ya no existe" };
  if (info.labels?.[PANEL_LABEL_KEY] === "1") return { kill: true, forced: false };
  if (force === true) return { kill: true, forced: true };
  return { kill: false, status: 409, needsConfirm: true, err: KILL_NEEDS_CONFIRM };
}

/** Dirección `tN` del JSON de `hc run`/`hc label`; null si no hay una válida. */
export function parseHcAddress(jsonText) {
  try {
    const a = JSON.parse(String(jsonText))?.address;
    return typeof a === "string" && ADDRESS_RE.test(a) ? a : null;
  } catch {
    return null;
  }
}

/** ¿El stdout de un `hc` fallido dice `name_taken`? (se reintenta con otro nombre) */
export function isNameTaken(jsonText) {
  try { return JSON.parse(String(jsonText))?.error?.kind === "name_taken"; } catch { return false; }
}

function sendArgv(address, text) {
  const base = ["send", address];
  if (typeof text === "string" && text.startsWith("-")) return [...base, "--", text];
  return [...base, text];
}

/**
 * Fábrica de operaciones Herdr; ningún método lanza: siempre devuelve objetos { ok } o listas vacías.
 */
export function createHerdr({
  hcPath = null,
  exec = execFile,
  env,
  now = Date.now,
  platform = process.platform,
  probe = probeUnixSocket,
} = {}) {
  let runningCache = null;
  let negative = null; // { at } último sondeo NEGATIVO (se reutiliza ≤ NEGATIVE_CACHE_MS)

  /**
   * POSIX: ¿acepta conexiones el socket del core? SIN caché positiva (≈1 ms): `hc get|read|ls|connect|server status`
   * AUTOARRANCAN un core vacío si no hay ninguno (medido), así que TODA invocación de hc pasa antes por aquí.
   * Carrera inevitable: el core puede morir entre este sondeo y el exec (~1 ms); no se puede cerrar sin cooperación de hc.
   * win32: `hc server status` nunca arranca un core (manual), no se sondea.
   */
  async function coreAlive() {
    if (platform === "win32") return true;
    if (!hcPath) return false;
    const t = now();
    if (negative && t - negative.at < NEGATIVE_CACHE_MS) return false;
    const socks = coreSocketCandidates({ env: env ? { ...process.env, ...env } : process.env });
    const alive = (await Promise.all(socks.map((sk) => probe(sk)))).some(Boolean);
    if (alive) { negative = null; return true; }
    negative = { at: t };
    runningCache = { value: false, at: t };
    return false;
  }

  /** Única vía de ejecución de hc. */
  async function execHc(argv, timeout = HC_TIMEOUT_MS, maxBuffer = HC_MAX_BUFFER) {
    if (!(await coreAlive())) return { ok: false, code: "NOCORE" };
    return runExec(exec, hcPath, argv, { timeout, env, maxBuffer });
  }
  const unavailable = (r) => r.code === "ENOENT" || r.code === "NOCORE";

  async function running() {
    const t = now();
    if (runningCache && t - runningCache.at < RUNNING_CACHE_MS) return runningCache.value;
    if (!hcPath) {
      runningCache = { value: false, at: t };
      return false;
    }
    const r = await execHc(["server", "status", "--json"]);
    const value = r.ok ? coreRunningFromStatus(r.out) : false;
    runningCache = { value, at: t };
    return value;
  }

  async function list() {
    if (!hcPath) return [];
    if (!(await running())) return [];
    const r = await execHc(["ls", "--json"]);
    if (!r.ok) { if (r.code === "NOCORE") runningCache = { value: false, at: now() }; return []; }
    return parseHcLs(r.out);
  }

  async function get(id) {
    const v = validateAddressFromId(id);
    if (!v.ok) return v;
    const r = await execHc(["get", v.address, "--json"]);
    if (!r.ok) return { ok: false, err: unavailable(r) ? "hc no disponible" : "get falló" };
    const info = parseHcGet(r.out);
    return info ? { ok: true, ...info } : { ok: false, err: "get falló" };
  }

  async function read(id, { lines = 0 } = {}) {
    const v = validateAddressFromId(id);
    if (!v.ok) return v;
    let n = Number(lines);
    if (!Number.isFinite(n) || n < 0) n = 0;
    if (n > READ_LINES_MAX) n = READ_LINES_MAX;
    const argv = ["read", v.address, "--lines", String(Math.trunc(n))];
    const r = await execHc(argv, HC_READ_TIMEOUT_MS);
    if (!r.ok) {
      if (unavailable(r)) return { ok: false, err: "hc no disponible" };
      return { ok: false, err: "lectura falló" };
    }
    return { ok: true, text: String(r.out ?? "") };
  }

  async function send(id, text) {
    const v = validateAddressFromId(id);
    if (!v.ok) return v;
    if (typeof text !== "string" || text.length === 0) return { ok: false, err: "texto vacío" };
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > SEND_MAX_BYTES) return { ok: false, err: "texto demasiado largo" };
    if (CONTROL_RE.test(text)) return { ok: false, err: "texto inválido" };
    const r = await execHc(sendArgv(v.address, text));
    if (r.ok) return { ok: true };
    if (r.code === 9) return { ok: false, err: "bloqueado: requiere a la persona" };
    if (unavailable(r)) return { ok: false, err: "hc no disponible" };
    return { ok: false, err: "envío falló" };
  }

  async function keys(id, keys) {
    const v = validateAddressFromId(id);
    if (!v.ok) return v;
    const list = Array.isArray(keys) ? keys : [keys];
    if (list.length === 0 || list.length > KEYS_MAX) return { ok: false, err: "teclas inválidas" };
    for (const k of list) {
      if (typeof k !== "string" || !KEY_RE.test(k)) return { ok: false, err: "teclas inválidas" };
    }
    const r = await execHc(["keys", v.address, "--", ...list]);
    if (r.ok) return { ok: true };
    if (unavailable(r)) return { ok: false, err: "hc no disponible" };
    return { ok: false, err: "teclas fallaron" };
  }

  async function interrupt(id) {
    const v = validateAddressFromId(id);
    if (!v.ok) return v;
    const r = await execHc(["interrupt", v.address]);
    if (r.ok) return { ok: true };
    if (unavailable(r)) return { ok: false, err: "hc no disponible" };
    return { ok: false, err: "interrupción falló" };
  }

  /** Olvida cachés (running/negativo): tras crear o cerrar un terminal la lista debe leerse de nuevo. */
  function invalidate() {
    runningCache = null;
    negative = null;
  }

  /**
   * ¿Hay un core al que crear un terminal? POSIX: sondeo del socket (nunca arranca nada). win32: `hc server status`
   * (medido en POSIX que no arranca; en Windows es manual por diseño de hc y NO está verificado aquí).
   */
  async function coreUp() {
    if (!hcPath) return false;
    if (platform !== "win32") return coreAlive();
    const r = await execHc(["server", "status", "--json"]);
    if (!r.ok) return false;
    try { return Boolean(JSON.parse(String(r.out))?.core); } catch { return false; }
  }

  /**
   * Crea un terminal en segundo plano, sin padre, ya marcado `mt3k.panel=1`. `argv` vacío = shell de hc.
   * Devuelve { ok, address, id } | { ok:false, err, code?, nameTaken? }. Nunca arranca un core (execHc sondea antes).
   */
  async function run({ argv = [], cwd, name } = {}) {
    const bad = runInputError({ argv, cwd, name });
    if (bad) return { ok: false, err: bad };
    const args = ["run", "--bg", "--no-parent", "--json", "--name", name, "--cwd", cwd, "--label", PANEL_LABEL];
    if (argv.length) args.push("--", ...argv);
    const r = await execHc(args, HC_RUN_TIMEOUT_MS, RUN_MAX_BUFFER);
    if (!r.ok) {
      if (unavailable(r)) return { ok: false, err: "hc no disponible", code: r.code };
      return { ok: false, err: "no se pudo crear el terminal", nameTaken: isNameTaken(r.out) };
    }
    const address = parseHcAddress(r.out);
    if (!address) return { ok: false, err: "hc no devolvió el terminal" };
    invalidate();
    return { ok: true, address, id: `hc:${address}` };
  }

  /** `hc label <t> mt3k.panel=1` (clave/valor fijos del panel; para terminales creados por `herdr-app do`). */
  async function markOwned(id) {
    const v = validateAddressFromId(id);
    if (!v.ok) return v;
    const r = await execHc(["label", v.address, "--json", PANEL_LABEL]);
    if (r.ok) return { ok: true };
    return { ok: false, err: unavailable(r) ? "hc no disponible" : "etiquetar falló" };
  }

  /**
   * Cierra un terminal: relee `hc get` justo antes (debe existir y estar vivo). Los del panel (`mt3k.panel=1`) se cierran;
   * los ajenos solo con `force === true`, si no 409 needsConfirm y no se toca nada (ver decideKill).
   * `hc kill` y luego `hc rm`; si rm falla (terminal aún no terminado) no es error: queda terminado y hc lo oculta.
   */
  async function killTerminal(id, { force = false } = {}) {
    const decision = decideKill(await get(id), force);
    if (!decision.kill) {
      const { kill: _k, ...denied } = decision;
      return { ok: false, ...denied };
    }
    const address = addressOf(id);
    const k = await execHc(["kill", address, "--json"]);
    if (!k.ok) return { ok: false, status: 500, err: unavailable(k) ? "hc no disponible" : "kill falló" };
    const rm = await execHc(["rm", address, "--json"]);
    invalidate();
    return { ok: true, removed: rm.ok, forced: decision.forced };
  }

  return { running, coreAlive, coreUp, invalidate, list, get, read, send, keys, interrupt, run, markOwned, killTerminal };
}
