import { useCallback, useEffect, useRef, useState } from "react";
import type { Manifest, ProjectData } from "./types";
import { refreshProject, getStatus, getToken, setToken, agentKey, type AgentRow, type SearchHit } from "./lib/api";
import CommandPalette from "./components/CommandPalette";
import { HomeIcon, SkillsIcon, MemoryIcon, GraphIcon, ActivityIcon, SettingsIcon, MenuIcon, CloseIcon, GitHubIcon, XIcon, LinkedInIcon, TikTokIcon, YouTubeIcon, MailIcon, AgentsViewIcon } from "./components/icons";
import KnowledgeGraph from "./pages/KnowledgeGraph";
import Skills from "./pages/Skills";
import Memory from "./pages/Memory";
import Activity from "./pages/Activity";
import Home from "./pages/Home";
import Settings from "./pages/Settings";
import AgentsView from "./pages/AgentsView";
import AgentTerminalSheet from "./components/AgentTerminalSheet";
import AgentLogo from "./components/AgentLogo";

const BASE = import.meta.env.BASE_URL;
const NAV = [
  { name: "Home", Icon: HomeIcon },
  { name: "Skills", Icon: SkillsIcon },
  { name: "Memory", Icon: MemoryIcon },
  { name: "Knowledge Graph", Icon: GraphIcon },
  { name: "Agents View", Icon: AgentsViewIcon },
  { name: "Activity", Icon: ActivityIcon },
] as const;
type Page = (typeof NAV)[number]["name"] | "Settings";

const SOCIALS = [
  { name: "GitHub", href: "https://github.com/MondoBoricua", Icon: GitHubIcon },
  { name: "X", href: "https://x.com/MondoBoricua", Icon: XIcon },
  { name: "LinkedIn", href: "https://www.linkedin.com/in/jdiazpr", Icon: LinkedInIcon },
  { name: "TikTok", href: "https://www.tiktok.com/@MondoBoricua", Icon: TikTokIcon },
  { name: "YouTube", href: "https://www.youtube.com/@MT3K", Icon: YouTubeIcon },
  { name: "contacto@mt3k.net", href: "mailto:contacto@mt3k.net", Icon: MailIcon },
];

export default function App() {
  const [page, setPage] = useState<Page>("Knowledge Graph");
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [selected, setSelected] = useState("");
  const [data, setData] = useState<ProjectData | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [navOpen, setNavOpen] = useState(false);
  const [sheetAgentId, setSheetAgentId] = useState<string | null>(null);
  const [toasts, setToasts] = useState<{ id: number; text: string; live: boolean }[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [pendingSel, setPendingSel] = useState<{ project: string; id: string } | null>(null);
  const [authNeeded, setAuthNeeded] = useState(false);
  const [tokenDraft, setTokenDraft] = useState("");
  const prevAgents = useRef<Record<string, boolean>>({});
  const firstPoll = useRef(true);

  // server runs with MT3K_TOKEN and ours is missing/wrong → ask once, store in localStorage
  useEffect(() => {
    const onUnauthorized = () => setAuthNeeded(true);
    window.addEventListener("mt3k:unauthorized", onUnauthorized);
    return () => window.removeEventListener("mt3k:unauthorized", onUnauthorized);
  }, []);
  const saveToken = () => {
    if (!tokenDraft.trim()) return;
    setToken(tokenDraft.trim());
    setAuthNeeded(false); setTokenDraft("");
    window.dispatchEvent(new Event("mt3k:refresh-change")); // re-kick the status poll with the new token
  };

  const pushToast = (text: string, live: boolean) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, text, live }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  };

  // daemon: poll system status on an interval (configurable in Settings) → live agent status
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const tick = () => getStatus().then((s) => {
      if (!s) return;
      setAgents(s.agents);
      if (!firstPoll.current) {
        for (const a of s.agents) {
          const tag = a.host ? `${a.name} @${a.host}` : a.name;
          if (a.running && prevAgents.current[agentKey(a)] === false) pushToast(`${tag} entró`, true);
          else if (!a.running && prevAgents.current[agentKey(a)] === true) pushToast(`${tag} salió`, false);
        }
      }
      prevAgents.current = Object.fromEntries(s.agents.map((a) => [agentKey(a), a.running]));
      firstPoll.current = false;
    });
    const start = () => {
      clearInterval(timer);
      tick();
      const ms = Number(localStorage.getItem("mt3k.refreshMs") ?? 10000);
      if (ms > 0) timer = setInterval(tick, ms);
    };
    start();
    window.addEventListener("mt3k:refresh-change", start);
    return () => { clearInterval(timer); window.removeEventListener("mt3k:refresh-change", start); };
  }, []);

  // keyboard shortcuts: Cmd/Ctrl+K or "/" → search · 1-9 → switch project
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPaletteOpen(true); return; }
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "/") { e.preventDefault(); setPaletteOpen(true); }
      else if (e.key >= "1" && e.key <= "9") {
        const p = manifest?.projects[Number(e.key) - 1];
        if (p) { setSelected(p.id); setPage("Knowledge Graph"); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [manifest]);

  const loadManifest = useCallback((bust = "") => {
    fetch(`${BASE}data/manifest.json${bust}`).then((r) => r.json()).then((m: Manifest) => {
      setManifest(m);
      setSelected((cur) => cur || m.projects[0]?.id || "");
    }).catch(() => setManifest({ projects: [], builtAt: null }));
  }, []);

  useEffect(() => { loadManifest(); }, [loadManifest]);

  useEffect(() => {
    if (!selected) return;
    setData(null);
    fetch(`${BASE}data/${selected}.json?t=${Date.now()}`).then((r) => r.json()).then(setData).catch(() => {});
  }, [selected]);

  const onRefresh = async () => {
    if (!selected || refreshing) return;
    setRefreshing(true);
    await refreshProject(selected);
    loadManifest(`?t=${Date.now()}`);
    const r = await fetch(`${BASE}data/${selected}.json?t=${Date.now()}`).then((x) => x.json()).catch(() => null);
    if (r) setData(r);
    setRefreshing(false);
  };

  const goProject = (id: string) => { setSelected(id); setPage("Knowledge Graph"); };
  const onlineCount = agents.filter((a) => a.online).length;
  const runningCount = agents.filter((a) => a.running).length;
  // open the shared terminal sheet (from the room or the sidebar). We key by host:id so the sheet
  // tracks the live agent (panes refresh on each poll) even across federated hosts.
  const openAgent = (a: AgentRow) => { setSheetAgentId(agentKey(a)); setNavOpen(false); };
  const sheetAgent = sheetAgentId ? agents.find((a) => agentKey(a) === sheetAgentId) ?? null : null;

  return (
    <div className="relative flex h-screen overflow-hidden text-white">
      {/* mobile backdrop */}
      {navOpen && <div className="fixed inset-0 z-30 bg-black/55 lg:hidden" onClick={() => setNavOpen(false)} />}

      {/* sidebar — static on lg, slide-in drawer on mobile */}
      <aside style={{ paddingTop: "calc(1rem + env(safe-area-inset-top))", paddingLeft: "calc(1rem + env(safe-area-inset-left))" }}
        className={`fixed inset-y-0 left-0 z-40 flex w-[220px] shrink-0 flex-col border-r border-ink-line bg-ink-850/95 p-4 backdrop-blur transition-transform duration-300 lg:static lg:translate-x-0 lg:bg-ink-850/40 ${navOpen ? "translate-x-0" : "-translate-x-full"}`}>
        <div className="mb-7 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="grid h-9 w-9 place-items-center overflow-hidden rounded-xl border border-accent/30 bg-ink-900 shadow-[0_0_18px_-6px] shadow-accent">
              <img src={`${BASE}logo.png`} alt="MT3K" className="h-7 w-7 object-contain" />
            </div>
            <div>
              <div className="text-sm font-semibold leading-tight">MT3K Agent OS</div>
              <div className="font-mono text-[10px] uppercase tracking-wider text-white/40">Operator</div>
            </div>
          </div>
          <button onClick={() => setNavOpen(false)} className="text-white/40 hover:text-white lg:hidden"><CloseIcon className="h-5 w-5" /></button>
        </div>

        <nav className="flex flex-col gap-1">
          {NAV.map(({ name, Icon }) => (
            <button key={name} onClick={() => { setPage(name); setNavOpen(false); }}
              className={`relative flex items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition before:absolute before:left-0 before:top-1/2 before:h-4 before:w-[3px] before:-translate-y-1/2 before:rounded-full before:bg-accent before:transition-opacity before:content-[''] ${
                page === name ? "bg-accent/12 text-accent shadow-[0_0_24px_-14px] shadow-accent before:opacity-100" : "text-white/55 before:opacity-0 hover:bg-white/5 hover:text-white"
              }`}>
              <Icon className="h-[18px] w-[18px] shrink-0" /> {name}
            </button>
          ))}
        </nav>

        <div className="mt-7 mb-2 flex items-center justify-between">
          <span className="font-mono text-[10px] uppercase tracking-wider text-white/35">Agents</span>
          <span className="font-mono text-[10px] text-emerald-300/70">{runningCount} live</span>
        </div>
        <div className="flex flex-col gap-1.5 overflow-y-auto">
          {agents.map((a) => {
            const sendable = (a.panes?.length ?? 0) > 0;
            const openable = sendable || !!a.launchable; // launchable agents open the sheet to spawn a session
            const cls = `flex items-center gap-2.5 rounded-lg border px-3 py-1.5 text-left font-mono text-xs transition ${
              a.running ? "border-emerald-400/40 bg-emerald-400/10 font-semibold text-white/90" : a.online ? "border-ink-line text-white/55" : "border-ink-line text-white/30"
            } ${openable ? "cursor-pointer hover:border-accent/50 hover:bg-accent/10" : ""}`;
            // brand logo + a status dot at its corner (amber = waiting for input, green = working)
            const logo = (
              <span className="relative shrink-0">
                <AgentLogo id={a.id} online={a.online} className="h-[18px] w-[18px]" />
                {a.running && (
                  <span className={`absolute -bottom-0.5 -right-0.5 h-1.5 w-1.5 animate-pulse rounded-full ring-2 ring-ink-850 ${a.waiting ? "bg-amber-400 shadow-[0_0_6px] shadow-amber-400" : "bg-emerald-400 shadow-[0_0_6px] shadow-emerald-400"}`} />
                )}
              </span>
            );
            const label = (
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate">{a.name}</span>
                {a.host && <span className="shrink-0 rounded border border-sky-400/30 bg-sky-400/10 px-1 text-[9px] text-sky-300">{a.host}</span>}
              </span>
            );
            // clickable quick-access: live session → terminal (⌨), launchable-only → spawn one (▶)
            return openable ? (
              <button key={agentKey(a)} onClick={() => openAgent(a)} title={sendable ? `abrir terminal · ${a.name}` : `abrir sesión · ${a.name}`} className={cls}>
                {logo}
                {label}
                <span className="ml-auto shrink-0 text-[10px] text-accent">{a.waiting ? "⏳" : sendable ? `⌨${(a.panes?.length ?? 0) > 1 ? a.panes!.length : ""}` : "▶"}</span>
              </button>
            ) : (
              <div key={agentKey(a)} className={cls}>
                {logo}
                {label}
                {a.running && <span className="ml-auto shrink-0 text-[9px] text-emerald-300">live</span>}
              </div>
            );
          })}
        </div>
        <div className="mt-auto">
          <div className="mb-3 flex gap-1.5 border-t border-ink-line pt-3">
            {SOCIALS.map(({ name, href, Icon }) => (
              <a key={name} href={href} target="_blank" rel="noopener noreferrer" title={name}
                className="grid h-8 flex-1 place-items-center rounded-lg border border-ink-line text-white/50 transition hover:-translate-y-0.5 hover:border-accent/50 hover:text-accent hover:shadow-[0_0_18px_-8px] hover:shadow-accent">
                <Icon className="h-4 w-4" />
              </a>
            ))}
          </div>
          <button onClick={() => { setPage("Settings"); setNavOpen(false); }}
            className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition ${page === "Settings" ? "bg-accent/12 text-accent" : "text-white/50 hover:text-white"}`}>
            <SettingsIcon className="h-[18px] w-[18px]" /> Settings
          </button>
        </div>
      </aside>

      {/* main */}
      <main className="flex min-w-0 flex-1 flex-col">
        <header style={{ paddingTop: "calc(0.75rem + env(safe-area-inset-top))" }}
          className="flex items-center justify-between gap-3 border-b border-ink-line px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <button onClick={() => setNavOpen(true)} className="text-white/60 hover:text-white lg:hidden"><MenuIcon className="h-5 w-5" /></button>
            <div className="truncate text-sm">
              <span className="text-white/50">Operator</span>
              <span className="mx-2 text-white/25">/</span>
              <span className="font-medium">{page === "Knowledge Graph" ? (data?.meta.name ?? "local") : page}</span>
            </div>
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            {page === "Knowledge Graph" && (
              <button onClick={onRefresh} disabled={refreshing}
                className="shrink-0 rounded-lg border border-ink-line px-3 py-1.5 text-xs text-white/70 transition hover:border-accent/50 hover:text-white disabled:opacity-40">
                {refreshing ? "↻ …" : "↻ Refresh"}
              </button>
            )}
            <div className="flex shrink-0 items-center gap-2 rounded-full border border-ink-line bg-ink-850/60 px-3 py-1 text-xs">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400 shadow-[0_0_8px] shadow-emerald-400" />
              <span className="text-emerald-300">{runningCount} live</span>
              <span className="text-white/25">·</span>
              <span className="text-white/45">{onlineCount} ready</span>
              {runningCount > 0 && <span className="hidden font-mono text-white/55 xl:inline">· {agents.filter((a) => a.running).map((a) => a.name).join(" · ")}</span>}
            </div>
          </div>
        </header>

        {page === "Knowledge Graph" && <KnowledgeGraph manifest={manifest} selected={selected} setSelected={setSelected} data={data} onReload={() => loadManifest(`?t=${Date.now()}`)} pendingSel={pendingSel} onPendingDone={() => setPendingSel(null)} />}
        {page === "Home" && <Home manifest={manifest} go={goProject} />}
        {page === "Skills" && <Skills />}
        {page === "Memory" && <Memory />}
        {page === "Activity" && <Activity />}
        {page === "Agents View" && <AgentsView agents={agents} onOpen={openAgent} onToast={pushToast} />}
        {page === "Settings" && <Settings manifest={manifest} onChanged={() => loadManifest(`?t=${Date.now()}`)} />}
      </main>

      {paletteOpen && (
        <CommandPalette
          onClose={() => setPaletteOpen(false)}
          onPick={(h: SearchHit) => { setSelected(h.project); setPage("Knowledge Graph"); setPendingSel({ project: h.project, id: h.id }); setPaletteOpen(false); }}
        />
      )}

      {/* shared terminal/compose sheet — opened from Agents View or the sidebar quick-access list */}
      <AgentTerminalSheet agent={sheetAgent} projects={manifest?.projects ?? []} onClose={() => setSheetAgentId(null)} onToast={pushToast} />

      {/* token gate — shows when the server requires MT3K_TOKEN and ours is missing/wrong */}
      {authNeeded && (
        <div className="fixed inset-0 z-[80] grid place-items-center bg-black/70 backdrop-blur-sm">
          <div className="w-[min(360px,90%)] rounded-2xl border border-ink-line bg-ink-900/95 p-5 shadow-2xl">
            <div className="mb-1 font-mono text-sm font-semibold">🔐 Token requerido</div>
            <p className="mb-3 font-mono text-[11px] text-white/45">Este servidor corre con MT3K_TOKEN. Pégalo una vez y queda guardado en este navegador.</p>
            <input value={tokenDraft} onChange={(e) => setTokenDraft(e.target.value)} type="password" placeholder="token…" autoFocus
              onKeyDown={(e) => { if (e.key === "Enter") saveToken(); }}
              className="mb-3 w-full rounded-lg border border-ink-line bg-ink-850/60 px-3 py-2 font-mono text-sm text-white placeholder:text-white/30 focus:border-accent/50 focus:outline-none" />
            <button onClick={saveToken} disabled={!tokenDraft.trim()}
              className="w-full rounded-lg bg-accent/20 px-4 py-2 text-sm font-medium text-accent transition hover:bg-accent/30 disabled:opacity-40">
              guardar y conectar
            </button>
            {getToken() && <p className="mt-2 text-center font-mono text-[10px] text-amber-300/70">el token guardado fue rechazado — verifica y vuelve a pegarlo</p>}
          </div>
        </div>
      )}

      {/* agent notifications */}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[70] flex flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} className={`pointer-events-auto flex items-center gap-2 rounded-xl border px-3 py-2 text-sm shadow-2xl backdrop-blur ${t.live ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-200" : "border-ink-line bg-ink-800/90 text-white/70"}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${t.live ? "animate-pulse bg-emerald-400" : "bg-white/30"}`} /> {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
