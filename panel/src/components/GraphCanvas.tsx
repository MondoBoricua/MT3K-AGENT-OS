import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D from "react-force-graph-2d";
import type { GNode, ProjectData } from "../types";
import { communityColor } from "../lib/ui";

const Graph3D = lazy(() => import("./Graph3D"));

type Mode = "full" | "core";

// huge graphs (e.g. 50k+ nodes) freeze the force layout — render only the most-connected
// nodes. Small graphs (≤ the cap) are unaffected and still show every node.
const CAP: Record<Mode, number> = { full: 2000, core: 600 };

export default function GraphCanvas({ data, onSelectNode, selectedId }: { data: ProjectData; onSelectNode?: (n: GNode | null) => void; selectedId?: string }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<any>(null);
  const [dims, setDims] = useState({ w: 800, h: 520 });
  const [mode, setMode] = useState<Mode>("full");
  const [paused, setPaused] = useState(false);
  const [is3d, setIs3d] = useState(true);
  const [hover, setHover] = useState<string | null>(null);

  useEffect(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setDims({ w: Math.max(320, r.width), h: Math.max(360, r.height) });
    });
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  // adjacency for hover highlight
  const adj = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const l of data.links) {
      const s = l.source as string, t = l.target as string;
      (m.get(s) ?? m.set(s, new Set()).get(s)!).add(t);
      (m.get(t) ?? m.set(t, new Set()).get(t)!).add(s);
    }
    return m;
  }, [data]);

  const graphData = useMemo(() => {
    const total = data.nodes.length;
    // core = top ~18% by degree; both modes are hard-capped so big graphs stay responsive
    const want = mode === "core" ? Math.max(24, Math.ceil(total * 0.18)) : total;
    const limit = Math.min(want, CAP[mode]);
    let nodes = data.nodes;
    if (limit < total) nodes = [...data.nodes].sort((a, b) => b.degree - a.degree).slice(0, limit);
    const keep = new Set(nodes.map((n) => n.id));
    return {
      nodes: nodes.map((n) => ({ ...n })),
      links: data.links.filter((l) => keep.has(l.source as string) && keep.has(l.target as string)).map((l) => ({ ...l })),
      total,
      rendered: nodes.length,
    };
  }, [data, mode]);

  useEffect(() => {
    const fg = fgRef.current;
    if (!fg || is3d) return;
    fg.d3Force("charge")?.strength(-55);
    paused ? fg.pauseAnimation() : fg.resumeAnimation();
  }, [paused, graphData, is3d]);

  const maxDeg = useMemo(() => Math.max(1, ...data.nodes.map((n) => n.degree)), [data]);
  const dim = (id: string) => hover && id !== hover && !adj.get(hover)?.has(id) && id !== selectedId;

  // fly the 2D camera to the selected node (from a click or the search palette)
  useEffect(() => {
    if (is3d || !selectedId) return;
    const focus = () => {
      const n: any = graphData.nodes.find((x) => x.id === selectedId);
      if (n && n.x != null) { fgRef.current?.centerAt(n.x, n.y, 700); fgRef.current?.zoom(2.4, 700); return true; }
      return false;
    };
    if (!focus()) { const t = setTimeout(focus, 900); return () => clearTimeout(t); }
  }, [selectedId, is3d, graphData]);

  const Controls = (
    <>
      {/* top overlay: label + controls share one flex-wrap row so they never collide on mobile */}
      <div className="pointer-events-none absolute inset-x-4 top-4 z-10 flex flex-wrap items-start justify-between gap-2">
        <div className="pointer-events-auto rounded-xl border border-ink-line bg-ink-850/80 px-3 py-2 backdrop-blur">
          <div className="flex items-center gap-2 text-sm font-medium"><span className="h-2 w-2 shrink-0 rounded-full bg-accent" /> {data.meta.name}</div>
          <div className="mt-0.5 font-mono text-[11px] text-white/45">{data.meta.files} files · {data.meta.clusters} clusters</div>
          {graphData.rendered < (data.meta.files ?? graphData.total) && (
            <div className="mt-0.5 font-mono text-[10px] text-amber/80">▸ {graphData.rendered.toLocaleString()} de {(data.meta.files ?? graphData.total).toLocaleString()} nodos (más conectados)</div>
          )}
        </div>
        <div className="pointer-events-auto flex flex-wrap justify-end gap-2">
          <div className="flex overflow-hidden rounded-lg border border-ink-line bg-ink-850/80 text-xs font-medium backdrop-blur">
            {(["2D", "3D"] as const).map((d) => {
              const on = (d === "3D") === is3d;
              return <button key={d} onClick={() => setIs3d(d === "3D")} className={`px-3 py-1.5 transition ${on ? "bg-accent/20 text-accent" : "text-white/55 hover:text-white"}`}>{d}</button>;
            })}
          </div>
          <div className="flex overflow-hidden rounded-lg border border-ink-line bg-ink-850/80 text-xs font-medium backdrop-blur">
            {(["full", "core"] as Mode[]).map((m) => (
              <button key={m} onClick={() => setMode(m)} className={`px-3 py-1.5 capitalize transition ${mode === m ? "bg-accent/20 text-accent" : "text-white/55 hover:text-white"}`}>{m}</button>
            ))}
            <button onClick={() => setPaused((p) => !p)} className={`border-l border-ink-line px-3 py-1.5 transition ${paused ? "bg-amber/20 text-amber" : "text-white/55 hover:text-white"}`}>{paused ? "Play" : "Pause"}</button>
          </div>
        </div>
      </div>
      <div className="pointer-events-none absolute bottom-4 left-4 z-10 rounded-lg border border-ink-line bg-ink-850/70 px-3 py-1.5 font-mono text-[11px] text-white/55 backdrop-blur">
        <span className="text-emerald-300">●</span> extracted&nbsp;&nbsp;<span className="text-violet-300">●</span> inferred&nbsp;&nbsp;· size = connectivity · colour = cluster
      </div>
    </>
  );

  return (
    <div ref={wrapRef} className="vignette relative h-full w-full overflow-hidden rounded-2xl border border-ink-line bg-ink-900/60">
      {Controls}
      {is3d ? (
        <Suspense fallback={<div className="skeleton grid h-full place-items-center"><span className="font-mono text-sm text-white/50">⌗ cargando motor 3D…</span></div>}>
          <Graph3D graphData={graphData} maxDeg={maxDeg} paused={paused} selectedId={selectedId} onSelect={(n) => onSelectNode?.(n)} />
        </Suspense>
      ) : (
        <ForceGraph2D
          ref={fgRef}
          width={dims.w}
          height={dims.h}
          graphData={graphData}
          backgroundColor="rgba(0,0,0,0)"
          cooldownTicks={120}
          nodeRelSize={1}
          linkColor={() => "rgba(255,255,255,0.07)"}
          linkWidth={0.5}
          onNodeHover={(n: any) => setHover(n ? n.id : null)}
          onNodeClick={(node: any) => { onSelectNode?.(node); fgRef.current?.centerAt(node.x, node.y, 600); }}
          nodeCanvasObject={(node: any, ctx, scale) => {
            const deg = node.degree || 1;
            const r = 1.6 + Math.sqrt(deg / maxDeg) * 8;
            const color = communityColor(node.community);
            const faded = dim(node.id);
            ctx.globalAlpha = faded ? 0.18 : 1;
            ctx.shadowBlur = (deg > maxDeg * 0.55 ? 22 : 12) * (data.nodes.length > 900 ? 0.6 : 1);
            ctx.shadowColor = color;
            ctx.beginPath(); ctx.arc(node.x, node.y, r, 0, 2 * Math.PI); ctx.fillStyle = color; ctx.fill();
            ctx.shadowBlur = 0;
            ctx.beginPath(); ctx.arc(node.x, node.y, r * 0.42, 0, 2 * Math.PI); ctx.fillStyle = "rgba(255,255,255,0.88)"; ctx.fill();
            if (deg > maxDeg * 0.55) { ctx.strokeStyle = "rgba(255,255,255,0.45)"; ctx.lineWidth = 0.7; ctx.beginPath(); ctx.arc(node.x, node.y, r + 2, 0, 2 * Math.PI); ctx.stroke(); }
            if (node.id === selectedId) {
              ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5;
              ctx.beginPath(); ctx.arc(node.x, node.y, r + 5, 0, 2 * Math.PI); ctx.stroke();
              ctx.strokeStyle = "rgba(255,255,255,0.3)"; ctx.lineWidth = 1;
              ctx.beginPath(); ctx.arc(node.x, node.y, r + 9, 0, 2 * Math.PI); ctx.stroke();
            }
            if ((node.id === hover || node.id === selectedId || deg > maxDeg * 0.55) && scale > 1.2) {
              ctx.fillStyle = "rgba(255,255,255,0.9)"; ctx.font = `${10 / scale}px ui-monospace, monospace`;
              ctx.fillText(node.label, node.x + r + 2, node.y + 3 / scale);
            }
            ctx.globalAlpha = 1;
          }}
          nodePointerAreaPaint={(node: any, color, ctx) => {
            const r = 2 + Math.sqrt((node.degree || 1) / maxDeg) * 7;
            ctx.fillStyle = color; ctx.beginPath(); ctx.arc(node.x, node.y, r + 2, 0, 2 * Math.PI); ctx.fill();
          }}
        />
      )}
    </div>
  );
}
