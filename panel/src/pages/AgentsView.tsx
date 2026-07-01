import type { AgentRow } from "../lib/api";
import AgentLogo from "../components/AgentLogo";

const HACKER = "/sprites/hacker.webp"; // standing/idle (row 2 = running-left, full frames)
const LAPTOP = "/sprites/laptop.png"; // coding-on-laptop strip (6 good frames)
const CODE_COLORS = ["#34d399", "#e6edf3", "#fb923c", "#60a5fa"];
const CODE_W = [82, 56, 70, 44];

type Props = { agents: AgentRow[]; onOpen: (a: AgentRow) => void };

export default function AgentsView({ agents, onOpen }: Props) {
  const live = agents.filter((a) => a.running).length;
  const ready = agents.filter((a) => a.online).length;

  return (
    <div className="room relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="z-20 px-6 pt-6">
        <h1 className="text-xl font-semibold tracking-tight">Agents View</h1>
        <p className="font-mono text-xs text-white/45">{live} codeando · {ready} listos · toca un agente para escribirle o abrirle una sesión en tmux</p>
      </div>

      <div className="relative flex-1">
        <div className="room-wall absolute inset-x-0 top-0 h-1/2" />
        <div className="room-floor absolute inset-x-0 bottom-0 h-[72%]" />

        {/* scroll starts at the first agent on mobile (mx-auto centers it only when it fits) */}
        <div className="absolute inset-0 z-10 flex snap-x items-end justify-start overflow-x-auto pb-[6%] sm:justify-center">
          <div className="mx-auto flex items-end gap-3 px-5 sm:gap-8 sm:px-8">
            {agents.map((a, i) => {
              const hue = (i * 53) % 360;
              const offline = !a.online;
              const sendable = (a.panes?.length ?? 0) > 0;
              const openable = sendable || !!a.launchable; // launchable agents open the sheet to spawn a session
              return (
                <div key={a.id}
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
                    </div>
                    <div className={`font-mono text-[9px] uppercase tracking-wider ${a.running ? "text-emerald-300" : a.online ? "text-white/45" : "text-white/25"}`}>
                      {a.running ? "● codeando" : a.online ? "○ listo" : "offline"}
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
