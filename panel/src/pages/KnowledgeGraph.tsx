import { useEffect, useState } from "react";
import type { GNode, Manifest, ProjectData, ProjectMeta } from "../types";
import { communityColor, fmt, langTint, money } from "../lib/ui";
import { askQuery } from "../lib/api";
import GraphCanvas from "../components/GraphCanvas";
import WikiPanel from "../components/WikiPanel";
import AddProjectModal from "../components/AddProjectModal";

interface Props {
  manifest: Manifest | null;
  selected: string;
  setSelected: (id: string) => void;
  data: ProjectData | null;
  onReload: () => void;
  pendingSel: { project: string; id: string } | null;
  onPendingDone: () => void;
}

const SUGGESTIONS = ["¿Qué hace este proyecto?", "¿Cómo lo corro?", "Dame un tour", "¿Algo roto o riesgoso?"];

export default function KnowledgeGraph({ manifest, selected, setSelected, data, onReload, pendingSel, onPendingDone }: Props) {
  const [view, setView] = useState<"graph" | "wiki">("graph");
  const [addOpen, setAddOpen] = useState(false);
  const [sel, setSel] = useState<GNode | null>(null);
  useEffect(() => setSel(null), [selected]);

  // resolve a node selected from the global search palette
  useEffect(() => {
    if (!pendingSel || !data || pendingSel.project !== selected) return;
    const node = data.nodes.find((n) => n.id === pendingSel.id);
    if (node) { setSel(node); onPendingDone(); }
  }, [pendingSel, data, selected, onPendingDone]);
  const [q, setQ] = useState("");
  const [answer, setAnswer] = useState<string>("");
  const [asking, setAsking] = useState(false);

  const send = async (question: string) => {
    if (!question.trim() || !selected) return;
    setAsking(true);
    setAnswer("");
    const r = await askQuery(selected, question.trim());
    setAnswer(r?.answer || "Sin respuesta (¿server corriendo? ¿el repo tiene graphify-out/?)");
    setAsking(false);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* project cards */}
      <div className="flex gap-2.5 overflow-x-auto border-b border-ink-line px-6 py-2.5">
        {manifest?.projects.map((p) => (
          <ProjectCard key={p.id} p={p} active={p.id === selected} onClick={() => setSelected(p.id)} />
        ))}
        <button onClick={() => setAddOpen(true)}
          className="flex min-w-[120px] shrink-0 flex-col items-center justify-center gap-0.5 rounded-xl border border-dashed border-ink-line px-4 text-center text-white/40 transition hover:border-accent/50 hover:text-white/75">
          <div className="text-base leading-none">＋</div>
          <div className="text-[11px]">Add a project</div>
        </button>
      </div>

      {addOpen && (
        <AddProjectModal
          onClose={() => setAddOpen(false)}
          onAdded={(id) => { setAddOpen(false); onReload(); setSelected(id); }}
        />
      )}

      {/* view toggle */}
      <div className="flex items-center gap-2 px-6 pt-2.5">
        {(["graph", "wiki"] as const).map((v) => (
          <button key={v} onClick={() => setView(v)}
            className={`rounded-lg border px-3 py-1.5 text-xs capitalize transition ${view === v ? "border-accent/50 bg-accent/15 text-accent" : "border-ink-line text-white/55 hover:text-white"}`}>
            {v === "graph" ? "Knowledge Graph" : "Wiki"}
          </button>
        ))}
      </div>

      {/* workspace — 2 cols on desktop, stacked + scrollable on mobile */}
      <section className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto p-4 pt-3 lg:grid-cols-[1fr_340px] lg:overflow-hidden">
        <div className="min-h-[58vh] lg:min-h-0">
          {data ? (view === "graph" ? <GraphCanvas data={data} onSelectNode={setSel} selectedId={sel?.id} /> : <WikiPanel data={data} />)
            : <div className="skeleton grid h-full place-items-center rounded-2xl border border-ink-line text-white/40">cargando grafo…</div>}
        </div>
        <StatsColumn data={data} selected={sel} onClear={() => setSel(null)} />
      </section>

      {/* live ask */}
      <footer className="border-t border-ink-line px-6 py-4">
        {(answer || asking) && (
          <div className="mb-3 max-h-52 overflow-y-auto rounded-xl border border-ink-line bg-ink-900/70 p-3">
            {asking
              ? <span className="font-mono text-xs text-accent">graphify query · recorriendo el grafo…</span>
              : <AnswerView text={answer} nodes={data?.nodes ?? []} onPick={setSel} />}
          </div>
        )}
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-white/40">ASK</span>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send(q)}
            placeholder={`Pregúntale a ${data?.meta.name ?? "este proyecto"}… (corre graphify query)`}
            className="flex-1 rounded-lg border border-ink-line bg-ink-850/60 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-accent/50 focus:outline-none"
          />
          <button onClick={() => send(q)} disabled={asking}
            className="rounded-lg bg-accent/20 px-4 py-2 text-sm font-medium text-accent transition hover:bg-accent/30 disabled:opacity-40">
            {asking ? "…" : "Ask"}
          </button>
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          {SUGGESTIONS.map((s) => (
            <button key={s} onClick={() => { setQ(s); send(s); }}
              className="rounded-full border border-ink-line bg-ink-800/60 px-3 py-1 text-xs text-white/65 transition hover:border-accent/50 hover:text-white">
              {s}
            </button>
          ))}
        </div>
      </footer>
    </div>
  );
}

function ProjectCard({ p, active, onClick }: { p: ProjectMeta; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className={`min-w-[150px] surface surface-hover px-3 py-2 text-left ${active ? "!border-accent/70 shadow-[0_0_30px_-12px] shadow-accent" : ""}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[13px] font-semibold">{p.name}</span>
        <span className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[9px] uppercase" style={{ background: langTint(p.lang) + "22", color: langTint(p.lang) }}>{p.lang}</span>
      </div>
      <div className="mt-0.5 font-mono text-[10px] text-white/45">{fmt(p.files)} files · {p.clusters} clusters</div>
    </button>
  );
}

function StatsColumn({ data, selected, onClear }: { data: ProjectData | null; selected: GNode | null; onClear: () => void }) {
  if (!data) return <div className="skeleton rounded-2xl border border-ink-line" />;
  const { meta, godNodes } = data;
  const maxDeg = Math.max(1, ...godNodes.map((g) => g.degree));
  const clusterLabel = selected ? (data.clusters.find((c) => c.id === selected.community)?.label ?? `Community ${selected.community}`) : "";
  return (
    <div className="flex flex-col gap-4 pr-1 lg:min-h-0 lg:overflow-y-auto">
      {selected && (
        <div className="surface p-4" style={{ borderColor: "oklch(62% 0.23 25 / 0.5)" }}>
          <div className="mb-2 flex items-center justify-between font-mono text-[11px] uppercase tracking-wider text-accent">
            <span>✦ Selected</span>
            <button onClick={onClear} className="text-white/40 hover:text-white">✕</button>
          </div>
          <div className="truncate text-sm font-semibold">{selected.label}</div>
          <div className="mt-2 space-y-1.5 font-mono text-[11px]">
            <div className="flex items-center gap-2 text-white/55">
              <span className={`h-1.5 w-1.5 rounded-full ${selected.origin === "extracted" ? "bg-emerald-400" : "bg-violet-400"}`} />
              {selected.origin === "extracted" ? "found in code" : "inferred"}
            </div>
            <div className="flex justify-between text-white/55"><span>cluster</span><span style={{ color: communityColor(selected.community) }}>{clusterLabel}</span></div>
            <div className="flex justify-between text-white/55"><span>connections</span><span className="text-white/80">{selected.degree}</span></div>
          </div>
        </div>
      )}
      <div className="grid grid-cols-3 gap-3">
        <Tile label="files" value={fmt(meta.files)} sub="nodes" />
        <Tile label="links" value={fmt(meta.links)} sub="relations" />
        <Tile label="clusters" value={fmt(meta.clusters)} sub="modules" />
      </div>
      <Panel title="Map Confidence">
        <div className="mb-2 flex h-2.5 overflow-hidden rounded-full bg-ink-700">
          <div className="bg-emerald-400" style={{ width: `${meta.confidence.extracted}%` }} />
          <div className="bg-violet-400" style={{ width: `${meta.confidence.inferred}%` }} />
        </div>
        <Row dot="bg-emerald-400" label="Found in code" value={`${meta.confidence.extracted}%`} />
        <Row dot="bg-violet-400" label="Inferred (model's guess)" value={`${meta.confidence.inferred}%`} />
      </Panel>
      <Panel title="Most Important Files">
        <p className="mb-3 text-[11px] leading-snug text-white/40">El corazón del proyecto — de lo que todo depende.</p>
        <div className="flex flex-col gap-2.5">
          {godNodes.slice(0, 6).map((g, i) => (
            <div key={g.id}>
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="truncate"><span className="text-white/35">{i + 1}.</span> <span className="font-medium">{g.label}</span></span>
                <span className="font-mono text-white/45">{g.degree}</span>
              </div>
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-ink-700">
                <div className="h-full rounded-full" style={{ width: `${(g.degree / maxDeg) * 100}%`, background: communityColor(g.community) }} />
              </div>
            </div>
          ))}
        </div>
      </Panel>
      <Panel title="Est. Savings / Session">
        <div className="font-mono text-3xl font-bold text-emerald-300">~{money(meta.savings.costPerSession)}</div>
        <div className="font-mono text-xs text-white/45">~{fmt(meta.savings.tokens)} tokens</div>
        <p className="mt-2 text-[11px] leading-snug text-white/40">Lo que pagarías re-leyendo el repo cada sesión, en vez de consultar el mapa.</p>
      </Panel>
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="surface px-3 py-3">
      <div className="font-mono text-[10px] uppercase tracking-wider text-white/40">{label}</div>
      <div className="mt-1 font-mono text-2xl font-bold leading-none">{value}</div>
      <div className="mt-1 font-mono text-[10px] text-white/35">{sub}</div>
    </div>
  );
}
function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="surface p-4">
      <div className="mb-2 flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-white/50"><span className="text-accent">✦</span> {title}</div>
      {children}
    </div>
  );
}
function Row({ dot, label, value }: { dot: string; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-0.5 text-xs">
      <span className="flex items-center gap-2 text-white/60"><span className={`h-1.5 w-1.5 rounded-full ${dot}`} /> {label}</span>
      <span className="font-mono text-white/80">{value}</span>
    </div>
  );
}

// Pretty-renders the graphify query output: a traversal badge + clickable node chips
// (clicking a chip selects that node in the graph → fills the SELECTED panel).
function AnswerView({ text, nodes, onPick }: { text: string; nodes: GNode[]; onPick: (n: GNode) => void }) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const header = lines.find((l) => /^traversal/i.test(l));
  const found = lines.filter((l) => l.startsWith("NODE ")).map((l) => {
    const m = l.match(/^NODE\s+(.+?)\s*\[(.*)\]\s*$/);
    const label = (m ? m[1] : l.slice(5)).trim();
    const src = m ? (m[2].match(/src=([^\s\]]+)/)?.[1] ?? "") : "";
    return { label, src };
  });
  const byLabel = new Map(nodes.map((n) => [n.label, n]));

  if (found.length === 0) {
    return <div className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-white/80">{text}</div>;
  }
  return (
    <div>
      {header && (
        <div className="mb-2 inline-flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent/10 px-2.5 py-1 font-mono text-[11px] text-accent">
          ⌗ {header.replace(/^traversal:\s*/i, "")}
        </div>
      )}
      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {found.map((f, i) => {
          const node = byLabel.get(f.label);
          return (
            <button key={i} disabled={!node} onClick={() => node && onPick(node)}
              className="flex items-center gap-2 rounded-lg border border-ink-line bg-ink-850/50 px-2.5 py-1.5 text-left transition enabled:hover:border-accent/40 disabled:opacity-60">
              {node && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: communityColor(node.community) }} />}
              <span className="min-w-0">
                <span className="block truncate font-mono text-xs text-white/85">{f.label}</span>
                {f.src && <span className="block truncate font-mono text-[10px] text-white/40">{f.src}</span>}
              </span>
            </button>
          );
        })}
      </div>
      <div className="mt-2 font-mono text-[10px] text-white/35">{found.length} nodos · click para verlo en el grafo →</div>
    </div>
  );
}
