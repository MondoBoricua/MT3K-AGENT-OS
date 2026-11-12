import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { agentKey, sendKey, sendToPane, type AgentRow } from "../lib/api";
import { isHerdrPane } from "../lib/herdr-pane";
import { HerdrBadge } from "./HerdrBadge";
import {
  MOSAIC_SLOTS,
  removePreset,
  resolveSlots,
  slotsFrom,
  upsertPreset,
  type MosaicPreset,
  type Session,
} from "../lib/mosaic-presets";
import { layoutForViewport, layoutsForViewport, pickActiveSlot, slotForShortcut, visibleSlotsFor, type MosaicLayout } from "../lib/mosaic-layout";
import { COMPACT_MOSAIC_QUERY, MOSAIC_DESKTOP_QUERY, useMediaQuery } from "../lib/use-media-query";
import { loadLastSlots, loadLayout, loadPresets, saveLastSlots, saveLayout, savePresets } from "../lib/mosaic-storage";
import { paneStatus, statusLabel, statusTone } from "../lib/pane-status";
import AgentLogo from "./AgentLogo";
import MosaicLayoutSwitch from "./MosaicLayoutSwitch";
import MosaicSlotStrip from "./MosaicSlotStrip";
import PaneTile from "./PaneTile";

type Props = {
  open: boolean;
  sessions: Session[];
  onClose: () => void;
  onExpand: (agent: AgentRow, paneId: string) => void;
  onToast?: (text: string, live: boolean, ms?: number) => void;
  onOpenPath?: (path: string, host?: string) => void;
};

const TONE_CLS = {
  emerald: "border-emerald-400/30 bg-emerald-400/10 text-emerald-200",
  amber: "border-amber-400/40 bg-amber-400/10 text-amber-200",
  sky: "border-sky-400/40 bg-sky-400/10 text-sky-200",
  muted: "border-ink-line bg-ink-850/60 text-white/50",
} as const;

const GRID_CLS: Record<MosaicLayout, string> = {
  "1x1": "grid-cols-1 grid-rows-1",
  "1x2": "grid-cols-2 grid-rows-1",
  "2x2": "grid-cols-2 grid-rows-2",
};

const sessionUid = (s: Session) => `${agentKey(s.agent)}|${s.pane.paneId}`;

export default function Mosaic(props: Props) {
  if (!props.open) return null;
  return <MosaicBody {...props} />;
}

function MosaicBody({ sessions, onClose, onExpand, onToast, onOpenPath }: Props) {
  const [slots, setSlots] = useState<(Session | null)[]>(() => resolveSlots(loadLastSlots(), sessions));
  const [focus, setFocus] = useState<number | null>(() => {
    const initial = resolveSlots(loadLastSlots(), sessions);
    const idx = initial.findIndex((s) => s !== null);
    return idx >= 0 ? idx : null;
  });
  const isDesktop = useMediaQuery(MOSAIC_DESKTOP_QUERY);
  const [savedLayout, setLayout] = useState<MosaicLayout>(() => loadLayout());
  const layout = layoutForViewport(savedLayout, isDesktop);
  const [active, setActive] = useState<number>(() => pickActiveSlot(resolveSlots(loadLastSlots(), sessions), null));
  const [presets, setPresets] = useState<MosaicPreset[]>(() => loadPresets());
  const [selectedPreset, setSelectedPreset] = useState("");
  const [text, setText] = useState("");
  const compact = useMediaQuery(COMPACT_MOSAIC_QUERY);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const grow = () => {
      input.style.height = "";
      if (!compact) return;
      const style = getComputedStyle(input);
      const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
      input.style.height = "auto";
      input.style.height = `${Math.min(76, Math.max(40, input.scrollHeight + border))}px`;
    };
    grow();
    let width = input.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const nextWidth = input.getBoundingClientRect().width;
      if (nextWidth === width) return;
      width = nextWidth;
      grow();
    });
    observer.observe(input);
    return () => observer.disconnect();
  }, [text, compact]);
  const [sending, setSending] = useState(false);
  const [enterSends, setEnterSends] = useState(() => {
    try {
      return localStorage.getItem("mt3k.enterSends") !== "false";
    } catch {
      return true;
    }
  });

  // Re-resolve when live sessions change so a tile whose pane died becomes empty again
  useEffect(() => {
    setSlots((prev) => {
      const used = new Set<string>();
      return Array.from({ length: MOSAIC_SLOTS }, (_, i) => {
        const cur = prev[i];
        if (!cur) return null;
        const exact = sessions.find((s) => sessionUid(s) === sessionUid(cur) && !used.has(sessionUid(s)));
        if (exact) {
          used.add(sessionUid(exact));
          return exact;
        }
        return null;
      });
    });
  }, [sessions]);

  // Persist the assignment only when it actually changes: the session refresh above rebuilds the
  // slots array on every parent poll (fresh session objects for live status) without moving anything.
  const lastSaved = useRef<string | null>(null);
  useEffect(() => {
    const assignment = slotsFrom(slots);
    const serialized = JSON.stringify(assignment);
    if (serialized !== lastSaved.current) {
      lastSaved.current = serialized;
      saveLastSlots(assignment);
    }
    setFocus((prev) => (prev !== null && !slots[prev] ? null : prev));
  }, [slots]);

  // 1x1 shows the slot that has focus: focus moves the active slot, never the other way round
  useEffect(() => {
    if (focus !== null) setActive(focus);
  }, [focus]);

  // Keys 1-4 pick the active slot in every layout (ignored while typing or with modifiers)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const idx = slotForShortcut(e, e.target instanceof HTMLElement ? e.target : null);
      if (idx === null) return;
      e.preventDefault();
      e.stopPropagation(); // App.tsx binds 1-9 to "switch project" on window: capture first so it never sees these
      setActive(idx);
      setFocus(slots[idx] ? idx : null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [slots]);

  // Lock body scroll while open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Escape closes mosaic when focus is not inside textarea
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const placedIds = new Set(slots.filter((s): s is Session => s !== null).map(sessionUid));
  // Picker order: by agent name, then host, then folder, so every agent and every machine is reachable
  // without hunting through a wall of same-agent rows (14 sessions across hosts is normal here).
  const freeSessions = sessions
    .filter((s) => !placedIds.has(sessionUid(s)))
    .sort((a, b) =>
      a.agent.name.localeCompare(b.agent.name)
      || (a.agent.host ?? "").localeCompare(b.agent.host ?? "")
      || a.pane.cwd.localeCompare(b.pane.cwd));
  const focusedSession = focus !== null ? slots[focus] ?? null : null;

  const changeLayout = (next: MosaicLayout) => {
    setLayout(next);
    saveLayout(next);
    setActive((cur) => (focus !== null ? focus : cur));
  };

  const selectSlot = (idx: number) => {
    setActive(idx);
    setFocus(slots[idx] ? idx : null);
  };

  const visibleIdx = visibleSlotsFor(layout, active);

  const placeInSlot = (idx: number, s: Session) => {
    setSlots((prev) => prev.map((cur, i) => (i === idx ? s : cur)));
    setFocus(idx);
  };

  const removeSlot = (idx: number) => {
    setSlots((prev) => prev.map((cur, i) => (i === idx ? null : cur)));
    setFocus((prev) => (prev === idx ? null : prev));
  };

  const handleLoadPreset = (name: string) => {
    setSelectedPreset(name);
    const found = presets.find((p) => p.name === name);
    if (!found) return;
    const resolved = resolveSlots(found.slots, sessions);
    setSlots(resolved);
    const firstFilled = resolved.findIndex((s) => s !== null);
    setFocus(firstFilled >= 0 ? firstFilled : null);
    setActive(pickActiveSlot(resolved, null));
  };

  const handleSavePreset = () => {
    const raw = window.prompt("Nombre del preset de mosaico:", selectedPreset || "");
    if (!raw || !raw.trim()) return;
    const next = upsertPreset(presets, { name: raw, slots: slotsFrom(slots) });
    setPresets(next);
    savePresets(next);
    setSelectedPreset(raw.trim());
    onToast?.(`preset «${raw.trim()}» guardado`, true);
  };

  const handleDeletePreset = () => {
    if (!selectedPreset) return;
    const next = removePreset(presets, selectedPreset);
    setPresets(next);
    savePresets(next);
    onToast?.(`preset «${selectedPreset}» borrado`, false);
    setSelectedPreset("");
  };

  const send = async () => {
    if (!focusedSession || !text.trim() || sending) return;
    setSending(true);
    const { agent, pane } = focusedSession;
    const r = await sendToPane(pane.paneId, text, true, agent.host);
    setSending(false);
    if (r?.ok) {
      onToast?.(`enviado a ${agent.name} · ${pane.label}`, true);
      setText("");
    } else {
      onToast?.(r?.err ? `error: ${r.err}` : `no se pudo enviar a ${agent.name}`, false);
    }
  };

  const key = async (k: string) => {
    if (!focusedSession) return;
    const { agent, pane } = focusedSession;
    const r = await sendKey(pane.paneId, k, agent.host);
    if (!r?.ok) onToast?.(r?.err ? `error: ${r.err}` : "no se pudo enviar la tecla", false);
  };

  const shorten = (value: string, limit: number) => value.length > limit ? `…${value.slice(-(limit - 1))}` : value;
  const sendTarget = focusedSession
    ? `${focusedSession.agent.name} · ${shorten(focusedSession.pane.cwd, 24)}${focusedSession.pane.name ? ` · ${shorten(focusedSession.pane.name, 20)}` : ""} (${focus! + 1})`
    : "elige un tile";

  return (
    <div
      className="mosaic fixed inset-0 z-[60] flex flex-col bg-black"
      style={{ paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)", paddingLeft: "env(safe-area-inset-left)", paddingRight: "env(safe-area-inset-right)" }}
    >
      <header className="mosaic-band flex shrink-0 items-center justify-between gap-3 border-b border-ink-line px-4 py-2.5">
        <div className="flex items-center gap-3">
          <span title="Mosaico" className="mosaic-title font-mono text-sm font-semibold text-white"><span aria-hidden="true">⊞</span> Mosaico</span>
          <span className="font-mono text-xs text-white/45">
            {sessions.length} {sessions.length === 1 ? "sesión" : "sesiones"}
          </span>
        </div>

        <MosaicSlotStrip slots={slots} active={active} visible={visibleIdx} onSelect={selectSlot} />

        <div className="flex items-center gap-2">
          <MosaicLayoutSwitch layout={layout} options={layoutsForViewport(isDesktop)} onChange={changeLayout} />
          <select
            aria-label="Presets del mosaico"
            title="cargar preset"
            value={selectedPreset}
            onChange={(e) => handleLoadPreset(e.target.value)}
            className="rounded-lg border border-ink-line bg-ink-850/60 px-2.5 py-1 font-mono text-xs text-white/80 focus:border-accent/50 focus:outline-none"
          >
            <option value="">presets ({presets.length})…</option>
            {presets.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            aria-label="guardar preset"
            title="guardar preset"
            onClick={handleSavePreset}
            className="rounded-lg border border-ink-line bg-ink-850/60 px-2.5 py-1 font-mono text-xs text-white/70 transition hover:border-accent/50 hover:text-accent"
          >
            <span className="mosaic-full-label">guardar</span><span className="mosaic-compact-icon" aria-hidden="true">▣</span>
          </button>
          <button
            type="button"
            aria-label="borrar preset"
            title="borrar preset"
            onClick={handleDeletePreset}
            disabled={!selectedPreset}
            className="rounded-lg border border-ink-line bg-ink-850/60 px-2.5 py-1 font-mono text-xs text-white/70 transition hover:border-red-400/50 hover:text-red-300 disabled:opacity-40"
          >
            <span className="mosaic-full-label">borrar</span><span className="mosaic-compact-icon" aria-hidden="true">⌫</span>
          </button>
          <button
            type="button"
            aria-label="cerrar mosaico"
            title="cerrar mosaico"
            onClick={onClose}
            className="rounded-lg border border-ink-line px-2.5 py-1 font-mono text-xs text-white/60 transition hover:text-white"
          >
            <span className="mosaic-full-label">✕ cerrar</span><span className="mosaic-compact-icon" aria-hidden="true">✕</span>
          </button>
        </div>
      </header>
      <div className={`mosaic-grid grid min-h-0 min-w-0 flex-1 gap-2 p-2 ${GRID_CLS[layout]}`}>
        {visibleIdx.map((idx) => {
          const slot = slots[idx];
          return slot ? (
            <PaneTile
              key={`${idx}-${sessionUid(slot)}`}
              session={slot}
              focused={focus === idx}
              tickMs={1000}
              onFocus={() => setFocus(idx)}
              onExpand={() => onExpand(slot.agent, slot.pane.paneId)}
              onRemove={() => removeSlot(idx)}
              onToast={onToast}
              onOpenPath={onOpenPath}
            />
          ) : (
            <div
              key={`empty-${idx}`}
              className="mosaic-empty flex min-h-0 min-w-0 flex-col rounded-xl border border-dashed border-ink-line bg-ink-900/40 p-3"
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="font-mono text-[10px] uppercase tracking-wider text-white/35">
                  Slot {idx + 1} · elegir sesión · {freeSessions.length} {freeSessions.length === 1 ? "libre" : "libres"}
                </span>
              </div>
              {freeSessions.length === 0 ? (
                <div className="flex flex-1 items-center justify-center font-mono text-xs text-white/30">
                  sin sesiones libres
                </div>
              ) : (
                <div className="grid flex-1 grid-cols-2 content-start gap-1.5 overflow-y-auto overscroll-contain">
                  {freeSessions.map((s) => {
                    const st = paneStatus(s.pane);
                    const tone = statusTone(st);
                    return (
                      <button
                        key={sessionUid(s)}
                        type="button"
                        onClick={() => placeInSlot(idx, s)}
                        className="flex min-w-0 items-center justify-between gap-2 rounded-lg border border-ink-line bg-ink-850/60 px-2.5 py-1 text-left font-mono text-[11px] transition hover:border-accent/50 hover:bg-ink-850"
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <AgentLogo id={s.agent.id} logo={s.agent.logo} online={s.agent.online} className="h-4 w-4 shrink-0" />
                          <span className="shrink-0 font-semibold text-white">{s.agent.name}</span>
                          {s.agent.host && (
                            <span className="shrink-0 rounded border border-sky-400/30 bg-sky-400/10 px-1 text-[9px] text-sky-300">
                              {s.agent.host}
                            </span>
                          )}
                          {isHerdrPane(s.pane) && <HerdrBadge />}
                          {s.pane.name && <span className="shrink-0 font-semibold text-accent">{s.pane.name}</span>}
                          <span className="truncate text-[11px] text-white/50">{s.pane.cwd}</span>
                        </div>
                        <span title={s.pane.statusRule} className={`shrink-0 rounded-full border px-2 py-0.5 text-[9px] ${TONE_CLS[tone]}`}>
                          {statusLabel(st)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <footer
        className="shrink-0 border-t border-ink-line bg-ink-900/95 p-3"
      >
        <div className="mb-2 flex items-center gap-1.5">
          {[
            { k: "Up", label: "↑", title: "Arriba" },
            { k: "Down", label: "↓", title: "Abajo" },
            { k: "Left", label: "←", title: "Izquierda" },
            { k: "Right", label: "→", title: "Derecha" },
            { k: "Enter", label: "↵", title: "Enter" },
            { k: "Escape", label: "esc", title: "Escape" },
            { k: "Tab", label: "tab", title: "Tab" },
            { k: "ShiftTab", label: "⇧ modo", title: "Shift+Tab: cambia el modo de permisos" },
          ].map((btn) => (
            <button
              key={btn.k}
              type="button"
              disabled={!focusedSession}
              onClick={() => void key(btn.k)}
              title={btn.title}
              aria-label={btn.title}
              className="flex-1 rounded-lg border border-ink-line bg-ink-850/60 py-1.5 font-mono text-xs text-white/80 transition hover:border-accent/40 active:bg-accent/20 active:text-accent disabled:opacity-40"
            >
              {btn.label}
            </button>
          ))}
        </div>

        <textarea
          ref={inputRef}
          aria-label={focusedSession ? `Mensaje a ${sendTarget}` : sendTarget}
          value={text}
          disabled={!focusedSession}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void send();
            } else if (e.key === "Enter" && !e.shiftKey && !e.altKey && enterSends && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          rows={compact ? 1 : 2}
          placeholder={focusedSession ? `Mensaje a ${sendTarget}…` : sendTarget}
          className="w-full resize-none rounded-lg border border-ink-line bg-ink-850/60 px-3 py-2 font-mono text-sm text-white placeholder:text-white/30 focus:border-accent/50 focus:outline-none disabled:opacity-40"
        />

        <div className="mt-2 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <label className="flex cursor-pointer items-center gap-2 font-mono text-[11px] text-white/55">
              <input
                type="checkbox"
                aria-label="Enviar al pulsar Enter"
                checked={enterSends}
                onChange={(e) => {
                  setEnterSends(e.target.checked);
                  try {
                    localStorage.setItem("mt3k.enterSends", String(e.target.checked));
                  } catch {
                    /* private mode */
                  }
                }}
                className="accent-[oklch(62%_0.23_25)]"
              />
              ↵ enviar
            </label>
            <span className="mosaic-focus font-mono text-[11px] text-white/40" title={sendTarget}>
              {focusedSession ? `foco: ${sendTarget}` : sendTarget}
            </span>
          </div>
          <button
            type="button"
            onClick={() => void send()}
            disabled={!focusedSession || !text.trim() || sending}
            className="rounded-lg bg-accent/20 px-4 py-1.5 font-mono text-sm font-medium text-accent transition hover:bg-accent/30 disabled:opacity-40"
          >
            {sending ? "enviando…" : "enviar"}
          </button>
        </div>
      </footer>
    </div>
  );
}
