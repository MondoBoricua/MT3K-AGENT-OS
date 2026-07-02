# MT3K Agent OS

A local, file-based **agentic operating system** + a visual **knowledge-graph dashboard** for every repo you map with [graphify](https://github.com/safishamsi/graphify).

Your "shared brain": each project is graphed once, then the panel shows its knowledge graph, god nodes, map confidence, token savings, and an in-panel wiki — and you can ask questions that run `graphify query` live. No external DB, no vector store, no cloud — JSON + markdown on disk.

## Layout

```
CLAUDE.md            kernel — routing + agent registry
agents/              specialist agents (e.g. @mapper)
data/
  projects.example.json  template — the panel reads projects.json (or falls back to empty)
  projects.json          the repos the panel tracks — GITIGNORED, host-local, never committed
  logs/                  file-based memory (sessions, queries, refreshes) — GITIGNORED
scripts/
  build-data.mjs     ingests each repo's graphify-out/ → panel data
  server.mjs         local API (query / refresh / discover / agents) + serves the panel
panel/               Vite + React + TS + Tailwind dashboard
```

## Run

```bash
# 1. build the dashboard
pnpm --dir panel install
pnpm --dir panel build

# 2. start the OS (serves panel + API on one port)
node scripts/server.mjs        # → http://localhost:4288
```

For development with hot-reload: `pnpm --dir panel dev` (Vite :5273, proxies `/api`) **+** `node scripts/server.mjs`.

## Install with an agent

Hand this prompt to a coding agent (Claude Code, Codex, Cursor `cursor-agent`, …) to set it up from scratch on a clean machine:

```text
Set up MT3K Agent OS on this machine. Steps:

1. Verify prerequisites are on PATH: node ≥18, pnpm, tmux, git, and graphify
   (https://github.com/safishamsi/graphify). Install whatever is missing, then stop and
   tell me if you can't.
2. Clone the repo and cd into it:
   git clone <REPO_URL> MT3K-AGENT-OS && cd MT3K-AGENT-OS
3. Start clean — the repo may carry the previous owner's baked data. Reset it:
   - write data/projects.json as: {"projects": []}
   - empty data/logs/ (delete every *.md inside it)
   - delete panel/public/data/*.json and panel/dist/data/*.json
   Then confirm none of my own paths/projects remain anywhere under data/ or panel/*/data/.
4. Build the dashboard:  pnpm --dir panel install && pnpm --dir panel build
5. Start the OS:  node scripts/server.mjs   (serves panel + API on http://localhost:4288)
6. Report back: the URL, and the agent CLIs it detected at GET /api/agents
   (id + online/running/launchable for each).

Then tell me how to add my first repo: graph it with `graphify .` inside the repo, then
use ＋ Add a project in the panel (or add it to data/projects.json and run
node scripts/build-data.mjs).
```

> Deploying to a shared/remote host instead of a clean local machine? Read **[DEPLOY.md](DEPLOY.md)** first — the privacy gate and auth requirements below are mandatory there.

## Agents View

The **Agents View** (and the sidebar list) shows every detected agent CLI. Tap one to:

- **✎ write** — if it's already running in a tmux pane, open its live terminal (SSE-streamed) and type
  into it, with an arrow-key pad for TUI menus, one-tap **quick prompts** (`data/macros.json`), and
  **⏻ kill** to end a session. **＋ nueva** spawns parallel sessions of the same agent.
- **▶ open** — if it's installed but has no session, spawn a fresh tmux session running that CLI in a
  directory you pick (a tracked project or any path like `~` — created on demand if missing), with an
  optional **first message** that is pasted once the CLI finishes booting.
- **⏳ waiting** — a pane whose screen goes still (10s on a prompt, 45s otherwise) is flagged amber
  everywhere; add `data/notify.json` with an [ntfy](https://ntfy.sh) topic to get a push on your phone.
- **📣 broadcast** — the wall HUD sends one message to every live session on every federated host.

All tmux control is **LAN-only** and goes through `tmux` directly (no shell) — see the API table.

### Federation (multi-host wall)

Federation is **manual and one-way**: copy `data/hosts.example.json` → `data/hosts.json` on the host
that should *aggregate* (e.g. your laptop) and list each remote panel's `url` + its `MT3K_TOKEN`.
That host's wall then shows the remote agents (tagged with the host id) and proxies terminal
view/typing/launch/kill to them server-side — remote tokens never reach the browser. Hosts that
aren't listed never connect anywhere; nothing is discovered automatically.

Because launches spawn the raw binary (no shell), your shell **aliases don't apply**. To launch an
agent with extra env/flags on a given host, copy `data/launch.example.json` → `data/launch.json`
(gitignored, host-local) and set per-agent `env` / `args` there.

### Auth token (recommended)

Set `MT3K_TOKEN` in the server's environment and every `/api/*` call requires
`Authorization: Bearer <token>` (SSE uses `?t=<token>`). Unset → everything stays open, for a
trusted LAN. Strongly recommended anywhere `/api/launch` + `data/launch.json` can spawn agents
with permissive flags.

**Run ad-hoc (dev / your laptop):**

```bash
MT3K_TOKEN=$(openssl rand -hex 16) node scripts/server.mjs   # prints nothing — save your token!
# or with a token you choose:
MT3K_TOKEN=my-secret node scripts/server.mjs
```

**Run under systemd (a provisioned host):** put it in a unit override so it survives restarts —

```bash
sudo mkdir -p /etc/systemd/system/mt3k-agent-os.service.d
sudo tee /etc/systemd/system/mt3k-agent-os.service.d/override.conf >/dev/null <<EOF
[Service]
Environment=MT3K_TOKEN=$(openssl rand -hex 16)
# without this, restarting the service kills every tmux session the panel launched:
KillMode=process
EOF
sudo chmod 600 /etc/systemd/system/mt3k-agent-os.service.d/override.conf
sudo systemctl daemon-reload && sudo systemctl restart mt3k-agent-os
```

**Where it lives:**
- *Server:* only in that environment variable — the override file above (readable by root only),
  or your shell command. It's never written to `data/` or served anywhere. To read it back:
  `grep MT3K_TOKEN /etc/systemd/system/mt3k-agent-os.service.d/override.conf`.
- *Browser:* the panel asks for the token the first time the API answers 401 and keeps it in
  that browser's `localStorage` (`mt3k.token`) — you paste it once per device. To change the
  token: update the override, restart the service, and the panel will prompt again.

## Deploying to another host

A fresh `git clone` is clean by design: everything private (`data/projects.json`, `data/launch.json`,
`data/hosts.json`, `data/notify.json`, `data/logs/`, `panel/public/data/`, `graphify-out/`) is
gitignored, ships as `*.example.json` templates, and the server falls back to empty defaults.

- **Deploy from git, not from your working copy.** An `scp`/`rsync` of a working tree carries your
  local `data/` and the baked graphs in `panel/{public,dist}/data/*.json` — that leaks your projects
  and your federation tokens. If you must copy files, exclude those paths and verify the host serves
  `/data/manifest.json` → `{"projects":[]}` before exposing it.
- **Set `MT3K_TOKEN`** (see [Auth token](#auth-token-recommended)). The API launches agents and types
  into tmux panes — never expose `:4288` beyond a trusted LAN without the token (and ideally a
  reverse proxy or VPN on top).
- Run it under **systemd with `KillMode=process`** (snippet in the Auth section) so service restarts
  don't kill the agents' tmux sessions.
- Target needs: node ≥ 22, tmux, pnpm (one-time panel build), and optionally graphify to graph repos
  on that host. Updating = `git pull` + `pnpm --dir panel build` + restart.

## Adding a project

Graph a repo (`graphify .` inside it), then either:
- Click **＋ Add a project** in the panel — it auto-discovers graphed repos under `~/Developer`, or
- Add it to `data/projects.json` and run `node scripts/build-data.mjs`.

## API

| Endpoint | What it does |
|---|---|
| `POST /api/query` | runs `graphify query` in a repo (traversal, $0) |
| `POST /api/refresh` | `graphify update` + re-ingest |
| `POST /api/add-project` | track a repo (graphs it if needed) + ingest |
| `GET /api/discover` | graphed repos not yet tracked |
| `GET /api/agents` | detects installed agent CLIs (Claude Code, Codex, OpenCode, Gemini, Grok, Antigravity `agy`, Cursor `cursor-agent`), their live tmux panes, and whether each is `launchable` |
| `POST /api/launch` | spawns a fresh detached tmux session running an agent's CLI (`{ agentId, projectId? \| cwd? }`) and returns the new `paneId` — binary comes from an allowlist, cwd is a tracked project or a real path like `~` |
| `POST /api/send` | types text into an agent's tmux pane (`{ paneId, text, enter? }`) — LAN-only, used by Agents View |
| `POST /api/key` | sends a single allowlisted key to a pane (`{ paneId, key }`: `Up`/`Down`/`Enter`/`Escape`/`Tab`…) for navigating TUI menus |
| `GET /api/pane?id=%N` | live capture of an agent's tmux pane (rendered screen + ANSI colors) for the terminal viewer |
| `GET /api/pane-stream?id=%N` | SSE stream of the same screen — pushed only when it changes (viewer falls back to polling) |
| `POST /api/kill` | kills a tmux pane/session (`{ paneId }`) |
| `POST /api/broadcast` | `{ text }` → pasted into every live agent pane, here and on federated hosts |
| `GET /api/macros` | quick prompts for the compose bar (`data/macros.json` or defaults) |

Any of the tmux endpoints accepts `?host=<id>` to target a federated host (see `data/hosts.json`) —
the server forwards the call with that host's own token.
| `GET /api/skills` | reads `~/.agents/skills` SKILL.md frontmatter |
| `GET /api/logs` | file-based memory for Memory / Activity |

Brand colors and logo are sourced from MT3K Web.
