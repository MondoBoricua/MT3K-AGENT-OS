// SSE de un terminal de Herdr (cualquier backend): lee la vista a >= 1 s y emite fotogramas con la misma forma que tmux.
// Recibe `has` (¿sigue en la lista?) y `view` (lectura) ya resueltos por el backend; no sabe nada de hc ni de herdr.

export const HERDR_STREAM_MIN_TICK_MS = 1000;
const STREAM_MISS_LIMIT = 2;

/** Un fotograma: misma forma que el SSE de tmux (cadena completa primero; con fmt=lines luego diffs). */
export function streamFrame(last, text, lineDiffs) {
  const lines = text.split("\n");
  let from = 0;
  while (last !== null && from < last.length && from < lines.length && last[from] === lines[from]) from++;
  if (last !== null && from === last.length && from === lines.length) return { same: true, lines };
  const payload = last === null || !lineDiffs
    ? JSON.stringify(text)
    : JSON.stringify({ from, lines: lines.slice(from), alt: false, mouse_sgr: false });
  return { same: false, lines, payload };
}

/** `gone` si el terminal desaparece de la lista o la lectura falla dos veces seguidas. */
export function startHerdrStream({ id, tickMs, lineDiffs, write, end, has, view, minTickMs = HERDR_STREAM_MIN_TICK_MS }) {
  const interval = Math.max(minTickMs, tickMs || 0);
  let last = null;
  let closed = false;
  let altSent = false;
  let misses = 0;
  let readFails = 0;
  let timer = null;
  const stop = () => {
    closed = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const gone = () => {
    write("event: gone\ndata: {}\n\n");
    stop();
    end();
  };
  const tick = async () => {
    timer = null;
    try {
      if (!(await has(id))) {
        if (closed) return;
        if (++misses >= STREAM_MISS_LIMIT) return gone();
        return;
      }
      misses = 0;
      const r = await view(id);
      if (closed) return;
      if (!r.ok) {
        if (++readFails >= STREAM_MISS_LIMIT) return gone();
        return;
      }
      readFails = 0;
      const frame = streamFrame(last, r.text, lineDiffs);
      if (!altSent) {
        altSent = true;
        write(`event: alt\ndata: ${JSON.stringify({ alt: false, mouse_sgr: false })}\n\n`);
      }
      if (frame.same) return;
      write(`data: ${frame.payload}\n\n`);
      last = frame.lines;
    } finally {
      if (!closed) timer = setTimeout(tick, interval);
    }
  };
  tick();
  return { stop };
}
