import { useEffect, useState } from "react";
import AgentLogo from "./AgentLogo";
import UsageBar from "./UsageBar";
import { useUsage } from "../lib/use-usage";
import { isExpired } from "../lib/usage";

const CLOCK_MS = 30_000; // the "en 25 min" texts move even when no new report arrives

/** Home section: every account with every measured window. Renders nothing on hosts without agent-usage. */
export default function UsagePanel() {
  const { report, loading, refresh } = useUsage();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(iv);
  }, []);
  if (!report?.available) return null;
  const busy = loading || report.refreshing;
  const observed = report.observedAt ? new Date(report.observedAt).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit", hour12: false }) : null;
  return (
    <div className="mb-7">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-white/50"><span className="text-accent">✦</span> Cuotas de los agentes</div>
        <div className="flex items-center gap-2 font-mono text-[10px] text-white/35">
          {report.err && <span className="text-amber-300/80" title={report.err}>última lectura falló</span>}
          {observed && <span>medido {observed}</span>}
          <button type="button" onClick={refresh} disabled={busy} title="medir de nuevo (el servidor espera 1 min entre lecturas)"
            className="rounded border border-ink-line bg-ink-850/60 px-2 py-0.5 text-white/60 transition hover:border-accent/50 hover:text-white disabled:cursor-wait disabled:opacity-40">
            {busy ? "midiendo…" : "↻ medir"}
          </button>
        </div>
      </div>
      {report.accounts.length === 0 ? (
        <div className="surface p-4 font-mono text-xs text-white/40">{busy ? "midiendo cuotas…" : "sin cuentas medidas"}</div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {report.accounts.map((a) => {
            const current = a.windows.filter((w) => !isExpired(w, now));
            return (
              <div key={a.id} className="surface p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <AgentLogo id={a.agentId} online className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate font-mono text-xs font-semibold">{a.id}</span>
                  </span>
                  {a.plan && <span className="shrink-0 rounded border border-ink-line px-1 font-mono text-[9px] uppercase text-white/40">{a.plan}</span>}
                </div>
                {current.length > 0 ? (
                  <div className="space-y-2">{current.map((w, i) => <UsageBar key={`${w.bucket}|${w.window}|${i}`} window={w} now={now} />)}</div>
                ) : (
                  <div className="font-mono text-[10px] leading-relaxed text-white/30">{a.windows.length > 0 ? "reinicio vencido: falta medir de nuevo" : a.note || "sin medida"}</div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
