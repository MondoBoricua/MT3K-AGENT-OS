import { useEffect, useMemo, useState } from "react";
import { getSkills, type SkillRow } from "../lib/api";

export default function Skills() {
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => { getSkills().then((r) => { setSkills(r?.skills || []); setLoading(false); }); }, []);

  const filtered = useMemo(() => {
    const s = q.toLowerCase().trim();
    if (!s) return skills;
    return skills.filter((k) => k.name.toLowerCase().includes(s) || k.description.toLowerCase().includes(s));
  }, [skills, q]);

  return (
    <div className="flex min-h-0 flex-1 flex-col p-6">
      <div className="mb-4 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Skills</h1>
          <p className="font-mono text-xs text-white/45">{loading ? "cargando…" : `${skills.length} skills en tu canon · ~/.agents/skills`}</p>
        </div>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar skill…"
          className="w-64 rounded-lg border border-ink-line bg-ink-850/60 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-accent/50 focus:outline-none" />
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto pr-1 sm:grid-cols-2 xl:grid-cols-3">
        {filtered.map((k) => (
          <div key={k.slug} className="surface surface-hover p-4">
            <div className="mb-1 flex items-center gap-2">
              <span className="text-accent">✦</span>
              <span className="truncate font-mono text-sm font-semibold">{k.name}</span>
            </div>
            <p className="line-clamp-3 text-xs leading-snug text-white/55">{k.description || "—"}</p>
          </div>
        ))}
        {!loading && filtered.length === 0 && (
          <div className="col-span-full py-16 text-center">
            <div className="mb-2 text-4xl opacity-40">⌕</div>
            <div className="text-white/50">Sin skills para “{q}”.</div>
            <div className="mt-1 font-mono text-xs text-white/30">Prueba otro término.</div>
          </div>
        )}
      </div>
    </div>
  );
}
