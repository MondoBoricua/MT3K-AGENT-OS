import { useEffect, useRef, useState } from "react";
import type { AgentRow, PaneRef } from "../lib/api";
import { sendToPane, getPane, sendKey, launchAgent } from "../lib/api";
import { ansiToHtml } from "../lib/ansi";
import AgentLogo from "./AgentLogo";

type Props = {
  agent: AgentRow | null; // the agent whose terminal/compose sheet is open (null = closed)
  projects?: { id: string; name: string }[]; // tracked repos, offered as launch targets
  onClose: () => void;
  onToast?: (text: string, live: boolean) => void;
};

// Shared sheet: session picker → fullscreen terminal (live view + docked compose).
// Used from both Agents View (the room) and the sidebar quick-access list.
// One session → opens straight into fullscreen; many → pick one, then fullscreen.
export default function AgentTerminalSheet({ agent, projects = [], onClose, onToast }: Props) {
  const [paneId, setPaneId] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [enterOnSend, setEnterOnSend] = useState(true);
  const [sending, setSending] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [term, setTerm] = useState("");
  // launch flow (agent has no live pane yet): pick a project ("" = free-form path) + spawn
  const [launched, setLaunched] = useState<PaneRef | null>(null);
  const [launching, setLaunching] = useState(false);
  const [launchProject, setLaunchProject] = useState<string>("");
  const [launchCwd, setLaunchCwd] = useState("~");
  const [missingDir, setMissingDir] = useState(false); // free-form path doesn't exist → offer to create it
  const [showLaunch, setShowLaunch] = useState(false); // force the launch form even when sessions exist (＋ nueva sesión)
  const termRef = useRef<HTMLPreElement>(null);

  // a just-launched pane isn't in agent.panes until the next status poll — merge it in meanwhile
  const basePanes: PaneRef[] = agent?.panes ?? [];
  const panes: PaneRef[] = launched && !basePanes.some((p) => p.paneId === launched.paneId) ? [...basePanes, launched] : basePanes;
  const activePane = panes.find((p) => p.paneId === paneId) ?? (panes.length === 1 ? panes[0] : null);
  const paneToWatch = activePane?.paneId;

  // reset whenever a different agent is opened (by id); a single-pane agent jumps straight to fullscreen.
  // launch target is remembered per agent (localStorage) so repeat opens are one tap.
  const agentId = agent?.id;
  useEffect(() => {
    const single = !!agent && agent.panes?.length === 1;
    setPaneId(single ? agent!.panes![0].paneId : null);
    setText(""); setFullscreen(single); setTerm("");
    let proj = "", cwd = "~";
    try {
      const saved = JSON.parse(localStorage.getItem(`mt3k.launch.${agentId}`) ?? "{}");
      if (saved.projectId && projects.some((p) => p.id === saved.projectId)) proj = saved.projectId;
      else if (saved.cwd) cwd = saved.cwd;
    } catch { /* corrupt/absent → defaults */ }
    setLaunched(null); setLaunching(false); setLaunchProject(proj); setLaunchCwd(cwd); setMissingDir(false); setShowLaunch(false);
  }, [agentId]); // eslint-disable-line react-hooks/exhaustive-deps

  // poll the pane's rendered screen while the fullscreen viewer is open
  useEffect(() => {
    if (!paneToWatch || !fullscreen) { setTerm(""); return; }
    let alive = true;
    const pull = async () => { const r = await getPane(paneToWatch); if (alive && r?.ok) setTerm(r.content ?? ""); };
    pull();
    const id = setInterval(pull, 900);
    return () => { alive = false; clearInterval(id); };
  }, [paneToWatch, fullscreen]);

  // lock body scroll behind the fullscreen overlay
  useEffect(() => {
    if (!fullscreen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [fullscreen]);

  // keep the terminal scrolled to the latest output
  useEffect(() => { const el = termRef.current; if (el) el.scrollTop = el.scrollHeight; }, [term]);

  const send = async () => {
    if (!activePane || !text.trim() || sending) return;
    setSending(true);
    const r = await sendToPane(activePane.paneId, text, enterOnSend);
    setSending(false);
    if (r?.ok) { onToast?.(`enviado a ${agent?.name} · ${activePane.label}`, true); setText(""); }
    else { onToast?.(r?.err ? `error: ${r.err}` : `no se pudo enviar a ${agent?.name}`, false); }
  };

  // tap a named key into the pane (arrow-key nav in TUI menus: Codex/Claude pickers, etc.)
  const key = async (k: string) => {
    if (!activePane) return;
    const r = await sendKey(activePane.paneId, k);
    if (!r?.ok) onToast?.(r?.err ? `error: ${r.err}` : "no se pudo enviar la tecla", false);
  };

  // spin up a fresh tmux session for this agent, then jump straight into its terminal.
  // create=true mkdir -p's a missing free-form path first.
  const launch = async (create = false) => {
    if (!agent || launching) return;
    setLaunching(true);
    const opts = launchProject ? { projectId: launchProject, create } : { cwd: launchCwd.trim() || "~", create };
    const r = await launchAgent(agent.id, opts);
    setLaunching(false);
    if (r?.ok && r.paneId) {
      const pane: PaneRef = { paneId: r.paneId, label: r.label ?? r.session ?? "", window: r.session ?? "", cwd: r.cwd ?? "" };
      setLaunched(pane); setPaneId(r.paneId); setFullscreen(true); setMissingDir(false); setShowLaunch(false);
      try { localStorage.setItem(`mt3k.launch.${agent.id}`, JSON.stringify(launchProject ? { projectId: launchProject } : { cwd: launchCwd.trim() || "~" })); } catch { /* private mode */ }
      onToast?.(`${agent.name} abierto · ${pane.cwd}`, true);
    } else if (r?.missingDir) {
      setMissingDir(true); // show the "create & open" affordance inline instead of a dead-end error
    } else {
      setMissingDir(false);
      onToast?.(r?.err ? `error: ${r.err}` : `no se pudo abrir ${agent.name}`, false);
    }
  };

  // leaving fullscreen: back to the picker if there are other sessions, otherwise close the sheet
  const exitFullscreen = () => {
    if (panes.length > 1) { setFullscreen(false); setPaneId(null); setText(""); }
    else onClose();
  };

  if (!agent) return null;

  // Fullscreen terminal: big live view + docked compose bar so you can watch and type comfortably (mobile-first).
  if (fullscreen && activePane) {
    return (
      <div className="fixed inset-0 z-[60] flex flex-col bg-black"
        style={{ paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }}>
        <header className="flex items-center justify-between border-b border-ink-line px-3 py-2"
          style={{ paddingLeft: "calc(0.75rem + env(safe-area-inset-left))", paddingRight: "calc(0.75rem + env(safe-area-inset-right))" }}>
          <div className="flex min-w-0 items-center gap-2">
            <AgentLogo id={agent.id} online={agent.online} className="h-5 w-5 shrink-0" />
            <div className="min-w-0">
              <div className="truncate font-mono text-xs font-semibold">{agent.name} <span className="text-emerald-400">●</span></div>
              <div className="truncate font-mono text-[10px] text-white/40">{activePane.cwd} ({activePane.label})</div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {agent.launchable && (
              <button onClick={() => { setFullscreen(false); setPaneId(null); setShowLaunch(true); }} title="abrir otra sesión"
                className="rounded-lg border border-ink-line px-2.5 py-1 font-mono text-[10px] text-white/55 transition hover:border-accent/50 hover:text-accent">
                ＋ nueva
              </button>
            )}
            <button onClick={exitFullscreen}
              className="rounded-lg border border-ink-line px-2.5 py-1 font-mono text-[10px] text-white/55 transition hover:text-white">
              {panes.length > 1 ? "← sesiones" : "✕ salir"}
            </button>
          </div>
        </header>

        {/* sanitized HTML: ansiToHtml escapes all text; spans carry only numeric-derived colors */}
        <pre ref={termRef}
          className="flex-1 overflow-y-auto overflow-x-hidden whitespace-pre-wrap break-words bg-black px-3 py-2 font-mono text-[11px] leading-snug text-white/90"
          dangerouslySetInnerHTML={{ __html: term ? ansiToHtml(term) : "<span style=\"opacity:.4\">cargando terminal…</span>" }} />

        <div className="border-t border-ink-line bg-ink-900/95 p-3"
          style={{ paddingLeft: "calc(0.75rem + env(safe-area-inset-left))", paddingRight: "calc(0.75rem + env(safe-area-inset-right))" }}>
          {/* key-pad: tap arrows/Enter/Esc for TUI menu navigation (Codex/Claude pickers) */}
          <div className="mb-2 flex items-center gap-1.5">
            <button onClick={() => key("Up")} title="Arriba" className="flex-1 rounded-lg border border-ink-line bg-ink-850/60 py-2 font-mono text-sm text-white/80 transition active:bg-accent/20 active:text-accent">↑</button>
            <button onClick={() => key("Down")} title="Abajo" className="flex-1 rounded-lg border border-ink-line bg-ink-850/60 py-2 font-mono text-sm text-white/80 transition active:bg-accent/20 active:text-accent">↓</button>
            <button onClick={() => key("Left")} title="Izquierda" className="flex-1 rounded-lg border border-ink-line bg-ink-850/60 py-2 font-mono text-sm text-white/80 transition active:bg-accent/20 active:text-accent">←</button>
            <button onClick={() => key("Right")} title="Derecha" className="flex-1 rounded-lg border border-ink-line bg-ink-850/60 py-2 font-mono text-sm text-white/80 transition active:bg-accent/20 active:text-accent">→</button>
            <button onClick={() => key("Enter")} title="Enter" className="flex-1 rounded-lg border border-ink-line bg-ink-850/60 py-2 font-mono text-xs text-white/80 transition active:bg-accent/20 active:text-accent">↵</button>
            <button onClick={() => key("Escape")} title="Escape" className="flex-1 rounded-lg border border-ink-line bg-ink-850/60 py-2 font-mono text-[10px] text-white/80 transition active:bg-accent/20 active:text-accent">esc</button>
            <button onClick={() => key("Tab")} title="Tab" className="flex-1 rounded-lg border border-ink-line bg-ink-850/60 py-2 font-mono text-[10px] text-white/80 transition active:bg-accent/20 active:text-accent">tab</button>
          </div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); send(); } }}
            rows={2}
            placeholder={`escríbele a ${agent.name}…  (⌘/Ctrl+Enter para enviar)`}
            className="w-full resize-none rounded-lg border border-ink-line bg-ink-850/60 px-3 py-2 text-base text-white placeholder:text-white/30 focus:border-accent/50 focus:outline-none sm:text-sm" />
          <div className="mt-2 flex items-center justify-between gap-3">
            <label className="flex cursor-pointer items-center gap-2 font-mono text-[11px] text-white/55">
              <input type="checkbox" checked={enterOnSend} onChange={(e) => setEnterOnSend(e.target.checked)} className="accent-[oklch(62%_0.23_25)]" />
              ↵ enviar (Enter en la terminal)
            </label>
            <button onClick={send} disabled={!text.trim() || sending}
              className="rounded-lg bg-accent/20 px-4 py-2 text-sm font-medium text-accent transition hover:bg-accent/30 disabled:opacity-40">
              {sending ? "enviando…" : "enviar"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Bottom sheet: only the "no session" message or the session picker. Picking a session opens fullscreen.
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[92vh] w-full max-w-lg flex-col overflow-y-auto rounded-t-2xl border border-ink-line bg-ink-900/95 p-4 shadow-2xl"
        style={{ paddingBottom: "calc(1rem + env(safe-area-inset-bottom))" }}>
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-white/20" />
        <header className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <AgentLogo id={agent.id} online={agent.online} className="h-6 w-6" />
            <div>
              <div className="font-mono text-sm font-semibold">{agent.name}</div>
              <div className="font-mono text-[11px] text-white/45">
                {panes.length === 0
                  ? agent.running ? "corriendo fuera de tmux — ábrele una sesión nueva" : "sin sesión activa en tmux"
                  : `${panes.length} ${panes.length === 1 ? "sesión" : "sesiones"} en tmux`}
              </div>
            </div>
          </div>
          <button onClick={onClose} className="rounded-lg border border-ink-line px-2.5 py-1 font-mono text-xs text-white/55 transition hover:text-white">cerrar</button>
        </header>

        {agent.launchable && (showLaunch || panes.length === 0) ? (
            // launch form: no live pane, or "＋ nueva sesión" was tapped with sessions running
            <div className="flex flex-col gap-2">
              <div className="mb-1 flex items-center justify-between">
                <p className="font-mono text-[11px] text-white/45">Abrir una sesión nueva de {agent.name} en tmux — ¿dónde?</p>
                {showLaunch && panes.length > 0 && (
                  <button onClick={() => setShowLaunch(false)} className="shrink-0 font-mono text-[10px] text-white/45 transition hover:text-white">← sesiones</button>
                )}
              </div>

              <button onClick={() => { setLaunchProject(""); setMissingDir(false); }}
                className={`flex items-center justify-between rounded-xl border px-3 py-2.5 text-left font-mono text-xs transition ${launchProject === "" ? "border-accent/60 bg-accent/15 text-white" : "border-ink-line bg-ink-850/50 text-white/70 hover:border-accent/40"}`}>
                <span>📁 Ruta específica</span>
                {launchProject === "" && <span className="text-accent">✓</span>}
              </button>
              {launchProject === "" && (
                <>
                  <input value={launchCwd} onChange={(e) => { setLaunchCwd(e.target.value); setMissingDir(false); }} placeholder="~" spellCheck={false} autoCapitalize="off"
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); launch(); } }}
                    className="rounded-lg border border-ink-line bg-ink-850/60 px-3 py-2 font-mono text-base text-white placeholder:text-white/30 focus:border-accent/50 focus:outline-none sm:text-sm" />
                  {/* quick-picks: one tap instead of typing a path on the phone */}
                  <div className="flex flex-wrap gap-1.5">
                    {["~", "~/Developer", "~/Desktop"].map((q) => (
                      <button key={q} onClick={() => { setLaunchCwd(q); setMissingDir(false); }}
                        className={`rounded-full border px-2.5 py-1 font-mono text-[10px] transition ${launchCwd === q ? "border-accent/60 bg-accent/15 text-accent" : "border-ink-line bg-ink-850/50 text-white/50 hover:text-white"}`}>
                        {q}
                      </button>
                    ))}
                  </div>
                  {missingDir && (
                    <button onClick={() => launch(true)} disabled={launching}
                      className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-left font-mono text-[11px] text-amber-200 transition hover:bg-amber-400/20 disabled:opacity-40">
                      ＋ esa carpeta no existe — crearla y abrir «{launchCwd.trim() || "~"}»
                    </button>
                  )}
                </>
              )}

              {projects.length > 0 && (
                <>
                  <p className="mt-1 font-mono text-[10px] uppercase tracking-wider text-white/35">o un proyecto trackeado</p>
                  <div className="grid grid-cols-2 gap-1.5">
                    {projects.map((p) => (
                      <button key={p.id} onClick={() => { setLaunchProject(p.id); setMissingDir(false); }}
                        className={`flex items-center justify-between rounded-lg border px-2.5 py-2 text-left font-mono text-[11px] transition ${launchProject === p.id ? "border-accent/60 bg-accent/15 text-white" : "border-ink-line bg-ink-850/50 text-white/60 hover:border-accent/40 hover:text-white"}`}>
                        <span className="truncate">{p.name}</span>
                        {launchProject === p.id && <span className="ml-1 shrink-0 text-accent">✓</span>}
                      </button>
                    ))}
                  </div>
                </>
              )}

              {/* sticky CTA that says WHERE it will open — always reachable without scrolling back */}
              <div className="sticky bottom-0 -mx-1 mt-1 bg-ink-900/95 px-1 pb-1 pt-2 backdrop-blur">
                <button onClick={() => launch()} disabled={launching}
                  className="w-full rounded-lg bg-accent/20 px-4 py-2.5 text-sm font-medium text-accent transition hover:bg-accent/30 disabled:opacity-40">
                  {launching ? "abriendo…" : `▶ abrir en ${launchProject ? (projects.find((p) => p.id === launchProject)?.name ?? launchProject) : (launchCwd.trim() || "~")}`}
                </button>
              </div>
            </div>
        ) : panes.length === 0 ? (
          <p className="py-6 text-center font-mono text-xs text-white/40">
            {agent.online ? "Este agente es una app (GUI) y no se puede abrir en tmux." : "Agente offline."}
          </p>
        ) : (
          // session picker — pick which tmux pane to open in fullscreen
          <div className="flex flex-col gap-2">
            <p className="mb-1 font-mono text-[11px] text-white/45">¿a cuál sesión?</p>
            {panes.map((p) => (
              <button key={p.paneId} onClick={() => { setPaneId(p.paneId); setFullscreen(true); }}
                className="rounded-xl border border-ink-line bg-ink-850/50 px-3 py-2.5 text-left transition hover:border-accent/40 hover:bg-ink-850">
                <div className="truncate font-mono text-xs text-white">{p.cwd}</div>
                <div className="font-mono text-[10px] text-white/40">{p.label} · {p.paneId}</div>
              </button>
            ))}
            {agent.launchable && (
              <button onClick={() => setShowLaunch(true)}
                className="rounded-xl border border-dashed border-ink-line px-3 py-2.5 text-left font-mono text-xs text-white/50 transition hover:border-accent/50 hover:text-accent">
                ＋ abrir otra sesión
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );
}
