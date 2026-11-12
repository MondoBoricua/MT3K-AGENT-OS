import { createPortal } from "react-dom";
import { useLayoutEffect, useState, type RefObject } from "react";
import { fsRawUrl } from "../lib/api";
import { humanAge, humanSize, previewPlacement } from "../lib/path-preview";
import type { PathPreview } from "../lib/use-path-preview";

export function PathPreviewCard({ preview, cardRef }: { preview: PathPreview | null; cardRef: RefObject<HTMLDivElement> }) {
  const [height, setHeight] = useState(360);
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const measure = () => setHeight(Math.min(360, card.scrollHeight + 2));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(card);
    return () => observer.disconnect();
  }, [preview, cardRef]);
  if (!preview) return null;
  const { path, host, data, x, y } = preview;
  const name = path.split(/[\\/]/).filter(Boolean).pop() || path;
  return createPortal(<div ref={cardRef} role="tooltip" style={previewPlacement(x, y, 560, height, window.innerWidth, window.innerHeight)}
    className="path-preview fixed z-[100] overflow-hidden rounded-xl border border-ink-line bg-ink-900 p-3 text-xs text-white/90 shadow-2xl">
    <div className="mb-2 truncate font-mono font-semibold">{name}</div>
    {data.kind === "missing" ? <p>no existe o no es accesible</p> : data.kind === "directory" ? <>
      {data.entries.map((entry) => <div key={entry.name} className="truncate font-mono leading-5">{entry.dir ? "▸ " : "  "}{entry.name}</div>)}
      {data.total > 12 && <p className="mt-1 text-white/50">+{data.total - 12} más</p>}
    </> : <>
      <p className="mb-2 truncate text-white/50">{humanSize(data.size)} · {humanAge(data.mtime)} · {data.mime}</p>
      {data.kind === "text" && <div className="overflow-hidden font-mono text-[11px] leading-[13px]">
        {data.lines?.map((line) => <div key={line.number} className={`flex ${line.highlight ? "bg-accent/15 text-accent" : ""}`}>
          <span className="mr-3 w-8 shrink-0 select-none text-right text-white/40">{line.number}</span>
          <span className="min-w-0 truncate whitespace-pre">{line.text || " "}</span>
        </div>)}
      </div>}
      {data.kind === "image" && <img src={fsRawUrl(path, host)} alt={name} loading="lazy" onLoad={() => { if (cardRef.current) setHeight(Math.min(360, cardRef.current.scrollHeight + 2)); }} className="max-h-[260px] w-full object-contain" />}
    </>}
  </div>, document.body);
}
