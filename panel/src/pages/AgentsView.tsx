import { useEffect, useState } from "react";
import type { AgentRow } from "../lib/api";
import { getLogs, broadcast, agentKey } from "../lib/api";
import AgentLogo from "../components/AgentLogo";

const HACKER = "/sprites/hacker.webp"; // standing/idle (row 2 = running-left, full frames)
const LAPTOP = "/sprites/laptop.png"; // coding-on-laptop strip (6 good frames)
const CODE_COLORS = ["#34d399", "#e6edf3", "#fb923c", "#60a5fa"];
const CODE_W = [82, 56, 70, 44];

type Props = { agents: AgentRow[]; onOpen: (a: AgentRow) => void; onToast?: (text: string, live: boolean) => void };

export default function AgentsView({ agents, onOpen, onToast }: Props) {
  const live = agents.filter((a) => a.running).length;
  const ready = agents.filter((a) => a.online).length;
  const sessions = agents.flatMap((a) => (a.panes ?? []).map((p) => ({ agent: a, pane: p })));
  const waitingCount = sessions.filter((s) => s.pane.waiting).length;

  // broadcast: one message → every live session on every federated host
  const [bcText, setBcText] = useState("");
  const [bcSending, setBcSending] = useState(false);
  const sendBroadcast = async () => {
    const text = bcText.trim();
    if (!text || bcSending) return;
    setBcSending(true);
    const r = await broadcast(text);
    setBcSending(false);
    if (r?.ok) { setBcText(""); onToast?.(`📣 enviado a ${r.sent} ${r.sent === 1 ? "sesión" : "sesiones"}`, true); }
    else onToast?.(r?.err ? `error: ${r.err}` : "broadcast falló", false);
  };

  // wall HUD feed: last few OS events (launch/send/query…) from today's log
  const [feed, setFeed] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    const pull = async () => {
      const r = await getLogs();
      if (!alive || !r?.logs?.length) return;
      const lines = r.logs[0].content.split("\n").filter((l) => l.startsWith("- "));
      setFeed(lines.slice(-4).reverse().map((l) => l.replace(/^- /, "")));
    };
    pull();
    const id = setInterval(pull, 30000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  return (
    <div className="room relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="z-20 px-6 pt-6">
        <h1 className="text-xl font-semibold tracking-tight">Agents View</h1>
        <p className="font-mono text-xs text-white/45">{live} codeando · {ready} listos · toca un agente para escribirle o abrirle una sesión en tmux</p>
      </div>

      <div className="relative flex-1">
        <div className="room-wall absolute inset-x-0 top-0 h-1/2" />
        <div className="room-floor absolute inset-x-0 bottom-0 h-[72%]" />

        {/* wall-mounted mission-control screen — fills the empty upper half of the room */}
        <div className="wallscreen absolute left-1/2 top-[6%] z-20 w-[min(620px,92%)] -translate-x-1/2 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-accent">◉ Sala de operaciones</span>
            <span className="font-mono text-[10px] text-white/45">
              {live} codeando · {sessions.length} {sessions.length === 1 ? "sesión" : "sesiones"}
              {waitingCount > 0 && <span className="text-amber-300"> · ⏳ {waitingCount} esperando</span>}
            </span>
          </div>
          {/* live tmux sessions as tappable chips (amber = waiting for your input) */}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {sessions.map(({ agent: a, pane: p }) => (
              <button key={`${agentKey(a)}-${p.paneId}`} onClick={() => onOpen(a)}
                className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[10px] transition ${
                  p.waiting ? "border-amber-400/40 bg-amber-400/10 text-amber-200 hover:bg-amber-400/20" : "border-emerald-400/30 bg-emerald-400/10 text-emerald-200 hover:bg-emerald-400/20"}`}>
                <AgentLogo id={a.id} online className="h-3 w-3" />
                {a.host && <span className="text-sky-300">{a.host}·</span>}
                <span className="max-w-[160px] truncate">{p.cwd}</span>
                {p.waiting && <span>⏳</span>}
              </button>
            ))}
            {sessions.length === 0 && <span className="font-mono text-[10px] text-white/30">sin sesiones en tmux — toca un agente y dale ▶ abrir</span>}
          </div>
          {/* broadcast: one line → every live session everywhere */}
          {sessions.length > 0 && (
            <div className="mt-2 flex gap-1.5">
              <input value={bcText} onChange={(e) => setBcText(e.target.value)} placeholder={`📣 broadcast a ${sessions.length > 1 ? "todas las sesiones" : "la sesión"}…`}
                spellCheck={false} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); sendBroadcast(); } }}
                className="min-w-0 flex-1 rounded-lg border border-ink-line bg-ink-850/60 px-2.5 py-1.5 font-mono text-[11px] text-white placeholder:text-white/25 focus:border-accent/50 focus:outline-none" />
              <button onClick={sendBroadcast} disabled={bcSending || !bcText.trim()}
                className="shrink-0 rounded-lg bg-accent/20 px-3 py-1.5 font-mono text-[11px] text-accent transition hover:bg-accent/30 disabled:opacity-40">
                {bcSending ? "…" : "enviar"}
              </button>
            </div>
          )}
          {/* recent OS events */}
          {feed.length > 0 && (
            <div className="mt-2 flex flex-col gap-0.5 border-t border-white/10 pt-2">
              {feed.map((l, i) => (
                <div key={i} className="truncate font-mono text-[9px] text-white/35" style={{ opacity: 1 - i * 0.18 }}>{l}</div>
              ))}
            </div>
          )}
        </div>

        {/* scroll starts at the first agent on mobile (mx-auto centers it only when it fits) */}
        <div className="absolute inset-0 z-10 flex snap-x items-end justify-start overflow-x-auto pb-[6%] sm:justify-center">
          <div className="mx-auto flex items-end gap-3 px-5 sm:gap-8 sm:px-8">
            {agents.map((a, i) => {
              const hue = (i * 53) % 360;
              const offline = !a.online;
              const sendable = (a.panes?.length ?? 0) > 0;
              const openable = sendable || !!a.launchable; // launchable agents open the sheet to spawn a session
              return (
                <div key={agentKey(a)}
                  onClick={() => openable && onOpen(a)}
                  role={openable ? "button" : undefined}
                  tabIndex={openable ? 0 : undefined}
                  onKeyDown={openable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(a); } } : undefined}
                  className={`flex shrink-0 snap-center flex-col items-center rounded-xl outline-none transition ${openable ? "cursor-pointer hover:bg-white/[0.03] focus-visible:ring-2 focus-visible:ring-accent/60" : ""}`}>
                  {/* monitor */}
                  <div className={`monitor ${a.running ? "live" : ""}`}>
                    {CODE_W.map((w, k) => (
                      <div key={k} className="codeline"
                        style={{ width: `${w}%`, background: a.running ? CODE_COLORS[k % CODE_COLORS.length] : "oklch(42% 0.02 270)", animationDelay: `${k * 0.22}s` }} />
                    ))}
                  </div>
                  {/* desk */}
                  <div className="desk mt-1.5" />

                  {/* agent at the workstation */}
                  <div className="relative -mt-2.5 flex h-[132px] w-[112px] items-end justify-center sm:h-[150px] sm:w-[140px]"
                    style={{ background: a.running ? "radial-gradient(55% 40% at 50% 86%, oklch(80% 0.15 150 / 0.2), transparent 70%)" : "none" }}>
                    <div className="sprite-wrap" style={{ filter: offline ? "grayscale(1) opacity(.4)" : `hue-rotate(${hue}deg) saturate(1.15)` }}>
                      {a.running ? (
                        <div className="sprite-laptop" style={{ backgroundImage: `url(${LAPTOP})`, ["--dur" as string]: "0.7s" }} />
                      ) : (
                        <div className="sprite-idle" style={{ backgroundImage: `url(${HACKER})`, ["--dur" as string]: "2.2s" }} />
                      )}
                    </div>
                  </div>

                  {/* contact shadow */}
                  <div className={`-mt-1 h-2 w-16 rounded-[50%] blur-[3px] ${a.running ? "bg-emerald-400/40" : "bg-black/50"}`} />

                  {/* nameplate */}
                  <div className="mt-2 rounded-lg border border-ink-line bg-ink-850/70 px-2.5 py-1 text-center backdrop-blur">
                    <div className="flex items-center justify-center gap-1.5">
                      <AgentLogo id={a.id} online={a.online} className="h-3.5 w-3.5" />
                      <span className="font-mono text-[11px] font-semibold leading-tight">{a.name}</span>
                      {a.host && <span className="rounded border border-sky-400/30 bg-sky-400/10 px-1 font-mono text-[8px] text-sky-300">{a.host}</span>}
                    </div>
                    <div className={`font-mono text-[9px] uppercase tracking-wider ${a.waiting ? "text-amber-300" : a.running ? "text-emerald-300" : a.online ? "text-white/45" : "text-white/25"}`}>
                      {a.waiting ? "⏳ esperando input" : a.running ? (sendable ? "● codeando" : "● fuera de tmux") : a.online ? "○ listo" : "offline"}
                    </div>
                  </div>
                  {/* action hint: live session → write, launchable-only → spawn */}
                  {sendable ? (
                    <div className="mt-1 rounded-full border border-accent/40 bg-accent/15 px-2 py-0.5 font-mono text-[9px] text-accent">
                      ✎ escribir{(a.panes?.length ?? 0) > 1 ? ` · ${a.panes!.length}` : ""}
                    </div>
                  ) : a.launchable ? (
                    <div className="mt-1 rounded-full border border-accent/40 bg-accent/15 px-2 py-0.5 font-mono text-[9px] text-accent">
                      ▶ abrir
                    </div>
                  ) : null}
                </div>
              );
            })}
            {agents.length === 0 && <div className="py-16 text-center text-white/40">detectando agentes…</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
