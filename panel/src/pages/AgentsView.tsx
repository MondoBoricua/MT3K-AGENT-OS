import { useEffect, useState } from "react";
import type { AgentRow, RestoreMissingItem, RestoreState } from "../lib/api";
import { getLogs, broadcast, agentKey, getRestore, restoreSessions } from "../lib/api";
import { paneStatus, statusTone } from "../lib/pane-status";
import AgentLogo from "../components/AgentLogo";
import { HerdrBadge } from "../components/HerdrBadge";
import { isHerdrPane } from "../lib/herdr-pane";

const RESTORE_DISMISS_KEY = "mt3k.restore.dismissed";

const HACKER = "/sprites/hacker.webp"; // standing/idle (row 2 = running-left, full frames)
const LAPTOP = "/sprites/laptop.png"; // coding-on-laptop strip (6 good frames)
const CODE_COLORS = ["#34d399", "#e6edf3", "#fb923c", "#60a5fa"];
const CODE_W = [82, 56, 70, 44];

/** Si el evento viene de un enlace o botón dentro de la tarjeta, no abrir la ficha del agente */
function eventFromCardControl(e: { target: EventTarget | null }) {
  const el = e.target instanceof HTMLElement ? e.target : null;
  return el?.closest("a, button") != null;
}

type Props = {
  agents: AgentRow[];
  onOpen: (a: AgentRow) => void;
  onOpenMosaic?: () => void;
  onToast?: (text: string, live: boolean) => void;
  focusPath?: string;
};

export default function AgentsView({ agents, onOpen, onOpenMosaic, onToast, focusPath }: Props) {
  const live = agents.filter((a) => a.running).length;
  const ready = agents.filter((a) => a.online).length;
  const sessions = agents.flatMap((a) => (a.panes ?? []).map((p) => ({ agent: a, pane: p })));
  const waitingCount = sessions.filter((s) => s.pane.waiting).length;
  const doneCount = sessions.filter((s) => paneStatus(s.pane) === "done").length;

  // broadcast: one message → every live session on every federated host
  const [bcText, setBcText] = useState("");
  const [bcSending, setBcSending] = useState(false);
  const sendBroadcast = async () => {
    const text = bcText.trim();
    if (!text || bcSending) return;
    setBcSending(true);
    const r = await broadcast(text, focusPath); // under Focus it only reaches the project's sessions
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

  const [restoreState, setRestoreState] = useState<RestoreState | null>(null);
  const [restoringKey, setRestoringKey] = useState<string | null>(null);
  const [dismissedSavedAt, setDismissedSavedAt] = useState<string>(() => {
    try { return localStorage.getItem(RESTORE_DISMISS_KEY) ?? ""; } catch { return ""; }
  });

  useEffect(() => {
    let alive = true;
    getRestore().then((r) => {
      if (alive && r?.ok) setRestoreState(r);
    });
    return () => { alive = false; };
  }, [sessions.length]);

  const missingSessions = restoreState?.missing ?? [];
  const restoreVisible =
    missingSessions.length > 0 &&
    !!restoreState?.savedAt &&
    restoreState.savedAt !== dismissedSavedAt;

  const dismissRestore = async () => {
    if (restoringKey) return;
    const sa = restoreState?.savedAt ?? "";
    setDismissedSavedAt(sa);
    try { if (sa) localStorage.setItem(RESTORE_DISMISS_KEY, sa); } catch { /* private mode */ }
    setRestoringKey("dismiss");
    const r = await restoreSessions({ dismissAll: true });
    setRestoringKey(null);
    if (r?.ok) {
      const fresh = await getRestore();
      if (fresh?.ok) setRestoreState(fresh);
      else setRestoreState(null);
    } else if (r?.err) {
      onToast?.(`error: ${r.err}`, false);
    }
  };

  const handleRestoreAll = async () => {
    if (restoringKey) return;
    setRestoringKey("all");
    const r = await restoreSessions({ all: true });
    setRestoringKey(null);
    const okCount = r?.results?.filter((x) => x.ok).length ?? 0;
    if (r?.ok) {
      onToast?.(`↻ ${okCount} ${okCount === 1 ? "sesión restaurada" : "sesiones restauradas"}`, true);
      window.dispatchEvent(new Event("mt3k:refresh-change"));
      const fresh = await getRestore();
      if (fresh?.ok) setRestoreState(fresh);
      else setRestoreState(null);
    } else {
      onToast?.(r?.err ? `error: ${r.err}` : "no se pudieron restaurar las sesiones", false);
    }
  };

  const handleRestoreOne = async (item: RestoreMissingItem) => {
    const key = item.sessionName ?? `${item.agentId}|${item.cwd}`;
    if (restoringKey || item.reason === "missing-dir" || item.reason === "ambiguous-owner") return;
    setRestoringKey(key);
    const r = await restoreSessions({
      items: [{ agentId: item.agentId, cwd: item.cwd, ...(item.sessionName ? { sessionName: item.sessionName } : {}) }],
    });
    setRestoringKey(null);
    const res = r?.results?.[0];
    if (r?.ok && res?.ok) {
      onToast?.(`↻ ${item.agentName} restaurado en ${item.cwd}`, true);
      window.dispatchEvent(new Event("mt3k:refresh-change"));
      const fresh = await getRestore();
      if (fresh?.ok) setRestoreState(fresh);
    } else {
      onToast?.(res?.err ?? r?.err ?? "no se pudo restaurar la sesión", false);
    }
  };

  return (
    <div className="room relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="z-20 flex items-start justify-between gap-4 px-6 pt-6">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Agents View</h1>
          <p className="font-mono text-xs text-white/45">{live} codeando · {ready} listos · toca un agente para escribirle o abrirle una sesión en tmux</p>
        </div>
        {/* desktop only: the 2x2 mosaic entry point, big enough to be seen from across the room */}
        {onOpenMosaic && (
          <button
            type="button"
            onClick={onOpenMosaic}
            disabled={sessions.length === 0}
            title={sessions.length === 0 ? "abre una sesión primero" : "ver hasta 4 terminales a la vez"}
            className="shrink-0 rounded-xl border border-accent/60 bg-accent/20 px-4 py-2 font-mono text-sm font-semibold text-accent shadow-[0_0_24px_-6px] shadow-accent/60 transition hover:bg-accent/30 disabled:cursor-not-allowed disabled:opacity-40"
          >
            ⊞ Mosaico
          </button>
        )}
      </div>

      <div className="room-body relative flex-1">
        <div className="room-wall absolute inset-x-0 top-0 h-1/2" />
        <div className="room-floor absolute inset-x-0 bottom-0 h-[72%]" />

        {/* wall-mounted mission-control screen — fills the empty upper half of the room */}
        <div className="wallscreen absolute left-1/2 top-[6%] z-20 w-[min(620px,92%)] -translate-x-1/2 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-accent">◉ Sala de operaciones</span>
            <div className="flex items-center gap-2">
              <span className="font-mono text-[10px] text-white/45">
                {live} codeando · {sessions.length} {sessions.length === 1 ? "sesión" : "sesiones"}
                {waitingCount > 0 && <span className="text-amber-300"> · ⏳ {waitingCount} esperando</span>}
                {doneCount > 0 && <span className="text-sky-300"> · ✓ {doneCount} terminados</span>}
              </span>
              {onOpenMosaic && sessions.length > 0 && (
                <button
                  type="button"
                  onClick={onOpenMosaic}
                  className="rounded-lg border border-ink-line bg-ink-850/60 px-2 py-0.5 font-mono text-[10px] text-accent transition hover:border-accent/50 hover:bg-accent/15"
                >
                  ⊞ mosaico
                </button>
              )}
            </div>
          </div>
          {/* live tmux sessions as tappable chips (amber = blocked, emerald = working, sky = done, muted = idle/unknown) */}
          <div className="mt-2 flex max-h-[72px] flex-wrap gap-1.5 overflow-y-auto sm:max-h-none">
            {sessions.map(({ agent: a, pane: p }) => {
              const st = paneStatus(p);
              const tone = statusTone(st);
              const chipCls =
                tone === "amber"
                  ? "border-amber-400/40 bg-amber-400/10 text-amber-200 hover:bg-amber-400/20"
                  : tone === "emerald"
                    ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-200 hover:bg-emerald-400/20"
                    : tone === "sky"
                      ? "border-sky-400/40 bg-sky-400/10 text-sky-200 hover:bg-sky-400/20"
                      : "border-ink-line bg-ink-850/60 text-white/60 hover:border-accent/40 hover:text-white";
              return (
                <button key={`${agentKey(a)}-${p.paneId}`} onClick={() => onOpen(a)} title={p.statusRule}
                  className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[10px] transition ${chipCls}`}>
                  <AgentLogo id={a.id} logo={a.logo} online className="h-3 w-3" />
                  {a.host && <span className="text-sky-300">{a.host}·</span>}
                  {isHerdrPane(p) && <HerdrBadge />}
                  {p.name && <span className="font-semibold text-accent">{p.name}</span>}
                  <span className="max-w-[160px] truncate">{p.cwd}</span>
                  {st === "blocked" && <span>⏳</span>}
                  {st === "done" && <span>✓</span>}
                </button>
              );
            })}
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
          {restoreVisible && (
            <div className="mt-2 rounded-lg border border-amber-400/35 bg-amber-400/10 px-2.5 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void handleRestoreAll()}
                    disabled={restoringKey !== null}
                    className="font-mono text-[10px] font-semibold text-amber-200 transition hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {restoringKey === "all"
                      ? "↻ restaurando sesiones…"
                      : `↻ ${missingSessions.length} ${missingSessions.length === 1 ? "sesión" : "sesiones"} de antes del reinicio · restaurar todas`}
                  </button>
                  <button
                    type="button"
                    onClick={() => void dismissRestore()}
                    disabled={restoringKey !== null}
                    className="rounded border border-ink-line bg-ink-850/60 px-2 py-0.5 font-mono text-[10px] text-white/60 transition hover:border-white/30 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    descartar
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => void dismissRestore()}
                  disabled={restoringKey !== null}
                  title="descartar sesiones pendientes"
                  className="font-mono text-[10px] text-white/45 transition hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                >
                  ✕
                </button>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {missingSessions.map((m) => {
                  // unique even if a server ever sends one session twice (one entry per session+agent)
                  const itemKey = `${m.sessionName ?? m.cwd}|${m.agentId}`;
                  const missingDir = m.reason === "missing-dir";
                  const ambiguous = m.reason === "ambiguous-owner";
                  return (
                    <button
                      key={itemKey}
                      type="button"
                      disabled={restoringKey !== null || missingDir || ambiguous}
                      onClick={() => void handleRestoreOne(m)}
                      title={
                        missingDir
                          ? "la carpeta ya no existe"
                          : ambiguous
                            ? `varios agentes reclaman esta sesión (${(m.claimants ?? []).join(", ")}): ábrela a mano o descártala`
                            : `restaurar ${m.agentName} en ${m.cwd}`
                      }
                      className="flex items-center gap-1.5 rounded-full border border-ink-line bg-ink-850/75 px-2.5 py-0.5 font-mono text-[10px] text-white/75 transition hover:border-accent/50 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <AgentLogo id={m.agentId} online className="h-3 w-3" />
                      <span className="font-semibold text-white">{m.agentName}</span>
                      {m.name && <span className="font-semibold text-accent">{m.name}</span>}
                      <span className="max-w-[140px] truncate text-white/55">{m.cwd}</span>
                      <span className={m.resumable ? "text-emerald-300" : "text-white/45"}>
                        {missingDir ? "⊘ sin carpeta" : ambiguous ? "? dueño dudoso" : m.resumable ? "↺ reanuda" : "○ nueva"}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* scroll starts at the first agent on mobile (mx-auto centers it only when it fits) */}
        <div className="room-scroll absolute inset-0 z-10 flex snap-x items-end justify-start overflow-x-auto overscroll-contain pb-[6%] sm:justify-center">
          <div className="room-crowd mx-auto flex items-end gap-0 px-3 sm:gap-8 sm:px-8">
            {agents.map((a, i) => {
              const hue = (i * 53) % 360;
              const offline = !a.online;
              const sendable = (a.panes?.length ?? 0) > 0;
              const caps = a.capabilities;
              // Con capacidades (servidor nuevo): acciones por contrato; sin ellas → lógica legada
              const openable = caps
                ? sendable
                  || (caps.launch?.supported && !!a.launchable)
                  || !!a.webPort
                  || !!a.webOff
                  || (caps.view?.supported && !!a.url && !sendable)
                : sendable || !!a.launchable || !!a.webPort || !!a.webOff;
              const externalLink = caps?.view?.supported && a.url && !sendable;
              const showLaunchHint = caps ? caps.launch?.supported && !!a.launchable : !!a.launchable;
              return (
                <div key={agentKey(a)}
                  onClick={(e) => { if (eventFromCardControl(e)) return; openable && onOpen(a); }}
                  role={openable ? "button" : undefined}
                  tabIndex={openable ? 0 : undefined}
                  onKeyDown={openable ? (e) => {
                    if (eventFromCardControl(e)) return;
                    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(a); }
                  } : undefined}
                  className={`station flex shrink-0 snap-center flex-col items-center rounded-xl outline-none transition ${openable ? "cursor-pointer hover:bg-white/[0.03] focus-visible:ring-2 focus-visible:ring-accent/60" : ""}`}>
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
                      <AgentLogo id={a.id} logo={a.logo} online={a.online} className="h-3.5 w-3.5" />
                      <span className="font-mono text-[11px] font-semibold leading-tight">{a.name}</span>
                      {a.host && <span className="rounded border border-sky-400/30 bg-sky-400/10 px-1 font-mono text-[8px] text-sky-300">{a.host}</span>}
                    </div>
                    <div className={`font-mono text-[9px] uppercase tracking-wider ${a.waiting ? "text-amber-300" : a.running ? "text-emerald-300" : a.online ? "text-white/45" : "text-white/25"}`}>
                      {a.waiting ? "⏳ esperando input" : a.running ? (sendable ? "● codeando" : "● fuera de tmux") : a.online ? "○ listo" : "offline"}
                    </div>
                    {externalLink && (
                      <div className="mt-0.5 font-mono text-[8px] normal-case tracking-normal text-white/30">estado no verificado</div>
                    )}
                  </div>
                  {/* action hint: live session → write, launchable-only → spawn, web-external → enlace */}
                  {sendable ? (
                    <div className="mt-1 rounded-full border border-accent/40 bg-accent/15 px-2 py-0.5 font-mono text-[9px] text-accent">
                      ✎ escribir{(a.panes?.length ?? 0) > 1 ? ` · ${a.panes!.length}` : ""}
                    </div>
                  ) : externalLink ? (
                    <a
                      href={a.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                      className="mt-1 rounded-full border border-accent/40 bg-accent/15 px-2 py-0.5 font-mono text-[9px] text-accent transition hover:bg-accent/25"
                    >
                      Abrir {a.name} ↗
                    </a>
                  ) : showLaunchHint ? (
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
