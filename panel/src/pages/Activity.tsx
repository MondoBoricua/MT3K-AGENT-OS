import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getLogs } from "../lib/api";
import { filterEvents, groupByDay, kindCounts, NOISY_KINDS, parseLogs, type ActivityEvent } from "../lib/activity";

const HIDDEN_KEY = "mt3k.activity.hidden";
const PAGE = 200; // events rendered per step: months of logs are tens of thousands of lines
const POLL_MS = 60_000;
const TOP_KINDS = 8; // chips shown before "+N tipos": the rare kinds would fill a phone screen

function loadHidden(): Set<string> {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY);
    if (raw === null) return new Set(NOISY_KINDS);
    const parsed: unknown = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : NOISY_KINDS);
  } catch {
    return new Set(NOISY_KINDS);
  }
}
function saveHidden(hidden: Set<string>) {
  try { localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hidden])); } catch { /* private mode: the filter lasts this visit */ }
}

const KIND_TONE: Record<string, string> = {
  query: "text-accent", refresh: "text-amber", launch: "text-emerald-300", restore: "text-emerald-300",
  kill: "text-red-300", "fs-delete": "text-red-300", "upload-rechazado": "text-red-300", send: "text-white/80",
};
const tone = (kind: string) => KIND_TONE[kind] ?? "text-white/55";

export default function Activity() {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(loadHidden);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [allKinds, setAllKinds] = useState(false);

  // the first load, the button and the interval can overlap: only a response newer than the last one
  // applied is used, and none after the page is gone
  const issued = useRef(0);
  const applied = useRef(0);
  const alive = useRef(true);
  const pull = useCallback(async () => {
    const id = ++issued.current;
    const r = await getLogs();
    if (!alive.current || id <= applied.current) return;
    applied.current = id;
    setLoading(false);
    if (!r) { setFailed(true); return; } // keep what is on screen
    setFailed(false);
    setEvents(parseLogs(r.logs || []));
  }, []);
  useEffect(() => {
    alive.current = true;
    void pull();
    const iv = setInterval(() => { if (document.visibilityState === "visible") void pull(); }, POLL_MS);
    return () => { alive.current = false; clearInterval(iv); };
  }, [pull]);

  const counts = useMemo(() => kindCounts(events), [events]);
  const shown = useMemo(() => filterEvents(events, hidden, query), [events, hidden, query]);
  const groups = useMemo(() => groupByDay(shown.slice(0, limit)), [shown, limit]);

  const applyHidden = (next: Set<string>) => { setHidden(next); saveHidden(next); setLimit(PAGE); };
  const toggle = (kind: string) => {
    const next = new Set(hidden);
    if (next.has(kind)) next.delete(kind); else next.add(kind);
    applyHidden(next);
  };
  const allOn = counts.every((c) => !hidden.has(c.kind));
  const chips = allKinds ? counts : counts.slice(0, TOP_KINDS);
  const restKinds = counts.length - TOP_KINDS;

  return (
    <div className="flex min-h-0 flex-1 flex-col p-6">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Activity</h1>
          <p className="font-mono text-xs text-white/45">
            {loading ? "cargando…" : `${shown.length.toLocaleString("es")} de ${events.length.toLocaleString("es")} eventos`}
            {failed && <span className="text-amber-300"> · no se pudo actualizar</span>}
          </p>
        </div>
        <div className="flex min-w-0 flex-1 items-center justify-end gap-2 sm:flex-none">
          <input value={query} onChange={(e) => { setQuery(e.target.value); setLimit(PAGE); }} placeholder="buscar texto, sesión o fecha…" spellCheck={false}
            className="min-w-0 flex-1 rounded-lg border border-ink-line bg-ink-850/60 px-2.5 py-1.5 font-mono text-xs text-white placeholder:text-white/25 focus:border-accent/50 focus:outline-none sm:w-72 sm:flex-none" />
          <button type="button" onClick={() => void pull()} title="actualizar"
            className="shrink-0 rounded-lg border border-ink-line bg-ink-850/60 px-2.5 py-1.5 font-mono text-xs text-white/60 transition hover:border-accent/50 hover:text-white">↻</button>
        </div>
      </div>

      {counts.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-1.5">
          <button type="button" onClick={() => applyHidden(allOn ? new Set(NOISY_KINDS) : new Set())}
            className="rounded-full border border-accent/40 bg-accent/10 px-2.5 py-0.5 font-mono text-[10px] text-accent transition hover:bg-accent/20">
            {allOn ? "ocultar ruido" : "ver todo"}
          </button>
          {chips.map(({ kind, count }) => {
            const on = !hidden.has(kind);
            return (
              <button key={kind} type="button" onClick={() => toggle(kind)} aria-pressed={on}
                className={`rounded-full border px-2.5 py-0.5 font-mono text-[10px] transition ${on ? "border-white/25 bg-white/10 text-white" : "border-ink-line bg-transparent text-white/30 line-through hover:text-white/60"}`}>
                {kind} <span className={on ? "text-white/45" : ""}>{count.toLocaleString("es")}</span>
              </button>
            );
          })}
          {restKinds > 0 && (
            <button type="button" onClick={() => setAllKinds((v) => !v)} aria-expanded={allKinds}
              className="rounded-full border border-ink-line px-2.5 py-0.5 font-mono text-[10px] text-white/45 transition hover:border-white/30 hover:text-white">
              {allKinds ? "menos tipos" : `+${restKinds} tipos`}
            </button>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {groups.map((g) => (
          <section key={g.date} className="mb-5">
            <h2 className="sticky top-0 z-10 mb-2 bg-ink-900/90 py-1 font-mono text-[11px] uppercase tracking-wider text-accent backdrop-blur">
              {g.date} <span className="text-white/30">· {g.events.length}</span>
            </h2>
            <div className="relative border-l border-ink-line pl-5">
              {g.events.map((e, i) => (
                <div key={`${e.time}-${i}`} className="relative pb-2.5">
                  <span className="absolute -left-[23px] top-1.5 h-1.5 w-1.5 rounded-full bg-accent/70 ring-4 ring-ink-900" />
                  <div className="flex items-baseline gap-3">
                    <span className="shrink-0 font-mono text-[11px] text-white/35">{e.time}</span>
                    <span className={`min-w-0 break-words font-mono text-[13px] ${tone(e.kind)}`}>{e.text}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}
        {shown.length > limit && (
          <button type="button" onClick={() => setLimit((n) => n + PAGE)}
            className="mb-6 w-full rounded-lg border border-ink-line bg-ink-850/60 py-2 font-mono text-xs text-white/60 transition hover:border-accent/50 hover:text-white">
            ver {Math.min(PAGE, shown.length - limit)} más · quedan {(shown.length - limit).toLocaleString("es")}
          </button>
        )}
        {!loading && shown.length === 0 && (
          <div className="py-16 text-center">
            <div className="mb-2 text-4xl opacity-40">◌</div>
            <div className="text-white/50">{events.length === 0 ? "Sin actividad todavía." : "Nada coincide con el filtro."}</div>
            <div className="mt-1 font-mono text-xs text-white/30">{events.length === 0 ? "Cada acción del panel aparece aquí." : "Prueba otra búsqueda o activa más tipos."}</div>
          </div>
        )}
      </div>
    </div>
  );
}
