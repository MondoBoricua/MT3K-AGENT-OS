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
  // local wall-clock time (the HUD feed shows these lines) — the filename stays UTC-dated
  appendFileSync(join(LOGS, `${day}.md`), `- ${new Date().toTimeString().slice(0, 8)} — ${line}\n`);
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
  // basenames of a pid's process AND all its descendants (the agent may BE the pane's root process
  // — tmux runs the binary directly on launch — or live under a kitty/shell wrapper)
  const descendants = (pid) => {
    const out = new Set(), stack = [pid, ...(childrenOf.get(pid) || [])];
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
  const rows = AGENT_DEFS.map((a) => {
    const installed = a.bins.some(onPath) || a.paths.some((p) => existsSync(expand(p)));
    const proc = a.proc || [];
    const isRunning = installed && proc.some((name) => running.has(name));
    // every pane whose process tree contains this agent's binary — supports multiple sessions of the same CLI.
    // prefix match covers vendor/arch names ("codex-aarch64-…") that tmux/ps report for the same CLI.
    const agentPanes = proc.length
      ? panes.filter((pn) => pn.comms.some((c) => proc.includes(c) || proc.some((p) => c.startsWith(p + "-"))))
          .map((pn) => ({ paneId: pn.paneId, label: pn.label, window: pn.window, cwd: pn.cwd }))
      : [];
    // launchable = a real TUI CLI we can spawn inside tmux (GUI-only apps have empty `proc`)
    return { id: a.id, name: a.name, online: installed, running: isRunning, launchable: installed && proc.length > 0, panes: agentPanes };
  });
  await updateWaiting(rows.flatMap((r) => r.panes.map((p) => ({ ...p, agentName: r.name }))));
  for (const r of rows) {
    for (const p of r.panes) p.waiting = paneWatch.get(p.paneId)?.waiting ?? false;
    r.waiting = r.panes.some((p) => p.waiting);
  }
  return rows;
}

// paste text into a pane via set-buffer/paste-buffer — safe for arbitrary text (no key interpretation)
async function pasteToPane(paneId, text, enter) {
  const buf = "mt3k_send";
  const set = await run("tmux", ["set-buffer", "-b", buf, "--", text], ROOT, 5000);
  if (!set.ok) return { ok: false, err: set.err || "set-buffer falló" };
  const paste = await run("tmux", ["paste-buffer", "-d", "-p", "-b", buf, "-t", paneId], ROOT, 5000);
  if (!paste.ok) return { ok: false, err: paste.err || "paste-buffer falló" };
  if (enter) await run("tmux", ["send-keys", "-t", paneId, "Enter"], ROOT, 5000);
  return { ok: true };
}

// --- federation: hosts this panel aggregates (data/hosts.json, host-local, NEVER automatic) ---
function readHosts() {
  try { return (readJSON(join(ROOT, "data", "hosts.json")).hosts || []).filter((h) => h.id && h.url); } catch { return []; }
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
    const r = await pasteToPane(paneId, text, enter);
    if (!r.ok) return sendJSON(res, 500, { ok: false, err: r.err });
    logEvent(`send · ${paneId} · "${text.slice(0, 80).replace(/\s+/g, " ").trim()}"`);
    return sendJSON(res, 200, { ok: true, paneId });
  }

  // one message → every live agent pane on this host (and, unless flat=1, on federated hosts too)
  if (path === "/api/broadcast" && req.method === "POST") {
    const { text } = await body(req);
    if (typeof text !== "string" || !text.trim()) return sendJSON(res, 400, { ok: false, err: "texto vacío" });
    if (text.length > 4000) return sendJSON(res, 400, { ok: false, err: "texto demasiado largo (máx 4000)" });
    const locals = (await detectAgents()).flatMap((a) => a.panes);
    let sent = 0;
    for (const p of locals) { if ((await pasteToPane(p.paneId, text, true)).ok) sent++; }
    const flat = new URL(req.url, "http://x").searchParams.get("flat");
    if (!flat) {
      for (const h of readHosts()) {
        try {
          const r = await fetch(`${h.url.replace(/\/$/, "")}/api/broadcast?flat=1`, {
            method: "POST", signal: AbortSignal.timeout(5000),
            headers: { "content-type": "application/json", ...(h.token ? { authorization: `Bearer ${h.token}` } : {}) },
            body: JSON.stringify({ text }),
          });
          if (r.ok) sent += (await r.json()).sent || 0;
        } catch { /* host down → skip */ }
      }
    }
    logEvent(`broadcast · ${sent} panes · "${text.slice(0, 60).replace(/\s+/g, " ").trim()}"`);
    return sendJSON(res, 200, { ok: true, sent });
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
    const { agentId, projectId, cwd: cwdIn, create, firstPrompt } = await body(req);
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
    // readable session name: mt3k-claude-onvacation-x4f (target dir + short suffix for uniqueness)
    const dirSlug = (basename(cwd) || "home").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 20) || "home";
    const session = `mt3k-${agentId}-${dirSlug}-${Date.now().toString(36).slice(-3)}`;
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
    // optional first message: wait for the CLI to boot (screen settles), then paste + enter.
    // fire-and-forget — the client already has its pane and is watching it live.
    if (typeof firstPrompt === "string" && firstPrompt.trim() && firstPrompt.length <= 4000) {
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
    logEvent(`launch · ${agentId} · ${session} · ${tildify(cwd)}`);
    return sendJSON(res, 200, { ok: true, paneId, label: label || session, session, cwd: tildify(cwd) });
  }

  // kill an agent's tmux pane (its dedicated session dies with its last pane)
  if (path === "/api/kill" && req.method === "POST") {
    const { paneId } = await body(req);
    if (typeof paneId !== "string" || !/^%\d+$/.test(paneId)) return sendJSON(res, 400, { ok: false, err: "paneId inválido" });
    const live = (await run("tmux", ["list-panes", "-a", "-F", "#{pane_id}"], ROOT, 5000)).out.split("\n");
    if (!live.includes(paneId)) return sendJSON(res, 404, { ok: false, err: "ese pane ya no existe" });
    const r = await run("tmux", ["kill-pane", "-t", paneId], ROOT, 5000);
    if (!r.ok) return sendJSON(res, 500, { ok: false, err: r.err || "kill-pane falló" });
    logEvent(`kill · ${paneId}`);
    return sendJSON(res, 200, { ok: true, paneId });
  }

  // live pane stream (SSE): pushes the rendered screen only when it changes — smoother than polling
  if (path === "/api/pane-stream") {
    const paneId = new URL(req.url, "http://x").searchParams.get("id") || "";
    if (!/^%\d+$/.test(paneId)) return sendJSON(res, 400, { ok: false, err: "paneId inválido" });
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "access-control-allow-origin": "*" });
    let last = null, closed = false;
    const tick = async () => {
      if (closed) return;
      const r = await run("tmux", ["capture-pane", "-t", paneId, "-p", "-e", "-S", "-200"], ROOT, 5000);
      if (!r.ok) { res.write(`event: gone\ndata: {}\n\n`); return end(); }
      if (r.out !== last) { last = r.out; res.write(`data: ${JSON.stringify(r.out)}\n\n`); }
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
  return sendJSON(res, 404, { ok: false, err: "no route" });
}

// forward one request to a federated host (data/hosts.json). Streams SSE bodies through.
function rawBody(req) {
  return new Promise((resolve) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => resolve(d)); });
}
async function proxyToHost(req, res, path, hostId) {
  const h = readHosts().find((x) => x.id === hostId);
  if (!h) return sendJSON(res, 400, { ok: false, err: `host desconocido: ${hostId}` });
  const u = new URL(req.url, "http://x");
  u.searchParams.delete("host"); u.searchParams.delete("t"); // our token never leaves this host
  const target = `${h.url.replace(/\/$/, "")}${path}${u.searchParams.size ? `?${u.searchParams}` : ""}`;
  const init = {
    method: req.method,
    signal: req.method === "GET" && path === "/api/pane-stream" ? undefined : AbortSignal.timeout(120000),
    headers: { "content-type": "application/json", ...(h.token ? { authorization: `Bearer ${h.token}` } : {}) },
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
  const text = await r.text();
  res.writeHead(r.status, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(text);
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

// optional auth: set MT3K_TOKEN in the env to require `Authorization: Bearer <token>` on /api/*.
// Unset → open (trusted homelab LAN). SSE can't send headers, so ?t=<token> is also accepted.
const TOKEN = process.env.MT3K_TOKEN || null;
const authorized = (req) => {
  if (!TOKEN) return true;
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
