import { useEffect, useRef, useState } from "react";
import { searchNodes, type SearchHit } from "../lib/api";
import { communityColor } from "../lib/ui";
import { SearchIcon } from "./icons";

export default function CommandPalette({ onClose, onPick }: { onClose: () => void; onPick: (h: SearchHit) => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchHit[]>([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    if (!q.trim()) { setResults([]); return; }
    setLoading(true);
    const t = setTimeout(async () => {
      const r = await searchNodes(q.trim());
      setResults(r?.results || []);
      setActive(0);
      setLoading(false);
    }, 180);
    return () => clearTimeout(t);
  }, [q]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    else if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter" && results[active]) onPick(results[active]);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/60 p-4 pt-[12vh] backdrop-blur-sm" onClick={onClose}>
      <div className="surface w-full max-w-xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 border-b border-ink-line px-4 py-3">
          <SearchIcon className="h-4 w-4 text-white/40" />
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey}
            placeholder="Buscar un archivo/nodo en todos los proyectos…"
            className="flex-1 bg-transparent text-sm text-white placeholder:text-white/30 focus:outline-none" />
          <kbd className="rounded border border-ink-line px-1.5 py-0.5 font-mono text-[10px] text-white/40">esc</kbd>
        </div>
        <div className="max-h-[50vh] overflow-y-auto p-2">
          {loading && <div className="px-3 py-4 text-center text-sm text-white/40">buscando…</div>}
          {!loading && q && results.length === 0 && <div className="px-3 py-4 text-center text-sm text-white/40">sin resultados</div>}
          {results.map((r, i) => (
            <button key={`${r.project}-${r.id}`} onMouseEnter={() => setActive(i)} onClick={() => onPick(r)}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition ${i === active ? "bg-accent/12" : "hover:bg-white/5"}`}>
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: communityColor(r.community) }} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-sm text-white/90">{r.label}</span>
              </span>
              <span className="shrink-0 font-mono text-[11px] text-white/40">{r.projectName}</span>
            </button>
          ))}
          {!q && <div className="px-3 py-4 text-center font-mono text-xs text-white/30">escribe para buscar across {""}los 7 proyectos · ↑↓ + enter</div>}
        </div>
      </div>
    </div>
  );
}
