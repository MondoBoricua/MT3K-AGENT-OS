import { useEffect, useRef, useState, type RefObject } from "react";
import { fsRead, fsList, type FsEntry } from "./api";
import { lineWindow, previewKind, PreviewCache } from "./path-preview";

export type PreviewData = { kind: "missing" } | { kind: "directory"; entries: FsEntry[]; total: number } | {
  kind: "text" | "image" | "metadata"; size: number; mtime: number; mime: string;
  lines?: ReturnType<typeof lineWindow>; target: number;
};
export type PathPreview = { path: string; host?: string; x: number; y: number; data: PreviewData };
const cache = new PreviewCache<PreviewData>();
// Shared across sheets and mosaic tiles. A departed hover cannot launch a queued request.
let pending: Promise<unknown> = Promise.resolve();
let dismissActive: (() => void) | undefined;
function load(path: string, host: string | undefined, target: number, alive: () => boolean): Promise<PreviewData | undefined> {
  const job = pending.then(async () => {
    if (!alive()) return;
    const key = JSON.stringify([host ?? "", path]);
    const hit = cache.get(key);
    if (hit && (hit.kind !== "text" || hit.target === target)) return hit;
    const file = await fsRead(path, host);
    if (!alive()) return;
    let data: PreviewData;
    if (file?.ok) {
      const kind = previewKind(path, file);
      data = { kind, size: file.size, mtime: file.mtime, mime: file.mime, target,
        ...(kind === "text" ? { lines: lineWindow(file.content ?? "", target) } : {}) };
    } else {
      const listing = await fsList(path, host);
      if (!alive()) return;
      data = listing?.ok ? { kind: "directory", total: listing.entries.length,
        entries: listing.entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)).slice(0, 12) } : { kind: "missing" };
    }
    cache.set(key, data);
    return data;
  });
  pending = job.catch(() => undefined);
  return job;
}

export function usePathPreview(container: RefObject<HTMLElement>, host?: string, view?: string) {
  const [preview, setPreview] = useState<PathPreview | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  // Reattach when the sheet switches between its overview and terminal.
  useEffect(() => {
    const el = container.current;
    const media = window.matchMedia("(hover: hover) and (pointer: fine)");
    setPreview(null);
    if (!el) return;
    let anchor: Element | null = null, generation = 0, activePath = "", activeLine = "";
    let point = { x: 0, y: 0 }, hovering = false;
    let dwell: ReturnType<typeof setTimeout> | undefined, grace: ReturnType<typeof setTimeout> | undefined;
    const hide = () => { if (dismissActive === hide) dismissActive = undefined; generation++; anchor = null; hovering = false; clearTimeout(dwell); clearTimeout(grace); setPreview(null); };
    const leave = () => { clearTimeout(dwell); generation++; hovering = false; clearTimeout(grace); grace = setTimeout(hide, 120); };
    const keep = () => { clearTimeout(grace); };
    const insideCard = (node: EventTarget | null) => node instanceof Node && !!cardRef.current?.contains(node);
    const over = (e: PointerEvent) => {
      if (e.pointerType === "touch" || !(e.target instanceof Element)) return;
      const a = e.target.closest("a[data-fs-path]");
      if (!a || !el.contains(a)) return;
      keep();
      if (a === anchor && hovering) return;
      dismissActive?.();
      hide(); dismissActive = hide; anchor = a; hovering = true;
      const path = a.getAttribute("data-fs-path")!; activePath = path;
      activeLine = a.getAttribute("data-fs-line") ?? "";
      const target = Number(activeLine) || 0;
      point = { x: e.clientX, y: e.clientY };
      const token = generation;
      const alive = () => generation === token && el.contains(a);
      dwell = setTimeout(() => {
        void load(path, host, target, alive).then((data) => {
          if (data && alive()) setPreview({ path, host, x: point.x, y: point.y, data });
        }).catch(() => { if (alive()) setPreview({ path, host, x: point.x, y: point.y, data: { kind: "missing" } }); });
      }, 300);
    };
    const out = (e: PointerEvent) => {
      if (!anchor || (e.relatedTarget instanceof Node && anchor.contains(e.relatedTarget))) return;
      if (insideCard(e.relatedTarget)) { keep(); return; }
      leave();
    };
    const move = (e: PointerEvent) => { point = { x: e.clientX, y: e.clientY }; };
    const keydown = (e: KeyboardEvent) => { if (e.key === "Escape") hide(); };
    const observer = new MutationObserver(() => { if (anchor && (!el.contains(anchor) || anchor.getAttribute("data-fs-path") !== activePath || (anchor.getAttribute("data-fs-line") ?? "") !== activeLine)) hide(); });
    // Card is portalled, so these delegated document listeners bridge the 120ms gap.
    const cardOver = (e: PointerEvent) => { if (insideCard(e.target)) keep(); };
    const cardOut = (e: PointerEvent) => { if (insideCard(e.target) && !insideCard(e.relatedTarget) && !(e.relatedTarget instanceof Node && anchor?.contains(e.relatedTarget))) leave(); };
    const attach = () => {
      if (!media.matches) return;
      el.addEventListener("pointerover", over); el.addEventListener("pointerout", out); el.addEventListener("pointermove", move);
      el.addEventListener("scroll", hide); document.addEventListener("click", hide);
      document.addEventListener("keydown", keydown); window.addEventListener("resize", hide);
      document.addEventListener("pointerover", cardOver); document.addEventListener("pointerout", cardOut);
      observer.observe(el, { childList: true, subtree: true, attributes: true });
    };
    const detach = () => {
      el.removeEventListener("pointerover", over); el.removeEventListener("pointerout", out); el.removeEventListener("pointermove", move);
      el.removeEventListener("scroll", hide); document.removeEventListener("click", hide);
      document.removeEventListener("keydown", keydown); window.removeEventListener("resize", hide); observer.disconnect();
      document.removeEventListener("pointerover", cardOver); document.removeEventListener("pointerout", cardOut);
    };
    const changed = () => { detach(); hide(); attach(); };
    attach(); media.addEventListener("change", changed);
    return () => {
      detach(); media.removeEventListener("change", changed);
      document.removeEventListener("pointerover", cardOver); document.removeEventListener("pointerout", cardOut);
      clearTimeout(dwell); clearTimeout(grace); generation++;
      if (dismissActive === hide) dismissActive = undefined;
    };
  }, [container, host, view]);
  return { preview, cardRef };
}
