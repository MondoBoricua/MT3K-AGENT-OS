#!/usr/bin/env node
/**
 * server.mjs — the OS backend. Zero dependencies (Node built-ins only).
 *
 * Serves the built panel (panel/dist) AND a small API the dashboard calls live:
 *   POST /api/query    { projectId, q }  → runs `graphify query` in that repo (traversal, $0)
 *   POST /api/refresh  { projectId }      → `graphify update` + re-ingest, appends an activity log
 *   POST /api/send     { paneId, text, enter? } → types text into an agent's tmux pane (LAN-only)
 *   GET  /api/agents                      → installed agent CLIs + their live tmux panes (auto-discovered)
 *   GET  /api/logs                        → data/logs/*.md (Memory / Activity pages)
 *   GET  /api/skills                      → reads ~/.agents/skills SKILL.md frontmatter (Skills page)
 *   GET  /api/manifest                    → current panel manifest
 *
 * Run:  node scripts/server.mjs        (serves dist + api on :4288)
 * Dev:  pnpm dev  (vite :5273 proxies /api → :4288)  +  node scripts/server.mjs
 */
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, appendFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, networkInterfaces } from "node:os";
import { spawn } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "panel", "dist");
const LOGS = join(ROOT, "data", "logs");
const SKILLS_DIR = join(homedir(), ".agents", "skills");
const GRAPHIFY = [join(homedir(), ".local/bin/graphify"), "graphify"].find((p) => p === "graphify" || existsSync(p));
const PORT = 4288;
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

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

function sendJSON(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(obj));
}
function body(req) {
  return new Promise((resolve) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => { try { resolve(JSON.parse(d || "{}")); } catch { resolve({}); } }); });
}
function run(cmd, args, cwd, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const ch = spawn(cmd, args, { cwd, env: { ...process.env, PATH: `${join(homedir(), ".local/bin")}:${process.env.PATH}` } });
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
  appendFileSync(join(LOGS, `${day}.md`), `- ${new Date().toISOString().slice(11, 19)} — ${line}\n`);
}

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
const PATH_DIRS = [join(homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", ...(process.env.PATH || "").split(":")];
const onPath = (bin) => PATH_DIRS.some((d) => d && existsSync(join(d, bin)));
// `proc` = exact process basenames (case-sensitive) that mean this agent is actively running.
// CLI binaries are lowercase (claude/codex/…); same-named GUI apps are Capitalized → not matched.
const AGENT_DEFS = [
  { id: "claude", name: "Claude Code", bins: ["claude"], paths: ["~/.claude"], proc: ["claude"] },
  { id: "codex", name: "Codex", bins: ["codex"], paths: ["~/.codex"], proc: ["codex"] },
  { id: "opencode", name: "OpenCode", bins: ["opencode"], paths: ["~/.config/opencode", "~/.opencode"], proc: ["opencode"] },
  { id: "gemini", name: "Gemini CLI", bins: ["gemini"], paths: ["~/.gemini"], proc: ["gemini"] },
  { id: "grok", name: "Grok CLI", bins: ["grok"], paths: ["~/.grok"], proc: ["grok"] },
  { id: "antigravity", name: "Antigravity", bins: ["agy", "antigravity"], paths: ["~/.antigravity", "/Applications/Antigravity.app"], proc: ["agy", "antigravity"] },
  // Cursor's agentic CLI (`cursor-agent`), not the `cursor` GUI launcher → real TUI, launchable in tmux
  { id: "cursor", name: "Cursor", bins: ["cursor-agent"], paths: ["~/.cursor"], proc: ["cursor-agent"] },
];
const base = (c) => (c || "").split("/").pop();
const tildify = (p) => (p && p.startsWith(homedir()) ? "~" + p.slice(homedir().length) : p);
// absolute path of a binary from our search dirs (so tmux launches it regardless of the server env's PATH)
const absBin = (name) => { for (const d of PATH_DIRS) { if (d && existsSync(join(d, name))) return join(d, name); } return null; };

// one ps snapshot → process tree (pid → ppid → comm). Used for both "is running" and pane discovery.
async function procTree() {
  const out = (await run("ps", ["-axo", "pid=,ppid=,comm="], ROOT, 5000)).out;
  const byPid = new Map(), childrenOf = new Map(), running = new Set();
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    const pid = +m[1], ppid = +m[2], comm = m[3];
    byPid.set(pid, comm);
    if (!childrenOf.has(ppid)) childrenOf.set(ppid, []);
    childrenOf.get(ppid).push(pid);
    if (!comm.includes(".app/")) running.add(base(comm)); // skip GUI-app internals (e.g. Codex.app/Resources/codex)
  }
  // collect basenames of all descendant processes of a pid (the real agent often lives under the kitty/tmux wrapper)
  const descendants = (pid) => {
    const out = new Set(), stack = [...(childrenOf.get(pid) || [])];
    let guard = 0;
    while (stack.length && guard++ < 500) {
      const p = stack.pop();
      if (byPid.has(p)) out.add(base(byPid.get(p)));
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
  const { running, descendants } = await procTree();
  const panes = await discoverPanes(descendants);
  return AGENT_DEFS.map((a) => {
    const installed = a.bins.some(onPath) || a.paths.some((p) => existsSync(expand(p)));
    const proc = a.proc || [];
    const isRunning = installed && proc.some((name) => running.has(name));
    // every pane whose process tree contains this agent's binary — supports multiple sessions of the same CLI
    const agentPanes = proc.length
      ? panes.filter((pn) => pn.comms.some((c) => proc.includes(c)))
          .map((pn) => ({ paneId: pn.paneId, label: pn.label, window: pn.window, cwd: pn.cwd }))
      : [];
    // launchable = a real TUI CLI we can spawn inside tmux (GUI-only apps have empty `proc`)
    return { id: a.id, name: a.name, online: installed, running: isRunning, launchable: installed && proc.length > 0, panes: agentPanes };
  });
}

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
async function api(req, res, path) {
  if (path === "/api/manifest") {
    const src = join(ROOT, "panel", "public", "data", "manifest.json");
    return sendJSON(res, 200, existsSync(src) ? readJSON(src) : { projects: [] });
  }
  if (path === "/api/skills") return sendJSON(res, 200, { skills: readSkills() });
  if (path === "/api/logs") return sendJSON(res, 200, { logs: readLogs() });
  if (path === "/api/agents") return sendJSON(res, 200, { agents: await detectAgents() });
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
      agents: await detectAgents(),
      uptimeMs: Date.now() - START,
      graphify: await graphifyVersion(),
      skills: readSkills().length,
      projects: projects().length,
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
    if (!/^%\d+$/.test(paneId)) return sendJSON(res, 400, { ok: false, err: "paneId inválido" });
    const live = (await run("tmux", ["list-panes", "-a", "-F", "#{pane_id}"], ROOT, 5000)).out.split("\n");
    if (!live.includes(paneId)) return sendJSON(res, 404, { ok: false, err: "ese pane ya no existe" });
    // -e keeps colors, -p prints to stdout, -S -200 includes a little scrollback (keep on-screen line breaks → less reflow)
    const r = await run("tmux", ["capture-pane", "-t", paneId, "-p", "-e", "-S", "-200"], ROOT, 5000);
    return sendJSON(res, 200, { ok: r.ok, content: r.out });
  }

  // send text to an agent's tmux pane (tmux-only, LAN-only). text is untrusted input → no shell, literal paste.
  if (path === "/api/send" && req.method === "POST") {
    const { paneId, text, enter = true } = await body(req);
    if (typeof paneId !== "string" || !/^%\d+$/.test(paneId)) return sendJSON(res, 400, { ok: false, err: "paneId inválido" });
    if (typeof text !== "string" || !text.trim()) return sendJSON(res, 400, { ok: false, err: "texto vacío" });
    if (text.length > 4000) return sendJSON(res, 400, { ok: false, err: "texto demasiado largo (máx 4000)" });
    // confirm the pane still exists before sending
    const live = (await run("tmux", ["list-panes", "-a", "-F", "#{pane_id}"], ROOT, 5000)).out.split("\n");
    if (!live.includes(paneId)) return sendJSON(res, 404, { ok: false, err: "ese pane ya no existe" });
    // set-buffer/paste-buffer handles arbitrary text safely (leading dashes, spaces, newlines) — no key interpretation
    const buf = "mt3k_send";
    const set = await run("tmux", ["set-buffer", "-b", buf, "--", text], ROOT, 5000);
    if (!set.ok) return sendJSON(res, 500, { ok: false, err: set.err || "set-buffer falló" });
    const paste = await run("tmux", ["paste-buffer", "-d", "-p", "-b", buf, "-t", paneId], ROOT, 5000);
    if (!paste.ok) return sendJSON(res, 500, { ok: false, err: paste.err || "paste-buffer falló" });
    if (enter) await run("tmux", ["send-keys", "-t", paneId, "Enter"], ROOT, 5000);
    logEvent(`send · ${paneId} · "${text.slice(0, 80).replace(/\s+/g, " ").trim()}"`);
    return sendJSON(res, 200, { ok: true, paneId });
  }

  // send a single named key to a tmux pane (arrow-key nav in TUI menus: Codex/Claude pickers, etc.)
  // allowlisted to tmux key names only → never raw shell, never arbitrary keystrokes
  if (path === "/api/key" && req.method === "POST") {
    const { paneId, key } = await body(req);
    const ALLOWED = new Set(["Up", "Down", "Left", "Right", "Enter", "Escape", "Tab", "Space", "BSpace", "PageUp", "PageDown", "Home", "End"]);
    if (typeof paneId !== "string" || !/^%\d+$/.test(paneId)) return sendJSON(res, 400, { ok: false, err: "paneId inválido" });
    if (typeof key !== "string" || !ALLOWED.has(key)) return sendJSON(res, 400, { ok: false, err: "tecla no permitida" });
    const live = (await run("tmux", ["list-panes", "-a", "-F", "#{pane_id}"], ROOT, 5000)).out.split("\n");
    if (!live.includes(paneId)) return sendJSON(res, 404, { ok: false, err: "ese pane ya no existe" });
    const r = await run("tmux", ["send-keys", "-t", paneId, key], ROOT, 5000);
    if (!r.ok) return sendJSON(res, 500, { ok: false, err: r.err || "send-keys falló" });
    logEvent(`key · ${paneId} · ${key}`);
    return sendJSON(res, 200, { ok: true, paneId, key });
  }

  // launch an agent CLI in a fresh detached tmux session (LAN-only). The binary comes from
  // AGENT_DEFS (allowlist) — never from the client; cwd is a tracked project or a real dir.
  if (path === "/api/launch" && req.method === "POST") {
    const { agentId, projectId, cwd: cwdIn, create } = await body(req);
    const def = AGENT_DEFS.find((a) => a.id === agentId);
    if (!def || !(def.proc && def.proc.length)) return sendJSON(res, 400, { ok: false, err: "agente no lanzable" });
    const bin = def.bins.map(absBin).find(Boolean);
    if (!bin) return sendJSON(res, 400, { ok: false, err: `${def.name} no está instalado` });
    // resolve working directory: a tracked project wins; else a free-form path (defaults to home)
    let cwd = homedir();
    if (projectId) {
      const pp = projectPath(projectId);
      if (!pp) return sendJSON(res, 400, { ok: false, err: "proyecto desconocido" });
      cwd = pp;
    } else if (typeof cwdIn === "string" && cwdIn.trim()) {
      cwd = expand(cwdIn.trim());
    }
    // create the folder on request (mkdir -p) — else report it's missing so the UI can offer to create it
    if (!existsSync(cwd)) {
      if (!create) return sendJSON(res, 400, { ok: false, err: "esa carpeta no existe", missingDir: true });
      try { mkdirSync(cwd, { recursive: true }); } catch { return sendJSON(res, 500, { ok: false, err: "no se pudo crear la carpeta" }); }
    } else if (!statSync(cwd).isDirectory()) {
      return sendJSON(res, 400, { ok: false, err: "esa ruta no es una carpeta" });
    }
    const session = `mt3k-${agentId}-${Date.now().toString(36).slice(-5)}`;
    // optional host-local launch flags (data/launch.json, gitignored) — shell aliases don't apply
    // here because we spawn the raw binary, so per-host env/args live in data instead:
    //   { "claude": { "env": { "IS_SANDBOX": "1" }, "args": ["--dangerously-skip-permissions"] } }
    let cmd = [bin];
    try {
      const lc = readJSON(join(ROOT, "data", "launch.json"))[agentId];
      if (lc) {
        const envPairs = Object.entries(lc.env || {}).filter(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === "string").map(([k, v]) => `${k}=${v}`);
        const args = (Array.isArray(lc.args) ? lc.args : []).filter((a) => typeof a === "string");
        if (envPairs.length) cmd = ["/usr/bin/env", ...envPairs, bin, ...args];
        else cmd = [bin, ...args];
      }
    } catch { /* no launch.json → plain binary */ }
    // -d detached · -P -F prints the new pane id + label · -c cwd · then the agent binary (no shell)
    const r = await run("tmux", ["new-session", "-d", "-P", "-F", "#{pane_id}|#{session_name}:#{window_index}.#{pane_index}", "-s", session, "-c", cwd, ...cmd], ROOT, 8000);
    if (!r.ok) return sendJSON(res, 500, { ok: false, err: r.err || "tmux new-session falló (¿tmux instalado?)" });
    const [paneId, label] = (r.out || "").split("|");
    logEvent(`launch · ${agentId} · ${session} · ${tildify(cwd)}`);
    return sendJSON(res, 200, { ok: true, paneId, label: label || session, session, cwd: tildify(cwd) });
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
  return sendJSON(res, 404, { ok: false, err: "no route" });
}

function serveStatic(res, path) {
  // /data/* is served live from public/data (rebuilt by build-data.mjs on every add/refresh)
  if (path.startsWith("/data/")) {
    const live = join(ROOT, "panel", "public", "data", path.slice(6));
    if (existsSync(live)) {
      res.writeHead(200, { "content-type": MIME[extname(live)] || "application/octet-stream" });
      return res.end(readFileSync(live));
    }
  }
  let file = join(DIST, path === "/" ? "index.html" : path.replace(/^\//, ""));
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(DIST, "index.html"); // SPA fallback
  if (!existsSync(file)) { res.writeHead(404); return res.end("build the panel first: pnpm build"); }
  res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
  res.end(readFileSync(file));
}

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (req.method === "OPTIONS") { res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST,OPTIONS" }); return res.end(); }
  try {
    if (path.startsWith("/api/")) return await api(req, res, path);
    return serveStatic(res, path);
  } catch (e) {
    sendJSON(res, 500, { ok: false, err: String(e) });
  }
}).listen(PORT, () => console.log(`MT3K Agent OS server → http://localhost:${PORT}`));
