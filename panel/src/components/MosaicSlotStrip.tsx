import type { Session } from "../lib/mosaic-presets";
import { paneStatus, statusLabel, statusTone } from "../lib/pane-status";

type Props = {
  slots: readonly (Session | null)[];
  active: number;
  visible?: readonly number[];
  onSelect: (idx: number) => void;
};

const DOT_CLS = {
  emerald: "bg-emerald-400",
  amber: "bg-amber-400",
  sky: "bg-sky-400",
  muted: "bg-white/30",
} as const;

export default function MosaicSlotStrip({ slots, active, visible = [], onSelect }: Props) {
  return (
    <nav aria-label="Slots del mosaico" className="flex shrink-0 gap-1.5 px-2 pt-2">
      {slots.map((slot, idx) => {
        const label = slot ? slot.pane.name || slot.agent.name : null;
        const tone = slot ? statusTone(paneStatus(slot.pane)) : null;
        const status = slot ? statusLabel(paneStatus(slot.pane)).replace(/^[●⏳✓○] /, "") : null;
        const title = slot ? `Slot ${idx + 1}: ${slot.agent.name} · ${label} · ${status} · ${slot.pane.cwd} (tecla ${idx + 1})` : `Slot ${idx + 1}: vacío, asignar sesión (tecla ${idx + 1})`;
        return (
          <button
            key={idx}
            type="button"
            aria-current={active === idx ? "true" : undefined}
            data-visible={visible.includes(idx) ? "true" : undefined}
            title={title}
            aria-label={title}
            onClick={() => onSelect(idx)}
            className={`flex min-w-0 flex-1 items-center gap-2 rounded-lg border px-2.5 py-1 font-mono text-xs ${
              active === idx
                ? "border-accent/60 bg-accent/15 text-white"
                : visible.includes(idx)
                  ? "border-accent/30 bg-accent/5 text-white/80 hover:border-accent/50 hover:text-white"
                  : "border-ink-line bg-ink-850/60 text-white/60 hover:border-accent/40 hover:text-white"
            }`}
          >
            <span className="shrink-0 text-white/40">{idx + 1}</span>
            {slot && tone ? (
              <>
                <span className={`h-2 w-2 shrink-0 rounded-full ${DOT_CLS[tone]}`} />
                <span className="truncate">{label}</span>
              </>
            ) : (
              <span className="text-white/40">+</span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
