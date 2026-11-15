import { bucketName, fmtReset, usageTone, windowLabel, type UsageWindow } from "../lib/usage";

const FILL = { emerald: "bg-emerald-400", amber: "bg-amber-400", red: "bg-red-400" } as const;
const TEXT = { emerald: "text-white/55", amber: "text-amber-300", red: "text-red-300" } as const;

/** One quota window: label, percentage used, bar and time of reset. `compact` is the nameplate size. */
export default function UsageBar({ window: w, now, tag, compact }: { window: UsageWindow; now: number; tag?: string; compact?: boolean }) {
  const tone = usageTone(w.usedPct);
  const reset = fmtReset(w.resetsAt, now);
  const pct = `${Math.round(w.usedPct)}%`;
  const name = bucketName(w);
  const title = `${tag ? `${tag} · ` : ""}${windowLabel(w)}: ${pct} usado${reset ? ` · reinicia ${reset}` : ""}`;
  if (compact) {
    return (
      <div className="mt-0.5 w-full" title={title}>
        <div className={`flex items-baseline justify-between gap-1.5 font-mono text-[8px] normal-case tracking-normal ${TEXT[tone]}`}>
          <span className="truncate">{tag ? `${tag} ` : ""}{pct}</span>
          {reset && <span className="shrink-0 text-white/35">↻ {reset.replace(/^en /, "")}</span>}
        </div>
        <div className="h-[3px] overflow-hidden rounded-full bg-white/10"><div className={`h-full rounded-full ${FILL[tone]}`} style={{ width: `${w.usedPct}%` }} /></div>
      </div>
    );
  }
  return (
    <div title={title}>
      <div className="flex items-baseline justify-between gap-2 font-mono text-[10px]">
        {/* the bucket name gives way first: the window ("7 días" / "5 horas") is what tells two rows apart */}
        <span className="flex min-w-0 gap-1 text-white/55">
          {name && <span className="truncate">{name}</span>}
          {w.window && <span className="shrink-0">{name ? "· " : ""}{w.window}</span>}
        </span>
        <span className={`shrink-0 ${TEXT[tone]}`}>{pct}{reset && <span className="text-white/35"> · {reset}</span>}</span>
      </div>
      <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-white/10"><div className={`h-full rounded-full ${FILL[tone]}`} style={{ width: `${w.usedPct}%` }} /></div>
    </div>
  );
}
