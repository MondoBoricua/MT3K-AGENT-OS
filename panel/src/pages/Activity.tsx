import { useEffect, useState } from "react";
import { getLogs } from "../lib/api";

interface Event { date: string; time: string; text: string }

export default function Activity() {
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getLogs().then((r) => {
      const evs: Event[] = [];
      for (const log of r?.logs || []) {
        for (const line of log.content.split("\n")) {
          const m = line.match(/^-\s+(\d{2}:\d{2}:\d{2})\s+—\s+(.+)$/);
          if (m) evs.push({ date: log.date, time: m[1], text: m[2] });
        }
      }
      setEvents(evs.reverse());
      setLoading(false);
    });
  }, []);

  const tone = (t: string) =>
    t.startsWith("query") ? "text-accent" : t.startsWith("refresh") ? "text-amber" : "text-white/60";

  return (
    <div className="flex min-h-0 flex-1 flex-col p-6">
      <div className="mb-4">
        <h1 className="text-xl font-semibold">Activity</h1>
        <p className="font-mono text-xs text-white/45">{loading ? "cargando…" : `${events.length} eventos · queries y refreshes del OS`}</p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        <div className="relative border-l border-ink-line pl-5">
          {events.map((e, i) => (
            <div key={i} className="relative pb-5">
              <span className="absolute -left-[23px] top-1 h-2.5 w-2.5 rounded-full bg-accent ring-4 ring-ink-900" />
              <div className="flex items-baseline gap-3">
                <span className="font-mono text-[11px] text-white/40">{e.date} {e.time}</span>
                <span className={`font-mono text-sm ${tone(e.text)}`}>{e.text}</span>
              </div>
            </div>
          ))}
          {!loading && events.length === 0 && (
            <div className="-ml-5 py-16 text-center">
              <div className="mb-2 text-4xl opacity-40">◌</div>
              <div className="text-white/50">Sin actividad todavía.</div>
              <div className="mt-1 font-mono text-xs text-white/30">Cada query y refresh aparece aquí.</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
