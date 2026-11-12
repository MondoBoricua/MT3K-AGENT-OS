// Pure preview helpers: no DOM or file contents retained outside the selected window.
export function lineWindow(content: string, target = 1) {
  const all = content.split(/\r?\n/);
  const line = Math.min(all.length, Math.max(1, Math.floor(target) || 1));
  const start = Math.max(0, Math.min(line - 11, all.length - 20));
  return all.slice(start, start + 20).map((text, i) => ({ number: start + i + 1, text, highlight: target > 0 && start + i + 1 === target }));
}
export function humanSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 ** 2).toFixed(1)} MB`;
}
export function humanAge(mtime: number, now = Date.now()) {
  const s = Math.max(0, Math.floor((now - mtime) / 1000));
  if (s < 60) return `hace ${s} s`;
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
  return `hace ${Math.floor(s / 86400)} d`;
}
export function previewKind(path: string, file: { mime: string; kind: string; tooBig?: boolean }) {
  const ext = path.split('.').pop()?.toLowerCase();
  if (file.tooBig) return 'metadata';
  if (ext === 'svg' || /svg|html|pdf|video\//i.test(file.mime) || /^(html?|pdf|mp4|webm|mov)$/.test(ext ?? '')) return 'metadata';
  if (/^(png|jpe?g|gif|webp|avif)$/.test(ext ?? '') && /^image\/(png|jpeg|gif|webp|avif)$/i.test(file.mime)) return 'image';
  return file.tooBig || file.kind !== 'text' ? 'metadata' : 'text';
}
export function previewPlacement(x: number, y: number, width: number, height: number, vw: number, vh: number) {
  // Keep the whole card to one side of the pointer, even near a viewport edge.
  const gap = 16, margin = 8;
  const right = vw - x - gap - margin, left = x - gap - margin;
  const useRight = right >= width || right >= left;
  const w = Math.max(0, Math.min(width, useRight ? right : left));
  const h = Math.min(height, Math.max(0, vh - margin * 2));
  return { left: useRight ? x + gap : x - gap - w, top: Math.max(margin, Math.min(y - gap - h, vh - margin - h)), width: w, maxHeight: h };
}
export class PreviewCache<T> {
  private items = new Map<string, { at: number; value: T }>();
  get(key: string, now = Date.now()): T | undefined {
    const hit = this.items.get(key);
    if (!hit) return undefined;
    this.items.delete(key);
    if (now - hit.at >= 30_000) return undefined;
    this.items.set(key, hit);
    return hit.value;
  }
  set(key: string, value: T, now = Date.now()) {
    this.items.delete(key);
    this.items.set(key, { at: now, value });
    if (this.items.size > 50) this.items.delete(this.items.keys().next().value!);
  }
}
