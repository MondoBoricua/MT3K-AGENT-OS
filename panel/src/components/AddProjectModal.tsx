import { useEffect, useState } from "react";
import { addProject, discoverRepos, type DiscoverRepo } from "../lib/api";
import { fmt } from "../lib/ui";

export default function AddProjectModal({ onClose, onAdded }: { onClose: () => void; onAdded: (id: string) => void }) {
  const [repos, setRepos] = useState<DiscoverRepo[]>([]);
  const [loading, setLoading] = useState(true);
  const [manual, setManual] = useState("");
  const [busy, setBusy] = useState<string>("");

  useEffect(() => { discoverRepos().then((r) => { setRepos(r?.repos || []); setLoading(false); }); }, []);

  const add = async (path: string, name?: string, label = path) => {
    setBusy(label);
    const r = await addProject(path, name);
    setBusy("");
    if (r?.ok) onAdded(r.id);
    else alert("No se pudo agregar (¿path válido? ¿server corriendo?)");
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="surface w-full max-w-lg p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Agregar proyecto</h2>
          <button onClick={onClose} className="text-white/40 hover:text-white">✕</button>
        </div>
        <p className="mb-4 text-xs text-white/45">Repos grafiados (en <span className="font-mono">~/Developer</span> o en tu home) que aún no trackeas.</p>

        <div className="mb-4 max-h-64 space-y-2 overflow-y-auto">
          {loading && <div className="py-6 text-center text-sm text-white/40">buscando repos…</div>}
          {!loading && repos.length === 0 && (
            <div className="py-6 text-center text-sm text-white/40">No hay repos grafiados sin trackear. Usa el path manual abajo.</div>
          )}
          {repos.map((r) => (
            <button key={r.path} disabled={!!busy} onClick={() => add(r.path, r.name, r.path)}
              className="surface surface-hover flex w-full items-center justify-between p-3 text-left disabled:opacity-50">
              <div>
                <div className="font-medium">{r.name}</div>
                <div className="font-mono text-[11px] text-white/40">{r.path.replace(/^.*\/Developer\//, "~/Developer/")}</div>
              </div>
              <span className="font-mono text-xs text-white/45">{busy === r.path ? "agregando…" : `${fmt(r.files)} files`}</span>
            </button>
          ))}
        </div>

        <div className="border-t border-ink-line pt-4">
          <div className="mb-2 font-mono text-[11px] uppercase tracking-wider text-white/45">O grafía un repo nuevo por path</div>
          <div className="flex gap-2">
            <input value={manual} onChange={(e) => setManual(e.target.value)}
              placeholder="~/Developer/mi-repo"
              className="flex-1 rounded-lg border border-ink-line bg-ink-850/60 px-3 py-2 font-mono text-sm text-white placeholder:text-white/30 focus:border-accent/50 focus:outline-none" />
            <button disabled={!manual.trim() || !!busy} onClick={() => add(manual.trim(), undefined, "manual")}
              className="rounded-lg bg-accent/20 px-4 py-2 text-sm font-medium text-accent transition hover:bg-accent/30 disabled:opacity-40">
              {busy === "manual" ? "grafiando…" : "Agregar"}
            </button>
          </div>
          <p className="mt-2 text-[11px] text-white/35">Si no está grafiado, corre <span className="font-mono text-accent">graphify .</span> primero (puede tardar).</p>
        </div>
      </div>
    </div>
  );
}
