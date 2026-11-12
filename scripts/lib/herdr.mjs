// Adaptador finito sobre `hc`: listar, leer y escribir en terminales Herdr que ya existen.
// Nunca crea, mata, redimensiona ni arranca un core por su cuenta; solo execFile con argv fijo.
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
 * Ruta absoluta de `hc`: primero ubicaciones conocidas, luego PATH con las mismas reglas de confianza que findGit.
 */
export function findHc({
  pathEnv = process.env.PATH || "",
  platform = process.platform,
  home = homedir(),
  localAppData = process.env.LOCALAPPDATA || "",
  exists,
  sep,
} = {}) {
  const P = pathFor(platform);
  const ok = exists ?? (platform === "win32" ? isFile : isExecutableFile);
  if (platform === "win32") {
    if (localAppData) {
      const bundled = P.join(localAppData, "Programs", "herdr-core", "hc.exe");
      if (ok(bundled)) return bundled;
    }
  } else {
    const bundled = posix.join(home, ".local", "bin", "hc");
    if (ok(bundled)) return bundled;
  }
  const names = platform === "win32" ? ["hc.exe"] : ["hc"];
  for (const entry of pathEnv.split(sep ?? P.delimiter)) {
    const dir = entry.trim().replace(/^"(.*)"$/, "$1");
    if (!dir || dir === ".") continue;
    if (platform === "win32" ? !WIN_QUALIFIED.test(dir) : !P.isAbsolute(dir)) continue;
    for (const name of names) {
      const full = P.join(dir, name);
      if (ok(full)) return full;
    }
  }
  return null;
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
  return {
    cwd: fg || launch,
    cols: size(d.cols),
    rows: size(d.rows),
    where: typeof d.labels?.where === "string" ? d.labels.where : null,
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

function runExec(exec, hcPath, argv, { timeout, env }) {
  if (!hcPath) return Promise.resolve({ ok: false, code: "ENOENT" });
  const mergedEnv = env ? { ...process.env, ...env } : process.env;
  return new Promise((resolve) => {
    try {
      exec(hcPath, argv, {
        timeout,
        maxBuffer: HC_MAX_BUFFER,
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
  async function execHc(argv, timeout = HC_TIMEOUT_MS) {
    if (!(await coreAlive())) return { ok: false, code: "NOCORE" };
    return runExec(exec, hcPath, argv, { timeout, env });
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

  return { running, coreAlive, list, get, read, send, keys, interrupt };
}
