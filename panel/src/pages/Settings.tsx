import { useEffect, useState } from "react";
import type { Manifest } from "../types";
import { getStatus, removeProject, reingest, type SystemStatus } from "../lib/api";
import { fmt } from "../lib/ui";

const REFRESH_KEY = "mt3k.refreshMs";
const INTERVALS = [
  { label: "Off", v: 0 }, { label: "5s", v: 5000 }, { label: "15s", v: 15000 }, { label: "30s", v: 30000 },
];

function fmtDur(ms: number): string {
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export default function Settings({ manifest, onChanged }: { manifest: Manifest | null; onChanged: () => void }) {
  const [st, setSt] = useState<SystemStatus | null>(null);
  const [busy, setBusy] = useState("");
  const [refreshMs, setRefreshMs] = useState<number>(() => Number(localStorage.getItem(REFRESH_KEY) ?? 10000));

  const refresh = () => getStatus().then(setSt);
  useEffect(() => { refresh(); }, []);

  const pickInterval = (v: number) => {
    setRefreshMs(v);
    localStorage.setItem(REFRESH_KEY, String(v));
    window.dispatchEvent(new Event("mt3k:refresh-change"));
  };
  const doReingest = async () => { setBusy("reingest"); await reingest(); await refresh(); onChanged(); setBusy(""); };
  const doRemove = async (id: string) => {
    if (!confirm(`¿Dejar de trackear "${id}"? (no borra el repo ni su grafo)`)) return;
    setBusy(id); await removeProject(id); await refresh(); onChanged(); setBusy("");
  };

  const rows = [
    ["graphify", st?.graphify ?? "…"],
    ["uptime del server", st ? fmtDur(st.uptimeMs) : "…"],
    ["LAN", st?.lan ?? "…"],
    ["proyectos", String(st?.projects ?? "…")],
    ["skills", String(st?.skills ?? "…")],
    ["última ingesta", st?.lastIngest ? new Date(st.lastIngest).toLocaleString() : "…"],
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-6">
      <div className="mb-6">
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="font-mono text-xs text-white/45">configuración del OS · todo file-based</p>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* system */}
        <div className="surface p-5">
          <div className="mb-3 flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-white/50"><span className="text-accent">✦</span> Sistema</div>
          <div className="space-y-2 text-sm">
            {rows.map(([k, v]) => (
              <div key={k} className="flex items-center justify-between border-b border-ink-line/50 pb-2 last:border-0">
                <span className="text-white/50">{k}</span>
                {k === "LAN" ? (
                  <button onClick={() => navigator.clipboard?.writeText(`http://${v}`)} title="copiar URL"
                    className="flex items-center gap-1.5 font-mono text-white/85 transition hover:text-accent">
                    {v} <span className="text-[11px] text-white/40">⧉</span>
                  </button>
                ) : (
                  <span className="font-mono text-white/85">{v}</span>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* daemon / live refresh */}
        <div className="surface p-5">
          <div className="mb-3 flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-white/50"><span className="text-accent">✦</span> Daemon · auto-refresh</div>
          <p className="mb-3 text-xs text-white/45">Cada cuánto el OS re-escanea los agentes vivos y el estado.</p>
          <div className="flex gap-2">
            {INTERVALS.map((i) => (
              <button key={i.v} onClick={() => pickInterval(i.v)}
                className={`rounded-lg border px-3 py-1.5 text-xs transition ${refreshMs === i.v ? "border-accent/50 bg-accent/15 text-accent" : "border-ink-line text-white/55 hover:text-white"}`}>
                {i.label}
              </button>
            ))}
          </div>
          <button onClick={doReingest} disabled={!!busy}
            className="mt-5 w-full rounded-lg border border-ink-line bg-ink-800/60 px-3 py-2 text-sm text-white/80 transition hover:border-accent/50 disabled:opacity-40">
            {busy === "reingest" ? "re-ingestando…" : "↻ Re-ingestar todos los proyectos"}
          </button>
        </div>

        {/* projects */}
        <div className="surface p-5 lg:col-span-2">
          <div className="mb-3 flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-white/50"><span className="text-accent">✦</span> Proyectos trackeados</div>
          <div className="space-y-2">
            {(manifest?.projects ?? []).map((p) => (
              <div key={p.id} className="flex items-center justify-between rounded-lg border border-ink-line bg-ink-850/40 px-3 py-2">
                <div className="min-w-0">
                  <span className="text-sm font-medium">{p.name}</span>
                  <span className="ml-2 font-mono text-[11px] text-white/40">{fmt(p.files)} files · {p.clusters} clusters</span>
                </div>
                <button onClick={() => doRemove(p.id)} disabled={!!busy}
                  className="rounded-md border border-red-500/30 px-2.5 py-1 font-mono text-[11px] text-red-300/80 transition hover:bg-red-500/10 disabled:opacity-40">
                  {busy === p.id ? "…" : "untrack"}
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
