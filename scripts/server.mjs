#!/usr/bin/env node
/**
 * server.mjs — the OS backend. Zero dependencies (Node built-ins only).
 *
 * Serves the built panel (panel/dist) AND a small API the dashboard calls live:
 *   POST /api/query    { projectId, q }  → runs `graphify query` in that repo (traversal, $0)
 *   POST /api/refresh  { projectId }      → `graphify update` + re-ingest, appends an activity log
 *   POST /api/send     { paneId, text, enter? } → types text into an agent's tmux pane (LAN-only)
 *   POST /api/upload   { name, data }       → saves a base64 image to data/uploads/, returns its path
 *   GET  /api/git/refs ?cwd=              → local branches of the repo at cwd: pushed?, GitHub url, worktree (read-only, no network)
 *   GET  /api/fs/list|read|raw ?path=  +  POST /api/fs/write|upload|move|delete → file browser / manager
 *   GET  /api/agents                      → installed agent CLIs + their live tmux panes (auto-discovered, with status: working|blocked|idle|done, optional name)
 *   GET  /api/pane-explain ?id=           → rule, region, matched snippet & tail explaining a pane's state
 *   GET  /api/pane-stream ?id=&fmt=lines&tick= → SSE live terminal stream (clamped tick ms, default 500)
 *   GET  /api/wait ?id=&until=&timeout=&baseline=&sawWorking= → long-poll until pane reaches state (blocked|idle|done|not-working|changed);
 *                                         timeout is a wall-clock deadline: a refresh finishing after it returns `timeout`
 *   POST /api/prompt-wait { paneId, text, enter?, until?, timeout? } → send prompt then wait for turn (mt3k-wait / mt3k-prompt CLIs);
 *                                         the gate opens on a manifest `working` sampled after the send, or after 10 s
 *   POST /api/pane-label  { paneId, name } → set/clear sanitized free-text label on a session (data/pane-labels.json, max 40 chars)
 *   GET|POST /api/restore                 → inspect, relaunch, or dismiss missing sessions from ledger data/session-snapshot.json
 *                                         (one owner per session: panel launch wins, else first claimant; two unknown
 *                                         claimants → `ambiguous`, skipped as "ambiguous-owner"; TTL checked on read;
 *                                         max 12 real launches, missing-dir skips do not count)
 *   POST /api/kill { paneId }             → kill-pane; acknowledges at once (ledger + generation tombstone written
 *                                         before the answer), full detect reconciles in the background
 *   (ledger)                              every ledger change goes through ledger.mutate (scripts/lib/ledger-store.mjs):
 *                                         one queue, latest state, atomic write; discovery first, then mutate; scans
 *                                         carry a start sequence and a scan older than the last kill is rejected;
 *                                         tombstones accumulate pane ids + pane_pid (Windows label reuse)
 *   GET|POST /api/restore-config          → read/toggle automatic session restore on startup (data/restore.json)
 *   GET|POST /api/launch-backend          → where NEW sessions are created: tmux (default) | herdr (data/launch-backend.json);
 *                                         herdr only when a core is already running (never started), else tmux + `fallback`
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
import { spawn, spawnSync, execFile } from "node:child_process";
import { sessionCookie } from "./lib/web-session.mjs";
import { keyArgs } from "./lib/keys.mjs";
import { parseAlternateMouseSgr, TMUX_ALT_MOUSE_DISPLAY } from "./lib/tmux-pane-flags.mjs";
import { missingHooks } from "./lib/tmux-hooks.mjs";
import { decideResume, hasResumableHistory } from "./lib/resume-history.mjs";
import { createPasteToPane } from "./lib/tmux-paste.mjs";
import { buildRunningSet } from "./lib/running-set.mjs";
import { WIN32_PS_COMMAND, createWin32ProcessSource, withoutWindowsApps } from "./lib/proc-tree-win32.mjs";
import { nvmBinDirs } from "./lib/bin-dirs.mjs";
import { createPaneNotifier } from "./lib/pane-notify.mjs";
import { describeAgent, normalizeAgentDefs, requireCapability } from "./lib/adapters.mjs";
import {
  validatePaneId,
  mt3kSessionName,
  parseLaunchConfig,
  composeTmuxArgv,
  envPairsToTmuxFlags,
  resolveTmuxBin,
  hasTmuxBinary,
  parseTmuxGlobalEnv,
  tmuxGlobalKeysToUnset,
  needsGlobalColortermTruecolor,
} from "./lib/adapters/cli-tmux.mjs";
import { pickWebStarter, webTokenFromLogText } from "./lib/adapters/web-local.mjs";
import { mergeLocalAgentDefs, readAgentsLocalFile } from "./lib/agents-local.mjs";
import { clampTick, paneStatusFor } from "./lib/pane-status.mjs";
import { detectState, loadManifests } from "./lib/agent-detect.mjs";
import { parseWaitBaseline, parseWaitCondition, parseWaitTimeout } from "./lib/wait-until.mjs";
import { runWait } from "./lib/wait-loop.mjs";
import { runChunkedWait } from "./lib/wait-cli.mjs";
import { applyLabels, labelKey, readLabels, sanitizePaneLabel, sessionNameOf, writeLabels } from "./lib/pane-labels.mjs";
import {
  buildSnapshot,
  diffSnapshot,
  dismissSnapshotSessions,
  readSnapshot,
  removeSnapshotSession,
  replaceRestoredSession,
  writeSnapshot,
} from "./lib/session-snapshot.mjs";
import { runRestore as runRestoreWithLock } from "./lib/restore-run.mjs";
import { tmuxServerAbsent } from "./lib/tmux-absent.mjs";
import { gitRefs } from "./lib/git-refs.mjs";
import { createKillTombstones } from "./lib/kill-tombstones.mjs";
import { createLedgerStore } from "./lib/ledger-store.mjs";
import { isHerdrId } from "./lib/herdr.mjs";
import { containsHerdrId, createHerdrPanes, herdrOccupies, herdrKeyArgs, herdrUnavailableBody } from "./lib/herdr-panes.mjs";
import { createHerdrLauncher, herdrLaunchArgv } from "./lib/herdr-launch.mjs";
import { LAUNCH_BACKENDS, parseLaunchBackend } from "./lib/launch-backend.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "panel", "dist");
const LOGS = join(ROOT, "data", "logs");
const PANE_LABELS_FILE = join(ROOT, "data", "pane-labels.json");
const SNAPSHOT_FILE = join(ROOT, "data", "session-snapshot.json");
const RESTORE_CFG_FILE = join(ROOT, "data", "restore.json");
const LAUNCH_BACKEND_FILE = join(ROOT, "data", "launch-backend.json");
const SKILLS_DIR = join(homedir(), ".agents", "skills");
const GRAPHIFY = [join(homedir(), ".local/bin/graphify"), "graphify"].find((p) => p === "graphify" || existsSync(p));
const PORT = Number(process.env.MT3K_PORT) || 4288;
const START = Date.now();

let AGENT_MANIFESTS = null;
try {
  const mfPath = join(ROOT, "scripts", "agent-detection", "manifests.json");
  AGENT_MANIFESTS = loadManifests(JSON.parse(readFileSync(mfPath, "utf8")));
  console.log(
    `[agent-detect] loaded ${Object.keys(AGENT_MANIFESTS.manifests).length} manifests (${AGENT_MANIFESTS.unsupported.length} unsupported rules)`
  );
} catch (err) {
  console.warn(`[agent-detect] manifests unavailable (${err?.message || err}); falling back to stillness heuristic`);
}
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
  return new Promise((resolve) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => { try { const v = JSON.parse(d || "{}"); resolve(v !== null && typeof v === "object" ? v : {}); } catch { resolve({}); } }); });
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
const IS_WIN = process.platform === "win32";
function run(cmd, args, cwd, timeoutMs = 60000, envOverride = null) {
  return new Promise((resolve) => {
    const env = envOverride ? { ...process.env, ...envOverride } : { ...process.env, PATH: `${join(homedir(), ".local/bin")}${delimiter}${process.env.PATH}` };
    // Windows env names are case-insensitive: process.env has `Path`, so an added `PATH` would become a second key
    if (IS_WIN) for (const k of Object.keys(env)) if (k !== "PATH" && k.toUpperCase() === "PATH" && env.PATH !== undefined) delete env[k];
    const ch = spawn(cmd, args, { cwd, env });
    let out = "", err = "";
    const t = setTimeout(() => { ch.kill("SIGKILL"); resolve({ ok: false, out, err: err + "\n[timeout]" }); }, timeoutMs);
    ch.stdout.on("data", (d) => (out += d));
    ch.stderr.on("data", (d) => (err += d));
    // Windows tools print CRLF; every caller splits on "\n" and compares ids exactly
    const clean = (x) => (IS_WIN ? x.replace(/\r\n/g, "\n") : x).trim();
    ch.on("close", (code) => { clearTimeout(t); resolve({ ok: code === 0, out: clean(out), err: clean(err) }); });
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
// npm globals (opencode, dsh, …) live in the bin dir of the node they were installed with, which is
// often NOT the node running this server (launchd may start a newer nvm node than nvm's default).
// So search: our own node's dir, ~/.local/bin, every nvm node bin (default alias first), then brew/system/PATH.
const NVM_BIN_DIRS = nvmBinDirs({ home: homedir(), env: process.env, exists: existsSync, readdir: readdirSync, readFile: (p) => readFileSync(p, "utf8") });
const PATH_DIRS = [dirname(process.execPath), join(homedir(), ".local/bin"), ...NVM_BIN_DIRS, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", ...(process.env.PATH || "").split(delimiter)];
// Windows binaries carry extensions (claude.cmd, dsh.ps1, ollama.exe) — probe those too
const BIN_EXTS = process.platform === "win32" ? ["", ".exe", ".cmd", ".ps1", ".bat"] : [""];
const onPath = (bin) => PATH_DIRS.some((d) => d && BIN_EXTS.some((e) => existsSync(join(d, bin + e))));
const notifyPane = createPaneNotifier({ binDirs: [...(process.env.PATH || "").split(delimiter), ...PATH_DIRS] });
// `proc` = exact process basenames (case-sensitive) that mean this agent is actively running.
// CLI binaries are lowercase (claude/codex/…); same-named GUI apps are Capitalized → not matched.
const AGENT_DEFS = [
  { id: "claude", name: "Claude Code", bins: ["claude"], paths: ["~/.claude"], proc: ["claude"] },
  { id: "codex", name: "Codex", bins: ["codex"], paths: ["~/.codex"], proc: ["codex"] },
  { id: "opencode", name: "OpenCode", bins: ["opencode"], paths: ["~/.config/opencode", "~/.opencode"], proc: ["opencode"] },
  { id: "grok", name: "Grok CLI", bins: ["grok"], paths: ["~/.grok"], proc: ["grok"] },
  { id: "copilot", name: "GitHub Copilot", bins: ["copilot"], paths: ["~/.copilot"], proc: ["copilot"] },
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
// tmux, or psmux (the native tmux clone on Windows). Every tmux call uses this absolute path, so it
// does not depend on the PATH this service was started with. No binary → nothing is
// launchable-in-tmux; web-UI agents and Files still work.
const HAS_TMUX = hasTmuxBinary({ absBin });
const TMUX_BIN = resolveTmuxBin({ absBin });
// psmux runs one server per session, so its %N pane ids repeat across sessions: on Windows a pane is
// identified by session:window.pane (unique, accepted by -t). POSIX keeps tmux's #{pane_id}.
const PANE_KEY_FMT = IS_WIN ? "#{session_name}:#{window_index}.#{pane_index}" : "#{pane_id}";
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

// Terminales de Herdr (hc) como panes: solo listar/leer/escribir. MT3K_HERDR=0 lo apaga por completo.
const herdrPanes = createHerdrPanes({ enabled: process.env.MT3K_HERDR !== "0", color: process.env.MT3K_HERDR_COLOR !== "0", tildify });
// el único `hc connect` (vistas en color) no sobrevive al servidor
process.on("exit", () => herdrPanes.close());
const herdrLauncher = createHerdrLauncher({ getHerdr: () => herdrPanes.hc() });
for (const sig of ["SIGTERM", "SIGINT"]) process.once(sig, () => process.exit(0));
/** 400 uniforme para los endpoints que no soportan Herdr; true = ya respondió. */
const denyHerdrId = (res, paneId) => {
  if (!isHerdrId(paneId)) return false;
  sendJSON(res, 400, herdrUnavailableBody());
  return true;
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
      const hooks = await run(TMUX_BIN, ["show-hooks", "-g"], ROOT, 3000);
      if (!hooks.ok) return;
      // tmux manual: resize-window "will automatically set window-size to manual in the window options".
      for (const hook of missingHooks(hooks.out)) {
        const added = await run(TMUX_BIN, ["set-hook", "-ga", hook, "set -w window-size latest"], ROOT, 3000);
        if (!added.ok) return;
      }
      tmuxHooksVerified = true;
    })();
    try { await tmuxHooksPending; } finally { tmuxHooksPending = null; }
  } catch { /* tmux absent, stopped or unavailable: retry on the next call */ }
}
if (HAS_TMUX && (await run(TMUX_BIN, ["list-sessions"], ROOT, 3000)).ok) await ensureTmuxHooks();

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
  // no fish, fish failed or timed out → PATH_DIRS (Debian hosts, Windows)
  agentPathCache = { at: Date.now(), value: cleanPath((await fishPath()) || PATH_DIRS) };
  return agentPathCache.value;
}

function parsePsRows(out) {
  const rows = [];
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (m) rows.push({ pid: +m[1], ppid: +m[2], comm: m[3] });
  }
  return rows;
}
// Windows has no `ps`: PowerShell/CIM snapshot, comm normalized to POSIX-style paths, cached 3 s
const win32ProcessRows = createWin32ProcessSource({
  exec: async () => (await run(WIN32_PS_COMMAND[0], WIN32_PS_COMMAND.slice(1), ROOT, 15000)).out,
});

// one ps snapshot → process tree (pid → ppid → comm). Used for both "is running" and pane discovery.
async function procTree() {
  const rows = IS_WIN ? await win32ProcessRows() : parsePsRows((await run("ps", ["-axo", "pid=,ppid=,comm="], ROOT, 5000)).out);
  const byPid = new Map(), childrenOf = new Map();
  for (const { pid, ppid, comm } of rows) {
    byPid.set(pid, comm);
    if (!childrenOf.has(ppid)) childrenOf.set(ppid, []);
    childrenOf.get(ppid).push(pid);
  }
  // index every path segment, not just the basename: cursor-agent's process is
  // ".../cursor-agent/versions/x.y/node" — the agent's name only appears as a directory.
  // GUI-app internals stay excluded (e.g. Codex.app/Resources/codex ≠ the codex CLI running)
  // — including bundle workers whose .app/ origin only survives in their ancestry
  // (buildRunningSet, ./lib/running-set.mjs).
  const running = buildRunningSet(IS_WIN ? withoutWindowsApps(rows) : rows);
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

let lastListPanesOk = false;
let transientTmuxFailureLogged = false;
let lastDiscoveredPaneIds = new Set();
let lastDiscoveredSessionNames = new Set();
let lastDetectAt = 0;
let lastDetectRows = [];
let detectAgentsInFlight = null;
// discovery generations: each detectAgents() run takes `++discoverySeqCounter` at its START and tags
// its rows with it (non-enumerable `discoverySeq`); kills record the counter, so ledger writes from a
// scan that began before a kill are rejected (scripts/lib/ledger-store.mjs, kill-tombstones.mjs)
let discoverySeqCounter = 0;
const scanSeqOf = (rows) => (Number.isFinite(rows?.discoverySeq) ? rows.discoverySeq : null);
const withScanSeq = (rows, seq) => {
  if (Number.isFinite(seq)) Object.defineProperty(rows, "discoverySeq", { value: seq, configurable: true });
  return rows;
};
const killTombstones = createKillTombstones();
const markSessionKilled = (sessionName, paneIds, opts) => killTombstones.mark(sessionName, paneIds, opts);
const withoutRecentlyKilled = (snapshot, rows, seq) => killTombstones.filter(snapshot, rows, seq);
// the one in-memory session ledger; every change goes through ledger.mutate (serialized, atomic)
const ledger = createLedgerStore({ file: SNAPSHOT_FILE, readSnapshot, writeSnapshot, log: (m) => logEvent(m) });

// tmux exits 1 when no server is running (the last session closed): that is a real, empty answer,
// not a transient failure. Only the confirmed absence shapes count (scripts/lib/tmux-absent.mjs);
// permission/busy/timeout/unknown errors stay transient and keep the previous names.
const tmuxNoServer = (r) => !r.ok && tmuxServerAbsent(r.err || "");

// map each tmux pane to the agent CLI actually running inside it (auto-discovery, nothing hardcoded)
async function discoverPanes(descendants) {
  const fmt = "#{pane_id}|#{pane_pid}|#{session_name}:#{window_index}.#{pane_index}|#{window_name}|#{pane_current_path}|#{pane_current_command}|#{pane_title}";
  const r = await run(TMUX_BIN, ["list-panes", "-a", "-F", fmt], ROOT, 5000);
  if (tmuxNoServer(r)) {
    lastListPanesOk = true;
    transientTmuxFailureLogged = false;
    return [];
  }
  if (!r.ok) {
    lastListPanesOk = false;
    if (!transientTmuxFailureLogged) {
      transientTmuxFailureLogged = true;
      console.warn(`[mt3k] transient tmux list-panes failure: ${r.err || "unknown error"}`);
    }
    return [];
  }
  lastListPanesOk = true;
  transientTmuxFailureLogged = false;
  if (!r.out) return [];
  const panes = [];
  for (const line of r.out.split("\n")) {
    const parts = line.split("|");
    if (parts.length < 6) continue;
    const [tmuxPaneId, panePid, label, window, cwd, command] = parts;
    const title = parts.slice(6).join("|") || "";
    const paneId = IS_WIN ? label : tmuxPaneId;
    const comms = descendants(+panePid);
    comms.add(base(command)); // also count the pane's own foreground command
    panes.push({ paneId, panePid: Number(panePid) || null, label, window, cwd: tildify(cwd), command, title, comms: [...comms] });
  }
  return panes;
}

// live tmux session names: a successful list-sessions is authoritative; when it fails (or there is
// no tmux) fall back to the last successful pane discovery so a transient error never reads as "gone"
async function listLiveTmuxSessionNames() {
  if (!HAS_TMUX) return new Set(lastDiscoveredSessionNames);
  const r = await run(TMUX_BIN, ["list-sessions", "-F", "#{session_name}"], ROOT, 4000);
  if (tmuxNoServer(r)) return new Set();
  if (!r.ok) return new Set(lastDiscoveredSessionNames);
  const names = new Set();
  for (const line of (r.out || "").split("\n")) {
    const clean = sessionNameOf(line);
    if (clean) names.add(clean);
  }
  return names;
}

const activeWaitPaneCounts = new Map(); // paneId → active /api/wait count
function incWaitPane(paneId) {
  activeWaitPaneCounts.set(paneId, (activeWaitPaneCounts.get(paneId) || 0) + 1);
}
function decWaitPane(paneId) {
  const next = (activeWaitPaneCounts.get(paneId) || 0) - 1;
  if (next <= 0) activeWaitPaneCounts.delete(paneId);
  else activeWaitPaneCounts.set(paneId, next);
}

async function detectAgentsImpl() {
  const seq = ++discoverySeqCounter; // taken at the START: a kill during this scan makes it stale
  refreshAgentDefsFromLocal();
  const { running, descendants } = await procTree();
  const panes = await discoverPanes(descendants);
  if (lastListPanesOk) {
    lastDiscoveredPaneIds = new Set(panes.map((pn) => pn.paneId));
    lastDiscoveredSessionNames = new Set(panes.map((pn) => sessionNameOf(pn.label)).filter(Boolean));
    killTombstones.observe([{ panes }], seq); // accumulate every pane id/pid each session ever had
  }
  const titleByPaneId = new Map(panes.map((pn) => [pn.paneId, pn.title || ""]));
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
        .map((pn) => ({ paneId: pn.paneId, panePid: pn.panePid, label: pn.label, window: pn.window, cwd: pn.cwd }));
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
          .map((pn) => ({ paneId: pn.paneId, panePid: pn.panePid, label: pn.label, window: pn.window, cwd: pn.cwd }))
      : [];
    // launchable = a real TUI CLI we can spawn inside tmux (GUI-only apps have empty `proc`)
    const web = a.web && webUp.has(a.id) ? a.web : undefined;
    return { id: a.id, name: a.name, online: installed, running: isRunning || !!web, launchable: HAS_TMUX && a.bins.some(onPath) && proc.length > 0, panes: agentPanes, ...(web ? { webPort: a.webProxy || web, webTls: PROXY_HTTPS } : a.web && installed && a.webCmd ? { webOff: true } : {}), ...adapterMeta };
  });
  const rowPanes = rows.flatMap((r) =>
    r.panes.map((p) => ({
      ...p,
      agentId: r.id,
      agentName: r.name,
      title: titleByPaneId.get(p.paneId) || "",
    }))
  );
  const rowPaneIds = new Set(rowPanes.map((p) => p.paneId));
  const extraWaitPanes = panes
    .filter((pn) => activeWaitPaneCounts.has(pn.paneId) && !rowPaneIds.has(pn.paneId))
    .map((pn) => ({
      paneId: pn.paneId,
      label: pn.label,
      window: pn.window,
      cwd: pn.cwd,
      agentId: "shell",
      agentName: "Terminal",
      title: pn.title || "",
    }));
  await updateWaiting([...rowPanes, ...extraWaitPanes]);
  const now = Date.now();
  for (const r of rows) {
    for (const p of r.panes) {
      const watch = paneWatch.get(p.paneId);
      const status = paneStatusFor(watch, now);
      p.status = status;
      p.waiting = status === "blocked";
      p.statusRule =
        watch?.ruleId ??
        (status === "blocked" ? "stillness_waiting" : status === "working" ? "recent_output" : "stillness_idle");
      p.statusSource = watch?.source ?? "heuristic";
    }
    r.waiting = r.panes.some((p) => p.waiting);
  }
  applyLabels(rows, readLabels(PANE_LABELS_FILE));
  return withScanSeq(rows, seq);
}

async function detectAgents() {
  if (detectAgentsInFlight) return detectAgentsInFlight;
  detectAgentsInFlight = detectAgentsImpl()
    .then((rows) => {
      lastDetectAt = Date.now();
      lastDetectRows = rows;
      return rows;
    })
    .finally(() => {
      detectAgentsInFlight = null;
    });
  return detectAgentsInFlight;
}

async function refreshForWait(force = false) {
  if (!force && lastDetectAt > 0 && Date.now() - lastDetectAt < 2000 && !detectAgentsInFlight) {
    return lastDetectRows;
  }
  return detectAgents();
}

// paste text into a pane via set-buffer/paste-buffer — safe for arbitrary text (no key interpretation)
const pasteToPane = createPasteToPane({ run, cwd: ROOT, tmuxBin: TMUX_BIN, targetBuffers: IS_WIN });

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
  const local = await herdrPanes.applyTo(await detectAgents());
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

// --- per-agent state watcher: herdr manifest rules when available, stillness heuristic as fallback ---
const PROMPT_RE = /(do you want|y\/n|yes\/no|proceed\?|trust|permission|allow|esperando|continuar|❯\s*1\.|\?\s*$)/i;
const paneWatch = new Map();

function markPaneSeen(paneId) {
  const now = Date.now();
  const st = paneWatch.get(paneId);
  if (st) {
    st.seenAt = now;
    if (st.source === "manifest" && st.state === "idle") st.changedAt = 0;
  }
}
// A prompt sent through the panel starts a turn. Short turns can finish between two 5 s samples,
// so the pane would never show `working` and `done` would be missed: for PENDING_TURN_MS after a
// send that pane is sampled every second (see the fast loop below the watcher), and a launch's
// boot grace does not apply to it. A screen change alone is never taken as "turn finished": the
// echoed prompt already changes the screen, so only an observed `working` can lead to `done`.
const PENDING_TURN_MS = 30000;
const pendingTurnMarks = new Map(); // paneId → ts, for panes the watcher has not created yet
function markPaneTurnStarted(paneId) {
  const now = Date.now();
  const st = paneWatch.get(paneId);
  if (st && st.source === "manifest") {
    st.pendingTurnAt = now; // fast sampling window (cleared once `working` is observed)
    st.turnRequested = true; // sticky: from now on the launch boot grace no longer applies
    return;
  }
  // first prompt right after a launch, or a send before the first sample: remembered until the
  // watcher creates the entry (consumed there); stale marks are dropped with the launch grace
  pendingTurnMarks.set(paneId, now);
  for (const [id, at] of pendingTurnMarks) if (now - at > LAUNCH_GRACE_MS) pendingTurnMarks.delete(id);
}
// A CLI launched from the panel spins (`working`) while it boots and then sits at its prompt:
// that boot is not a turn Mondo asked for, so it must not surface as `done`. Launches are
// remembered here until the watcher creates the pane's entry; the grace covers slow boots.
const LAUNCH_GRACE_MS = 90000;
const recentlyLaunched = new Map(); // paneId → launch timestamp
function markPaneLaunched(paneId) {
  recentlyLaunched.set(paneId, Date.now());
  for (const [id, at] of recentlyLaunched) if (Date.now() - at > LAUNCH_GRACE_MS) recentlyLaunched.delete(id);
}

let watcherBusy = false;
async function updateWaiting(panes, { partial = false } = {}) {
  // partial = a fast re-sample of a few panes: it must not evict the entries it did not visit
  if (watcherBusy) return;
  watcherBusy = true;
  try { await sampleWatch(panes, partial); } finally { watcherBusy = false; }
}
async function sampleWatch(panes, partial) {
  const now = Date.now();
  const seen = new Set();
  for (const pn of panes) {
    if (seen.has(pn.paneId)) continue;
    seen.add(pn.paneId);
    const r = await run(TMUX_BIN, ["capture-pane", "-t", pn.paneId, "-p"], ROOT, 4000);
    if (!r.ok) continue;
    const screen = r.out.trimEnd();
    const manifest = AGENT_MANIFESTS ? AGENT_MANIFESTS.resolve(pn.agentId) : null;
    let existing = paneWatch.get(pn.paneId);
    // the same tmux pane can change hands (agent exits to a shell, another CLI starts): a stale
    // entry would keep the old agent's state/done/blocked, so identity changes start the DETECTOR
    // state afresh. Pane-level bookkeeping (seen, launched, turn requested) belongs to the pane,
    // not to the detector, and is carried over so a transient attribution change loses nothing.
    let carry = null;
    if (existing && (existing.agentId !== pn.agentId || existing.source !== (manifest ? "manifest" : "heuristic"))) {
      // two different KNOWN agents in a row (codex → antigravity) is a real new occupant: it keeps the
      // viewing history only, never the previous occupant's prompt/launch exemptions. Anything that
      // passes through the heuristic (agent → shell → agent) is treated as a transient attribution
      // loss and keeps everything.
      // `ownerAgentId` names the known agent the bookkeeping belongs to, even across a shell spell
      const owner = existing.source === "manifest" ? existing.agentId : (existing.ownerAgentId ?? null);
      const newOccupant = !!manifest && owner !== null && owner !== pn.agentId;
      carry = newOccupant
        ? { seenAt: existing.seenAt ?? 0, launchedAt: 0, turnRequested: false, pendingTurnAt: 0, ownerAgentId: null }
        : { seenAt: existing.seenAt ?? 0, launchedAt: existing.launchedAt ?? 0, turnRequested: !!existing.turnRequested, pendingTurnAt: existing.pendingTurnAt ?? 0, ownerAgentId: owner };
      paneWatch.delete(pn.paneId);
      existing = undefined;
    }
    // a prompt sent before this pane had an entry: applied (if still fresh) to whichever entry is
    // created now, manifest or heuristic, and only then forgotten
    const queuedMark = existing ? undefined : pendingTurnMarks.get(pn.paneId);
    const freshMark = queuedMark !== undefined && now - queuedMark < LAUNCH_GRACE_MS;
    if (!existing) pendingTurnMarks.delete(pn.paneId);

    if (manifest) {
      const isFirst = !existing;
      const st = existing ?? {
        hash: null,
        changedAt: 0,
        waiting: false,
        notifiedAt: 0,
        doneNotifiedAt: 0,
        lastWorkingAt: 0,
        doneAt: 0,
        seenAt: carry?.seenAt ?? 0,
        pendingTurnAt: freshMark ? queuedMark : (carry?.pendingTurnAt ?? 0),
        turnRequested: freshMark || (carry?.turnRequested ?? false),
        launchedAt: recentlyLaunched.get(pn.paneId) ?? carry?.launchedAt ?? 0,
        ownerAgentId: pn.agentId,
        source: "manifest",
        state: "idle",
        ruleId: null,
        region: null,
        matched: null,
        prevDetect: null,
      };
      const prevState = isFirst ? null : st.state;
      const det = detectState(manifest, { screen, oscTitle: pn.title || "" }, st.prevDetect);
      st.source = "manifest";
      st.state = det.state;
      st.sampledAt = now; // when this manifest state was observed (the prompt gate needs a post-send sample)
      st.ruleId = det.ruleId;
      st.region = det.region;
      st.matched = det.matched;
      st.prevDetect = { state: det.state, ruleId: det.ruleId };
      st.agentId = pn.agentId;
      st.agentName = pn.agentName;
      st.cwd = pn.cwd;
      st.title = pn.title || "";

      if (det.state === "working") {
        st.lastWorkingAt = now;
        st.doneAt = 0;
        st.waiting = false;
        st.pendingTurnAt = 0;
        if (screen !== st.hash) {
          st.hash = screen;
          st.changedAt = now;
        }
      } else if (det.state === "blocked") {
        st.waiting = true;
        st.hash = screen;
        if (prevState !== "blocked" && now - st.notifiedAt > 600000) {
          st.notifiedAt = now;
          notifyWaiting(pn, st);
        }
      } else {
        st.waiting = false;
        const bootOnly = st.launchedAt > 0 && now - st.launchedAt < LAUNCH_GRACE_MS && !st.turnRequested;
        if (prevState === "working" && !bootOnly) {
          st.pendingTurnAt = 0;
          st.doneAt = now;
          st.hash = screen;
          st.changedAt = 0;
          if (st.doneAt > st.seenAt && now - st.doneNotifiedAt > 600000) {
            st.doneNotifiedAt = now;
            notifyDone(pn, st);
          }
        } else if (!isFirst && screen !== st.hash) {
          st.hash = screen;
          if (
            det.ruleId === "default_known_agent_idle_fallback" &&
            st.lastWorkingAt > 0 &&
            now - st.lastWorkingAt < 10000
          ) {
            st.changedAt = now;
          } else {
            st.changedAt = 0;
          }
        } else if (isFirst) {
          st.hash = screen;
          st.changedAt = 0;
        }
      }
      paneWatch.set(pn.paneId, st);
    } else {
      const st = existing ?? {
        hash: null,
        changedAt: now,
        waiting: false,
        notifiedAt: 0,
        doneNotifiedAt: 0,
        lastWorkingAt: 0,
        doneAt: 0,
        seenAt: carry?.seenAt ?? 0,
        // pane bookkeeping survives a spell as "shell" so the agent gets it back when re-attributed
        pendingTurnAt: freshMark ? queuedMark : (carry?.pendingTurnAt ?? 0),
        turnRequested: freshMark || (carry?.turnRequested ?? false),
        launchedAt: recentlyLaunched.get(pn.paneId) ?? carry?.launchedAt ?? 0,
        ownerAgentId: carry?.ownerAgentId ?? null,
        source: "heuristic",
        ruleId: "recent_output",
        region: null,
        matched: null,
      };
      st.source = "heuristic";
      st.agentId = pn.agentId;
      st.agentName = pn.agentName;
      st.cwd = pn.cwd;
      st.title = pn.title || "";
      if (screen !== st.hash) {
        st.hash = screen;
        st.changedAt = now;
        st.waiting = false;
        st.ruleId = "recent_output";
      } else {
        const still = now - st.changedAt;
        const promptish = PROMPT_RE.test(screen.split("\n").slice(-8).join("\n"));
        const was = st.waiting;
        st.waiting = still >= (promptish ? 10000 : 45000);
        st.ruleId = st.waiting
          ? promptish
            ? "stillness_prompt_10s"
            : "stillness_45s"
          : still < 5000
            ? "recent_output"
            : "stillness_idle";
        if (st.waiting && !was && now - st.notifiedAt > 600000) {
          st.notifiedAt = now;
          notifyWaiting(pn, st);
        }
      }
      paneWatch.set(pn.paneId, st);
    }
  }
  if (!partial) {
    for (const id of [...paneWatch.keys()]) if (!seen.has(id)) paneWatch.delete(id);
    // marks for panes that never showed up (swallowed launch, dead pane) expire with the grace
    for (const [id, at] of pendingTurnMarks) if (now - at > LAUNCH_GRACE_MS) pendingTurnMarks.delete(id);
    for (const [id, at] of recentlyLaunched) if (now - at > LAUNCH_GRACE_MS) recentlyLaunched.delete(id);
  }
}
// fast loop: panes with a prompt in flight are sampled every second so a short turn is still seen
setInterval(() => {
  const now = Date.now();
  const hot = [...paneWatch.entries()]
    .filter(([, st]) => st.source === "manifest" && st.pendingTurnAt > 0 && now - st.pendingTurnAt < PENDING_TURN_MS)
    .map(([paneId, st]) => ({ paneId, agentId: st.agentId, agentName: st.agentName, cwd: st.cwd, title: st.title }));
  if (hot.length) updateWaiting(hot, { partial: true }).catch(() => {});
}, 1000);
// push notification via ntfy (data/notify.json: { "ntfy": "https://ntfy.sh/tu-topic" }) — optional
function notifyWaiting(pn, st) {
  notifyPane({ state: "blocked", agentId: pn.agentId, statusSource: st.source, ruleId: st.ruleId, session: sessionNameOf(pn.label), paneId: pn.paneId });
  logEvent(`waiting · ${pn.agentName} · ${pn.cwd}`);
  let cfg; try { cfg = readJSON(join(ROOT, "data", "notify.json")); } catch { return; }
  if (!cfg?.ntfy) return;
  fetch(cfg.ntfy, {
    method: "POST",
    body: `${pn.agentName} espera tu input · ${pn.cwd}`,
    headers: { Title: "MT3K Agent OS", Priority: "high", Tags: "hourglass" },
  }).catch(() => { /* notification is best-effort */ });
}
function notifyDone(pn, st) {
  notifyPane({ state: "done", agentId: pn.agentId, statusSource: st.source, ruleId: st.ruleId, session: sessionNameOf(pn.label), paneId: pn.paneId });
  logEvent(`done · ${pn.agentName} · ${pn.cwd}`);
  let cfg; try { cfg = readJSON(join(ROOT, "data", "notify.json")); } catch { return; }
  if (!cfg?.ntfy || cfg.onDone === false) return;
  fetch(cfg.ntfy, {
    method: "POST",
    body: `${pn.agentName} terminó · ${pn.cwd}`,
    headers: { Title: "MT3K Agent OS", Priority: "default", Tags: "white_check_mark" },
  }).catch(() => { /* notification is best-effort */ });
}
// keep watching even when no browser is polling — otherwise notifications only fire while the panel is open
// 5 s (was 15): a turn shorter than the sampling gap never shows `working`, so `done` would be missed
detectAgents().catch(() => {});
setInterval(() => detectAgents().catch(() => {}), 5000);

// ledger writer from one discovery: every await (detect, list-sessions) finishes BEFORE the mutation,
// which then rebuilds against the latest ledger; a scan older than the last kill is rejected
async function saveCurrentSnapshot(rowsIn = null) {
  try {
    const rows = rowsIn || (await detectAgents());
    const seq = scanSeqOf(rows);
    const liveSessionNames = await listLiveTmuxSessionNames();
    const res = await ledger.mutate(
      "writer",
      (cur) => withoutRecentlyKilled(buildSnapshot(rows, cur, new Date().toISOString(), { liveSessionNames }), rows, seq),
      { scanSeq: seq }
    );
    return res.applied ? res.state : null;
  } catch {
    return null;
  }
}

function recordLaunchInSnapshot({ agentId, cwd, sessionName, name, replacesSessionName }) {
  killTombstones.clear(sessionName);
  if (!agentId || agentId === "shell") return Promise.resolve({ applied: false, reason: "not-tracked" });
  const launchMutation = (prev) => {
    const nowIso = new Date().toISOString();
    if (replacesSessionName) {
      return replaceRestoredSession(
        prev,
        replacesSessionName,
        {
          agentId,
          cwd,
          sessionName,
          ...(name ? { name } : {}),
        },
        nowIso
      );
    }
    const sessions = Array.isArray(prev?.sessions) ? [...prev.sessions] : [];
    const existingIdx = sessions.findIndex((s) => sessionNameOf(s?.sessionName) === sessionNameOf(sessionName));
    const entry = {
      agentId,
      cwd,
      sessionName: sessionNameOf(sessionName),
      ...(name ? { name } : {}),
      launched: true, // the panel launched it with this agent: it owns the session (one-owner rule)
      firstSeen: existingIdx >= 0 && sessions[existingIdx].firstSeen ? sessions[existingIdx].firstSeen : nowIso,
      lastSeen: nowIso,
    };
    if (existingIdx >= 0) sessions[existingIdx] = entry;
    else sessions.push(entry);
    return {
      savedAt: nowIso,
      host: typeof prev?.host === "string" && prev.host ? prev.host : buildSnapshot([], prev, nowIso).host,
      sessions,
    };
  };
  return ledger.mutate("launch", launchMutation, { retry: true });
}

function readRestoreConfig() {
  try {
    if (!existsSync(RESTORE_CFG_FILE)) return { auto: false };
    const raw = readJSON(RESTORE_CFG_FILE);
    return { auto: Boolean(raw?.auto) };
  } catch {
    return { auto: false };
  }
}

function writeRestoreConfig(auto) {
  mkdirSync(dirname(RESTORE_CFG_FILE), { recursive: true });
  const tmp = `${RESTORE_CFG_FILE}.mt3k-tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify({ auto: Boolean(auto) }, null, 2) + "\n", "utf8");
  renameSync(tmp, RESTORE_CFG_FILE);
}

// Dónde se crean las sesiones NUEVAS: "tmux" (por defecto, también si falta o está corrupto el archivo) o "herdr".
function readLaunchBackend() {
  if (process.env.MT3K_HERDR === "0") return "tmux";
  try {
    return parseLaunchBackend(existsSync(LAUNCH_BACKEND_FILE) ? readFileSync(LAUNCH_BACKEND_FILE, "utf8") : null);
  } catch {
    return "tmux";
  }
}

function writeLaunchBackend(backend) {
  mkdirSync(dirname(LAUNCH_BACKEND_FILE), { recursive: true });
  const tmp = `${LAUNCH_BACKEND_FILE}.mt3k-tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify({ backend }, null, 2) + "\n", "utf8");
  renameSync(tmp, LAUNCH_BACKEND_FILE);
}

setInterval(() => { saveCurrentSnapshot().catch(() => {}); }, 60000).unref();

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
    )
      // un terminal vivo de Herdr (lista cacheada, sin llamar a hc) también ocupa agente + carpeta
      || herdrOccupies(herdrPanes.cachedRows(), agentId, normalizedCwd, (p) => tildify(realDir(expand(p))));
    return { resumeArgs, alreadyOpen, hasHistory: hasResumableHistory(agentId, cwd, { realDir }) };
  } catch {
    return { resumeArgs, alreadyOpen: false, hasHistory: false };
  }
}

async function captureTail(paneId) {
  const cap = await run(TMUX_BIN, ["capture-pane", "-t", paneId, "-p"], ROOT, 4000);
  if (!cap.ok) return [];
  return cap.out
    .trimEnd()
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .slice(-12);
}

function readPaneWaitStatus(paneId) {
  if (!paneWatch.has(paneId)) return null;
  const now = Date.now();
  const watch = paneWatch.get(paneId);
  const status = paneStatusFor(watch, now);
  const statusRule =
    watch?.ruleId ??
    (status === "blocked" ? "stillness_waiting" : status === "working" ? "recent_output" : "stillness_idle");
  return {
    status,
    statusRule,
    source: watch?.source ?? "heuristic",
    sampledAt: typeof watch?.sampledAt === "number" ? watch.sampledAt : 0,
  };
}

async function waitOnPane({ res, paneId, until, timeoutSec, baseline = null, sawWorkingBefore = false, isPromptWait = false, sentAt = null }) {
  if (res.writableEnded || res.destroyed) return;
  incWaitPane(paneId);
  try {
    const result = await runWait({
      cond: until,
      timeoutMs: timeoutSec * 1000,
      baseline,
      sawWorkingBefore,
      isPromptWait,
      sentAt,
      refresh: async (force = false) => {
        const mustForce =
          Boolean(force) ||
          lastDetectAt === 0 ||
          !lastListPanesOk ||
          !lastDiscoveredPaneIds.has(paneId) ||
          !paneWatch.has(paneId);
        await refreshForWait(mustForce);
      },
      readStatus: () => readPaneWaitStatus(paneId),
      isAlive: () => (!lastListPanesOk ? true : lastDiscoveredPaneIds.has(paneId)),
      onAbort: (abort) => {
        const onClose = () => abort();
        res.on("close", onClose);
        if (res.writableEnded || res.destroyed) abort();
        return () => res.removeListener("close", onClose);
      },
    });
    if (result.reason === "aborted" || res.writableEnded || res.destroyed) {
      logEvent(`wait-abort · ${paneId} · ${result.waitedMs}ms`);
      return;
    }
    const tail = result.reason === "gone" ? [] : await captureTail(paneId);
    if (res.writableEnded || res.destroyed) return;
    return sendJSON(res, 200, {
      ok: true,
      paneId,
      status: result.status,
      statusRule: result.statusRule,
      reason: result.reason,
      waitedMs: result.waitedMs,
      sawWorking: Boolean(result.sawWorking),
      tail,
      ...(result.baseline ? { baseline: result.baseline } : {}),
    });
  } finally {
    decWaitPane(paneId);
  }
}

// /api/wait y /api/prompt-wait sobre un terminal de Herdr: misma respuesta que waitOnPane, estado de la lista cacheada
async function waitOnHerdr({ res, paneId, until, timeoutSec, baseline = null, sawWorkingBefore = false, isPromptWait = false, sentAt = null }) {
  if (res.writableEnded || res.destroyed) return;
  const result = await herdrPanes.wait({
    id: paneId, until, timeoutSec, baseline, sawWorkingBefore, isPromptWait, sentAt,
    onAbort: (abort) => {
      const onClose = () => abort();
      res.on("close", onClose);
      if (res.writableEnded || res.destroyed) abort();
      return () => res.removeListener("close", onClose);
    },
  });
  if (result.reason === "aborted" || res.writableEnded || res.destroyed) return;
  const tail = result.reason === "gone" ? [] : await herdrPanes.tailOf(paneId);
  if (res.writableEnded || res.destroyed) return;
  return sendJSON(res, 200, {
    ok: true, paneId, status: result.status, statusRule: result.statusRule, reason: result.reason,
    waitedMs: result.waitedMs, sawWorking: Boolean(result.sawWorking), tail,
    ...(result.baseline ? { baseline: result.baseline } : {}),
  });
}

// Executable + args + env of a NEW session, shared by every backend (tmux and herdr build their command from this one
// result, so YOLO flags, the claude --settings overlay and resume args can never drift apart). It may reserve a resume
// slot: the caller releases it (see RESUME_HOLD_MS) once the session exists or the launch is abandoned.
async function composeLaunchCommand({ def, agentId, bin, isShell, cwd, fresh }) {
  let cmd = isShell ? [] : [bin];
  let launchEnvPairs = [];
  let resumed = false;
  let reason = "no-args";
  let resumeReservation = null;
  let ownsResumeReservation = false;
  try {
    const lc = isShell ? null : readJSON(join(ROOT, "data", "launch.json"))[agentId];
    if (lc) {
      const { envPairs, args } = parseLaunchConfig(lc);
      launchEnvPairs = envPairs;
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
  }
  if (!isShell && cmd.length === 1) cmd = composeTmuxArgv({ bin, envPairs: [], args: [] });
  return { cmd, launchEnvPairs, resumed, reason, resumeReservation, ownsResumeReservation };
}

// Backend herdr de un lanzamiento (solo /api/launch con data/launch-backend.json = herdr). Devuelve
// { result } si ya respondió (éxito o error sin tmux) o { fallback } para que el llamador abra en tmux.
// Nunca arranca un core ni la app de Herdr: sin core vivo cae a tmux.
const HERDR_FALLBACK_NO_CORE = "herdr no está corriendo; se abrió en tmux";
const HERDR_FALLBACK_NOT_INSTALLED = "herdr no está instalado; se abrió en tmux";
const HERDR_FALLBACK_WIN_ENV = "herdr no admite variables de entorno en Windows; se abrió en tmux";
async function launchInHerdr({ agentId, session, cwd, cmd, launchEnvPairs, resumed, reason, firstPrompt }) {
  if (IS_WIN && launchEnvPairs.length) return { fallback: HERDR_FALLBACK_WIN_ENV };
  const argv = herdrLaunchArgv({ cmd, path: await agentPath(), platform: process.platform });
  const made = await herdrLauncher.launch({ agentId, cwd, argv });
  if (!made.ok) {
    if (made.reason === "no-core") return { fallback: HERDR_FALLBACK_NO_CORE };
    if (made.reason === "not-installed") return { fallback: HERDR_FALLBACK_NOT_INSTALLED };
    return { result: { ok: false, status: 500, err: made.err || "no se pudo abrir en herdr" } };
  }
  herdrPanes.invalidate();
  await herdrPanes.refresh(true); // el terminal nuevo ya es conocido (y su etiqueta leída) cuando el panel lo abre
  const paneId = made.paneId;
  const cleanCwd = tildify(cwd);
  if (typeof firstPrompt === "string" && firstPrompt.trim() && firstPrompt.length <= 64000) {
    (async () => {
      let prev = "";
      for (let i = 0; i < 10; i++) {
        await new Promise((ok) => setTimeout(ok, 2000));
        const cap = await herdrPanes.read(paneId, 0);
        if (!cap.ok) return;
        if (cap.text.trim() && cap.text === prev) break;
        prev = cap.text;
      }
      const sent = await herdrPanes.send(paneId, firstPrompt.trim());
      if (sent.ok) markPaneTurnStarted(paneId);
      logEvent(`first-prompt · ${agentId} · herdr · "${firstPrompt.slice(0, 60).replace(/\s+/g, " ").trim()}"`);
    })().catch(() => {});
  }
  markPaneLaunched(paneId);
  logEvent(`launch · ${agentId} · ${session} · ${cleanCwd} · resumed=${resumed} · herdr(${made.via})`);
  return {
    result: {
      ok: true,
      status: 200,
      paneId,
      label: made.name || made.address,
      session: made.name || made.address,
      cwd: cleanCwd,
      resumed,
      reason,
      ledger: "no-aplica", // las sesiones de herdr no entran al ledger de restauración (que reabre en tmux)
      backend: "herdr",
      ...(made.warning ? { warning: made.warning } : { killable: true }),
    },
  };
}

async function launchLocalSession(
  { agentId, projectId, cwd: cwdIn, create, firstPrompt, fresh } = {},
  { internalLabelName = "", replacesSessionName = "", allowHerdr = false } = {}
) {
  if (!HAS_TMUX) return { ok: false, status: 400, err: "tmux no está instalado en este host" };
  const def = AGENT_DEFS.find((a) => a.id === agentId);
  const isShell = agentId === "shell";
  if (!def || (!isShell && !(def.proc && def.proc.length))) return { ok: false, status: 400, err: "agente no lanzable" };
  const gate = requireCapability(def, adapterEnv(), "launch");
  if (!gate.ok) return { ok: false, status: gate.status, err: gate.err };
  const bin = isShell ? null : def.bins.map(absBin).find(Boolean);
  if (!isShell && !bin) return { ok: false, status: 400, err: `${def.name} no está instalado` };
  const target = await resolveLaunchCwd({ projectId, cwd: cwdIn });
  if (target.err && !(target.missingDir && create)) {
    const { status, cwd: _cwd, ...error } = target;
    return { ok: false, status, ...error };
  }
  const cwd = target.cwd;
  if (target.missingDir) {
    try { mkdirSync(target.cwd, { recursive: true }); } catch { return { ok: false, status: 500, err: "no se pudo crear la carpeta" }; }
  }
  const session = mt3kSessionName(agentId, basename(cwd) || "home");
  let { cmd, launchEnvPairs, resumed, reason, resumeReservation, ownsResumeReservation } = await composeLaunchCommand({ def, agentId, bin, isShell, cwd, fresh });
  let fallback = "";
  if (allowHerdr && readLaunchBackend() === "herdr") {
    const viaHerdr = await launchInHerdr({ agentId, session, cwd, cmd, launchEnvPairs, resumed, reason, firstPrompt });
    if (viaHerdr.result) {
      if (ownsResumeReservation) setTimeout(() => resumeLaunchReservations.delete(resumeReservation), RESUME_HOLD_MS);
      return viaHerdr.result;
    }
    fallback = viaHerdr.fallback;
  }
  let r;
  try {
    const tmuxEnv = { PATH: await agentPath() };
    const globalEnv = parseTmuxGlobalEnv((await run(TMUX_BIN, ["show-environment", "-g"], ROOT, 3000, tmuxEnv)).out);
    for (const key of tmuxGlobalKeysToUnset(globalEnv)) {
      await run(TMUX_BIN, ["set-environment", "-gr", key], ROOT, 3000, tmuxEnv);
    }
    if (needsGlobalColortermTruecolor(globalEnv)) {
      await run(TMUX_BIN, ["set-environment", "-g", "COLORTERM", "truecolor"], ROOT, 3000, tmuxEnv);
    }
    const curGlobal = (await run(TMUX_BIN, ["show-environment", "-g", "PATH"], ROOT, 3000, tmuxEnv)).out.replace(/^PATH=/i, "");
    await run(TMUX_BIN, ["set-environment", "-g", "PATH", cleanPath([...tmuxEnv.PATH.split(delimiter), ...(curGlobal ? curGlobal.split(delimiter) : [])])], ROOT, 3000, tmuxEnv);
    r = await run(TMUX_BIN, ["new-session", "-d", "-e", `PATH=${tmuxEnv.PATH}`, "-e", "COLORTERM=truecolor", ...(IS_WIN ? envPairsToTmuxFlags(launchEnvPairs) : []), "-P", "-F", `${PANE_KEY_FMT}|#{session_name}:#{window_index}.#{pane_index}`, "-s", session, "-c", cwd, ...cmd], ROOT, 8000, tmuxEnv);
    if (r.ok) await ensureTmuxHooks(true);
  } finally {
    if (ownsResumeReservation) setTimeout(() => resumeLaunchReservations.delete(resumeReservation), RESUME_HOLD_MS);
  }
  if (!r.ok) return { ok: false, status: 500, err: r.err || "tmux new-session falló (¿tmux instalado?)" };
  const [rawPaneId, label] = (r.out || "").split("|");
  const paneId = IS_WIN ? label : rawPaneId;
  const cleanCwd = tildify(cwd);
  const labelSanitized = sanitizePaneLabel(internalLabelName);
  const cleanLabelName = labelSanitized.ok ? labelSanitized.name : "";
  if (cleanLabelName || replacesSessionName) {
    try {
      const map = readLabels(PANE_LABELS_FILE);
      if (replacesSessionName) {
        delete map[labelKey(agentId, cleanCwd, replacesSessionName)];
      }
      if (cleanLabelName) {
        map[labelKey(agentId, cleanCwd, session)] = { label: cleanLabelName, at: new Date().toISOString() };
      }
      writeLabels(PANE_LABELS_FILE, map);
    } catch { /* best-effort label write */ }
  }
  const launchLedger = await recordLaunchInSnapshot({
    agentId,
    cwd: cleanCwd,
    sessionName: session,
    name: cleanLabelName || undefined,
    replacesSessionName: replacesSessionName || undefined,
  });
  setTimeout(() => { saveCurrentSnapshot().catch(() => {}); }, 1500).unref();
  if (typeof firstPrompt === "string" && firstPrompt.trim() && firstPrompt.length <= 64000) {
    (async () => {
      let prev = "";
      for (let i = 0; i < 10; i++) {
        await new Promise((ok) => setTimeout(ok, 2000));
        const cap = await run(TMUX_BIN, ["capture-pane", "-t", paneId, "-p"], ROOT, 4000);
        if (!cap.ok) return;
        if (cap.out.trim() && cap.out === prev) break;
        prev = cap.out;
      }
      const pasted = await pasteToPane(paneId, firstPrompt.trim(), true);
      if (pasted.ok) markPaneTurnStarted(paneId);
      logEvent(`first-prompt · ${agentId} · "${firstPrompt.slice(0, 60).replace(/\s+/g, " ").trim()}"`);
    })().catch(() => {});
  }
  markPaneLaunched(paneId);
  logEvent(`launch · ${agentId} · ${session} · ${cleanCwd} · resumed=${resumed}`);
  return {
    ok: true,
    status: 200,
    paneId,
    label: label || session,
    session,
    cwd: cleanCwd,
    resumed,
    reason,
    // ledger: ok | pendiente (write failed, kept as a pending intent) | <error reason>
    ledger: launchLedger.applied || launchLedger.reason === "not-tracked" || launchLedger.reason === "unchanged" ? "ok" : launchLedger.queued ? "pendiente" : launchLedger.reason,
    ...(cleanLabelName ? { name: cleanLabelName } : {}),
    ...(fallback ? { fallback } : {}),
  };
}

async function triggerRestore({ all = false, items = [] } = {}) {
  const res = await runRestoreWithLock({
    all,
    items,
    missing: async () => {
      const liveRows = await detectAgents();
      const liveSessionNames = await listLiveTmuxSessionNames();
      const snapshot = ledger.projected(); // read AFTER the awaits: latest ledger + pending (unpersisted) removals
      if (!snapshot) return [];
      return diffSnapshot(snapshot, liveRows, { liveSessionNames }).missing;
    },
    // folder check before a launch slot is used: dead folders never consume the 12-launch quota
    precheck: async (item) => {
      const target = await resolveLaunchCwd({ cwd: item.cwd });
      return target.err ? { skipped: true, reason: "missing-dir", err: target.err } : null;
    },
    launch: async (item) => {
      const target = await resolveLaunchCwd({ cwd: item.cwd });
      if (target.err) {
        return {
          ok: false,
          skipped: true,
          reason: "missing-dir",
          err: target.err,
        };
      }
      return launchLocalSession(
        { agentId: item.agentId, cwd: item.cwd },
        { internalLabelName: item.name, replacesSessionName: item.sessionName }
      );
    },
    log: (msg) => logEvent(msg),
  });
  if (res.ok) {
    await saveCurrentSnapshot();
  }
  return res;
}

if (readRestoreConfig().auto) {
  setTimeout(() => {
    triggerRestore({ all: true }).catch(() => {});
  }, 20000).unref();
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
    return sendJSON(res, 200, { agents: flat ? await herdrPanes.applyTo(await detectAgents()) : await federatedAgents() });
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
    if (isHerdrId(paneId)) {
      if (denyUnlessCap(res, SHELL_DEF, "view")) return;
      if (!(await herdrPanes.has(paneId))) return sendJSON(res, 404, { ok: false, err: "ese pane ya no existe" });
      const hr = await herdrPanes.view(paneId);
      return sendJSON(res, 200, { ok: hr.ok, content: hr.ok ? hr.text : "", alternate: false, mouse_sgr: false });
    }
    const paneCheck = validatePaneId(paneId);
    if (!paneCheck.ok) return sendJSON(res, 400, { ok: false, err: paneCheck.err });
    if (denyUnlessCap(res, SHELL_DEF, "view")) return;
    const live = (await run(TMUX_BIN, ["list-panes", "-a", "-F", PANE_KEY_FMT], ROOT, 5000)).out.split("\n");
    if (!live.includes(paneId)) return sendJSON(res, 404, { ok: false, err: "ese pane ya no existe" });
    markPaneSeen(paneId);
    // -e keeps colors, -p prints to stdout, -S -1000 ships real scrollback — 200 felt like
    // "no history" on long agent sessions (keep on-screen line breaks → less reflow)
    const r = await run(TMUX_BIN, ["capture-pane", "-t", paneId, "-p", "-e", "-N", "-S", "-1000"], ROOT, 5000);
    // alt + ratón SGR en un solo display (cero llamadas tmux extra)
    const flags = parseAlternateMouseSgr(
      (await run(TMUX_BIN, ["display-message", "-p", "-t", paneId, TMUX_ALT_MOUSE_DISPLAY], ROOT, 4000)).out,
    );
    return sendJSON(res, 200, { ok: r.ok, content: r.out, alternate: flags.alternate, mouse_sgr: flags.mouse_sgr });
  }

  // explain why a pane has its current state (manifest rule/region/matched vs stillness heuristic)
  if (path === "/api/pane-explain" && req.method === "GET") {
    const paneId = new URL(req.url, "http://x").searchParams.get("id") || "";
    if (isHerdrId(paneId)) {
      if (denyUnlessCap(res, SHELL_DEF, "view")) return;
      if (!(await herdrPanes.has(paneId))) return sendJSON(res, 404, { ok: false, err: "ese pane ya no existe" });
      return sendJSON(res, 200, await herdrPanes.explain(paneId));
    }
    const paneCheck = validatePaneId(paneId);
    if (!paneCheck.ok) return sendJSON(res, 400, { ok: false, err: paneCheck.err });
    if (denyUnlessCap(res, SHELL_DEF, "view")) return;
    refreshAgentDefsFromLocal();
    const { descendants } = await procTree();
    const panes = await discoverPanes(descendants);
    const pn = panes.find((x) => x.paneId === paneId);
    if (!pn) return sendJSON(res, 404, { ok: false, err: "ese pane ya no existe" });
    let agent = paneWatch.get(paneId)?.agentId || null;
    if (!agent) {
      if (pn.label.startsWith("mt3k-shell-")) {
        agent = "shell";
      } else {
        const matchedDef = normalizedAgentDefs.find(
          (a) =>
            a.id !== "shell" &&
            Array.isArray(a.proc) &&
            a.proc.length > 0 &&
            pn.comms.some((comm) => a.proc.some((name) => procMatches(comm, name)))
        );
        agent = matchedDef ? matchedDef.id : "shell";
      }
    }
    const cap = await run(TMUX_BIN, ["capture-pane", "-t", paneId, "-p"], ROOT, 4000);
    const screen = cap.ok ? cap.out.trimEnd() : "";
    const title = pn.title || "";
    const tail = screen
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0)
      .slice(-12);
    const watch = paneWatch.get(paneId);
    const manifest = AGENT_MANIFESTS ? AGENT_MANIFESTS.resolve(agent) : null;
    if (manifest) {
      const det = detectState(manifest, { screen, oscTitle: title }, watch?.prevDetect || null);
      return sendJSON(res, 200, {
        ok: true,
        paneId,
        agent,
        source: "manifest",
        state: det.state,
        ruleId: det.ruleId,
        region: det.region,
        matched: det.matched,
        title,
        tail,
      });
    }
    const hStatus = paneStatusFor(watch, Date.now());
    return sendJSON(res, 200, {
      ok: true,
      paneId,
      agent,
      source: "heuristic",
      state: hStatus,
      ruleId: watch?.ruleId ?? (hStatus === "blocked" ? "stillness_waiting" : hStatus === "working" ? "recent_output" : "stillness_idle"),
      region: null,
      matched: null,
      title,
      tail,
    });
  }

  // grow a detached tmux window so the CLI reflows to the viewer's width — panel-launched
  // sessions default to 80 cols, wasting most of a desktop screen. Never touches a window
  // with a real client attached (kitty/ssh): that client owns the size.
  if (path === "/api/pane-resize" && req.method === "POST") {
    const { paneId, cols, rows } = await body(req);
    if (denyHerdrId(res, paneId)) return;
    const paneCheck = validatePaneId(paneId);
    if (!paneCheck.ok) return sendJSON(res, 400, { ok: false, err: paneCheck.err });
    const c = Math.round(Number(cols)), r = Math.round(Number(rows));
    if (!(c >= 40 && c <= 400) || !(r >= 10 && r <= 200)) return sendJSON(res, 400, { ok: false, err: "tamaño inválido" });
    if (denyUnlessCap(res, SHELL_DEF, "view")) return;
    const cur = await run(TMUX_BIN, ["display-message", "-p", "-t", paneId, "#{pane_width} #{pane_height} #{window_width} #{window_height}"], ROOT, 4000);
    if (!cur.ok) return sendJSON(res, 404, { ok: false, err: "ese pane ya no existe" });
    const [paneW, paneH, winW, winH] = cur.out.trim().split(" ").map(Number);
    const attached = (await run(TMUX_BIN, ["list-clients", "-t", paneId], ROOT, 4000)).out.trim();
    if (attached) return sendJSON(res, 200, { ok: true, skipped: "attached", cols: paneW, rows: paneH });
    // grow-only: a phone opening the same pane later must never shrink it back. The PANE is
    // what matters — in a split window, grow the window by the pane's shortfall first so the
    // sibling panes keep their size, then claim the new space for this pane.
    // Dos espectadores del panel en el mismo pane: sin histéresis — gana la última petición grow
    // que entre en esta rama (comportamiento aceptado para uso personal).
    const dW = Math.max(0, c - paneW), dH = Math.max(0, r - paneH);
    if (!dW && !dH) return sendJSON(res, 200, { ok: true, cols: paneW, rows: paneH });
    await ensureTmuxHooks();
    const rz = await run(TMUX_BIN, ["resize-window", "-t", paneId, "-x", String(Math.min(400, winW + dW)), "-y", String(Math.min(200, winH + dH))], ROOT, 5000);
    if (!rz.ok) return sendJSON(res, 500, { ok: false, err: rz.err || "no se pudo redimensionar" });
    await run(TMUX_BIN, ["resize-pane", "-t", paneId, "-x", String(c), "-y", String(r)], ROOT, 5000);
    logEvent(`pane-resize · ${paneId} · ${paneW}x${paneH} → ${c}x${r}`);
    return sendJSON(res, 200, { ok: true, cols: c, rows: r });
  }

  // send text to an agent's tmux pane (tmux-only, LAN-only). text is untrusted input → no shell, literal paste.
  if (path === "/api/send" && req.method === "POST") {
    const { paneId, text, enter = true } = await body(req);
    if (isHerdrId(paneId)) {
      if (typeof text !== "string" || !text.trim()) return sendJSON(res, 400, { ok: false, err: "texto vacío" });
      if (enter === false) return sendJSON(res, 400, { ok: false, err: "enviar sin Enter: " + herdrUnavailableBody().err }); // hc send siempre pulsa Enter
      if (denyUnlessCap(res, SHELL_DEF, "send")) return;
      if (!(await herdrPanes.has(paneId))) return sendJSON(res, 404, { ok: false, err: "ese pane ya no existe" });
      const hs = await herdrPanes.send(paneId, text);
      if (!hs.ok) { const f = herdrPanes.failure(hs); return sendJSON(res, f.status, f.body); }
      logEvent(`send · ${paneId} · "${text.slice(0, 80).replace(/\s+/g, " ").trim()}"`);
      return sendJSON(res, 200, { ok: true, paneId });
    }
    const paneCheck = validatePaneId(paneId);
    if (!paneCheck.ok) return sendJSON(res, 400, { ok: false, err: paneCheck.err });
    if (typeof text !== "string" || !text.trim()) return sendJSON(res, 400, { ok: false, err: "texto vacío" });
    if (text.length > 64000) return sendJSON(res, 400, { ok: false, err: "texto demasiado largo (máx 64000)" }); // long pastes (docs, diffs) are legit — tmux buffers handle them fine
    if (denyUnlessCap(res, SHELL_DEF, "send")) return;
    // confirm the pane still exists before sending
    const live = (await run(TMUX_BIN, ["list-panes", "-a", "-F", PANE_KEY_FMT], ROOT, 5000)).out.split("\n");
    if (!live.includes(paneId)) return sendJSON(res, 404, { ok: false, err: "ese pane ya no existe" });
    const r = await pasteToPane(paneId, text, enter);
    if (!r.ok) return sendJSON(res, 500, { ok: false, err: r.err });
    markPaneSeen(paneId);
    if (enter !== false) {
      markPaneTurnStarted(paneId);
      const w = paneWatch.get(paneId);
      if (w && w.source === "heuristic") { w.changedAt = Date.now(); w.waiting = false; w.ruleId = "recent_output"; }
    }
    logEvent(`send · ${paneId} · "${text.slice(0, 80).replace(/\s+/g, " ").trim()}"`);
    return sendJSON(res, 200, { ok: true, paneId });
  }

  // long-poll until a pane reaches a target state (blocked | idle | done | not-working | changed)
  if (path === "/api/wait" && req.method === "GET") {
    const params = new URL(req.url, "http://x").searchParams;
    let paneId = params.get("id") || "";
    if (!isHerdrId(paneId) && !validatePaneId(paneId).ok) {
      const rawId = req.url.match(/[?&]id=(%[0-9]+)(?:&|$)/)?.[1];
      if (rawId) paneId = rawId;
    }
    const paneCheck = isHerdrId(paneId) ? { ok: true } : validatePaneId(paneId);
    if (!paneCheck.ok) return sendJSON(res, 400, { ok: false, err: paneCheck.err });
    const condCheck = parseWaitCondition(params.get("until"));
    if (!condCheck.ok) return sendJSON(res, 400, { ok: false, err: condCheck.err });
    const timeoutCheck = parseWaitTimeout(params.get("timeout"));
    if (!timeoutCheck.ok) return sendJSON(res, 400, { ok: false, err: timeoutCheck.err });
    const baselineCheck = parseWaitBaseline(params.get("baseline"));
    if (!baselineCheck.ok) return sendJSON(res, 400, { ok: false, err: baselineCheck.err });
    if (denyUnlessCap(res, SHELL_DEF, "view")) return;
    if (isHerdrId(paneId)) {
      return await waitOnHerdr({ res, paneId, until: condCheck.until, timeoutSec: timeoutCheck.timeout, baseline: baselineCheck.baseline, sawWorkingBefore: /^(1|true)$/i.test(params.get("sawWorking") || "") });
    }
    return await waitOnPane({
      res,
      paneId,
      until: condCheck.until,
      timeoutSec: timeoutCheck.timeout,
      baseline: baselineCheck.baseline,
      sawWorkingBefore: /^(1|true)$/i.test(params.get("sawWorking") || ""),
      isPromptWait: false,
    });
  }

  // send a prompt like /api/send then wait like /api/wait (only after manifest working is seen or 10 s elapsed)
  if (path === "/api/prompt-wait" && req.method === "POST") {
    const { paneId, text, enter = true, until: rawUntil, timeout: rawTimeout, baseline: rawBaseline } = await body(req);
    const herdrTarget = isHerdrId(paneId);
    const paneCheck = herdrTarget ? { ok: true } : validatePaneId(paneId);
    if (!paneCheck.ok) return sendJSON(res, 400, { ok: false, err: paneCheck.err });
    if (typeof text !== "string" || !text.trim()) return sendJSON(res, 400, { ok: false, err: "texto vacío" });
    if (text.length > 64000) return sendJSON(res, 400, { ok: false, err: "texto demasiado largo (máx 64000)" });
    const condCheck = parseWaitCondition(rawUntil);
    if (!condCheck.ok) return sendJSON(res, 400, { ok: false, err: condCheck.err });
    const timeoutCheck = parseWaitTimeout(rawTimeout);
    if (!timeoutCheck.ok) return sendJSON(res, 400, { ok: false, err: timeoutCheck.err });
    const baselineCheck = parseWaitBaseline(rawBaseline);
    if (!baselineCheck.ok) return sendJSON(res, 400, { ok: false, err: baselineCheck.err });
    if (denyUnlessCap(res, SHELL_DEF, "send")) return;
    if (denyUnlessCap(res, SHELL_DEF, "view")) return;
    if (herdrTarget) {
      if (enter === false) return sendJSON(res, 400, { ok: false, err: "enviar sin Enter: " + herdrUnavailableBody().err });
      if (!(await herdrPanes.has(paneId))) return sendJSON(res, 404, { ok: false, err: "ese pane ya no existe" });
      const hs = await herdrPanes.send(paneId, text);
      if (!hs.ok) { const f = herdrPanes.failure(hs); return sendJSON(res, f.status, f.body); }
      const herdrSentAt = Date.now();
      logEvent(`prompt-wait · ${paneId} · "${text.slice(0, 80).replace(/\s+/g, " ").trim()}"`);
      await new Promise((ok) => setTimeout(ok, 150));
      return await waitOnHerdr({ res, paneId, until: condCheck.until, timeoutSec: timeoutCheck.timeout, baseline: baselineCheck.baseline, isPromptWait: true, sentAt: herdrSentAt });
    }
    const live = (await run(TMUX_BIN, ["list-panes", "-a", "-F", PANE_KEY_FMT], ROOT, 5000)).out.split("\n");
    if (!live.includes(paneId)) return sendJSON(res, 404, { ok: false, err: "ese pane ya no existe" });
    const r = await pasteToPane(paneId, text, enter);
    if (!r.ok) return sendJSON(res, 500, { ok: false, err: r.err });
    const sentAt = Date.now(); // the gate only trusts a manifest `working` sampled after this
    markPaneSeen(paneId);
    if (enter !== false) {
      markPaneTurnStarted(paneId);
      const w = paneWatch.get(paneId);
      if (w && w.source === "heuristic") { w.changedAt = Date.now(); w.waiting = false; w.ruleId = "recent_output"; }
    }
    logEvent(`prompt-wait · ${paneId} · "${text.slice(0, 80).replace(/\s+/g, " ").trim()}"`);
    await new Promise((ok) => setTimeout(ok, 150));
    return await waitOnPane({
      res,
      paneId,
      until: condCheck.until,
      timeoutSec: timeoutCheck.timeout,
      baseline: baselineCheck.baseline,
      isPromptWait: true,
      sentAt,
    });
  }

  // set or clear a session's free-text label (persisted in data/pane-labels.json)
  if (path === "/api/pane-label" && req.method === "POST") {
    const { paneId, name } = await body(req);
    if (denyHerdrId(res, paneId)) return;
    const paneCheck = validatePaneId(paneId);
    if (!paneCheck.ok) return sendJSON(res, 400, { ok: false, err: paneCheck.err });
    const nameCheck = sanitizePaneLabel(name);
    if (!nameCheck.ok) return sendJSON(res, 400, { ok: false, err: nameCheck.err });
    if (denyUnlessCap(res, SHELL_DEF, "send")) return;
    const rows = await detectAgents();
    let matchedRow = null;
    let matchedPane = null;
    for (const r of rows) {
      const p = (r.panes || []).find((x) => x.paneId === paneId);
      if (p) { matchedRow = r; matchedPane = p; break; }
    }
    if (!matchedRow || !matchedPane) return sendJSON(res, 404, { ok: false, err: "ese pane ya no existe" });
    const cleanName = nameCheck.name;
    const key = labelKey(matchedRow.id, matchedPane.cwd, matchedPane.label);
    const map = readLabels(PANE_LABELS_FILE);
    if (cleanName) {
      map[key] = { label: cleanName, at: new Date().toISOString() };
    } else {
      delete map[key];
    }
    writeLabels(PANE_LABELS_FILE, map);
    const updatedRows = rows.map((r) => ({
      ...r,
      panes: (r.panes || []).map((p) => {
        if (p.paneId !== paneId) return p;
        const copy = { ...p };
        if (cleanName) copy.name = cleanName;
        else delete copy.name;
        return copy;
      }),
    }));
    lastDetectRows = withScanSeq(updatedRows, scanSeqOf(rows));
    await saveCurrentSnapshot(lastDetectRows);
    const logLabel = (cleanName || "(borrado)").replace(/\s+/g, " ").trim();
    logEvent(`pane-label · ${paneId} · ${logLabel}`);
    return sendJSON(res, 200, { ok: true, key, name: cleanName });
  }

  // inspect missing sessions from data/session-snapshot.json vs live panes
  if (path === "/api/restore" && req.method === "GET") {
    const liveRows = await detectAgents();
    const liveSessionNames = await listLiveTmuxSessionNames();
    const snapshot = ledger.projected(); // read AFTER the awaits: latest ledger + pending (unpersisted) removals
    if (!snapshot) return sendJSON(res, 200, { ok: true, savedAt: null, missing: [], present: 0 });
    const { missing, present } = diffSnapshot(snapshot, liveRows, { liveSessionNames });
    const missingItems = [];
    const seenResumeTargets = new Set();
    for (const m of missing) {
      const def = AGENT_DEFS.find((a) => a.id === m.agentId);
      const agentName = def?.name || m.agentId;
      const target = await resolveLaunchCwd({ cwd: m.cwd });
      let resumable = false;
      let reason = "no-args";
      if (m.ambiguous === true) {
        reason = "ambiguous-owner";
      } else if (target.err) {
        reason = target.missingDir ? "missing-dir" : "invalid-dir";
      } else if (def) {
        const resumeKey = `${m.agentId}\0${tildify(realDir(target.cwd))}`;
        const alreadyClaimed = seenResumeTargets.has(resumeKey);
        seenResumeTargets.add(resumeKey);
        const probe = await resumeProbe(def, m.agentId, target.cwd);
        const decision = decideResume({ ...probe, alreadyOpen: probe.alreadyOpen || alreadyClaimed });
        resumable = decision.resume;
        reason = decision.reason;
      }
      missingItems.push({
        agentId: m.agentId,
        agentName,
        cwd: m.cwd,
        sessionName: m.sessionName,
        ...(m.name ? { name: m.name } : {}),
        ...(m.missingSince ? { missingSince: m.missingSince } : {}),
        ...(m.ambiguous === true ? { ambiguous: true, claimants: m.claimants || [] } : {}),
        resumable,
        reason,
      });
    }
    return sendJSON(res, 200, {
      ok: true,
      savedAt: snapshot.savedAt || null,
      missing: missingItems,
      present: present.length,
    });
  }

  // relaunch or dismiss missing sessions from data/session-snapshot.json
  if (path === "/api/restore" && req.method === "POST") {
    const { all, items, dismiss, dismissAll } = await body(req);
    if (containsHerdrId({ items, dismiss })) return sendJSON(res, 400, herdrUnavailableBody());
    if (dismissAll === true || (Array.isArray(dismiss) && dismiss.length > 0)) {
      // discovery FIRST, then one mutation against the latest ledger (a kill or launch that lands
      // while discovery runs is never overwritten by a stale copy)
      const liveRows = await detectAgents();
      const liveSessionNames = await listLiveTmuxSessionNames();
      let dismissed = 0;
      const out = await ledger.mutate("dismiss", (cur) => {
        if (!cur) return null;
        const r = dismissSnapshotSessions(
          cur,
          {
            dismiss: Array.isArray(dismiss) ? dismiss : [],
            dismissAll: Boolean(dismissAll),
            liveRows,
            liveSessionNames,
          },
          new Date().toISOString()
        );
        dismissed = r.dismissed;
        return r.snapshot;
      });
      if (!out.state) return sendJSON(res, 200, { ok: true, dismissed: 0, savedAt: null });
      if (out.reason === "error") return sendJSON(res, 500, { ok: false, err: "no se pudo escribir el registro de sesiones" });
      logEvent(`restore-dismiss · ${dismissed} descartadas`);
      return sendJSON(res, 200, { ok: true, dismissed, savedAt: out.state.savedAt || null });
    }
    if (!HAS_TMUX) return sendJSON(res, 400, { ok: false, err: "tmux no está instalado en este host" });
    const result = await triggerRestore({ all: Boolean(all), items: Array.isArray(items) ? items : [] });
    if (result.status === 409) {
      return sendJSON(res, 409, { ok: false, err: result.err });
    }
    const { status: _st, ...payload } = result;
    return sendJSON(res, 200, payload);
  }

  if (path === "/api/restore-config" && req.method === "GET") {
    return sendJSON(res, 200, { ok: true, ...readRestoreConfig() });
  }

  // dónde se abren las sesiones NUEVAS (tmux | herdr). Misma compuerta que restore-config: el token global de /api/*.
  if (path === "/api/launch-backend" && req.method === "GET") {
    return sendJSON(res, 200, { ok: true, backend: readLaunchBackend(), herdr: await herdrLauncher.status() });
  }

  if (path === "/api/launch-backend" && req.method === "POST") {
    const { backend } = await body(req);
    if (!LAUNCH_BACKENDS.includes(backend)) return sendJSON(res, 400, { ok: false, err: "backend inválido (tmux | herdr)" });
    if (backend === "herdr" && !(await herdrLauncher.status()).installed) {
      return sendJSON(res, 400, { ok: false, err: "Herdr no está instalado en este host" });
    }
    writeLaunchBackend(backend);
    logEvent(`launch-backend · ${backend}`);
    return sendJSON(res, 200, { ok: true, backend: readLaunchBackend() });
  }

  if (path === "/api/restore-config" && req.method === "POST") {
    const { auto } = await body(req);
    writeRestoreConfig(Boolean(auto));
    logEvent(`restore-config · auto=${Boolean(auto)}`);
    return sendJSON(res, 200, { ok: true, auto: Boolean(auto) });
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
    const RAW_EXT = new Set([
      ".png", ".jpg", ".jpeg", ".webp", ".gif", ".heic", ".heif",
      ".pdf", ".mp3", ".m4a", ".wav", ".ogg", ".webm", ".aac", ".flac",
    ]);
    const SIPS_BIN = "/usr/bin/sips";
    const canConvertHeic = process.platform === "darwin" && existsSync(SIPS_BIN);
    const uploadNombre = (raw) => basename(typeof raw === "string" ? raw : "").replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, 80) || "(sin nombre)";
    const rejectUpload = (status, err, rawName) => {
      logEvent(`upload-rechazado · ${uploadNombre(rawName)} · ${err}`);
      return sendJSON(res, status, { ok: false, err });
    };
    const heicToJpeg = (tmp, outJpg) => new Promise((resolve) => {
      execFile(SIPS_BIN, ["-s", "format", "jpeg", tmp, "--out", outJpg], { timeout: 30000 }, (err) => {
        resolve(!err && existsSync(outJpg));
      });
    });
    mkdirSync(UPLOADS_DIR, { recursive: true });
    // sanitized original name (for humans) + ms timestamp (uniqueness) — never trust the client's filename
    const cleanBase = (raw) => (typeof raw === "string" ? basename(raw) : "").replace(/\.[^.]*$/, "").replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 40) || "screenshot";
    // raw octet-stream branch (new clients): bytes stream straight to disk, up to UPLOAD_MAX.
    // The type allowlist is enforced by extension — same set as the base64 MIME allowlist.
    if (isRawUpload(req)) {
      const rawName = new URL(req.url, "http://x").searchParams.get("name") || "";
      const ext = extname(basename(rawName)).toLowerCase();
      const errExt = "formato no soportado (png/jpg/jpeg/heic/webp/gif/pdf/audio)";
      if (!RAW_EXT.has(ext)) return rejectUpload(400, errExt, rawName);
      const isHeic = ext === ".heic" || ext === ".heif";
      if (isHeic && !canConvertHeic) {
        return rejectUpload(415, "este host no convierte HEIC: en el iPhone pon Ajustes › Cámara › Formatos › Más compatible", rawName);
      }
      const outExt = ext === ".jpeg" || isHeic ? ".jpg" : ext;
      const file = join(UPLOADS_DIR, `${Date.now()}-${cleanBase(rawName)}${outExt}`);
      const tmp = `${file}.mt3k-tmp-${process.pid}`;
      const r = await streamUploadToFile(req, tmp);
      if (!r.ok) {
        try { unlinkSync(tmp); } catch { /* none */ }
        return rejectUpload(r.err?.includes("grande") ? 413 : 400, r.err, rawName);
      }
      if (isHeic) {
        const converted = await heicToJpeg(tmp, file);
        try { unlinkSync(tmp); } catch { /* none */ }
        if (!converted) {
          try { unlinkSync(file); } catch { /* none */ }
          return rejectUpload(415, "HEIC inválido o no convertible", rawName);
        }
        logEvent(`upload · ${basename(file)} · ${Math.round(r.size / 1024)}KB`);
        return sendJSON(res, 200, { ok: true, path: file });
      }
      renameSync(tmp, file);
      logEvent(`upload · ${basename(file)} · ${Math.round(r.size / 1024)}KB`);
      return sendJSON(res, 200, { ok: true, path: file });
    }
    // legacy base64-in-JSON branch (old federated panels) — small files only
    const { name, data } = await body(req);
    if (typeof data !== "string" || !data) return rejectUpload(400, "imagen vacía", name);
    const m = data.match(/^data:(image\/(?:png|jpeg|webp|gif)|application\/pdf|audio\/(?:mpeg|mp3|mp4|x-m4a|wav|x-wav|ogg|webm|aac|flac));base64,([A-Za-z0-9+/=]+)$/);
    if (!m) return rejectUpload(400, "formato no soportado (png/jpg/jpeg/heic/webp/gif/pdf/audio)", name);
    const buf = Buffer.from(m[2], "base64");
    if (!buf.length) return rejectUpload(400, "archivo vacío", name);
    if (buf.length > 25 * 1024 * 1024) return rejectUpload(400, "archivo demasiado grande (máx 25MB)", name);
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
    for (const p of locals) { if ((await pasteToPane(p.paneId, text, true)).ok) { sent++; markPaneTurnStarted(p.paneId); } }
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
    if (isHerdrId(paneId)) {
      if (!herdrKeyArgs(key)) return sendJSON(res, 400, { ok: false, err: "tecla no permitida" });
      if (denyUnlessCap(res, SHELL_DEF, "keys")) return;
      if (!(await herdrPanes.has(paneId))) return sendJSON(res, 404, { ok: false, err: "ese pane ya no existe" });
      const hk = await herdrPanes.keys(paneId, key);
      if (!hk.ok) { const f = herdrPanes.failure(hk); return sendJSON(res, f.status, f.body); }
      logEvent(`key · ${paneId} · ${key}`);
      return sendJSON(res, 200, { ok: true, paneId, key });
    }
    const paneCheck = validatePaneId(paneId);
    if (!paneCheck.ok) return sendJSON(res, 400, { ok: false, err: paneCheck.err });
    const args = keyArgs(key);
    if (!args) return sendJSON(res, 400, { ok: false, err: "tecla no permitida" });
    if (denyUnlessCap(res, SHELL_DEF, "keys")) return;
    const live = (await run(TMUX_BIN, ["list-panes", "-a", "-F", PANE_KEY_FMT], ROOT, 5000)).out.split("\n");
    if (!live.includes(paneId)) return sendJSON(res, 404, { ok: false, err: "ese pane ya no existe" });
    const r = await run(TMUX_BIN, ["send-keys", "-t", paneId, ...args], ROOT, 5000);
    if (!r.ok) return sendJSON(res, 500, { ok: false, err: r.err || "send-keys falló" });
    markPaneSeen(paneId);
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
    const payload = await body(req);
    const launched = await launchLocalSession(payload, { allowHerdr: true });
    const { status, ...rest } = launched;
    return sendJSON(res, status || (launched.ok ? 200 : 400), rest);
  }

  // kill an agent's tmux pane (its dedicated session dies with its last pane)
  if (path === "/api/kill" && req.method === "POST") {
    const { paneId, force } = await body(req);
    if (isHerdrId(paneId)) {
      // los del panel (etiqueta mt3k.panel=1, releída al cerrar) se cierran; los ajenos solo con force === true
      const hc = herdrPanes.hc();
      if (!hc) return sendJSON(res, 400, herdrUnavailableBody());
      const closed = await hc.killTerminal(paneId, { force: force === true });
      herdrPanes.invalidate();
      if (!closed.ok) return sendJSON(res, closed.status, { ok: false, err: closed.err, ...(closed.needsConfirm ? { needsConfirm: true } : {}) });
      logEvent(`kill · ${paneId} · herdr${closed.forced ? " · forzado" : ""}`);
      return sendJSON(res, 200, { ok: true, paneId, ledger: "no-aplica" });
    }
    const paneCheck = validatePaneId(paneId);
    if (!paneCheck.ok) return sendJSON(res, 400, { ok: false, err: paneCheck.err });
    if (denyUnlessCap(res, SHELL_DEF, "kill")) return;
    const panesOut = (await run(TMUX_BIN, ["list-panes", "-a", "-F", `${PANE_KEY_FMT}|#{pane_pid}|#{session_name}`], ROOT, 5000)).out;
    let targetSessionName = "";
    let foundPane = false;
    const paneSessions = [];
    for (const line of panesOut.split("\n")) {
      if (!line) continue;
      const [id, pidStr = "", ...rest] = line.split("|");
      const sName = rest.length ? sessionNameOf(rest.join("|")) : "";
      paneSessions.push({ id, sName, pid: Number(pidStr) || null });
      if (id === paneId) {
        foundPane = true;
        targetSessionName = sName;
      }
    }
    if (!foundPane) return sendJSON(res, 404, { ok: false, err: "ese pane ya no existe" });
    const r = await run(TMUX_BIN, ["kill-pane", "-t", paneId], ROOT, 5000);
    if (!r.ok) return sendJSON(res, 500, { ok: false, err: r.err || "kill-pane falló" });
    // surviving sibling panes keep the session alive: no tombstone, no ledger removal for it
    const siblings = targetSessionName
      ? paneSessions.filter((p) => p.sName === targetSessionName && p.id !== paneId)
      : [];
    const sessionDied = Boolean(targetSessionName) && siblings.length === 0;
    let ledgerState = "ok"; // what happened to the ledger removal (ok | pendiente | <error reason>)
    // in-memory rows without the pane, tombstone, one ledger mutation — no detect awaited
    const rowsNow = withScanSeq(
      lastDetectRows.map((row) => ({
        ...row,
        panes: (row.panes || []).filter((p) => p.paneId !== paneId),
      })),
      scanSeqOf(lastDetectRows)
    );
    lastDetectRows = rowsNow;
    lastDiscoveredPaneIds = new Set([...lastDiscoveredPaneIds].filter((id) => id !== paneId));
    if (sessionDied) {
      // every discovery that started up to now is older than this kill (killedAtSeq)
      const killedAtSeq = discoverySeqCounter;
      const killedPid = paneSessions.find((p) => p.id === paneId)?.pid;
      markSessionKilled(targetSessionName, [paneId], {
        killedAtSeq,
        panePids: killedPid ? { [paneId]: killedPid } : {},
      });
      lastDiscoveredSessionNames = new Set([...lastDiscoveredSessionNames].filter((n) => n !== targetSessionName));
      // only removes the killed entry from the LATEST ledger (no rebuild from the older in-memory scan)
      const persisted = await ledger.mutate(
        "kill",
        (cur) => (cur ? removeSnapshotSession(cur, targetSessionName, new Date().toISOString()) : null),
        { killSeq: killedAtSeq, retry: true }
      );
      // the pane is dead either way; a failed disk write is reported, kept as a pending intent
      // (re-applied on the next ledger write) and never read as "session still restorable"
      ledgerState = persisted.applied || persisted.reason === "unchanged" ? "ok" : persisted.queued ? "pendiente" : persisted.reason;
      if (ledgerState !== "ok") logEvent(`kill · ${paneId} · ledger ${ledgerState}`);
    }
    logEvent(`kill · ${paneId}`);
    sendJSON(res, 200, { ok: true, paneId, ledger: ledgerState });
    // background reconcile: a detect started before kill-pane would still list the pane, so wait it
    // out and save from a fresh one (the tombstone filters a stale echo either way)
    (async () => {
      if (detectAgentsInFlight) await detectAgentsInFlight.catch(() => {});
      await saveCurrentSnapshot(await detectAgents().catch(() => null));
    })().catch(() => {});
    return;
  }

  // live pane stream (SSE): pushes the rendered screen only when it changes — smoother than polling
  if (path === "/api/pane-stream") {
    const params = new URL(req.url, "http://x").searchParams;
    const paneId = params.get("id") || "";
    const tickMs = clampTick(params.get("tick"));
    // Opt-in diffs preserve full strings for old bundles and mixed-version federation.
    const lineDiffs = params.get("fmt") === "lines";
    if (isHerdrId(paneId)) {
      if (denyUnlessCap(res, SHELL_DEF, "view")) return;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "access-control-allow-origin": "*" });
      const hStream = herdrPanes.startStream({ id: paneId, tickMs: tickMs, lineDiffs, write: (c) => { if (!res.writableEnded) res.write(c); }, end: () => { try { res.end(); } catch { /* gone */ } } });
      req.on("close", hStream.stop);
      return;
    }
    const paneCheck = validatePaneId(paneId);
    if (!paneCheck.ok) return sendJSON(res, 400, { ok: false, err: paneCheck.err });
    if (denyUnlessCap(res, SHELL_DEF, "view")) return;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "access-control-allow-origin": "*" });
    markPaneSeen(paneId);
    let last = null, lastAlt = null, lastMouseSgr = null, idleTicks = 0, closed = false, busy = false;
    const tick = async () => {
      // Diffs are relative to `last`: a slow capture-pane must never overlap the next tick,
      // or an out-of-order frame would corrupt the client's line buffer until it reloads.
      if (closed || busy) return;
      busy = true;
      try {
        const r = await run(TMUX_BIN, ["capture-pane", "-t", paneId, "-p", "-e", "-N", "-S", "-1000"], ROOT, 5000);
        if (closed) return;
        if (!r.ok) { res.write(`event: gone\ndata: {}\n\n`); return end(); }
        markPaneSeen(paneId);
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
            (await run(TMUX_BIN, ["display-message", "-p", "-t", paneId, TMUX_ALT_MOUSE_DISPLAY], ROOT, 4000)).out,
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
    const iv = setInterval(tick, tickMs);
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

  // read-only branch list of the repo containing ?cwd= (terminal branch links). Same gate as /api/fs/list:
  // this sits behind the /api/* authorized() check and ?host= proxying in createServer; git runs via
  // execFile with a fixed argv (scripts/lib/git-refs.mjs), never the network.
  if (path === "/api/git/refs") {
    const r = await gitRefs(new URL(req.url, "http://x").searchParams.get("cwd") || "");
    return sendJSON(res, r.ok ? 200 : r.err === "cwd inválido" ? 400 : 500, r);
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
  const baseUrl = h.url.replace(/\/$/, "");
  const authHeaders = h.token ? { authorization: `Bearer ${h.token}` } : {};

  // Chunked proxy for /api/wait and /api/prompt-wait so waits > 300 s never hit undici's headersTimeout
  if (path === "/api/wait" && req.method === "GET") {
    const timeoutCheck = parseWaitTimeout(u.searchParams.get("timeout"));
    if (timeoutCheck.ok) {
      const clientAbort = new AbortController();
      const onClose = () => clientAbort.abort();
      res.on("close", onClose);
      try {
        const result = await runChunkedWait({
          totalSeconds: timeoutCheck.timeout,
          initialBaseline: u.searchParams.get("baseline") || null,
          isAborted: () => res.writableEnded || res.destroyed,
          requestChunk: async ({ chunkSec, baseline, sawWorking }) => {
            const params = new URLSearchParams(u.searchParams);
            params.set("timeout", String(chunkSec));
            if (baseline) params.set("baseline", baseline);
            if (sawWorking) params.set("sawWorking", "1");
            const r = await fetch(`${baseUrl}/api/wait?${params.toString()}`, {
              headers: authHeaders,
              signal: AbortSignal.any([AbortSignal.timeout((chunkSec + 15) * 1000), clientAbort.signal]),
            });
            const data = await r.json().catch(() => ({ ok: false, err: `HTTP ${r.status}` }));
            return { ok: r.ok, status: r.status, data };
          },
        });
        if (result?.aborted || res.writableEnded || res.destroyed) return;
        const out = result?.data ?? { ok: false, err: `${hostId} no responde` };
        if (out && typeof out === "object" && "baseline" in out && !u.searchParams.get("baseline")) {
          delete out.baseline;
        }
        return sendJSON(res, result?.status || 200, out);
      } catch {
        if (res.writableEnded || res.destroyed) return;
        return sendJSON(res, 502, { ok: false, err: `${hostId} no responde` });
      } finally {
        res.removeListener("close", onClose);
      }
    }
  }

  if (path === "/api/prompt-wait" && req.method === "POST") {
    const reqBuf = await rawBody(req);
    let parsedBody = null;
    try { parsedBody = JSON.parse(reqBuf.toString("utf8") || "{}"); } catch { parsedBody = null; }
    const timeoutCheck = parseWaitTimeout(parsedBody?.timeout);
    if (parsedBody && timeoutCheck.ok) {
      const clientAbort = new AbortController();
      const onClose = () => clientAbort.abort();
      res.on("close", onClose);
      try {
        const result = await runChunkedWait({
          totalSeconds: timeoutCheck.timeout,
          initialBaseline: parsedBody.baseline || null,
          isAborted: () => res.writableEnded || res.destroyed,
          requestChunk: async ({ chunkSec, isFirst, baseline, sawWorking }) => {
            if (isFirst) {
              const r = await fetch(`${baseUrl}/api/prompt-wait`, {
                method: "POST",
                headers: { "content-type": "application/json", ...authHeaders },
                body: JSON.stringify({ ...parsedBody, timeout: chunkSec }),
                signal: AbortSignal.any([AbortSignal.timeout((chunkSec + 15) * 1000), clientAbort.signal]),
              });
              const data = await r.json().catch(() => ({ ok: false, err: `HTTP ${r.status}` }));
              return { ok: r.ok, status: r.status, data };
            }
            const params = new URLSearchParams({
              id: String(parsedBody.paneId || ""),
              until: String(parsedBody.until || "not-working"),
              timeout: String(chunkSec),
            });
            if (baseline) params.set("baseline", baseline);
            if (sawWorking) params.set("sawWorking", "1");
            const r = await fetch(`${baseUrl}/api/wait?${params.toString()}`, {
              headers: authHeaders,
              signal: AbortSignal.any([AbortSignal.timeout((chunkSec + 15) * 1000), clientAbort.signal]),
            });
            const data = await r.json().catch(() => ({ ok: false, err: `HTTP ${r.status}` }));
            return { ok: r.ok, status: r.status, data };
          },
        });
        if (result?.aborted || res.writableEnded || res.destroyed) return;
        const out = result?.data ?? { ok: false, err: `${hostId} no responde` };
        if (out && typeof out === "object" && "baseline" in out) {
          delete out.baseline;
        }
        return sendJSON(res, result?.status || 200, out);
      } catch {
        if (res.writableEnded || res.destroyed) return;
        return sendJSON(res, 502, { ok: false, err: `${hostId} no responde` });
      } finally {
        res.removeListener("close", onClose);
      }
    }
    const target = `${baseUrl}${path}${u.searchParams.size ? `?${u.searchParams}` : ""}`;
    try {
      const r = await fetch(target, {
        method: "POST",
        signal: AbortSignal.timeout(120000),
        headers: { "content-type": req.headers["content-type"] || "application/json", ...authHeaders },
        body: reqBuf,
      });
      const bytes = Buffer.from(await r.arrayBuffer());
      res.writeHead(r.status, { "content-type": r.headers.get("content-type") || "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", "access-control-allow-origin": "*" });
      return res.end(bytes);
    } catch {
      return sendJSON(res, 502, { ok: false, err: `${hostId} no responde` });
    }
  }

  const target = `${baseUrl}${path}${u.searchParams.size ? `?${u.searchParams}` : ""}`;
  // uploads can be 500MB over Wi-Fi — give them 10 min instead of the usual 2
  const isLongUpload = path === "/api/upload" || path === "/api/fs/upload";
  const init = {
    method: req.method,
    signal: req.method === "GET" && path === "/api/pane-stream" ? undefined : AbortSignal.timeout(isLongUpload ? 615000 : 120000),
    headers: { "content-type": req.headers["content-type"] || "application/json", ...authHeaders },
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
  // ship the whole scripts/lib dir AND scripts/agent-detection: a module server.mjs imports but the
  // bundle lacks crashes every host on restart (2026-11-07: vendor.mjs imported from lib took the fleet down)
  // COPYFILE_DISABLE keeps macOS from adding AppleDouble ._* entries that then litter other hosts
  const r = spawnSync("tar", ["czf", "-", "--exclude", "panel/dist/data", "scripts/server.mjs", "scripts/lib", "scripts/agent-detection", "panel/dist"], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, COPYFILE_DISABLE: "1" } });
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
    srv.on("error", () => {});
    srv.listen(def.webProxy, () => console.log(`  ${def.name} web UI proxied → ${tls ? "https" : "http"}://:${def.webProxy} → 127.0.0.1:${def.web}`));
  }
})();
