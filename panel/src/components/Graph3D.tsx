import { useEffect, useRef, useState } from "react";
import ForceGraph3D from "react-force-graph-3d";
import type { GLink, GNode } from "../types";
import { communityColor } from "../lib/ui";

interface Props {
  graphData: { nodes: GNode[]; links: GLink[] };
  maxDeg: number;
  paused: boolean;
  selectedId?: string;
  onSelect?: (n: GNode) => void;
}

export default function Graph3D({ graphData, maxDeg, paused, selectedId, onSelect }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const fgRef = useRef<any>(null);
  const [dims, setDims] = useState({ w: 800, h: 520 });

  useEffect(() => {
    if (!wrap.current) return;
    const ro = new ResizeObserver((e) => {
      const r = e[0].contentRect;
      setDims({ w: Math.max(320, r.width), h: Math.max(360, r.height) });
    });
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    paused ? fg.pauseAnimation() : fg.resumeAnimation();
  }, [paused, graphData]);

  // fly the camera to the selected node
  useEffect(() => {
    if (!selectedId) return;
    const focus = () => {
      const n: any = graphData.nodes.find((x) => x.id === selectedId);
      if (n && n.x != null) {
        const r = Math.hypot(n.x, n.y, n.z || 0) || 1;
        const k = 1 + 90 / r;
        fgRef.current?.cameraPosition({ x: n.x * k, y: n.y * k, z: (n.z || 0) * k }, n, 1200);
        return true;
      }
      return false;
    };
    if (!focus()) { const t = setTimeout(focus, 1000); return () => clearTimeout(t); }
  }, [selectedId, graphData]);

  return (
    <div ref={wrap} className="h-full w-full">
      <ForceGraph3D
        ref={fgRef}
        width={dims.w}
        height={dims.h}
        graphData={graphData}
        backgroundColor="rgba(0,0,0,0)"
        nodeColor={(n: any) => (n.id === selectedId ? "#ffffff" : communityColor(n.community))}
        nodeVal={(n: any) => (n.id === selectedId ? 20 : 1 + (n.degree / maxDeg) * 9)}
        nodeOpacity={0.9}
        nodeResolution={14}
        linkColor={() => "rgba(255,255,255,0.13)"}
        linkWidth={0.4}
        linkOpacity={0.4}
        showNavInfo={false}
        onNodeClick={(n: any) => onSelect?.(n)}
      />
    </div>
  );
}
