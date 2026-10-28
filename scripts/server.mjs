#!/usr/bin/env node
/**
 * server.mjs — the OS backend. Zero dependencies (Node built-ins only).
 *
 * Serves the built panel (panel/dist) AND a small API the dashboard calls live:
 *   POST /api/query    { projectId, q }  → runs `graphify query` in that repo (traversal, $0)
 *   POST /api/refresh  { projectId }      → `graphify update` + re-ingest, appends an activity log
 *   POST /api/send     { paneId, text, enter? } → types text into an agent's tmux pane (LAN-only)
 *   POST /api/upload   { name, data }       → saves a base64 image to data/uploads/, returns its path
 *   GET  /api/fs/list|read|raw ?path=  +  POST /api/fs/write|upload|move|delete → file browser / manager
 *   GET  /api/agents                      → installed agent CLIs + their live tmux panes (auto-discovered)
 *   GET  /api/logs                        → data/logs/*.md (Memory / Activity pages)
 *   GET  /api/skills                      → reads ~/.agents/skills SKILL.md frontmatter (Skills page)
 *   GET  /api/manifest                    → current panel manifest
 *
 * Run:  node scripts/server.mjs        (serves dist + api on :4288)
 * Dev:  pnpm dev  (vite :5273 proxies /api → :4288)  +  node scripts/server.mjs
 */
import { createServer, request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect as netConnect } from "node:net";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, appendFileSync, mkdirSync, unlinkSync, renameSync, rmdirSync, statfsSync, createWriteStream, realpathSync, openSync, closeSync } from "node:fs";
import { join, dirname, extname, basename, resolve, isAbsolute, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, userInfo, networkInterfaces, loadavg, cpus, totalmem, freemem } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { sessionCookie } from "./lib/web-session.mjs";
import { keyArgs } from "./lib/keys.mjs";
import { parseAlternateMouseSgr, TMUX_ALT_MOUSE_DISPLAY } from "./lib/tmux-pane-flags.mjs";
import { missingHooks } from "./lib/tmux-hooks.mjs";
import { decideResume, hasResumableHistory } from "./lib/resume-history.mjs";
import { createPasteToPane } from "./lib/tmux-paste.mjs";
import { buildRunningSet } from "./lib/running-set.mjs";
import { describeAgent, normalizeAgentDefs, requireCapability } from "./lib/adapters.mjs";
import {
  validatePaneId,
  mt3kSessionName,
  parseLaunchConfig,
  composeTmuxArgv,
  parseTmuxGlobalEnv,
  tmuxGlobalKeysToUnset,
  needsGlobalColortermTruecolor,
} from "./lib/adapters/cli-tmux.mjs";
import { pickWebStarter, webTokenFromLogText } from "./lib/adapters/web-local.mjs";
import { mergeLocalAgentDefs, readAgentsLocalFile } from "./lib/agents-local.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "panel", "dist");
const LOGS = join(ROOT, "data", "logs");
const SKILLS_DIR = join(homedir(), ".agents", "skills");
const GRAPHIFY = [join(homedir(), ".local/bin/graphify"), "graphify"].find((p) => p === "graphify" || existsSync(p));
const PORT = Number(process.env.MT3K_PORT) || 4288;
const START = Date.now();
function lanIP() {
  const ifs = networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const i of ifs[name] || []) {
      if (i.family === "IPv4" && !i.internal && /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))\./.test(i.address)) return i.address;
    }
  }
  return "localhost";
}
let _gv = null;
async function graphifyVersion() {
  if (_gv !== null) return _gv;
  try { _gv = ((await run(GRAPHIFY || "graphify", ["--version"], ROOT, 5000)).out || "").trim() || "unknown"; } catch { _gv = "unknown"; }
  return _gv;
}

const expand = (p) => p.replace(/^~(?=$|\/)/, homedir());
const readJSON = (p) => JSON.parse(readFileSync(p, "utf8"));
// data/projects.json is host-local & gitignored — a fresh clone has none, so fall back to empty.
const projects = () => { const f = join(ROOT, "data", "projects.json"); return existsSync(f) ? (readJSON(f).projects || []) : []; };
const projectPath = (id) => { const p = projects().find((x) => x.id === id); return p ? expand(p.path) : null; };

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2" };

function sendJSON(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(obj));
}
function body(req) {
  return new Promise((resolve) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => { try { resolve(JSON.parse(d || "{}")); } catch { resolve({}); } }); });
}
// big uploads travel as raw octet-stream bodies, never base64-in-JSON: at 500MB the base64
// string would blow past phone-browser memory and flirt with V8's max string length
const UPLOAD_MAX = 500 * 1024 * 1024;
function streamUploadToFile(req, tmp) {
  return new Promise((resolve) => {
    const out = createWriteStream(tmp);
    let size = 0, done = false;
    const finish = (ok, err) => { if (done) return; done = true; resolve({ ok, size, err }); };
    req.on("data", (c) => {
      size += c.length;
      if (size > UPLOAD_MAX) { out.destroy(); req.destroy(); return finish(false, `archivo demasiado grande (máx ${UPLOAD_MAX / 1024 / 1024}MB)`); }
      if (!out.write(c)) { req.pause(); out.once("drain", () => req.resume()); }
    });
    req.on("end", () => out.end(() => finish(size > 0, size > 0 ? undefined : "archivo vacío")));
    req.on("error", () => { out.destroy(); finish(false, "subida interrumpida"); });
    out.on("error", (e) => { req.destroy(); finish(false, `no se pudo escribir: ${e.code || e}`); });
  });
}
const isRawUpload = (req) => (req.headers["content-type"] || "").includes("octet-stream");
function run(cmd, args, cwd, timeoutMs = 60000, envOverride = null) {
  return new Promise((resolve) => {
    const env = envOverride ? { ...process.env, ...envOverride } : { ...process.env, PATH: `${join(homedir(), ".local/bin")}:${process.env.PATH}` };
    const ch = spawn(cmd, args, { cwd, env });
    let out = "", err = "";
    const t = setTimeout(() => { ch.kill("SIGKILL"); resolve({ ok: false, out, err: err + "\n[timeout]" }); }, timeoutMs);
    ch.stdout.on("data", (d) => (out += d));
    ch.stderr.on("data", (d) => (err += d));
    ch.on("close", (code) => { clearTimeout(t); resolve({ ok: code === 0, out: out.trim(), err: err.trim() }); });
    ch.on("error", (e) => { clearTimeout(t); resolve({ ok: false, out, err: String(e) }); });
  });
}
function logEvent(line) {
  mkdirSync(LOGS, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  // local wall-clock time (the HUD feed shows these lines) — the filename stays UTC-dated
  appendFileSync(join(LOGS, `${day}.md`), `- ${new Date().toTimeString().slice(0, 8)} — ${line}\n`);
}

// uploaded screenshots are transient — the agent reads them within minutes of upload.
// Keep 7 days (re-reads, debugging), then sweep: on boot and every 12h, so the folder
// never accumulates old captures of the owner's screens on any host.
const UPLOADS_DIR = join(ROOT, "data", "uploads");
const UPLOAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
function sweepUploads() {
  if (!existsSync(UPLOADS_DIR)) return;
  let removed = 0;
  for (const f of readdirSync(UPLOADS_DIR)) {
    const p = join(UPLOADS_DIR, f);
    try {
      const st = statSync(p);
      if (st.isFile() && Date.now() - st.mtimeMs > UPLOAD_TTL_MS) { unlinkSync(p); removed++; }
    } catch { /* deleted underneath us — fine */ }
  }
  if (removed) logEvent(`uploads-sweep · ${removed} screenshot${removed === 1 ? "" : "s"} borrado${removed === 1 ? "" : "s"} (>7d)`);
}
sweepUploads();
setInterval(sweepUploads, 12 * 60 * 60 * 1000).unref();

// file browser helpers: `~` expansion + absolute-only paths, text size cap, preview MIMEs
const FS_TEXT_MAX = 2 * 1024 * 1024;
const fsPath = (p) => {
  if (typeof p !== "string" || !p.trim()) return null;
  const abs = resolve(expand(p.trim()));
  return isAbsolute(abs) ? abs : null; // isAbsolute (not startsWith "/") so C:\ paths work on Windows
};
const FS_MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav", ".ogg": "audio/ogg", ".aac": "audio/aac", ".flac": "audio/flac",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".json": "application/json", ".md": "text/markdown", ".txt": "text/plain", ".csv": "text/csv",
  ".ts": "text/plain", ".tsx": "text/plain", ".jsx": "text/plain", ".py": "text/plain", ".go": "text/plain",
  ".rs": "text/plain", ".swift": "text/plain", ".sh": "text/plain", ".yml": "text/plain", ".yaml": "text/plain",
  ".toml": "text/plain", ".conf": "text/plain", ".log": "text/plain",
  // active content → plain text on purpose (see /api/fs/raw)
  ".html": "text/plain", ".htm": "text/plain", ".svg": "text/plain", ".js": "text/plain", ".mjs": "text/plain", ".xml": "text/plain",
};
const fsMime = (file) => {
  const m = FS_MIME[extname(file).toLowerCase()] || "application/octet-stream";
  return /^(image|video|audio|application\/(pdf|octet-stream))/.test(m) ? m : `${m}; charset=utf-8`;
};

// --- skills cache ---
let _skills = null;
function readSkills() {
  if (_skills) return _skills;
  const out = [];
  if (existsSync(SKILLS_DIR)) {
    for (const name of readdirSync(SKILLS_DIR)) {
      const md = join(SKILLS_DIR, name, "SKILL.md");
      if (!existsSync(md)) continue;
      const head = readFileSync(md, "utf8").split(/\n---/)[0];
      const nm = (head.match(/^name:\s*(.+)$/m) || [])[1]?.trim() || name;
      let desc = (head.match(/description:\s*>?\s*([\s\S]*?)(?:\n\w+:|$)/) || [])[1] || "";
      desc = desc.replace(/\n\s+/g, " ").replace(/^["']|["']$/g, "").trim();
      out.push({ name: nm, slug: name, description: desc.slice(0, 240) });
    }
  }
  _skills = out.sort((a, b) => a.name.localeCompare(b.name));
  return _skills;
}

function readLogs() {
  if (!existsSync(LOGS)) return [];
  return readdirSync(LOGS).filter((f) => f.endsWith(".md")).sort().reverse()
    .map((f) => ({ date: f.replace(".md", ""), content: readFileSync(join(LOGS, f), "utf8") }));
}

// --- agent detection: which CLIs / agents are actually installed on this machine ---
// dirname(process.execPath): wherever OUR node lives (nvm, brew, …), its npm-global siblings
// (dsh, claude, …) live too — a launchd/systemd service PATH usually misses that dir
const PATH_DIRS = [dirname(process.execPath), join(homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", ...(process.env.PATH || "").split(delimiter)];
// Windows binaries carry extensions (claude.cmd, dsh.ps1, ollama.exe) — probe those too
const BIN_EXTS = process.platform === "win32" ? ["", ".exe", ".cmd", ".ps1", ".bat"] : [""];
const onPath = (bin) => PATH_DIRS.some((d) => d && BIN_EXTS.some((e) => existsSync(join(d, bin + e))));
// `proc` = exact process basenames (case-sensitive) that mean this agent is actively running.
// CLI binaries are lowercase (claude/codex/…); same-named GUI apps are Capitalized → not matched.
const AGENT_DEFS = [
  { id: "claude", name: "Claude Code", bins: ["claude"], paths: ["~/.claude"], proc: ["claude"] },
  { id: "codex", name: "Codex", bins: ["codex"], paths: ["~/.codex"], proc: ["codex"] },
  { id: "opencode", name: "OpenCode", bins: ["opencode"], paths: ["~/.config/opencode", "~/.opencode"], proc: ["opencode"] },
  { id: "grok", name: "Grok CLI", bins: ["grok"], paths: ["~/.grok"], proc: ["grok"] },
  { id: "antigravity", name: "Antigravity", bins: ["agy", "antigravity"], paths: ["~/.antigravity", "/Applications/Antigravity.app"], proc: ["agy", "antigravity"] },
  // Cursor's agentic CLI (`cursor-agent`), not the `cursor` GUI launcher → real TUI, launchable in tmux
  { id: "cursor", name: "Cursor", bins: ["cursor-agent"], paths: ["~/.cursor"], proc: ["cursor-agent"] },
  // `zcode` is an sh wrapper that execs node (~/.zcode/runtime/…/zcode.mjs); the TUI then
  // re-titles its processes `zcode-cli`, so that's the live pane/run signal (tmux shows "node").
  { id: "zcode", name: "ZCode", bins: ["zcode"], paths: ["~/.zcode"], proc: ["zcode", "zcode-cli"] },
  // DeepSeek Harness (dsh): no TUI profile — its interactive surface is `dsh web` on a local
  // port. `web` marks it as a web-UI agent: a port probe drives "running" and the panel offers
  // an "abrir UI web" link instead of a tmux terminal.
  { id: "deepseek", name: "DeepSeek", bins: ["dsh"], paths: ["~/.dsh"], proc: [], web: 3080, webProxy: 4290, webCmd: ["dsh", "web", "--no-open"], webService: "dsh-web", webTask: "DSH-Web", webLog: "~/.dsh/web.log" },
  // plain tmux shell — no AI. Launch runs the user's default shell (rc + aliases apply).
  // Its panes are matched by session-name prefix, not by process (every pane has a shell).
  { id: "shell", name: "Terminal", bins: [], paths: [], proc: [] },
];
const AGENTS_LOCAL_FILE = join(ROOT, "data", "agents.local.json");
const warnAgentsLocal = (msg) => console.warn(`[mt3k] ${msg}`);
let agentsLocalMtime = null;
let effectiveAgentDefs = AGENT_DEFS;
let normalizedAgentDefs = normalizeAgentDefs(AGENT_DEFS);
/** Relee agents.local.json si cambió el mtime (barato: solo stat). */
function refreshAgentDefsFromLocal() {
  let mtime = 0;
  try {
    if (!existsSync(AGENTS_LOCAL_FILE)) mtime = -1;
    else mtime = statSync(AGENTS_LOCAL_FILE).mtimeMs;
  } catch {
    mtime = -1;
  }
  if (mtime === agentsLocalMtime) return;
  agentsLocalMtime = mtime;
  const local = mtime >= 0 ? readAgentsLocalFile(AGENTS_LOCAL_FILE, warnAgentsLocal) : [];
  effectiveAgentDefs = mergeLocalAgentDefs(AGENT_DEFS, local, warnAgentsLocal);
  normalizedAgentDefs = normalizeAgentDefs(effectiveAgentDefs);
}
refreshAgentDefsFromLocal();
const base = (c) => (c || "").split("/").pop();
const tildify = (p) => (p && p.startsWith(homedir()) ? "~" + p.slice(homedir().length) : p);
const procMatches = (comm, proc) => comm.split("/").some((segment) => segment === proc || segment.startsWith(proc + "-"));
const resumeLaunchReservations = new Set();
const RESUME_HOLD_MS = 8000;
// tmux reports the physical cwd (/private/tmp, not /tmp): compare real paths, not lexical ones
const realDir = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
// Claude, Grok and Cursor exit with an error when continuing without saved history, so
// resume only where their per-project transcript/session/chat exists. Other agents: allowed.
// absolute path of a binary from our search dirs (so tmux launches it regardless of the server env's PATH)
const absBin = (name) => { for (const d of PATH_DIRS) for (const e of BIN_EXTS) { if (d && existsSync(join(d, name + e))) return join(d, name + e); } return null; };
// no tmux (Windows) → nothing is launchable-in-tmux; web-UI agents and Files still work
const HAS_TMUX = !!absBin("tmux");
const adapterEnv = () => ({ hasTmux: HAS_TMUX, platform: process.platform });
const SHELL_DEF = AGENT_DEFS.find((a) => a.id === "shell");
/** Corta el handler si el adaptador no soporta la operación (respuesta uniforme 400 + err). */
const denyUnlessCap = (res, def, op) => {
  const gate = requireCapability(def, adapterEnv(), op);
  if (!gate.ok) {
    sendJSON(res, gate.status, { ok: false, err: gate.err });
    return true;
  }
  return false;
};

let tmuxHooksVerified = false;
let tmuxHooksPending = null;
async function ensureTmuxHooks(force = false) {
  try {
    if (!HAS_TMUX) return;
    if (force) {
      await tmuxHooksPending;
      tmuxHooksVerified = false;
    }
    if (tmuxHooksVerified) return;
    if (tmuxHooksPending) return await tmuxHooksPending;
    tmuxHooksPending = (async () => {
      const hooks = await run("tmux", ["show-hooks", "-g"], ROOT, 3000);
      if (!hooks.ok) return;
      // tmux manual: resize-window "will automatically set window-size to manual in the window options".
      for (const hook of missingHooks(hooks.out)) {
        const added = await run("tmux", ["set-hook", "-ga", hook, "set -w window-size latest"], ROOT, 3000);
        if (!added.ok) return;
      }
      tmuxHooksVerified = true;
    })();
    try { await tmuxHooksPending; } finally { tmuxHooksPending = null; }
  } catch { /* tmux absent, stopped or unavailable: retry on the next call */ }
}
if (HAS_TMUX && (await run("tmux", ["list-sessions"], ROOT, 3000)).ok) await ensureTmuxHooks();

// PATH for everything the panel launches inside tmux. A new tmux session takes the env of the
// CLIENT that runs `new-session` — this service, whose launchd/systemd PATH has no nvm — not
// the server's global env. So derive the user's real PATH and hand it over explicitly.
// Source of truth: the user's fish login config (it resolves the nvm default itself, nothing
// pinned here); hosts without fish fall back to PATH_DIRS. Ephemeral dirs (agent plugins,
// temp) never get in, missing dirs and duplicates are dropped, ~/.local/bin always goes first.
const EPHEMERAL_DIRS = [/\/\.claude\/(plugins|skills|shell-snapshots)\//, /^\/(private\/)?tmp\//, /^\/(private\/)?var\/folders\//];
let agentPathCache = { at: 0, value: "" };
function cleanPath(dirs) {
  const seen = new Set();
  return [join(homedir(), ".local/bin"), ...dirs]
    .filter((d) => d && !seen.has(d) && seen.add(d) && !EPHEMERAL_DIRS.some((re) => re.test(d + "/")) && existsSync(d))
    .join(delimiter);
}
function fishPath() {
  const fish = absBin("fish");
  if (!fish) return Promise.resolve(null);
  const user = process.env.USER || userInfo().username;
  return new Promise((done) => {
    // minimal env: nothing of this service (or of whoever started it) leaks into the result
    const ch = spawn(fish, ["-l", "-c", "string join : $PATH"], { env: { HOME: homedir(), USER: user, LOGNAME: user, TERM: "dumb", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } });
    let out = "";
    const t = setTimeout(() => { ch.kill("SIGKILL"); done(null); }, 5000);
    ch.stdout.on("data", (d) => (out += d));
    ch.on("error", () => { clearTimeout(t); done(null); });
    ch.on("close", (code) => {
      clearTimeout(t);
      // only the LAST line, and only if it looks like a PATH: anything config.fish prints
      // (a greeting, fastfetch without its is-interactive guard…) must not become PATH
      const last = out.trim().split("\n").pop() || "";
      done(code === 0 && last.startsWith("/") && last.includes(":") ? last.split(":") : null);
    });
  });
}
async function agentPath() {
  if (agentPathCache.value && Date.now() - agentPathCache.at < 60000) return agentPathCache.value;
  // no fish, fish failed or timed out → PATH_DIRS (Debian hosts, Windows never reaches tmux)
  agentPathCache = { at: Date.now(), value: cleanPath((await fishPath()) || PATH_DIRS) };
  return agentPathCache.value;
}

// one ps snapshot → process tree (pid → ppid → comm). Used for both "is running" and pane discovery.
async function procTree() {
  const out = (await run("ps", ["-axo", "pid=,ppid=,comm="], ROOT, 5000)).out;
  const byPid = new Map(), childrenOf = new Map(), rows = [];
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    const pid = +m[1], ppid = +m[2], comm = m[3];
    byPid.set(pid, comm);
    if (!childrenOf.has(ppid)) childrenOf.set(ppid, []);
    childrenOf.get(ppid).push(pid);
    rows.push({ pid, ppid, comm });
  }
  // index every path segment, not just the basename: cursor-agent's process is
  // ".../cursor-agent/versions/x.y/node" — the agent's name only appears as a directory.
  // GUI-app internals stay excluded (e.g. Codex.app/Resources/codex ≠ the codex CLI running)
  // — including bundle workers whose .app/ origin only survives in their ancestry
  // (buildRunningSet, ./lib/running-set.mjs).
  const running = buildRunningSet(rows);
  // basenames of a pid's process AND all its descendants (the agent may BE the pane's root process
  // — tmux runs the binary directly on launch — or live under a kitty/shell wrapper)
  const descendants = (pid) => {
    const out = new Set(), stack = [pid, ...(childrenOf.get(pid) || [])];
    let guard = 0;
    while (stack.length && guard++ < 500) {
      const p = stack.pop();
      if (byPid.has(p)) out.add(byPid.get(p)); // full executable path — matching inspects its segments
      for (const c of childrenOf.get(p) || []) stack.push(c);
    }
    return out;
  };
  return { running, descendants };
}

// map each tmux pane to the agent CLI actually running inside it (auto-discovery, nothing hardcoded)
async function discoverPanes(descendants) {
  const fmt = "#{pane_id}|#{pane_pid}|#{session_name}:#{window_index}.#{pane_index}|#{window_name}|#{pane_current_path}|#{pane_current_command}";
  const r = await run("tmux", ["list-panes", "-a", "-F", fmt], ROOT, 5000);
  if (!r.ok || !r.out) return []; // no tmux server / not installed → degrade quietly
  const panes = [];
  for (const line of r.out.split("\n")) {
    const parts = line.split("|");
    if (parts.length < 6) continue;
    const [paneId, panePid, label, window, cwd, command] = parts;
    const comms = descendants(+panePid);
    comms.add(base(command)); // also count the pane's own foreground command
    panes.push({ paneId, label, window, cwd: tildify(cwd), command, comms: [...comms] });
  }
  return panes;
}

async function detectAgents() {
  refreshAgentDefsFromLocal();
  const { running, descendants } = await procTree();
  const panes = await discoverPanes(descendants);
  // web-UI agents (def.web = local port): a quick probe tells us whether their server is up
  const webUp = new Set();
  await Promise.all(normalizedAgentDefs.filter((a) => a.web).map(async (a) => {
    if (await webProbe(a)) webUp.add(a.id); // same probe as web-start: an auth-walled 401 still means "up"
  }));
  const env = adapterEnv();
  const rows = normalizedAgentDefs.map((a) => {
    const adapterMeta = describeAgent(a, env);
    // Agente SaaS/enlace: configurado en agents.local.json — el panel solo enlaza, sin fetch ni tmux
    if (a.adapter === "web-external") {
      const row = {
        id: a.id,
        name: a.name,
        online: true,
        running: false,
        launchable: false,
        panes: [],
        url: a.url,
        ...adapterMeta,
      };
      if (a.logo) row.logo = a.logo;
      return row;
    }
    if (a.id === "shell") {
      const shellPanes = panes.filter((pn) => pn.label.startsWith("mt3k-shell-"))
        .map((pn) => ({ paneId: pn.paneId, label: pn.label, window: pn.window, cwd: pn.cwd }));
      return { id: a.id, name: a.name, online: true, running: shellPanes.length > 0, launchable: HAS_TMUX, panes: shellPanes, ...adapterMeta };
    }
    const installed = a.bins.some(onPath) || a.paths.some((p) => existsSync(expand(p)));
    const proc = a.proc || [];
    const isRunning = installed && proc.some((name) => running.has(name));
    // every pane whose process tree contains this agent's binary — supports multiple sessions of the same CLI.
    // segment match: the agent name may be the basename, a vendor/arch name ("codex-aarch64-…"),
    // or a directory in the executable's path (".../cursor-agent/versions/x.y/node").
    const agentPanes = proc.length
      ? panes.filter((pn) => pn.comms.some((comm) => proc.some((name) => procMatches(comm, name))))
          .map((pn) => ({ paneId: pn.paneId, label: pn.label, window: pn.window, cwd: pn.cwd }))
      : [];
    // launchable = a real TUI CLI we can spawn inside tmux (GUI-only apps have empty `proc`)
    const web = a.web && webUp.has(a.id) ? a.web : undefined;
    return { id: a.id, name: a.name, online: installed, running: isRunning || !!web, launchable: HAS_TMUX && installed && proc.length > 0, panes: agentPanes, ...(web ? { webPort: a.webProxy || web, webTls: PROXY_HTTPS } : a.web && installed && a.webCmd ? { webOff: true } : {}), ...adapterMeta };
  });
  await updateWaiting(rows.flatMap((r) => r.panes.map((p) => ({ ...p, agentName: r.name }))));
  for (const r of rows) {
    for (const p of r.panes) p.waiting = paneWatch.get(p.paneId)?.waiting ?? false;
    r.waiting = r.panes.some((p) => p.waiting);
  }
  return rows;
}

// paste text into a pane via set-buffer/paste-buffer — safe for arbitrary text (no key interpretation)
const pasteToPane = createPasteToPane({ run, cwd: ROOT });

// --- federation: hosts this panel aggregates (data/hosts.json, host-local, NEVER automatic) ---
// every federation consumer (agents, proxy, broadcast) sees only ENABLED hosts — a disabled
// host stays configured (token and all) but the panel acts as if it weren't there
function readHostsAll() {
  try { return (readJSON(join(ROOT, "data", "hosts.json")).hosts || []).filter((h) => h.id && h.url); } catch { return []; }
}
function readHosts() {
  return readHostsAll().filter((h) => !h.disabled);
}
async function federatedAgents() {
  const local = await detectAgents();
  const remote = await Promise.all(readHosts().map(async (h) => {
    try {
      const r = await fetch(`${h.url.replace(/\/$/, "")}/api/agents?flat=1`, {
        headers: h.token ? { authorization: `Bearer ${h.token}` } : {}, signal: AbortSignal.timeout(3000),
      });
      if (!r.ok) return [];
      // only agents actually installed over there — keeps the room from filling with offline desks
      return ((await r.json()).agents || []).filter((a) => a.online).map((a) => ({ ...a, host: h.id }));
    } catch { return []; } // host down → just its absence, never an error here
  }));
  return [...local, ...remote.flat()];
}

// --- waiting-for-input watcher: a pane whose screen goes still is an agent waiting on you ---
// promptish tail → waiting after 10s of stillness; anything else after 45s (spinners keep repainting).
const PROMPT_RE = /(do you want|y\/n|yes\/no|proceed\?|trust|permission|allow|esperando|continuar|❯\s*1\.|\?\s*$)/i;
const paneWatch = new Map(); // paneId → { hash, changedAt, waiting, notifiedAt }
async function updateWaiting(panes) {
  const now = Date.now();
  const seen = new Set();
  for (const pn of panes) {
    seen.add(pn.paneId);
    const r = await run("tmux", ["capture-pane", "-t", pn.paneId, "-p"], ROOT, 4000);
    if (!r.ok) continue;
    const screen = r.out.trimEnd();
    const st = paneWatch.get(pn.paneId) ?? { hash: null, changedAt: now, waiting: false, notifiedAt: 0 };
    if (screen !== st.hash) {
      st.hash = screen; st.changedAt = now; st.waiting = false;
    } else {
      const still = now - st.changedAt;
      const promptish = PROMPT_RE.test(screen.split("\n").slice(-8).join("\n"));
      const was = st.waiting;
      st.waiting = still >= (promptish ? 10000 : 45000);
      if (st.waiting && !was && now - st.notifiedAt > 600000) { st.notifiedAt = now; notifyWaiting(pn); }
    }
    paneWatch.set(pn.paneId, st);
  }
  for (const id of [...paneWatch.keys()]) if (!seen.has(id)) paneWatch.delete(id);
}
// push notification via ntfy (data/notify.json: { "ntfy": "https://ntfy.sh/tu-topic" }) — optional
function notifyWaiting(pn) {
  logEvent(`waiting · ${pn.agentName} · ${pn.cwd}`);
  let cfg; try { cfg = readJSON(join(ROOT, "data", "notify.json")); } catch { return; }
  if (!cfg?.ntfy) return;
  fetch(cfg.ntfy, {
    method: "POST",
    body: `${pn.agentName} espera tu input · ${pn.cwd}`,
    headers: { Title: "MT3K Agent OS", Priority: "high", Tags: "hourglass" },
  }).catch(() => { /* notification is best-effort */ });
}
// keep watching even when no browser is polling — otherwise notifications only fire while the panel is open
setInterval(() => detectAgents().catch(() => {}), 15000);

// scan for graphified repos that aren't tracked yet: ~/Developer (deep) + home top-level (shallow,
// catches repos graphed outside Developer, e.g. ~/.proxmox or ~/.agent-forge-skills)
function discover() {
  const home = homedir();
  const tracked = new Set(projects().map((p) => expand(p.path)));
  const found = [];
  const add = (dir) => {
    if (tracked.has(dir) || found.some((f) => f.path === dir)) return;
    if (!existsSync(join(dir, "graphify-out", "graph.json"))) return;
    let files = 0;
    try { files = (readJSON(join(dir, "graphify-out", "graph.json")).nodes || []).length; } catch {}
    found.push({ name: basename(dir), path: dir, files });
  };
  const walk = (dir, depth) => {
    if (depth > 3 || found.length > 60) return;
    if (existsSync(join(dir, "graphify-out", "graph.json"))) { add(dir); return; } // don't descend into a graphed repo
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries)
      if (e.isDirectory() && ![".git", "node_modules", "dist", "vendor"].includes(e.name)) walk(join(dir, e.name), depth + 1);
  };
  walk(join(home, "Developer"), 0);
  // shallow pass over home's immediate children (incl. dotdirs) so repos graphed outside Developer show up too
  try {
    for (const e of readdirSync(home, { withFileTypes: true }))
      if (e.isDirectory() && e.name !== "Developer" && !["node_modules", "Library", "Applications"].includes(e.name)) add(join(home, e.name));
  } catch {}
  return found.sort((a, b) => b.files - a.files);
}

// --- routes ---
async function resolveLaunchCwd({ projectId, cwd: cwdIn }) {
  let cwd = homedir();
  if (projectId) {
    const pp = projectPath(projectId);
    if (!pp) return { err: "proyecto desconocido", status: 400 };
    cwd = pp;
  } else if (typeof cwdIn === "string" && cwdIn.trim()) {
    cwd = expand(cwdIn.trim());
  }
  if (!existsSync(cwd)) return { cwd, err: "esa carpeta no existe", status: 400, missingDir: true };
  if (!statSync(cwd).isDirectory()) return { err: "esa ruta no es una carpeta", status: 400 };
  return { cwd };
}

async function resumeProbe(def, agentId, cwd) {
  let resumeArgs = [];
  try {
    const lc = agentId === "shell" ? null : readJSON(join(ROOT, "data", "launch.json"))[agentId];
    resumeArgs = parseLaunchConfig(lc).resumeArgs;
  } catch { /* no/invalid launch.json → no resume flags */ }
  if (!resumeArgs.length) return { resumeArgs, alreadyOpen: false, hasHistory: false };
  try {
    const normalizedCwd = tildify(realDir(cwd));
    const { descendants } = await procTree();
    const panes = await discoverPanes(descendants);
    const alreadyOpen = panes.some((pane) =>
      tildify(realDir(expand(pane.cwd))) === normalizedCwd
      && pane.comms.some((comm) => def.proc.some((name) => procMatches(comm, name)))
    );
    return { resumeArgs, alreadyOpen, hasHistory: hasResumableHistory(agentId, cwd, { realDir }) };
  } catch {
    return { resumeArgs, alreadyOpen: false, hasHistory: false };
  }
}

async function api(req, res, path) {
  if (path === "/api/manifest") {
    const src = join(ROOT, "panel", "public", "data", "manifest.json");
    return sendJSON(res, 200, existsSync(src) ? readJSON(src) : { projects: [] });
  }
  if (path === "/api/skills") return sendJSON(res, 200, { skills: readSkills() });
  if (path === "/api/logs") return sendJSON(res, 200, { logs: readLogs() });
  if (path === "/api/agents") {
    // flat=1 → this host only (what federating peers request; also stops any federation loop)
    const flat = new URL(req.url, "http://x").searchParams.get("flat");
    return sendJSON(res, 200, { agents: flat ? await detectAgents() : await federatedAgents() });
  }
  if (path === "/api/discover") return sendJSON(res, 200, { repos: discover() });

  if (path === "/api/add-project" && req.method === "POST") {
    const { path: repoPath, name } = await body(req);
    if (!repoPath) return sendJSON(res, 400, { ok: false, err: "missing path" });
    const abs = expand(repoPath);
    if (!existsSync(abs)) return sendJSON(res, 400, { ok: false, err: "ese path no existe" });
    const id = (name || basename(abs)).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const pj = join(ROOT, "data", "projects.json");
    const cfg = existsSync(pj) ? readJSON(pj) : { projects: [] };
    if (!cfg.projects.some((p) => p.id === id || expand(p.path) === abs)) {
      cfg.projects.push({ id, name: name || basename(abs), path: repoPath.startsWith("~") ? repoPath : abs });
      writeFileSync(pj, JSON.stringify(cfg, null, 2) + "\n");
    }
    // graph it if it has never been graphed (uses whatever backend the server env has)
    if (!existsSync(join(abs, "graphify-out", "graph.json")) && GRAPHIFY) await run(GRAPHIFY, ["."], abs, 300000);
    if (GRAPHIFY && existsSync(join(abs, "graphify-out", "graph.json"))) await run(GRAPHIFY, ["export", "wiki"], abs, 60000);
    const ingest = await run("node", [join(ROOT, "scripts", "build-data.mjs")], ROOT, 120000);
    logEvent(`add-project · ${id} · ${ingest.ok ? "ok" : "failed"}`);
    return sendJSON(res, 200, { ok: ingest.ok, id });
  }

  if (path === "/api/status") {
    const mf = join(ROOT, "panel", "public", "data", "manifest.json");
    return sendJSON(res, 200, {
      agents: await federatedAgents(),
      uptimeMs: Date.now() - START,
      graphify: await graphifyVersion(),
      skills: readSkills().length,
      projects: projects().length,
      // live (never baked): id+name+path of tracked repos — the Focus mode filters by these
      projectList: projects().map((pr) => ({ id: pr.id, name: pr.name || pr.id, path: tildify(expand(pr.path)) })),
      lastIngest: existsSync(mf) ? statSync(mf).mtime.toISOString() : null,
      port: PORT,
      lan: `${lanIP()}:${PORT}`,
    });
  }

  if (path === "/api/remove-project" && req.method === "POST") {
    const { id } = await body(req);
    const pj = join(ROOT, "data", "projects.json");
    const cfg = existsSync(pj) ? readJSON(pj) : { projects: [] };
    cfg.projects = cfg.projects.filter((p) => p.id !== id);
    writeFileSync(pj, JSON.stringify(cfg, null, 2) + "\n");
    const df = join(ROOT, "panel", "public", "data", `${id}.json`);
    if (existsSync(df)) { try { unlinkSync(df); } catch {} }
    const ingest = await run("node", [join(ROOT, "scripts", "build-data.mjs")], ROOT, 120000);
    logEvent(`remove-project · ${id}`);
    return sendJSON(res, 200, { ok: ingest.ok });
  }

  if (path === "/api/reingest" && req.method === "POST") {
    if (GRAPHIFY) {
      for (const p of projects()) {
        const cwd = expand(p.path);
        if (existsSync(join(cwd, "graphify-out", "graph.json"))) await run(GRAPHIFY, ["export", "wiki"], cwd, 60000);
      }
    }
    const ingest = await run("node", [join(ROOT, "scripts", "build-data.mjs")], ROOT, 120000);
    logEvent("reingest · all");
    return sendJSON(res, 200, { ok: ingest.ok });
  }

  if (path === "/api/search") {
    const q = (new URL(req.url, "http://x").searchParams.get("q") || "").toLowerCase().trim();
    const results = [];
    if (q) {
      const dir = join(ROOT, "panel", "public", "data");
      for (const f of readdirSync(dir).filter((x) => x.endsWith(".json") && x !== "manifest.json")) {
        let d; try { d = readJSON(join(dir, f)); } catch { continue; }
        for (const n of d.nodes || []) {
          if (n.label?.toLowerCase().includes(q)) {
            results.push({ project: f.replace(".json", ""), projectName: d.meta?.name || f, id: n.id, label: n.label, community: n.community });
            if (results.length >= 80) break;
          }
        }
        if (results.length >= 80) break;
      }
    }
    return sendJSON(res, 200, { results });
  }

  // live read of an agent's tmux pane — capture the rendered screen (with ANSI colors) for the terminal viewer
  if (path === "/api/pane") {
    const paneId = new URL(req.url, "http://x").searchParams.get("id") || "";
    const paneCheck = validatePaneId(paneId);
    if (!paneCheck.ok) return sendJSON(res, 400, { ok: false, err: paneCheck.err });
    if (denyUnlessCap(res, SHELL_DEF, "view")) return;
    const live = (await run("tmux", ["list-panes", "-a", "-F", "#{pane_id}"], ROOT, 5000)).out.split("\n");
    if (!live.includes(paneId)) return sendJSON(res, 404, { ok: false, err: "ese pane ya no existe" });
    // -e keeps colors, -p prints to stdout, -S -1000 ships real scrollback — 200 felt like
    // "no history" on long agent sessions (keep on-screen line breaks → less reflow)
    const r = await run("tmux", ["capture-pane", "-t", paneId, "-p", "-e", "-N", "-S", "-1000"], ROOT, 5000);
    // alt + ratón SGR en un solo display (cero llamadas tmux extra)
    const flags = parseAlternateMouseSgr(
      (await run("tmux", ["display-message", "-p", "-t", paneId, TMUX_ALT_MOUSE_DISPLAY], ROOT, 4000)).out,
    );
    return sendJSON(res, 200, { ok: r.ok, content: r.out, alternate: flags.alternate, mouse_sgr: flags.mouse_sgr });
  }

  // grow a detached tmux window so the CLI reflows to the viewer's width — panel-launched
  // sessions default to 80 cols, wasting most of a desktop screen. Never touches a window
  // with a real client attached (kitty/ssh): that client owns the size.
  if (path === "/api/pane-resize" && req.method === "POST") {
    const { paneId, cols, rows } = await body(req);
    const paneCheck = validatePaneId(paneId);
    if (!paneCheck.ok) return sendJSON(res, 400, { ok: false, err: paneCheck.err });
    const c = Math.round(Number(cols)), r = Math.round(Number(rows));
    if (!(c >= 40 && c <= 400) || !(r >= 10 && r <= 200)) return sendJSON(res, 400, { ok: false, err: "tamaño inválido" });
    if (denyUnlessCap(res, SHELL_DEF, "view")) return;
    const cur = await run("tmux", ["display-message", "-p", "-t", paneId, "#{pane_width} #{pane_height} #{window_width} #{window_height}"], ROOT, 4000);
    if (!cur.ok) return sendJSON(res, 404, { ok: false, err: "ese pane ya no existe" });
    const [paneW, paneH, winW, winH] = cur.out.trim().split(" ").map(Number);
    const attached = (await run("tmux", ["list-clients", "-t", paneId], ROOT, 4000)).out.trim();
    if (attached) return sendJSON(res, 200, { ok: true, skipped: "attached", cols: paneW, rows: paneH });
    // grow-only: a phone opening the same pane later must never shrink it back. The PANE is
    // what matters — in a split window, grow the window by the pane's shortfall first so the
    // sibling panes keep their size, then claim the new space for this pane.
    // Dos espectadores del panel en el mismo pane: sin histéresis — gana la última petición grow
    // que entre en esta rama (comportamiento aceptado para uso personal).
    const dW = Math.max(0, c - paneW), dH = Math.max(0, r - paneH);
    if (!dW && !dH) return sendJSON(res, 200, { ok: true, cols: paneW, rows: paneH });
    await ensureTmuxHooks();
    const rz = await run("tmux", ["resize-window", "-t", paneId, "-x", String(Math.min(400, winW + dW)), "-y", String(Math.min(200, winH + dH))], ROOT, 5000);
    if (!rz.ok) return sendJSON(res, 500, { ok: false, err: rz.err || "no se pudo redimensionar" });
    await run("tmux", ["resize-pane", "-t", paneId, "-x", String(c), "-y", String(r)], ROOT, 5000);
    logEvent(`pane-resize · ${paneId} · ${paneW}x${paneH} → ${c}x${r}`);
    return sendJSON(res, 200, { ok: true, cols: c, rows: r });
  }

  // send text to an agent's tmux pane (tmux-only, LAN-only). text is untrusted input → no shell, literal paste.
  if (path === "/api/send" && req.method === "POST") {
    const { paneId, text, enter = true } = await body(req);
    const paneCheck = validatePaneId(paneId);
    if (!paneCheck.ok) return sendJSON(res, 400, { ok: false, err: paneCheck.err });
    if (typeof text !== "string" || !text.trim()) return sendJSON(res, 400, { ok: false, err: "texto vacío" });
    if (text.length > 64000) return sendJSON(res, 400, { ok: false, err: "texto demasiado largo (máx 64000)" }); // long pastes (docs, diffs) are legit — tmux buffers handle them fine
    if (denyUnlessCap(res, SHELL_DEF, "send")) return;
    // confirm the pane still exists before sending
    const live = (await run("tmux", ["list-panes", "-a", "-F", "#{pane_id}"], ROOT, 5000)).out.split("\n");
    if (!live.includes(paneId)) return sendJSON(res, 404, { ok: false, err: "ese pane ya no existe" });
    const r = await pasteToPane(paneId, text, enter);
    if (!r.ok) return sendJSON(res, 500, { ok: false, err: r.err });
    logEvent(`send · ${paneId} · "${text.slice(0, 80).replace(/\s+/g, " ").trim()}"`);
    return sendJSON(res, 200, { ok: true, paneId });
  }

  // receive an image, PDF, or audio file from the panel (from the phone/desktop), save it under
  // data/uploads/ (gitignored), and return the absolute path — agent CLIs read images by path,
  // so the panel then pastes that path into the pane. ?host= proxies this to a federated host,
  // which saves the file on ITS disk (where its agents can actually read it).
  if (path === "/api/upload" && req.method === "POST") {
    const EXT = {
      "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif",
      "application/pdf": ".pdf",
      "audio/mpeg": ".mp3", "audio/mp3": ".mp3", "audio/mp4": ".m4a", "audio/x-m4a": ".m4a",
      "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/ogg": ".ogg", "audio/webm": ".webm",
      "audio/aac": ".aac", "audio/flac": ".flac",
    };
    mkdirSync(UPLOADS_DIR, { recursive: true });
    // sanitized original name (for humans) + ms timestamp (uniqueness) — never trust the client's filename
    const cleanBase = (raw) => (typeof raw === "string" ? basename(raw) : "").replace(/\.[^.]*$/, "").replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 40) || "screenshot";
    // raw octet-stream branch (new clients): bytes stream straight to disk, up to UPLOAD_MAX.
    // The type allowlist is enforced by extension — same set as the base64 MIME allowlist.
    if (isRawUpload(req)) {
      const rawName = new URL(req.url, "http://x").searchParams.get("name") || "";
      const ext = extname(basename(rawName)).toLowerCase();
      if (!Object.values(EXT).includes(ext)) return sendJSON(res, 400, { ok: false, err: "formato no soportado (png/jpeg/webp/gif/pdf/audio)" });
      const file = join(UPLOADS_DIR, `${Date.now()}-${cleanBase(rawName)}${ext}`);
      const tmp = `${file}.mt3k-tmp-${process.pid}`;
      const r = await streamUploadToFile(req, tmp);
      if (!r.ok) { try { unlinkSync(tmp); } catch { /* none */ } return sendJSON(res, r.err?.includes("grande") ? 413 : 400, { ok: false, err: r.err }); }
      renameSync(tmp, file);
      logEvent(`upload · ${basename(file)} · ${Math.round(r.size / 1024)}KB`);
      return sendJSON(res, 200, { ok: true, path: file });
    }
    // legacy base64-in-JSON branch (old federated panels) — small files only
    const { name, data } = await body(req);
    if (typeof data !== "string" || !data) return sendJSON(res, 400, { ok: false, err: "imagen vacía" });
    const m = data.match(/^data:(image\/(?:png|jpeg|webp|gif)|application\/pdf|audio\/(?:mpeg|mp3|mp4|x-m4a|wav|x-wav|ogg|webm|aac|flac));base64,([A-Za-z0-9+/=]+)$/);
    if (!m) return sendJSON(res, 400, { ok: false, err: "formato no soportado (png/jpeg/webp/gif/pdf/audio)" });
    const buf = Buffer.from(m[2], "base64");
    if (!buf.length) return sendJSON(res, 400, { ok: false, err: "archivo vacío" });
    if (buf.length > 25 * 1024 * 1024) return sendJSON(res, 400, { ok: false, err: "archivo demasiado grande (máx 25MB)" });
    const file = join(UPLOADS_DIR, `${Date.now()}-${cleanBase(name)}${EXT[m[1]]}`);
    writeFileSync(file, buf);
    logEvent(`upload · ${basename(file)} · ${Math.round(buf.length / 1024)}KB`);
    return sendJSON(res, 200, { ok: true, path: file });
  }

  // one message → every live agent pane on this host (and, unless flat=1, on federated hosts too)
  if (path === "/api/broadcast" && req.method === "POST") {
    const { text, cwdPrefix } = await body(req);
    if (typeof text !== "string" || !text.trim()) return sendJSON(res, 400, { ok: false, err: "texto vacío" });
    if (text.length > 4000) return sendJSON(res, 400, { ok: false, err: "texto demasiado largo (máx 4000)" });
    // Focus mode: only sessions whose cwd lives under the focused project (clones on other hosts match too)
    const inPrefix = (cwd) => typeof cwdPrefix !== "string" || !cwdPrefix || cwd === cwdPrefix || cwd.startsWith(cwdPrefix + "/");
    const locals = (await detectAgents()).flatMap((a) => a.panes).filter((p) => inPrefix(p.cwd));
    let sent = 0;
    for (const p of locals) { if ((await pasteToPane(p.paneId, text, true)).ok) sent++; }
    const flat = new URL(req.url, "http://x").searchParams.get("flat");
    if (!flat) {
      for (const h of readHosts()) {
        try {
          const r = await fetch(`${h.url.replace(/\/$/, "")}/api/broadcast?flat=1`, {
            method: "POST", signal: AbortSignal.timeout(5000),
            headers: { "content-type": "application/json", ...(h.token ? { authorization: `Bearer ${h.token}` } : {}) },
            body: JSON.stringify({ text, cwdPrefix }),
          });
          if (r.ok) sent += (await r.json()).sent || 0;
        } catch { /* host down → skip */ }
      }
    }
    logEvent(`broadcast · ${sent} panes · "${text.slice(0, 60).replace(/\s+/g, " ").trim()}"`);
    return sendJSON(res, 200, { ok: true, sent });
  }

  // --- federated hosts CRUD (edits data/hosts.json from Settings) ---
  // list never returns tokens — the browser only ever learns whether one is set
  if (path === "/api/hosts") {
    const hosts = await Promise.all(readHostsAll().map(async (h) => {
      let reachable = false;
      if (!h.disabled) {
        try {
          const r = await fetch(`${h.url.replace(/\/$/, "")}/api/agents?flat=1`, {
            headers: h.token ? { authorization: `Bearer ${h.token}` } : {}, signal: AbortSignal.timeout(2500),
          });
          reachable = r.ok;
        } catch { /* down/unreachable */ }
      }
      return { id: h.id, name: h.name || h.id, url: h.url, hasToken: !!h.token, reachable, disabled: !!h.disabled };
    }));
    return sendJSON(res, 200, { hosts });
  }

  // start a web-UI agent's server on THIS host (federation: ?host= proxies it). Prefers the
  // host's systemd unit when one exists (lifecycle stays with systemd); otherwise spawns the
  // CLI detached + hidden (Windows: no console window) so it survives panel restarts.
  if (path === "/api/web-start" && req.method === "POST") {
    const { agentId } = await body(req);
    const def = AGENT_DEFS.find((a) => a.id === agentId && a.web && a.webCmd);
    if (!def) return sendJSON(res, 400, { ok: false, err: "ese agente no tiene UI web arrancable" });
    if (denyUnlessCap(res, def, "launch")) return;
    const r = await startWebTool(def);
    return sendJSON(res, r.ok ? 200 : 500, r);
  }

  // stop + start — e.g. dsh requires a restart after installing a plugin
  if (path === "/api/web-restart" && req.method === "POST") {
    const { agentId } = await body(req);
    const def = AGENT_DEFS.find((a) => a.id === agentId && a.web && a.webCmd);
    if (!def) return sendJSON(res, 400, { ok: false, err: "ese agente no tiene UI web arrancable" });
    if (denyUnlessCap(res, def, "launch")) return;
    await stopWebTool(def); // best effort — if it wasn't running we just start it
    const r = await startWebTool(def);
    if (r.ok) logEvent(`web-restart · ${def.id}`);
    return sendJSON(res, r.ok ? 200 : 500, r);
  }

  if (path === "/api/vitals") {
    return sendJSON(res, 200, { ok: true, vitals: await readVitals() });
  }

  // local + every enabled federated host, in one shot for the fleet-health row
  if (path === "/api/fleet-vitals") {
    const out = [{ id: "local", name: "local", vitals: await readVitals() }];
    await Promise.all(readHosts().map(async (h) => {
      try {
        const r = await fetch(`${h.url.replace(/\/$/, "")}/api/vitals`, {
          headers: h.token ? { authorization: `Bearer ${h.token}` } : {}, signal: AbortSignal.timeout(6000),
        });
        if (r.ok) out.push({ id: h.id, name: h.name || h.id, vitals: (await r.json()).vitals });
        else out.push({ id: h.id, name: h.name || h.id, vitals: null });
      } catch { out.push({ id: h.id, name: h.name || h.id, vitals: null }); }
    }));
    return sendJSON(res, 200, { ok: true, hosts: out });
  }

  // stop a web-UI agent's server (the ⏻ symmetry of prender/reiniciar)
  if (path === "/api/web-stop" && req.method === "POST") {
    const { agentId } = await body(req);
    const def = AGENT_DEFS.find((a) => a.id === agentId && a.web && a.webCmd);
    if (!def) return sendJSON(res, 400, { ok: false, err: "ese agente no tiene UI web" });
    if (denyUnlessCap(res, def, "kill")) return;
    const stopped = await stopWebTool(def);
    if (stopped) logEvent(`web-stop · ${def.id}`);
    return sendJSON(res, stopped ? 200 : 500, stopped ? { ok: true } : { ok: false, err: "no se pudo detener (¿estaba corriendo?)" });
  }

  // quick-prompts editor (Settings) — writes the host-local data/macros.json
  if (path === "/api/save-macros" && req.method === "POST") {
    const { macros } = await body(req);
    if (!Array.isArray(macros) || macros.some((m) => typeof m !== "string") || macros.length > 30) return sendJSON(res, 400, { ok: false, err: "lista inválida (máx 30)" });
    const clean = macros.map((m) => m.trim()).filter(Boolean).map((m) => m.slice(0, 200));
    writeFileSync(join(ROOT, "data", "macros.json"), JSON.stringify({ macros: clean }, null, 2) + "\n");
    logEvent(`macros · ${clean.length} guardados`);
    return sendJSON(res, 200, { ok: true, macros: clean });
  }

  // RECEIVE a fleet update: extract the gzipped-tar bundle over ROOT, then restart.
  if (path === "/api/self-update" && req.method === "POST") {
    const raw = await rawBody(req);
    let bundle;
    try { bundle = JSON.parse(raw).bundle; } catch { return sendJSON(res, 400, { ok: false, err: "cuerpo inválido" }); }
    if (typeof bundle !== "string" || !bundle) return sendJSON(res, 400, { ok: false, err: "bundle vacío" });
    let buf;
    try { buf = Buffer.from(bundle, "base64"); if (buf[0] !== 0x1f || buf[1] !== 0x8b) throw new Error("no es gzip"); } catch (e) { return sendJSON(res, 400, { ok: false, err: `bundle inválido: ${e.message}` }); }
    if (buf.length > 64 * 1024 * 1024) return sendJSON(res, 400, { ok: false, err: "bundle demasiado grande" });
    const tmp = join(ROOT, ".update.tgz");
    try {
      writeFileSync(tmp, buf);
      const r = spawnSync("tar", ["xzf", tmp, "-C", ROOT], { maxBuffer: 8 * 1024 * 1024 });
      unlinkSync(tmp);
      if (r.status !== 0) return sendJSON(res, 500, { ok: false, err: "tar xzf falló: " + (r.stderr?.toString().slice(0, 200) || r.status) });
    } catch (e) { try { unlinkSync(tmp); } catch { /* none */ } return sendJSON(res, 500, { ok: false, err: String(e).slice(0, 200) }); }
    logEvent("self-update aplicado — reiniciando");
    sendJSON(res, 200, { ok: true });
    scheduleSelfRestart();
    return;
  }

  // PUSH an update to every enabled federated host (this host = the aggregator/source).
  if (path === "/api/update-fleet" && req.method === "POST") {
    let bundle;
    try { bundle = buildUpdateBundle().toString("base64"); } catch (e) { return sendJSON(res, 500, { ok: false, err: String(e).slice(0, 200) }); }
    const results = [];
    for (const h of readHosts()) {
      try {
        const r = await fetch(`${h.url.replace(/\/$/, "")}/api/self-update`, {
          method: "POST", signal: AbortSignal.timeout(60000),
          headers: { "content-type": "application/json", ...(h.token ? { authorization: `Bearer ${h.token}` } : {}) },
          body: JSON.stringify({ bundle }),
        });
        results.push({ id: h.id, ok: r.ok, status: r.status });
      } catch (e) { results.push({ id: h.id, ok: false, err: String(e).slice(0, 80) }); }
    }
    logEvent(`update-fleet · ${results.filter((x) => x.ok).length}/${results.length} ok · ${Math.round(Buffer.byteLength(bundle, "base64") / 1024)}KB`);
    return sendJSON(res, 200, { ok: true, sizeKB: Math.round(bundle.length * 0.75 / 1024), results });
  }

  // reorder federated hosts — hosts.json order IS the wall/sidebar order
  if (path === "/api/move-host" && req.method === "POST") {
    const { id, dir } = await body(req);
    const hf = join(ROOT, "data", "hosts.json");
    const cfg = existsSync(hf) ? readJSON(hf) : { hosts: [] };
    const list = cfg.hosts || [];
    const i = list.findIndex((h) => h.id === id);
    const j = i + (dir === -1 ? -1 : 1);
    if (i < 0 || j < 0 || j >= list.length) return sendJSON(res, 400, { ok: false, err: "no se puede mover" });
    [list[i], list[j]] = [list[j], list[i]];
    cfg.hosts = list;
    writeFileSync(hf, JSON.stringify(cfg, null, 2) + "\n");
    return sendJSON(res, 200, { ok: true });
  }

  // flip a federated host on/off WITHOUT losing its config (url + token stay in hosts.json)
  if (path === "/api/toggle-host" && req.method === "POST") {
    const { id, disabled } = await body(req);
    const hf = join(ROOT, "data", "hosts.json");
    const cfg = existsSync(hf) ? readJSON(hf) : { hosts: [] };
    const h = (cfg.hosts || []).find((x) => x.id === id);
    if (!h) return sendJSON(res, 404, { ok: false, err: "host desconocido" });
    h.disabled = !!disabled;
    writeFileSync(hf, JSON.stringify(cfg, null, 2) + "\n");
    logEvent(`toggle-host · ${id} · ${h.disabled ? "apagado" : "prendido"}`);
    return sendJSON(res, 200, { ok: true, disabled: h.disabled });
  }

  if (path === "/api/save-host" && req.method === "POST") {
    const { id: idIn, name, url: urlIn, token } = await body(req);
    if (typeof urlIn !== "string" || !/^https?:\/\/[^\s/]+/.test(urlIn.trim())) return sendJSON(res, 400, { ok: false, err: "URL inválida (http://ip:puerto)" });
    const url = urlIn.trim().replace(/\/$/, "");
    const id = (idIn || name || new URL(url).hostname).toString().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24);
    if (!id) return sendJSON(res, 400, { ok: false, err: "nombre/id inválido" });
    const hf = join(ROOT, "data", "hosts.json");
    const cfg = existsSync(hf) ? readJSON(hf) : { hosts: [] };
    cfg.hosts = cfg.hosts || [];
    const prev = cfg.hosts.find((h) => h.id === id);
    const entry = {
      id, name: (name || id).toString().slice(0, 40), url,
      // empty token on edit keeps the stored one — so editing the URL never forces re-pasting the secret
      token: typeof token === "string" && token.trim() ? token.trim() : prev?.token || "",
      ...(prev?.disabled ? { disabled: true } : {}), // editing never silently re-enables
    };
    const at = cfg.hosts.findIndex((h) => h.id === id);
    if (at >= 0) cfg.hosts[at] = entry; else cfg.hosts.push(entry); // in place: editing keeps the wall order
    writeFileSync(hf, JSON.stringify(cfg, null, 2) + "\n");
    // reachability probe so Settings can show instant feedback
    let reachable = false, status = 0;
    try {
      const r = await fetch(`${url}/api/agents?flat=1`, { headers: entry.token ? { authorization: `Bearer ${entry.token}` } : {}, signal: AbortSignal.timeout(3000) });
      reachable = r.ok; status = r.status;
    } catch { /* down */ }
    logEvent(`save-host · ${id} · ${url} · ${reachable ? "ok" : `unreachable(${status || "timeout"})`}`);
    return sendJSON(res, 200, { ok: true, id, reachable, status });
  }

  if (path === "/api/remove-host" && req.method === "POST") {
    const { id } = await body(req);
    const hf = join(ROOT, "data", "hosts.json");
    const cfg = existsSync(hf) ? readJSON(hf) : { hosts: [] };
    cfg.hosts = (cfg.hosts || []).filter((h) => h.id !== id);
    writeFileSync(hf, JSON.stringify(cfg, null, 2) + "\n");
    logEvent(`remove-host · ${id}`);
    return sendJSON(res, 200, { ok: true });
  }

  // quick prompts for the compose bar — host-local data/macros.json or sensible defaults
  if (path === "/api/macros") {
    let macros = ["continúa", "¿en qué vas? dame un resumen corto", "commit y push lo que tengas", "para lo que estás haciendo"];
    try { const m = readJSON(join(ROOT, "data", "macros.json")).macros; if (Array.isArray(m) && m.length) macros = m.filter((x) => typeof x === "string"); } catch { /* defaults */ }
    return sendJSON(res, 200, { macros });
  }

  // send a single named key to a tmux pane (arrow-key nav in TUI menus: Codex/Claude pickers, etc.)
  // allowlisted to tmux key names only → never raw shell, never arbitrary keystrokes
  if (path === "/api/key" && req.method === "POST") {
    const { paneId, key } = await body(req);
    const paneCheck = validatePaneId(paneId);
    if (!paneCheck.ok) return sendJSON(res, 400, { ok: false, err: paneCheck.err });
    const args = keyArgs(key);
    if (!args) return sendJSON(res, 400, { ok: false, err: "tecla no permitida" });
    if (denyUnlessCap(res, SHELL_DEF, "keys")) return;
    const live = (await run("tmux", ["list-panes", "-a", "-F", "#{pane_id}"], ROOT, 5000)).out.split("\n");
    if (!live.includes(paneId)) return sendJSON(res, 404, { ok: false, err: "ese pane ya no existe" });
    const r = await run("tmux", ["send-keys", "-t", paneId, ...args], ROOT, 5000);
    if (!r.ok) return sendJSON(res, 500, { ok: false, err: r.err || "send-keys falló" });
    logEvent(`key · ${paneId} · ${key}`);
    return sendJSON(res, 200, { ok: true, paneId, key });
  }

  if (path === "/api/resumable" && req.method === "GET") {
    const params = new URL(req.url, "http://x").searchParams;
    const agentId = params.get("agentId");
    const def = AGENT_DEFS.find((a) => a.id === agentId);
    const isShell = agentId === "shell";
    if (!HAS_TMUX || !def || (!isShell && (!def.proc?.length || !def.bins.map(absBin).find(Boolean)))) {
      return sendJSON(res, 200, { ok: true, resumable: false, reason: "not-launchable" });
    }
    if (!isShell && denyUnlessCap(res, def, "resume")) return;
    const target = await resolveLaunchCwd({ projectId: params.get("projectId"), cwd: params.get("cwd") });
    if (target.err) return sendJSON(res, 200, { ok: true, resumable: false, reason: "no-dir" });
    const probe = await resumeProbe(def, agentId, target.cwd);
    const decision = decideResume(probe);
    return sendJSON(res, 200, { ok: true, cwd: tildify(target.cwd), resumable: decision.resume, alreadyOpen: probe.alreadyOpen, hasHistory: probe.hasHistory, reason: decision.reason });
  }

  // launch an agent CLI in a fresh detached tmux session (LAN-only). The binary comes from
  // AGENT_DEFS (allowlist) — never from the client; cwd is a tracked project or a real dir.
  if (path === "/api/launch" && req.method === "POST") {
    if (!HAS_TMUX) return sendJSON(res, 400, { ok: false, err: "tmux no está instalado en este host" });
    const { agentId, projectId, cwd: cwdIn, create, firstPrompt, fresh } = await body(req);
    const def = AGENT_DEFS.find((a) => a.id === agentId);
    const isShell = agentId === "shell";
    if (!def || (!isShell && !(def.proc && def.proc.length))) return sendJSON(res, 400, { ok: false, err: "agente no lanzable" });
    if (denyUnlessCap(res, def, "launch")) return;
    const bin = isShell ? null : def.bins.map(absBin).find(Boolean);
    if (!isShell && !bin) return sendJSON(res, 400, { ok: false, err: `${def.name} no está instalado` });
    const target = await resolveLaunchCwd({ projectId, cwd: cwdIn });
    if (target.err && !(target.missingDir && create)) {
      const { status, cwd: _cwd, ...error } = target;
      return sendJSON(res, status, { ok: false, ...error });
    }
    const cwd = target.cwd;
    if (target.missingDir) {
      try { mkdirSync(target.cwd, { recursive: true }); } catch { return sendJSON(res, 500, { ok: false, err: "no se pudo crear la carpeta" }); }
    }
    // readable session name: mt3k-claude-onvacation-x4f (target dir + short suffix for uniqueness)
    const session = mt3kSessionName(agentId, basename(cwd) || "home");
    // optional host-local launch flags (data/launch.json, gitignored) — shell aliases don't apply
    // here because we spawn the raw binary, so per-host env/args live in data instead. resumeArgs
    // are appended only when this agent has no live pane in the same working directory.
    // shell → NO command: tmux spawns the user's default shell, so rc files and aliases apply
    let cmd = isShell ? [] : [bin];
    let resumed = false;
    let reason = "no-args";
    let resumeReservation = null;
    let ownsResumeReservation = false;
    try {
      const lc = isShell ? null : readJSON(join(ROOT, "data", "launch.json"))[agentId];
      if (lc) {
        const { envPairs, args } = parseLaunchConfig(lc);
        const reservationKey = `${agentId}\0${tildify(realDir(cwd))}`;
        if (!resumeLaunchReservations.has(reservationKey)) {
          resumeReservation = reservationKey;
          ownsResumeReservation = true;
          resumeLaunchReservations.add(resumeReservation);
        }
        const probe = await resumeProbe(def, agentId, cwd);
        const decision = decideResume({ ...probe, fresh: fresh === true, alreadyOpen: probe.alreadyOpen || !ownsResumeReservation });
        reason = decision.reason;
        if (!decision.resume && ownsResumeReservation) {
          resumeLaunchReservations.delete(resumeReservation);
          resumeReservation = null;
          ownsResumeReservation = false;
        }
        const launchArgs = decision.resume ? [...args, ...probe.resumeArgs] : args;
        if (decision.resume) resumed = true;
        cmd = isShell ? [] : composeTmuxArgv({ bin, envPairs, args: launchArgs });
      }
    } catch {
      if (ownsResumeReservation) resumeLaunchReservations.delete(resumeReservation);
      resumeReservation = null;
      ownsResumeReservation = false;
      // no/invalid launch.json → plain binary
    }
    if (!isShell && cmd.length === 1) cmd = composeTmuxArgv({ bin, envPairs: [], args: [] });
    // Un servidor tmux nacido en Codex/Claude/Cursor arrastra su env al global; aquí lo limpiamos en cada launch.
    // PATH (see agentPath): tmux gives a new session the PATH of the CLIENT running `new-session`,
    // so running tmux with tmuxEnv is what sets it (and a server born right here starts with a
    // clean global env too). -e also stores it in the session env for windows opened later in it,
    // and the global copy keeps windows opened from other sessions in sync.
    let r;
    try {
      const tmuxEnv = { PATH: await agentPath() };
      const globalEnv = parseTmuxGlobalEnv((await run("tmux", ["show-environment", "-g"], ROOT, 3000, tmuxEnv)).out);
      for (const key of tmuxGlobalKeysToUnset(globalEnv)) {
        await run("tmux", ["set-environment", "-gr", key], ROOT, 3000, tmuxEnv);
      }
      if (needsGlobalColortermTruecolor(globalEnv)) {
        await run("tmux", ["set-environment", "-g", "COLORTERM", "truecolor"], ROOT, 3000, tmuxEnv);
      }
      // global = the user's PATH + whatever the running server already had (e.g. kitty's own dir
      // for windows opened from kitty), cleaned — never narrower than before
      const curGlobal = (await run("tmux", ["show-environment", "-g", "PATH"], ROOT, 3000, tmuxEnv)).out.replace(/^PATH=/, "");
      await run("tmux", ["set-environment", "-g", "PATH", cleanPath([...tmuxEnv.PATH.split(delimiter), ...(curGlobal ? curGlobal.split(delimiter) : [])])], ROOT, 3000, tmuxEnv);
      // -d detached · -e PATH + COLORTERM · -P -F prints the new pane id + label · -c cwd · then the agent binary (no shell)
      r = await run("tmux", ["new-session", "-d", "-e", `PATH=${tmuxEnv.PATH}`, "-e", "COLORTERM=truecolor", "-P", "-F", "#{pane_id}|#{session_name}:#{window_index}.#{pane_index}", "-s", session, "-c", cwd, ...cmd], ROOT, 8000, tmuxEnv);
      if (r.ok) await ensureTmuxHooks(true);
    } finally {
      // tmux returns before the agent process shows up in the process tree, so a quick second
      // launch could miss it; keep the reservation until the new pane is discoverable
      if (ownsResumeReservation) setTimeout(() => resumeLaunchReservations.delete(resumeReservation), RESUME_HOLD_MS);
    }
    if (!r.ok) return sendJSON(res, 500, { ok: false, err: r.err || "tmux new-session falló (¿tmux instalado?)" });
    const [paneId, label] = (r.out || "").split("|");
    // optional first message: wait for the CLI to boot (screen settles), then paste + enter.
    // fire-and-forget — the client already has its pane and is watching it live.
    if (typeof firstPrompt === "string" && firstPrompt.trim() && firstPrompt.length <= 64000) {
      (async () => {
        let prev = "";
        for (let i = 0; i < 10; i++) {
          await new Promise((ok) => setTimeout(ok, 2000));
          const cap = await run("tmux", ["capture-pane", "-t", paneId, "-p"], ROOT, 4000);
          if (!cap.ok) return; // pane died before boot
          if (cap.out.trim() && cap.out === prev) break; // two identical captures → CLI is idle at its prompt
          prev = cap.out;
        }
        await pasteToPane(paneId, firstPrompt.trim(), true);
        logEvent(`first-prompt · ${agentId} · "${firstPrompt.slice(0, 60).replace(/\s+/g, " ").trim()}"`);
      })().catch(() => {});
    }
    logEvent(`launch · ${agentId} · ${session} · ${tildify(cwd)} · resumed=${resumed}`);
    return sendJSON(res, 200, { ok: true, paneId, label: label || session, session, cwd: tildify(cwd), resumed, reason });
  }

  // kill an agent's tmux pane (its dedicated session dies with its last pane)
  if (path === "/api/kill" && req.method === "POST") {
    const { paneId } = await body(req);
    const paneCheck = validatePaneId(paneId);
    if (!paneCheck.ok) return sendJSON(res, 400, { ok: false, err: paneCheck.err });
    if (denyUnlessCap(res, SHELL_DEF, "kill")) return;
    const live = (await run("tmux", ["list-panes", "-a", "-F", "#{pane_id}"], ROOT, 5000)).out.split("\n");
    if (!live.includes(paneId)) return sendJSON(res, 404, { ok: false, err: "ese pane ya no existe" });
    const r = await run("tmux", ["kill-pane", "-t", paneId], ROOT, 5000);
    if (!r.ok) return sendJSON(res, 500, { ok: false, err: r.err || "kill-pane falló" });
    logEvent(`kill · ${paneId}`);
    return sendJSON(res, 200, { ok: true, paneId });
  }

  // live pane stream (SSE): pushes the rendered screen only when it changes — smoother than polling
  if (path === "/api/pane-stream") {
    const params = new URL(req.url, "http://x").searchParams;
    const paneId = params.get("id") || "";
    // Opt-in diffs preserve full strings for old bundles and mixed-version federation.
    const lineDiffs = params.get("fmt") === "lines";
    const paneCheck = validatePaneId(paneId);
    if (!paneCheck.ok) return sendJSON(res, 400, { ok: false, err: paneCheck.err });
    if (denyUnlessCap(res, SHELL_DEF, "view")) return;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "access-control-allow-origin": "*" });
    let last = null, lastAlt = null, lastMouseSgr = null, idleTicks = 0, closed = false, busy = false;
    const tick = async () => {
      // Diffs are relative to `last`: a slow capture-pane must never overlap the next tick,
      // or an out-of-order frame would corrupt the client's line buffer until it reloads.
      if (closed || busy) return;
      busy = true;
      try {
        const r = await run("tmux", ["capture-pane", "-t", paneId, "-p", "-e", "-N", "-S", "-1000"], ROOT, 5000);
        if (closed) return;
        if (!r.ok) { res.write(`event: gone\ndata: {}\n\n`); return end(); }
        const lines = r.out.split("\n");
        let from = 0;
        while (last !== null && from < last.length && from < lines.length && last[from] === lines[from]) from++;
        const sameFrame = last !== null && from === last.length && from === lines.length;
        // alt-screen changes rarely (CLI enters/leaves its full-screen UI); notify as a NAMED
        // event so old bundles (which only listen to unnamed data) ignore it untouched.
        // The probe is a whole second tmux process — run it only when the frame changed,
        // or at most every 10 ticks (~5 s) while the pane sits idle.
        let alt = lastAlt, mouseSgr = lastMouseSgr;
        if (!sameFrame || ++idleTicks >= 10) {
          idleTicks = 0;
          const flags = parseAlternateMouseSgr(
            (await run("tmux", ["display-message", "-p", "-t", paneId, TMUX_ALT_MOUSE_DISPLAY], ROOT, 4000)).out,
          );
          alt = flags.alternate;
          mouseSgr = flags.mouse_sgr;
          if (alt !== lastAlt || mouseSgr !== lastMouseSgr) {
            lastAlt = alt;
            lastMouseSgr = mouseSgr;
            res.write(`event: alt\ndata: ${JSON.stringify({ alt, mouse_sgr: mouseSgr })}\n\n`);
          }
        }
        if (sameFrame) return;
        if (last === null) {
          res.write(`data: ${JSON.stringify(r.out)}\n\n`);
        } else {
          res.write(`data: ${JSON.stringify(lineDiffs ? { from, lines: lines.slice(from), alt, mouse_sgr: mouseSgr } : r.out)}\n\n`);
        }
        last = lines;
      } finally {
        busy = false;
      }
    };
    const iv = setInterval(tick, 500);
    const end = () => { if (!closed) { closed = true; clearInterval(iv); try { res.end(); } catch { /* gone */ } } };
    req.on("close", end);
    tick();
    return; // keep the connection open
  }

  if (path === "/api/query" && req.method === "POST") {
    const { projectId, q } = await body(req);
    const cwd = projectPath(projectId);
    if (!cwd || !q) return sendJSON(res, 400, { ok: false, err: "missing projectId or q" });
    if (!GRAPHIFY) return sendJSON(res, 500, { ok: false, err: "graphify not found" });
    const r = await run(GRAPHIFY, ["query", q], cwd, 45000);
    logEvent(`query · ${projectId} · "${q}"`);
    return sendJSON(res, 200, { ok: r.ok, answer: r.out || r.err });
  }

  if (path === "/api/refresh" && req.method === "POST") {
    const { projectId } = await body(req);
    const cwd = projectPath(projectId);
    if (cwd && GRAPHIFY) {
      await run(GRAPHIFY, ["update", "."], cwd, 120000);
      await run(GRAPHIFY, ["export", "wiki"], cwd, 60000);
    }
    const ingest = await run("node", [join(ROOT, "scripts", "build-data.mjs")], ROOT, 120000);
    logEvent(`refresh · ${projectId || "all"} · ${ingest.ok ? "ok" : "failed"}`);
    return sendJSON(res, 200, { ok: ingest.ok, log: ingest.out });
  }
  // --- file browser / viewer / editor (same trust boundary as typing into agent panes:
  // anyone who can reach /api/* can already run commands through an agent). Paths are
  // absolute on THIS host; ?host= proxies the whole thing to a federated panel, so the
  // browser walks that host's disk. `~` expands to the server user's home.
  if (path === "/api/fs/list") {
    const dir = fsPath(new URL(req.url, "http://x").searchParams.get("path") || "~");
    if (!dir) return sendJSON(res, 400, { ok: false, err: "ruta inválida" });
    let st; try { st = statSync(dir); } catch { return sendJSON(res, 404, { ok: false, err: "esa carpeta no existe" }); }
    if (!st.isDirectory()) return sendJSON(res, 400, { ok: false, err: "no es una carpeta" });
    let names; try { names = readdirSync(dir, { withFileTypes: true }); } catch (e) { return sendJSON(res, 403, { ok: false, err: `sin acceso: ${e.code || e}` }); }
    const entries = names.flatMap((d) => {
      try {
        const full = join(dir, d.name);
        const isDir = d.isSymbolicLink() ? statSync(full).isDirectory() : d.isDirectory();
        const s2 = statSync(full);
        return [{ name: d.name, dir: isDir, size: isDir ? 0 : s2.size, mtime: s2.mtimeMs }];
      } catch { return []; } // dangling symlink / vanished mid-list
    });
    // one-tap destinations: home, every tracked project, the panel's own uploads
    const quick = [{ name: "~", path: homedir() }, ...projects().map((pr) => ({ name: pr.name || pr.id, path: expand(pr.path) })), { name: "uploads", path: UPLOADS_DIR }];
    return sendJSON(res, 200, { ok: true, path: dir, parent: dirname(dir), home: homedir(), quick, entries });
  }

  if (path === "/api/fs/read") {
    const file = fsPath(new URL(req.url, "http://x").searchParams.get("path") || "");
    if (!file) return sendJSON(res, 400, { ok: false, err: "ruta inválida" });
    let st; try { st = statSync(file); } catch { return sendJSON(res, 404, { ok: false, err: "ese archivo no existe" }); }
    if (!st.isFile()) return sendJSON(res, 400, { ok: false, err: "no es un archivo" });
    const mime = fsMime(file);
    if (st.size > FS_TEXT_MAX) return sendJSON(res, 200, { ok: true, path: file, kind: "binary", mime, size: st.size, mtime: st.mtimeMs, tooBig: true });
    const buf = readFileSync(file);
    // NUL byte in the first 8KB → treat as binary; everything else is editable text
    if (buf.subarray(0, 8192).includes(0)) return sendJSON(res, 200, { ok: true, path: file, kind: "binary", mime, size: st.size, mtime: st.mtimeMs });
    return sendJSON(res, 200, { ok: true, path: file, kind: "text", mime, content: buf.toString("utf8"), size: st.size, mtime: st.mtimeMs });
  }

  // atomic write (tmp + rename) with an optional optimistic lock: expectMtime = the mtime the
  // editor loaded → if the file changed underneath (an agent edited it), refuse with conflict
  if (path === "/api/fs/write" && req.method === "POST") {
    const { path: p, content, expectMtime } = await body(req);
    const file = fsPath(typeof p === "string" ? p : "");
    if (!file) return sendJSON(res, 400, { ok: false, err: "ruta inválida" });
    if (typeof content !== "string") return sendJSON(res, 400, { ok: false, err: "contenido inválido" });
    if (Buffer.byteLength(content) > FS_TEXT_MAX) return sendJSON(res, 400, { ok: false, err: "archivo demasiado grande (máx 2MB)" });
    if (!existsSync(dirname(file))) return sendJSON(res, 400, { ok: false, err: "la carpeta no existe" });
    if (existsSync(file)) {
      const st = statSync(file);
      if (!st.isFile()) return sendJSON(res, 400, { ok: false, err: "no es un archivo" });
      if (typeof expectMtime === "number" && Math.abs(st.mtimeMs - expectMtime) > 1) return sendJSON(res, 409, { ok: false, conflict: true, err: "el archivo cambió en disco desde que lo abriste" });
    }
    const tmp = `${file}.mt3k-tmp-${process.pid}`;
    try { writeFileSync(tmp, content); renameSync(tmp, file); } catch (e) { try { unlinkSync(tmp); } catch { /* none */ } return sendJSON(res, 500, { ok: false, err: `no se pudo guardar: ${e.code || e}` }); }
    logEvent(`fs-write · ${file} · ${Buffer.byteLength(content)}B`);
    return sendJSON(res, 200, { ok: true, path: file, mtime: statSync(file).mtimeMs });
  }

  // drop a file from the device into the current folder (any type — this is a file manager,
  // not the agent-attach flow). Refuses to clobber silently: existing name -> 409 unless overwrite.
  if (path === "/api/fs/upload" && req.method === "POST") {
    // raw octet-stream branch (new clients): metadata in the query string, bytes streamed to disk
    const raw = isRawUpload(req);
    const q = raw ? new URL(req.url, "http://x").searchParams : null;
    const { dir, name, data, overwrite } = raw
      ? { dir: q.get("dir") || "", name: q.get("name") || "", data: null, overwrite: q.get("overwrite") === "1" }
      : await body(req);
    const target = fsPath(typeof dir === "string" ? dir : "");
    if (!target) return sendJSON(res, 400, { ok: false, err: "carpeta inválida" });
    let st; try { st = statSync(target); } catch { return sendJSON(res, 404, { ok: false, err: "esa carpeta no existe" }); }
    if (!st.isDirectory()) return sendJSON(res, 400, { ok: false, err: "no es una carpeta" });
    // keep the original name minus path separators and control bytes — never trust the client
    const rawName = typeof name === "string" ? basename(name) : "";
    const clean = Array.from(rawName).filter((c) => c.charCodeAt(0) > 31 && c !== "/" && c !== "\\").join("").trim();
    if (!clean || clean === "." || clean === "..") return sendJSON(res, 400, { ok: false, err: "nombre inválido" });
    const file = join(target, clean);
    if (existsSync(file) && !overwrite) return sendJSON(res, 409, { ok: false, exists: true, err: "ya existe un archivo con ese nombre" });
    const tmp = `${file}.mt3k-tmp-${process.pid}`;
    let size = 0;
    if (raw) {
      const r = await streamUploadToFile(req, tmp);
      if (!r.ok) { try { unlinkSync(tmp); } catch { /* none */ } return sendJSON(res, r.err?.includes("grande") ? 413 : 400, { ok: false, err: r.err }); }
      try { renameSync(tmp, file); } catch (e) { try { unlinkSync(tmp); } catch { /* none */ } return sendJSON(res, 500, { ok: false, err: `no se pudo subir: ${e.code || e}` }); }
      size = r.size;
    } else {
      // legacy base64-in-JSON branch (old federated panels) — small files only
      const m = typeof data === "string" ? data.match(/^data:[^;,]*;base64,([A-Za-z0-9+\/=]+)$/) : null;
      if (!m) return sendJSON(res, 400, { ok: false, err: "archivo vacío o mal codificado" });
      const buf = Buffer.from(m[1], "base64");
      if (buf.length > 25 * 1024 * 1024) return sendJSON(res, 400, { ok: false, err: "archivo demasiado grande (máx 25MB)" });
      try { writeFileSync(tmp, buf); renameSync(tmp, file); } catch (e) { try { unlinkSync(tmp); } catch { /* none */ } return sendJSON(res, 500, { ok: false, err: `no se pudo subir: ${e.code || e}` }); }
      size = buf.length;
    }
    logEvent(`fs-upload · ${file} · ${Math.round(size / 1024)}KB`);
    return sendJSON(res, 200, { ok: true, path: file });
  }

  // move/rename a file or folder. `to` may be a target directory (moves inside, keeps the name)
  // or a full destination path (rename). Never clobbers without overwrite.
  if (path === "/api/fs/move" && req.method === "POST") {
    const { from, to, overwrite } = await body(req);
    const src = fsPath(typeof from === "string" ? from : "");
    let dst = fsPath(typeof to === "string" ? to : "");
    if (!src || !dst) return sendJSON(res, 400, { ok: false, err: "ruta inválida" });
    let st; try { st = statSync(src); } catch { return sendJSON(res, 404, { ok: false, err: "el origen no existe" }); }
    try { if (statSync(dst).isDirectory()) dst = join(dst, basename(src)); } catch { /* full destination path */ }
    if (src === dst) return sendJSON(res, 200, { ok: true, path: dst });
    if (dst.startsWith(src + "/")) return sendJSON(res, 400, { ok: false, err: "no puedes mover una carpeta dentro de sí misma" });
    if (existsSync(dst) && !overwrite) return sendJSON(res, 409, { ok: false, exists: true, err: "ya existe algo en el destino" });
    if (!existsSync(dirname(dst))) return sendJSON(res, 400, { ok: false, err: "la carpeta destino no existe" });
    try {
      renameSync(src, dst);
    } catch (e) {
      // EXDEV = destination on another filesystem — copy+delete works for files, not dirs
      if (e.code === "EXDEV" && st.isFile()) {
        try { writeFileSync(dst, readFileSync(src)); unlinkSync(src); } catch (e2) { return sendJSON(res, 500, { ok: false, err: `no se pudo mover: ${e2.code || e2}` }); }
      } else {
        return sendJSON(res, 500, { ok: false, err: `no se pudo mover: ${e.code || e}` });
      }
    }
    logEvent(`fs-move · ${src} -> ${dst}`);
    return sendJSON(res, 200, { ok: true, path: dst });
  }

  // delete a file or an EMPTY folder. The client confirms first; recursive folder delete stays
  // out on purpose — from a phone that is a one-tap disaster. Root and home are never deletable.
  if (path === "/api/fs/delete" && req.method === "POST") {
    const { path: p } = await body(req);
    const target = fsPath(typeof p === "string" ? p : "");
    if (!target) return sendJSON(res, 400, { ok: false, err: "ruta inválida" });
    if (target === "/" || target === homedir()) return sendJSON(res, 400, { ok: false, err: "esa ruta no se puede borrar" });
    let st; try { st = statSync(target); } catch { return sendJSON(res, 404, { ok: false, err: "eso ya no existe" }); }
    try {
      if (st.isDirectory()) rmdirSync(target); // ENOTEMPTY if it still has content
      else unlinkSync(target);
    } catch (e) {
      if (e.code === "ENOTEMPTY") return sendJSON(res, 400, { ok: false, err: "la carpeta no está vacía — borra su contenido primero" });
      return sendJSON(res, 500, { ok: false, err: `no se pudo borrar: ${e.code || e}` });
    }
    logEvent(`fs-delete · ${target}`);
    return sendJSON(res, 200, { ok: true });
  }

  // raw bytes for previews (<img>/<iframe>/<audio>). ?t= carries the token since tags can't
  // send headers. Active content (html/svg/js) is served as text/plain: a file on disk must never
  // be able to run script on the panel's origin.
  if (path === "/api/fs/raw") {
    const file = fsPath(new URL(req.url, "http://x").searchParams.get("path") || "");
    if (!file) return sendJSON(res, 400, { ok: false, err: "ruta inválida" });
    let st; try { st = statSync(file); } catch { return sendJSON(res, 404, { ok: false, err: "ese archivo no existe" }); }
    if (!st.isFile()) return sendJSON(res, 400, { ok: false, err: "no es un archivo" });
    const mime = fsMime(file);
    res.writeHead(200, { "content-type": mime, "content-length": st.size, "cache-control": "no-store", "x-content-type-options": "nosniff", "access-control-allow-origin": "*" });
    return res.end(readFileSync(file));
  }

  return sendJSON(res, 404, { ok: false, err: "no route" });
}

// forward one request to a federated host (data/hosts.json). Streams SSE bodies through.
function rawBody(req) {
  // Buffer, not string — POST bodies proxied to federated hosts include raw binary uploads
  return new Promise((resolve) => { const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => resolve(Buffer.concat(chunks))); });
}
async function proxyToHost(req, res, path, hostId) {
  const h = readHosts().find((x) => x.id === hostId);
  if (!h) return sendJSON(res, 400, { ok: false, err: `host desconocido: ${hostId}` });
  const u = new URL(req.url, "http://x");
  u.searchParams.delete("host"); u.searchParams.delete("t"); // our token never leaves this host
  const target = `${h.url.replace(/\/$/, "")}${path}${u.searchParams.size ? `?${u.searchParams}` : ""}`;
  // uploads can be 500MB over Wi-Fi — give them 10 min instead of the usual 2
  const isUpload = path === "/api/upload" || path === "/api/fs/upload";
  const init = {
    method: req.method,
    signal: req.method === "GET" && path === "/api/pane-stream" ? undefined : AbortSignal.timeout(isUpload ? 600000 : 120000),
    headers: { "content-type": req.headers["content-type"] || "application/json", ...(h.token ? { authorization: `Bearer ${h.token}` } : {}) },
  };
  if (req.method === "POST") init.body = await rawBody(req);
  let r;
  try { r = await fetch(target, init); } catch { return sendJSON(res, 502, { ok: false, err: `${hostId} no responde` }); }
  if ((r.headers.get("content-type") || "").includes("text/event-stream")) {
    res.writeHead(r.status, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "access-control-allow-origin": "*" });
    const reader = r.body.getReader();
    req.on("close", () => reader.cancel().catch(() => {}));
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; res.write(value); } } catch { /* stream dropped */ }
    return res.end();
  }
  // bytes through untouched — /api/fs/raw previews are binary, not JSON
  const bytes = Buffer.from(await r.arrayBuffer());
  res.writeHead(r.status, { "content-type": r.headers.get("content-type") || "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", "access-control-allow-origin": "*" });
  res.end(bytes);
}

function serveStatic(res, path) {
  // /data/* is served live from public/data (rebuilt by build-data.mjs on every add/refresh)
  if (path.startsWith("/data/")) {
    const live = join(ROOT, "panel", "public", "data", path.slice(6));
    if (existsSync(live)) {
      res.writeHead(200, { "content-type": MIME[extname(live)] || "application/octet-stream", "cache-control": "no-cache" });
      return res.end(readFileSync(live));
    }
  }
  let file = join(DIST, path === "/" ? "index.html" : path.replace(/^\//, ""));
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(DIST, "index.html"); // SPA fallback
  if (!existsSync(file)) { res.writeHead(404); return res.end("build the panel first: pnpm build"); }
  // Vite assets carry a content hash → cache forever. Everything else (index.html, icons) must
  // NOT be heuristically cached: a stale index.html keeps pointing at a pre-deploy bundle.
  const cache = path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
  res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream", "cache-control": cache });
  res.end(readFileSync(file));
}

// optional auth: set MT3K_TOKEN in the env to require `Authorization: Bearer <token>` on /api/*.
// Unset → open (trusted homelab LAN). SSE can't send headers, so ?t=<token> is also accepted.
const TOKEN = process.env.MT3K_TOKEN || null;

// trusted subnets: MT3K_TRUST_CIDR="10.10.10.0/24[,…]" skips the token for clients inside those
// ranges — made for the WireGuard mesh, where the tunnel already authenticated the peer.
// Spoofing is impractical: the TCP handshake's replies route back through wg0, so an outside
// host faking a mesh source never completes the connection. Unset → token required as always.
const TRUST_CIDRS = (process.env.MT3K_TRUST_CIDR || "").split(",").map((s) => s.trim()).filter(Boolean);
const ipInCidr = (ip, cidr) => {
  const mapped = ip?.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); // Node reports v4 clients as ::ffff:a.b.c.d
  if (mapped) ip = mapped[1];
  const [base, bitsRaw = "32"] = cidr.split("/");
  const bits = Number(bitsRaw);
  const v4 = /^\d+\.\d+\.\d+\.\d+$/;
  if (!v4.test(ip || "") || !v4.test(base) || !(bits >= 0 && bits <= 32)) return false;
  const toInt = (s) => s.split(".").reduce((a, o) => a * 256 + Number(o), 0);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((toInt(ip) & mask) >>> 0) === ((toInt(base) & mask) >>> 0);
};
// loopback is always trusted (a local process can do anything anyway — this is what lets the
// machine's own browser open its panel without pasting the token). To keep BOTH loopback and
// LAN trust safe from DNS rebinding, the Host header must be an IP literal or localhost — a
// rebinding page necessarily carries the attacker's domain there.
const LOOPBACK_RE = /^(::1$|::ffff:127\.|127\.)/;
const fromTrustedNet = (req) => {
  const ip = req.socket?.remoteAddress || "";
  const h = (req.headers.host || "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  if (!(h === "localhost" || /^[0-9.]+$/.test(h) || /^[0-9a-f:]+$/i.test(h))) return false;
  return LOOPBACK_RE.test(ip) || TRUST_CIDRS.some((c) => ipInCidr(ip, c));
};

const authorized = (req) => {
  if (!TOKEN) return true;
  if (fromTrustedNet(req)) return true;
  if (req.headers.authorization === `Bearer ${TOKEN}`) return true;
  return new URL(req.url, "http://x").searchParams.get("t") === TOKEN;
};

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (req.method === "OPTIONS") { res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type,authorization", "access-control-allow-methods": "GET,POST,OPTIONS" }); return res.end(); }
  try {
    if (path.startsWith("/api/")) {
      if (!authorized(req)) return sendJSON(res, 401, { ok: false, err: "token requerido" });
      // federation: ?host=<id> forwards the request verbatim to that host's panel with ITS token
      const targetHost = new URL(req.url, "http://x").searchParams.get("host");
      if (targetHost) return await proxyToHost(req, res, path, targetHost);
      return await api(req, res, path);
    }
    return serveStatic(res, path);
  } catch (e) {
    sendJSON(res, 500, { ok: false, err: String(e) });
  }
}).listen(PORT, () => console.log(`MT3K Agent OS server → http://localhost:${PORT}`));

// start/stop a web-UI tool on THIS host. Start prefers the host's systemd unit, then a
// Windows hidden scheduled task (a naked detached spawn opens a console window the user
// closes — killing the tool), then a detached spawn as last resort.
const webTokens = new Map();
const webSessions = new Map();
const webSessionPending = new Map();
const webProbe = (def) => fetch(`http://127.0.0.1:${def.web}/`, { redirect: "manual", signal: AbortSignal.timeout(800) }).then((r) => {
  r.body?.cancel().catch(() => {});
  return r.status >= 200 && r.status < 500;
}, () => false);

function readWebToken(def) {
  if (!def.webLog) return null;
  try { return webTokenFromLogText(readFileSync(expand(def.webLog), "utf8")); } catch { return null; }
}

async function exchangeWebSession(def) {
  let token = webTokens.get(def.id) || readWebToken(def);
  for (let attempt = 0; token && attempt < 2; attempt++) {
    webTokens.set(def.id, token);
    const host = `127.0.0.1:${def.web}`;
    const r = await fetch(`http://${host}/?token=${encodeURIComponent(token)}`, {
      headers: { host }, redirect: "manual", signal: AbortSignal.timeout(3000),
    });
    const cookie = r.status === 303 ? sessionCookie(r.headers.get("set-cookie")) : null;
    await r.body?.cancel();
    if (cookie) { webSessions.set(def.id, cookie); return cookie; }
    if (r.status !== 401) break;
    webTokens.delete(def.id);
    token = attempt === 0 ? readWebToken(def) : null;
  }
  return null;
}

function webSession(def, invalid = null) {
  if (!def.webLog) return Promise.resolve(null);
  if (invalid && webSessions.get(def.id) === invalid) webSessions.delete(def.id);
  if (webSessions.has(def.id)) return Promise.resolve(webSessions.get(def.id));
  if (!webSessionPending.has(def.id)) {
    const pending = exchangeWebSession(def).catch(() => null).finally(() => webSessionPending.delete(def.id));
    webSessionPending.set(def.id, pending);
  }
  return webSessionPending.get(def.id);
}

// stdout/stderr of a spawned web tool go straight to its log file (a kernel fd, not a pipe we
// would have to drain forever: closing a pipe while the tool still logs kills it with EPIPE).
// The launch token is read back from that file on demand (readWebToken).
function webLogFd(def) {
  if (!def.webLog) return null;
  try {
    const file = expand(def.webLog);
    mkdirSync(dirname(file), { recursive: true });
    return openSync(file, "a", 0o600);
  } catch { return null; }
}
async function startWebTool(def) {
  if (await webProbe(def)) return { ok: true, already: true };
  const bin = absBin(def.webCmd[0]);
  if (!bin) return { ok: false, err: `${def.webCmd[0]} no está instalado en este host` };
  const serviceUnitExists = !!(def.webService && existsSync(`/etc/systemd/system/${def.webService}.service`));
  const starter = pickWebStarter(def, process.platform, serviceUnitExists);
  let started = false;
  if (starter === "systemd") {
    started = (await run("systemctl", ["start", def.webService], ROOT, 10000)).ok;
  }
  if (!started && starter === "task") {
    started = (await run("schtasks", ["/run", "/tn", def.webTask], ROOT, 10000)).ok;
  }
  if (!started) {
    const fd = webLogFd(def);
    const ch = spawn(bin, def.webCmd.slice(1), { detached: true, stdio: fd === null ? "ignore" : ["ignore", fd, fd], windowsHide: true, shell: process.platform === "win32", env: process.env });
    ch.unref();
    if (fd !== null) { try { closeSync(fd); } catch { /* child holds its own copy */ } }
    webTokens.delete(def.id); webSessions.delete(def.id); // a fresh process mints a fresh token
  }
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await webProbe(def)) { logEvent(`web-start · ${def.id}`); return { ok: true }; }
  }
  return { ok: false, err: `${def.name} no levantó en :${def.web} (~20s)` };
}
async function stopWebTool(def) {
  if (process.platform !== "win32" && def.webService && existsSync(`/etc/systemd/system/${def.webService}.service`)) {
    await run("systemctl", ["stop", def.webService], ROOT, 10000);
  } else if (process.platform === "win32") {
    const r = await run("powershell", ["-NoProfile", "-Command", `(Get-NetTCPConnection -LocalPort ${def.web} -State Listen | Select-Object -First 1).OwningProcess`], ROOT, 10000);
    const pid = (r.out || "").trim();
    if (/^\d+$/.test(pid)) await run("taskkill", ["/PID", pid, "/F"], ROOT, 10000);
  } else {
    // macOS: lsof lives in /usr/sbin, which a launchd service's PATH often lacks
    const r = await run(process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof", ["-ti", `tcp:${def.web}`], ROOT, 5000);
    const pid = (r.out || "").split("\n")[0].trim();
    if (/^\d+$/.test(pid)) await run("kill", [pid], ROOT, 5000);
  }
  for (let i = 0; i < 10; i++) {
    if (!(await webProbe(def))) return true; // port is dead → stopped
    await new Promise((r) => setTimeout(r, 700));
  }
  return false;
}

// --- fleet self-update: the aggregator (Mac) tars its own server.mjs + panel/dist, the
// receiving host extracts over its ROOT and restarts. Same trust gate as everything else;
// the payload is code from the owner's own trusted panel. data/ is never in the bundle.
// host vitals for the fleet-health row: cheap OS reads + (when present) nvidia-smi.
// GPU is cached briefly — several browsers poll status at once.
let _gpuCache = { at: 0, gpu: null };
async function readVitals() {
  let cpu = null;
  if (process.platform === "win32") {
    // loadavg is always 0 on Windows — sample the perf counter instead
    const r = await run("powershell", ["-NoProfile", "-Command", "(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average"], ROOT, 8000);
    const n = parseFloat(r.out); cpu = Number.isFinite(n) ? Math.round(n) : null;
  } else {
    cpu = Math.min(100, Math.round((loadavg()[0] / cpus().length) * 100));
  }
  let disk = null;
  try { const f = statfsSync(ROOT); disk = { total: f.blocks * f.bsize, free: f.bavail * f.bsize }; } catch { /* unsupported fs */ }
  let gpu = null;
  if (Date.now() - _gpuCache.at < 5000) gpu = _gpuCache.gpu;
  else {
    if (absBin("nvidia-smi")) {
      const r = await run("nvidia-smi", ["--query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"], ROOT, 8000);
      const m = (r.out || "").split(",").map((x) => parseFloat(x));
      if (r.ok && m.length >= 4 && m.every(Number.isFinite)) gpu = { util: m[0], temp: m[1], memUsed: m[2], memTotal: m[3] };
    }
    _gpuCache = { at: Date.now(), gpu };
  }
  return { cpu, mem: { total: totalmem(), free: freemem() }, disk, gpu };
}

function buildUpdateBundle() {
  // tar without data (privacy gate) — spawnSync so we can return the bytes synchronously
  // ship the whole scripts/lib dir: a module server.mjs imports but the bundle lacks crashes every host on restart
  // COPYFILE_DISABLE keeps macOS from adding AppleDouble ._* entries that then litter other hosts
  const r = spawnSync("tar", ["czf", "-", "--exclude", "panel/dist/data", "scripts/server.mjs", "scripts/lib", "panel/dist"], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, COPYFILE_DISABLE: "1" } });
  if (r.status !== 0) throw new Error("tar falló: " + (r.stderr?.toString().slice(0, 200) || r.status));
  return r.stdout; // gzipped tar bytes
}
function scheduleSelfRestart() {
  // respond first, then restart out-of-band so THIS request finishes cleanly
  setTimeout(() => {
    try {
      if (process.platform === "win32") {
        // kill the :PORT owner and rerun the scheduled task. A detached powershell.exe with no std
        // handles dies at startup before running anything, so it must get a console of its own:
        // `cmd /c start` creates one (minimized, then hidden by -WindowStyle).
        const args = ["/c", "start", "/min", "powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", join(ROOT, "restart-panel.ps1")];
        spawn("cmd.exe", args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
      } else if (existsSync("/etc/systemd/system/mt3k-agent-os.service")) {
        spawn("systemctl", ["restart", "mt3k-agent-os"], { detached: true, stdio: "ignore" }).unref();
      } else {
        process.exit(0); // launchd/pm2 KeepAlive respawns us
      }
    } catch { process.exit(0); }
  }, 400);
}

// --- web-app proxy: expose a localhost-only tool (e.g. DeepSeek's `dsh web`) through the
// panel's OWN auth gate on a dedicated port, so its absolute asset paths keep working and it
// becomes reachable wherever the panel is (LAN, WireGuard) without the tool itself opening up.
// Plain http by default (with a crypto.randomUUID polyfill injected into HTML — that API is
// secure-context-only). Set MT3K_PROXY_HTTPS=1 to serve the proxy over https with an
// auto-generated self-signed cert instead: gives proxied tools a full secure context
// (crypto.subtle / OPFS), at the cost of a cert warning once per device — annoying on phones,
// which is why it's opt-in. Note: dsh's Settings page fails remotely on BOTH schemes (it
// restricts settings to localhost browsers by design) — edit ~/.dsh/settings.yaml instead.
// Host/Origin are rewritten to the target so the tool's browser-trust fence stays satisfied,
// and a first visit with ?t=<token> mints a cookie so every follow-up asset/XHR/WS is authed.
let PROXY_HTTPS = false; // detectAgents reports it so the panel builds the right scheme
// crypto.randomUUID also needs a secure context; keep the polyfill for the http fallback
const PROXY_POLYFILL = `<script>if(!crypto.randomUUID){crypto.randomUUID=()=>{const b=crypto.getRandomValues(new Uint8Array(16));b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;const h=Array.from(b,x=>x.toString(16).padStart(2,"0")).join("");return h.slice(0,8)+"-"+h.slice(8,12)+"-"+h.slice(12,16)+"-"+h.slice(16,20)+"-"+h.slice(20)}}</script>`;
// dsh hard-codes its Settings UI to loopback browsers (client-side isLoopbackHostname on
// window.location — --trusted-host feeds only the server fence, not this). Behind OUR authed
// proxy the remote browser IS the owner, so patch that single gate in flight. The regex takes
// any expression ending in the hostname check — 0.1.1 had `pageLocation === void 0 || …`,
// 0.1.5 prepends `transport?.ownsHost === true || …`. A miss only keeps Settings
// localhost-only (nothing else breaks), but it's logged so a dsh update can't hide it.
const PROXY_JS_PATCHES = [{
  path: "/plugins/@deepseek-ai/dsh-client-connection/client.js",
  find: /isLoopback: [^,\n]*isLoopbackHostname\(pageLocation\.hostname\)/,
  replace: "isLoopback: true",
}];
const proxyCookieOk = (req) => {
  if (!TOKEN) return false;
  const m = (req.headers.cookie || "").match(/(?:^|;\s*)mt3k_t=([^;]+)/);
  return !!m && decodeURIComponent(m[1]) === TOKEN;
};
async function proxyTlsOptions() {
  const dir = join(ROOT, "data", "tls");
  const key = join(dir, "proxy.key"), crt = join(dir, "proxy.crt");
  if (!existsSync(key) || !existsSync(crt)) {
    mkdirSync(dir, { recursive: true });
    const r = await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", key, "-out", crt,
      "-days", "3650", "-nodes", "-subj", "/CN=MT3K Panel Proxy", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], ROOT, 20000);
    if (!r.ok) { console.log("  ⚠ openssl falló — el proxy de apps queda en http (algunas apps no funcionarán):", r.err.slice(0, 120)); return null; }
  }
  try { return { key: readFileSync(key), cert: readFileSync(crt) }; } catch { return null; }
}
(async () => {
  // Servidor auxiliar (MT3K_PORT distinto): solo API + estáticos; no duplicar proxies en 4290.
  if (process.env.MT3K_PORT) return;
  const defs = AGENT_DEFS.filter((d) => d.web && d.webProxy);
  if (!defs.length) return;
  const wantTls = /^(1|true|yes)$/i.test(process.env.MT3K_PROXY_HTTPS || "");
  const tls = wantTls ? await proxyTlsOptions() : null;
  PROXY_HTTPS = !!tls;
  for (const def of defs) {
    const rewrite = (headers, session = null) => {
      const h = { ...headers, host: `127.0.0.1:${def.web}` };
      if (h.origin) h.origin = `http://127.0.0.1:${def.web}`;
      if (h.referer) h.referer = `http://127.0.0.1:${def.web}/`;
      delete h.cookie; // our auth cookie is not the tool's business
      if (def.webLog && session) {
        const cookies = (headers.cookie || "").split(";").map((c) => c.trim()).filter((c) => c && !/^mt3k_t\s*=/.test(c));
        h.cookie = [session, ...cookies].join("; ");
      }
      return h;
    };
    const cleanPath = (url) => {
      // Strip only our `t` param and forward the rest of the query byte-for-byte: tools use
      // combo URLs like /plugins/??a/x.js,b/y.js&rev=… that URLSearchParams would re-encode into 404s.
      const qi = url.indexOf("?");
      const pathname = qi === -1 ? url : url.slice(0, qi);
      const parts = qi === -1 ? [] : url.slice(qi + 1).split("&");
      const hadToken = parts.some((p) => /^t=/.test(p));
      const kept = parts.filter((p) => !/^t=/.test(p));
      return { path: pathname + (kept.length ? `?${kept.join("&")}` : ""), pathname, hadToken };
    };
    const handler = async (req, res) => {
      if (!(authorized(req) || proxyCookieOk(req))) { res.writeHead(401, { "content-type": "text/plain; charset=utf-8" }); return res.end("token requerido — abre desde el panel"); }
      const { path: fwdPath, pathname, hadToken } = cleanPath(req.url);
      let session = await webSession(def);
      if (res.destroyed) return;
      const fh = rewrite(req.headers, session);
      const wantsHtml = (req.headers.accept || "").includes("text/html");
      // dsh ≥0.2 ships client modules as one combo bundle (/plugins/??a/x.js,b/y.js) — match the module inside it too
      const jsPatch = PROXY_JS_PATCHES.find((x) => x.path === pathname || (pathname === "/plugins/" && fwdPath.includes(x.path.slice("/plugins/".length))));
      if ((wantsHtml && !tls) || jsPatch) delete fh["accept-encoding"]; // we edit these bodies → identity encoding
      const replayable = !req.headers["transfer-encoding"] && (!req.headers["content-length"] || req.headers["content-length"] === "0");
      const forward = (retried = false) => {
        const p = httpRequest({ host: "127.0.0.1", port: def.web, method: req.method, path: fwdPath, headers: fh }, async (pr) => {
          if (pr.statusCode === 401 && session) {
            if (webSessions.get(def.id) === session) webSessions.delete(def.id); // stale: the next request re-exchanges
            const renewed = retried ? null : await webSession(def); // renew now so the next request is fast
            if (renewed && replayable) {
              pr.resume();
              session = renewed;
              fh.cookie = rewrite(req.headers, session).cookie;
              if (!res.destroyed) forward(true);
              return;
            }
          }
          const extra = {};
          if (TOKEN && hadToken) extra["set-cookie"] = `mt3k_t=${encodeURIComponent(TOKEN)}; Path=/; HttpOnly; SameSite=Lax${tls ? "; Secure" : ""}`;
          const isHtml = (pr.headers["content-type"] || "").includes("text/html");
          const editHtml = isHtml && !tls; // http fallback: inject the randomUUID polyfill (https doesn't need it)
          if ((editHtml || jsPatch) && !pr.headers["content-encoding"]) {
            const chunks = [];
            pr.on("data", (c) => chunks.push(c));
            pr.on("end", () => {
              let text = Buffer.concat(chunks).toString("utf8");
              if (editHtml) text = text.includes("<head>") ? text.replace("<head>", "<head>" + PROXY_POLYFILL) : PROXY_POLYFILL + text;
              if (jsPatch) {
                const patched = text.replace(jsPatch.find, jsPatch.replace);
                if (patched === text) logEvent(`proxy-patch MISS · ${jsPatch.path} — dsh cambió; Settings remoto no funcionará`);
                text = patched;
              }
              const body = Buffer.from(text);
              delete pr.headers["transfer-encoding"]; // buffered responses use Content-Length
              res.writeHead(pr.statusCode || 200, { ...pr.headers, ...extra, "content-length": body.length });
              res.end(body);
            });
            return;
          }
          res.writeHead(pr.statusCode || 502, { ...pr.headers, ...extra });
          pr.pipe(res); // streamed, not buffered — the tool may use SSE
        });
        p.on("error", () => { if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" }); res.end(`${def.name} no responde en 127.0.0.1:${def.web} — ¿está corriendo?`); });
        if (retried) p.end(); else req.pipe(p);
      };
      forward();
    };
    const srv = tls ? createHttpsServer(tls, handler) : createServer(handler);
    // WebSocket passthrough: replay the upgrade against the target, then pipe both ways
    srv.on("upgrade", async (req, socket, head) => {
      if (!(authorized(req) || proxyCookieOk(req))) return socket.destroy();
      socket.on("error", () => socket.destroy()); // the browser may drop the socket while we await the session
      let session = await webSession(def);
      if (session) {
        const forward = (retried = false) => {
          if (socket.destroyed) return;
          const up = httpRequest({ host: "127.0.0.1", port: def.web, method: req.method,
            path: cleanPath(req.url).path, headers: rewrite(req.headers, session) });
          const abort = () => up.destroy();
          socket.once("close", abort);
          up.once("close", () => socket.removeListener("close", abort));
          up.on("upgrade", (pr, peer, peerHead) => {
            let raw = `HTTP/1.1 ${pr.statusCode} ${pr.statusMessage}\r\n`;
            for (let i = 0; i < pr.rawHeaders.length; i += 2) raw += `${pr.rawHeaders[i]}: ${pr.rawHeaders[i + 1]}\r\n`;
            socket.write(raw + "\r\n");
            if (peerHead.length) socket.write(peerHead);
            if (head.length) peer.write(head);
            peer.on("error", () => socket.destroy());
            socket.on("error", () => peer.destroy());
            socket.once("close", () => peer.destroy());
            peer.once("close", () => socket.destroy());
            socket.pipe(peer); peer.pipe(socket);
          });
          up.on("response", async (pr) => {
            if (pr.statusCode === 401 && session) {
              if (webSessions.get(def.id) === session) webSessions.delete(def.id);
              const replayable = !req.headers["transfer-encoding"] && (!req.headers["content-length"] || req.headers["content-length"] === "0");
              const renewed = retried ? null : await webSession(def);
              if (renewed && replayable) { pr.resume(); session = renewed; forward(true); return; }
            }
            // Send the failed handshake as a close-delimited HTTP response.
            socket.write(`HTTP/1.1 ${pr.statusCode} ${pr.statusMessage}\r\nConnection: close\r\n\r\n`);
            pr.pipe(socket);
          });
          up.on("error", () => socket.destroy());
          up.end();
        };
        forward();
        return;
      }
      const up = netConnect(def.web, "127.0.0.1", () => {
        const h = rewrite(req.headers);
        let raw = `${req.method} ${cleanPath(req.url).path} HTTP/1.1\r\n`;
        for (const [k, v] of Object.entries(h)) raw += `${k}: ${Array.isArray(v) ? v.join(", ") : v}\r\n`;
        up.write(raw + "\r\n");
        if (head?.length) up.write(head);
        socket.pipe(up); up.pipe(socket);
      });
      up.on("error", () => socket.destroy());
      socket.on("error", () => up.destroy());
    });
    srv.listen(def.webProxy, () => console.log(`  ${def.name} web UI proxied → ${tls ? "https" : "http"}://:${def.webProxy} → 127.0.0.1:${def.web}`));
  }
})();
