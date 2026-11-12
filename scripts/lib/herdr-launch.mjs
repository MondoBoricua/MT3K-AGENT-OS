// Crear sesiones NUEVAS en Herdr desde el panel. Dos estrategias, ambas con argv fijo y sin shell:
//   1. app:  la ventana de Herdr está abierta → `herdr-app do tab.new|space.new` (la sesión aparece como pestaña).
//   2. core: solo hay core → `hc run --bg --no-parent` (terminal sin pantalla, visible con `hc ls`).
// Nunca arranca un core ni la app: sin core vivo devuelve { reason: "no-core" } y el servidor abre en tmux.
// Los ejecutables y el argv los decide el servidor (tabla de lanzamiento); aquí solo se arma y se valida.
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { basename } from "node:path";
import { findHerdrApp } from "./herdr.mjs";

const APP_STATUS_TIMEOUT_MS = 1500;
const APP_LS_TIMEOUT_MS = 4000;
const APP_DO_TIMEOUT_MS = 8000;
const APP_MAX_BUFFER = 512 * 1024;
const NAME_ATTEMPTS = 2;
const ADDRESS_RE = /^t[0-9]{1,6}[a-z]?$/;
const AGENT_SLUG_MAX = 12;

/** `env` de `exec` de un `execFile`-like: (file, args, opts, cb). Devuelve { ok, out, code }. */
function runApp(exec, appPath, argv, timeout, env) {
  return new Promise((resolve) => {
    try {
      exec(appPath, argv, { timeout, maxBuffer: APP_MAX_BUFFER, windowsHide: true, env: env ? { ...process.env, ...env } : process.env }, (err, stdout) => {
        if (err) resolve({ ok: false, code: err.code ?? "ERROR", killed: err.killed === true || Boolean(err.signal), out: String(stdout ?? "") });
        else resolve({ ok: true, out: String(stdout ?? "") });
      });
    } catch (e) {
      resolve({ ok: false, code: e?.code ?? "ERROR", out: "" });
    }
  });
}

/** mt3k-<agente>-<hash6 de la carpeta>-<sufijo>: a-z 0-9 - _ y ≤ 32 (límite de `hc run --name`). */
export function launchName(agentId, cwd, suffix = randomBytes(2).toString("hex").slice(0, 3)) {
  const agent = String(agentId || "x").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, AGENT_SLUG_MAX) || "x";
  const hash = createHash("sha1").update(String(cwd)).digest("hex").slice(0, 6);
  const tail = String(suffix).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 3) || "0";
  return `mt3k-${agent}-${hash}-${tail}`;
}

const stripSlash = (p) => (p.length > 1 ? p.replace(/[\\/]+$/, "") : p);

/** `herdr-app ls` → [{ id, name, folder }] (solo espacios con id y carpeta en texto). */
export function parseAppSpaces(jsonText) {
  let data;
  try { data = JSON.parse(String(jsonText)); } catch { return []; }
  const spaces = Array.isArray(data?.spaces) ? data.spaces : [];
  return spaces
    .filter((s) => s && typeof s.id === "string" && s.id && typeof s.folder === "string" && s.folder)
    .map((s) => ({ id: s.id, name: typeof s.name === "string" ? s.name : "", folder: s.folder, remote: typeof s.machine === "string" && s.machine !== "" }));
}

/** Espacio LOCAL cuya carpeta es exactamente `cwd` (sin barra final); null si no hay. */
export function findSpaceByFolder(spaces, cwd) {
  const want = stripSlash(String(cwd));
  return spaces.find((s) => !s.remote && stripSlash(s.folder) === want) || null;
}

/**
 * Argv de `herdr-app do …`. Se pasa UN objeto JSON como único argumento (forma documentada en `herdr-app --skill`):
 * ningún valor puede leerse como opción aunque empiece por "-" (p. ej. una carpeta llamada "-x").
 */
export function appDoArgv({ space, folder, argv, agentName, spaceName }) {
  const common = { folder, ...(argv.length ? { argv } : {}) };
  if (space) return ["do", "tab.new", JSON.stringify({ space, name: agentName, ...common })];
  return ["do", "space.new", JSON.stringify({ name: spaceName, ...common })];
}

/** Dirección `tN` del campo `terminal` de la respuesta de `herdr-app do`; null si falta o no es válida. */
export function parseAppTerminal(jsonText) {
  try {
    const t = JSON.parse(String(jsonText))?.terminal;
    return typeof t === "string" && ADDRESS_RE.test(t) ? t : null;
  } catch {
    return null;
  }
}

export function createHerdrLauncher({
  getHerdr = () => null, // () => adaptador `createHerdr(...)` o null (sin hc / MT3K_HERDR=0)
  findApp = findHerdrApp,
  exec = execFile,
  env,
  nameSuffix,
} = {}) {
  // Entorno de herdr-app = el de hc hacia el core vivo (Linux sin XDG_RUNTIME_DIR). Falla CERRADO: sin core vivo, error o
  // adaptador sin `hcEnv` → null y NO se llama a herdr-app.
  const appEnv = async () => {
    let extra = null;
    try { extra = await getHerdr()?.hcEnv?.(); } catch { extra = null; }
    if (extra === null || extra === undefined) return null;
    return Object.keys(extra).length ? { ...env, ...extra } : env;
  };
  const appUp = async (appPath, appEnvResolved) => {
    const r = await runApp(exec, appPath, ["status"], APP_STATUS_TIMEOUT_MS, appEnvResolved);
    return r.ok;
  };

  /** { installed: hc existe, running: core con socket vivo, app: ventana de Herdr alcanzable }. Nunca arranca nada. */
  async function status() {
    const h = getHerdr();
    if (!h) return { installed: false, running: false, app: false };
    const running = await h.coreUp().catch(() => false);
    if (!running) return { installed: true, running: false, app: false }; // sin core NO se invoca herdr-app
    const appPath = findApp();
    const e = appPath ? await appEnv() : null;
    const app = appPath && e !== null ? await appUp(appPath, e) : false;
    return { installed: true, running, app };
  }

  async function viaApp(appPath, { argv, cwd, agentId }, e) {
    const ls = await runApp(exec, appPath, ["ls"], APP_LS_TIMEOUT_MS, e);
    if (!ls.ok) return { ok: false, retryable: true, err: "herdr-app ls falló" };
    const space = findSpaceByFolder(parseAppSpaces(ls.out), cwd);
    const doArgv = appDoArgv({ space: space?.id, folder: cwd, argv, agentName: String(agentId), spaceName: basename(cwd) || "home" });
    const r = await runApp(exec, appPath, doArgv, APP_DO_TIMEOUT_MS, e);
    // exit ≠ 0 con {"error": …} = la app rechazó el comando sin crear nada → se puede caer a `hc run`.
    // Timeout o respuesta ilegible: puede haberse creado → NO se reintenta (evita duplicados).
    if (!r.ok) {
      const rejected = typeof r.code === "number" && !r.killed && /"error"/.test(r.out);
      return { ok: false, retryable: rejected, err: "herdr-app do falló" };
    }
    const address = parseAppTerminal(r.out);
    if (!address) return { ok: false, retryable: false, err: "herdr-app no devolvió el terminal" };
    return { ok: true, address, via: "app" };
  }

  async function viaHc(h, { argv, cwd, agentId }) {
    for (let i = 0; i < NAME_ATTEMPTS; i++) {
      const name = launchName(agentId, cwd, i === 0 ? nameSuffix : undefined);
      const r = await h.run({ argv, cwd, name });
      if (r.ok) return { ok: true, address: r.address, via: "core", name };
      // NOCORE = el adaptador no ejecutó hc (sondeo previo falló): seguro que no se despachó nada
      if (!r.nameTaken) return { ok: false, err: r.err, notDispatched: r.code === "NOCORE" };
    }
    return { ok: false, err: "nombre de terminal ocupado" };
  }

  /**
   * Crea la sesión. { ok:true, paneId, address, via, name?, warning? } | { ok:false, reason, err? } con
   * reason = "not-installed" | "no-core" (→ el servidor abre en tmux) | "error" (→ 500, sin tmux: ya pudo crearse).
   */
  async function launch({ agentId, cwd, argv }) {
    const h = getHerdr();
    if (!h) return { ok: false, reason: "not-installed" };
    if (!(await h.coreUp())) return { ok: false, reason: "no-core" };
    const input = { argv, cwd, agentId };
    let made = null;
    const e = await appEnv(); // una vez por lanzamiento; sin core vivo no se llama a herdr-app ni a hc
    if (e === null) return { ok: false, reason: "no-core" };
    const appPath = findApp();
    if (appPath && (await appUp(appPath, e))) {
      const a = await viaApp(appPath, input, e);
      if (!a.ok && !a.retryable) return { ok: false, reason: "error", err: a.err };
      if (a.ok) {
        const mark = await h.markOwned(`hc:${a.address}`);
        made = { ...a, ...(mark.ok ? {} : { warning: "no se pudo marcar el terminal; el panel no podrá cerrarlo" }) };
      }
    }
    if (!made) {
      const c = await viaHc(h, input);
      // "no-core" (→ el servidor abre en tmux) SOLO si es seguro que hc no recibió el comando; si no, "error"
      if (!c.ok) return { ok: false, reason: c.notDispatched ? "no-core" : "error", err: c.err };
      made = c;
    }
    h.invalidate();
    return { ok: true, paneId: `hc:${made.address}`, address: made.address, via: made.via, ...(made.name ? { name: made.name } : {}), ...(made.warning ? { warning: made.warning } : {}) };
  }

  return { status, launch };
}

/**
 * argv que recibe Herdr a partir del `cmd` que armó el servidor para tmux (misma ruta, mismos argumentos).
 * POSIX: antepone `/usr/bin/env PATH=<PATH de agentes> COLORTERM=truecolor`, equivalente a los `-e` de `tmux new-session`
 * (el core de Herdr tiene su propio entorno, sin el PATH con nvm). Shell (cmd vacío) → [] = el shell de hc.
 */
export function herdrLaunchArgv({ cmd, path, platform = process.platform }) {
  if (!Array.isArray(cmd) || cmd.length === 0) return [];
  if (platform === "win32") return [...cmd];
  return ["/usr/bin/env", `PATH=${path}`, "COLORTERM=truecolor", ...cmd];
}
