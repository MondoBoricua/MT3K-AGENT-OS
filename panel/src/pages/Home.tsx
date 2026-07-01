import { useEffect, useState } from "react";
import type { Manifest } from "../types";
import { fmt, langTint, money } from "../lib/ui";
import { getLogs } from "../lib/api";

interface Ev { date: string; time: string; text: string }

export default function Home({ manifest, go }: { manifest: Manifest | null; go: (id: string) => void }) {
  const ps = manifest?.projects || [];
  const sum = (k: "files" | "links" | "clusters") => ps.reduce((a, p) => a + p[k], 0);
  const savings = ps.reduce((a, p) => a + p.savings.costPerSession, 0);
  const [events, setEvents] = useState<Ev[]>([]);

  useEffect(() => {
    getLogs().then((r) => {
      const evs: Ev[] = [];
      for (const log of r?.logs || [])
        for (const line of log.content.split("\n")) {
          const m = line.match(/^-\s+(\d{2}:\d{2}:\d{2})\s+—\s+(.+)$/);
          if (m) evs.push({ date: log.date, time: m[1], text: m[2] });
        }
      setEvents(evs.reverse().slice(0, 6));
    });
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Operator Console</h1>
        <p className="text-sm text-white/50">Tu cerebro compartido — {ps.length} proyectos mapeados con graphify.</p>
      </div>

      <div className="mb-7 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Big icon="◆" label="Proyectos" value={String(ps.length)} />
        <Big icon="⦿" label="Archivos mapeados" value={fmt(sum("files"))} />
        <Big icon="↬" label="Relaciones" value={fmt(sum("links"))} />
        <Big icon="$" label="Ahorro / sesión" value={`~${money(savings)}`} accent />
      </div>

      <div className="grid min-h-0 flex-1 gap-7 lg:grid-cols-[1.4fr_1fr]">
        {/* projects */}
        <div>
          <h2 className="mb-3 font-mono text-xs uppercase tracking-wider text-white/45">Proyectos</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {ps.map((p) => (
              <button key={p.id} onClick={() => go(p.id)} className="surface surface-hover p-4 text-left">
                <div className="flex items-center justify-between">
                  <span className="font-semibold">{p.name}</span>
                  <span className="rounded px-1.5 py-0.5 font-mono text-[9px] uppercase" style={{ background: langTint(p.lang) + "22", color: langTint(p.lang) }}>{p.lang}</span>
                </div>
                <div className="mt-2 flex gap-3 font-mono text-[11px] text-white/45">
                  <span>{fmt(p.files)} files</span><span>{p.clusters} clusters</span>
                  <span className="text-emerald-300/80">~{money(p.savings.costPerSession)}</span>
                </div>
                <div className="mt-3 flex h-1 overflow-hidden rounded-full bg-ink-700">
                  <div className="bg-emerald-400/80" style={{ width: `${p.confidence.extracted}%` }} />
                  <div className="bg-violet-400/70" style={{ width: `${p.confidence.inferred}%` }} />
                </div>
                <div className="mt-1 font-mono text-[10px] text-white/35">{p.confidence.extracted}% verified in code</div>
              </button>
            ))}
          </div>
        </div>

        {/* languages + recent activity */}
        <div className="space-y-7">
          <div>
            <h2 className="mb-3 font-mono text-xs uppercase tracking-wider text-white/45">Lenguajes</h2>
            <div className="surface space-y-2.5 p-4">
              {(() => {
                const byLang: Record<string, number> = {};
                ps.forEach((p) => { byLang[p.lang] = (byLang[p.lang] || 0) + p.files; });
                const total = Object.values(byLang).reduce((a, b) => a + b, 0) || 1;
                return Object.entries(byLang).sort((a, b) => b[1] - a[1]).map(([lang, files]) => (
                  <div key={lang}>
                    <div className="flex items-center justify-between text-xs">
                      <span style={{ color: langTint(lang) }}>{lang}</span>
                      <span className="font-mono text-white/45">{fmt(files)}</span>
                    </div>
                    <div className="mt-1 h-1 overflow-hidden rounded-full bg-ink-700">
                      <div className="h-full rounded-full" style={{ width: `${(files / total) * 100}%`, background: langTint(lang) }} />
                    </div>
                  </div>
                ));
              })()}
            </div>
          </div>

          <h2 className="mb-3 font-mono text-xs uppercase tracking-wider text-white/45">Actividad reciente</h2>
          <div className="surface p-4">
            {events.length ? (
              <div className="relative border-l border-ink-line pl-4">
                {events.map((e, i) => (
                  <div key={i} className="relative pb-4 last:pb-0">
                    <span className="absolute -left-[19px] top-1 h-2 w-2 rounded-full bg-accent ring-4 ring-ink-850" />
                    <div className="font-mono text-[11px] text-white/40">{e.time}</div>
                    <div className={`font-mono text-xs ${e.text.startsWith("query") ? "text-accent" : e.text.startsWith("refresh") ? "text-amber" : "text-white/65"}`}>{e.text}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-6 text-center text-sm text-white/40">
                <div className="mb-1 text-2xl opacity-50">◌</div>
                Sin actividad todavía.<br />
                <span className="font-mono text-xs text-white/30">Haz una pregunta en Knowledge Graph.</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Big({ icon, label, value, accent }: { icon: string; label: string; value: string; accent?: boolean }) {
  return (
    <div className={`surface relative overflow-hidden p-4 ${accent ? "before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-gradient-to-r before:from-transparent before:via-emerald-400/60 before:to-transparent before:content-['']" : ""}`}>
      <div className="flex items-center justify-between">
        <div className="font-mono text-[10px] uppercase tracking-wider text-white/40">{label}</div>
        <span className={`font-mono text-sm ${accent ? "text-emerald-300/70" : "text-white/25"}`}>{icon}</span>
      </div>
      <div className={`mt-1.5 font-mono text-3xl font-bold ${accent ? "text-emerald-300 drop-shadow-[0_0_12px_oklch(80%_0.15_150_/_0.4)]" : ""}`}>{value}</div>
    </div>
  );
}
