import { useEffect, useRef, useState } from "react";
import { paneResize, setPaneLabel, type PaneEvent } from "../lib/api";
import { measuredLineHeightPx } from "../lib/alt-pane-wheel";
import type { Session } from "../lib/mosaic-presets";
import { paneStatus, statusLabel, statusTone } from "../lib/pane-status";
import { applyPaneEvent } from "../lib/pane-stream";
import { usePaneStream } from "../lib/use-pane-stream";
import AgentLogo from "./AgentLogo";
import { TerminalLine } from "./TerminalLines";

type Props = {
  session: Session;
  focused: boolean;
  tickMs: number;
  onFocus: () => void;
  onExpand: () => void;
  onRemove: () => void;
  onToast?: (text: string, live: boolean, ms?: number) => void;
};

const TONE_CLS = {
  emerald: "border-emerald-400/30 bg-emerald-400/10 text-emerald-200",
  amber: "border-amber-400/40 bg-amber-400/10 text-amber-200",
  sky: "border-sky-400/40 bg-sky-400/10 text-sky-200",
  muted: "border-ink-line bg-ink-850/60 text-white/50",
} as const;

const TILE_FONT_PX = 12;

export default function PaneTile({ session, focused, tickMs, onFocus, onExpand, onRemove, onToast }: Props) {
  const { agent, pane } = session;
  const host = agent.host;
  const [term, setTerm] = useState<string[]>([]);
  const [localName, setLocalName] = useState<string | null>(null);
  const latestTerm = useRef<string[]>([]);
  const termRef = useRef<HTMLPreElement>(null);
  const stickToBottom = useRef(true);
  const [scrolledUp, setScrolledUp] = useState(false);
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastResize = useRef<{ cols: number; rows: number } | null>(null);

  useEffect(() => {
    latestTerm.current = [];
    setTerm([]);
    setLocalName(null);
    stickToBottom.current = true;
    setScrolledUp(false);
    lastResize.current = null;
  }, [pane.paneId, host]);

  useEffect(() => {
    setLocalName(null);
  }, [pane.name]);

  const displayName = localName !== null ? (localName || undefined) : pane.name;

  const handleRename = async () => {
    const next = window.prompt("Nombre de la sesión", displayName ?? "");
    if (next === null) return;
    const r = await setPaneLabel(pane.paneId, next.trim(), host);
    if (r?.ok) {
      setLocalName(r.name ?? "");
      window.dispatchEvent(new Event("mt3k:refresh-change"));
      onToast?.(r.name ? `sesión renombrada a «${r.name}»` : "nombre de sesión borrado", true);
    } else {
      onToast?.(r?.err ? `error: ${r.err}` : "no se pudo renombrar la sesión", false);
    }
  };

  const onEvent = (ev: PaneEvent) => {
    const next = applyPaneEvent(latestTerm.current, ev);
    latestTerm.current = next;
    setTerm(next);
  };

  usePaneStream({
    paneId: pane.paneId,
    host,
    enabled: true,
    tickMs,
    onEvent,
  });

  useEffect(() => {
    const el = termRef.current;
    if (el && stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [term]);

  useEffect(() => {
    const el = termRef.current;
    if (!el) return;
    const scheduleResize = () => {
      if (resizeTimer.current) clearTimeout(resizeTimer.current);
      resizeTimer.current = setTimeout(() => {
        resizeTimer.current = null;
        const pre = termRef.current;
        if (!pre || pre.clientWidth <= 0 || pre.clientHeight <= 0) return;
        const lh = measuredLineHeightPx(pre, TILE_FONT_PX);
        const cols = Math.min(220, Math.max(60, Math.floor((pre.clientWidth - 24) / (0.62 * TILE_FONT_PX))));
        const rows = Math.min(80, Math.max(20, Math.floor(pre.clientHeight / lh)));
        const prev = lastResize.current;
        if (prev && prev.cols === cols && prev.rows === rows) return;
        void paneResize(pane.paneId, cols, rows, host).then((r) => {
          if (r?.ok && !r.skipped) {
            lastResize.current = { cols, rows };
          }
        });
      }, 300);
    };
    scheduleResize();
    const ro = new ResizeObserver(scheduleResize);
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (resizeTimer.current) clearTimeout(resizeTimer.current);
    };
  }, [pane.paneId, host]);

  const onScroll = () => {
    const el = termRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    stickToBottom.current = atBottom;
    setScrolledUp((prev) => (prev === !atBottom ? prev : !atBottom));
  };

  const jumpToBottom = (e: React.MouseEvent) => {
    e.stopPropagation();
    const el = termRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    stickToBottom.current = true;
    setScrolledUp(false);
  };

  const st = paneStatus(pane);
  const tone = statusTone(st);

  return (
    <div
      onClick={onFocus}
      className={`mosaic-tile flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-ink-line bg-ink-900/90 transition ${
        focused ? "ring-2 ring-accent/60" : ""
      }`}
    >
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-ink-line bg-ink-850/60 px-2.5 py-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <AgentLogo id={agent.id} logo={agent.logo} online={agent.online} className="h-4 w-4 shrink-0" />
          <span className="shrink-0 font-mono text-xs font-semibold text-white">{agent.name}</span>
          {host && (
            <span className="shrink-0 rounded border border-sky-400/30 bg-sky-400/10 px-1 font-mono text-[9px] text-sky-300">
              {host}
            </span>
          )}
          {displayName && (
            <span className="shrink-0 font-mono text-[11px] font-semibold text-accent" title={displayName}>
              {displayName}
            </span>
          )}
          <span className="truncate font-mono text-[10px] text-white/45" title={pane.cwd}>
            {pane.cwd}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span title={pane.statusRule} className={`rounded-full border px-2 py-0.5 font-mono text-[9px] ${TONE_CLS[tone]}`}>
            {statusLabel(st)}
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void handleRename();
            }}
            title="renombrar sesión"
            className="rounded border border-ink-line px-1.5 py-0.5 font-mono text-[10px] text-white/60 transition hover:border-accent/50 hover:text-accent"
          >
            ✎
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onExpand();
            }}
            title="ampliar a pantalla completa"
            className="rounded border border-ink-line px-1.5 py-0.5 font-mono text-[10px] text-white/60 transition hover:border-accent/50 hover:text-accent"
          >
            ⤢
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            title="quitar del mosaico"
            className="rounded border border-ink-line px-1.5 py-0.5 font-mono text-[10px] text-white/60 transition hover:border-red-400/50 hover:text-red-300"
          >
            ✕
          </button>
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <pre
          ref={termRef}
          onScroll={onScroll}
          style={{ fontSize: TILE_FONT_PX }}
          className="flex-1 overflow-y-auto overflow-x-hidden whitespace-pre-wrap break-words bg-black px-2.5 py-2 font-mono leading-none text-white/90"
        >
          {term.length > 0 && !(term.length === 1 && term[0] === "")
            ? term.map((line, idx) => <TerminalLine key={idx} line={line} last={idx === term.length - 1} />)
            : <span className="opacity-40">cargando terminal…</span>}
        </pre>
        {scrolledUp && (
          <button
            type="button"
            onClick={jumpToBottom}
            className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full border border-ink-line bg-ink-900/90 px-2.5 py-1 font-mono text-[10px] text-white/70 shadow-lg backdrop-blur transition hover:border-accent/50 hover:text-accent"
          >
            ↓ al final
          </button>
        )}
      </div>
    </div>
  );
}
