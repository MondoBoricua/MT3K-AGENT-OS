// Small repaint interpreter, not a terminal emulator. Every code point is one
// column (including CJK/emoji), except Unicode combining marks, which are zero.
const ESC = '\x1b';
const LIMIT = 2 * 1024 * 1024;
const MARK = /\p{Mark}/u;
const dimension = (n, fallback, max) => Number.isFinite(n) ? Math.max(1, Math.min(max, Math.trunc(n))) : fallback;

/** Interpret a bounded attach repaint as history + screen, with only SGR escapes. */
export function paintToAnsiLines(bytes, options = {}) {
  let { cols = 200, rows = 120 } = options ?? {};
  let complete = true;
  if ((Number.isFinite(cols) && cols > 1000) || (Number.isFinite(rows) && rows > 5000)) complete = false;
  cols = dimension(cols, 200, 1000); rows = dimension(rows, 120, 5000);
  let source;
  try {
    let b;
    if (typeof bytes === 'string') {
      if (bytes.length > LIMIT) complete = false;
      b = Buffer.from(bytes.slice(0, LIMIT));
    } else if (ArrayBuffer.isView(bytes)) {
      if (bytes.byteLength > LIMIT) complete = false;
      b = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, LIMIT));
    } else if (bytes instanceof ArrayBuffer) {
      if (bytes.byteLength > LIMIT) complete = false;
      b = Buffer.from(bytes, 0, Math.min(bytes.byteLength, LIMIT));
    } else if (Array.isArray(bytes)) {
      if (bytes.length > LIMIT) complete = false;
      b = Buffer.from(bytes.slice(0, LIMIT));
    } else if (bytes == null) b = Buffer.alloc(0);
    else return { lines: [], complete: false };
    if (b.length > LIMIT) complete = false;
    source = b.subarray(0, LIMIT).toString('utf8');
  } catch { return { lines: [], complete: false }; }
  const fresh = () => ({ grid: Array.from({ length: rows }, () => []), top: 0, x: 0, y: 0, saved: null, attrs: new Map(), sgr: '' });
  let s = fresh(), main = null;
  let stopped = false;
  const row = () => s.grid[s.top + s.y];
  const setSgr = () => { s.sgr = s.attrs.size ? `${ESC}[${[...s.attrs.values()].join(';')}m` : ''; };
  function sgr(raw) {
    // Store attributes by category instead of accumulating an unbounded SGR log.
    const p = raw === '' ? [0] : raw.split(';').map(v => v === '' ? 0 : Number(v));
    for (let i = 0; i < p.length; i++) {
      const n = p[i];
      if (!Number.isInteger(n) || n < 0 || n > 255) continue;
      if (n === 0) s.attrs.clear();
      else if ([38, 48, 58].includes(n)) {
        const count = p[i + 1] === 2 ? 4 : p[i + 1] === 5 ? 2 : 0;
        if (count && i + count < p.length && p.slice(i + 1, i + count + 1).every(v => Number.isInteger(v) && v >= 0 && v <= 255)) {
          s.attrs.set(n, p.slice(i, i + count + 1).join(';')); i += count;
        }
      } else if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) s.attrs.set(38, `${n}`);
      else if ((n >= 40 && n <= 47) || (n >= 100 && n <= 107)) s.attrs.set(48, `${n}`);
      else if ([39, 49, 59].includes(n)) s.attrs.delete(n - 1);
      else if (n === 22) { s.attrs.delete(1); s.attrs.delete(2); }
      else if (n === 23) s.attrs.delete(3);
      else if (n === 24) s.attrs.delete(4);
      else if (n === 25) s.attrs.delete(5);
      else if (n === 27) s.attrs.delete(7);
      else if (n === 28) s.attrs.delete(8);
      else if (n === 29) s.attrs.delete(9);
      else if (n === 54) s.attrs.delete(51);
      else if (n === 55) s.attrs.delete(53);
      else if (n === 75) s.attrs.delete(73);
      else if (n >= 10 && n <= 19) { if (n === 10) s.attrs.delete(10); else s.attrs.set(10, `${n}`); }
      else if ([1, 2, 3, 4, 5, 6, 7, 8, 9, 21, 26, 51, 52, 53, 73, 74].includes(n)) {
        const key = n === 6 ? 5 : n === 21 ? 4 : n === 52 ? 51 : n === 74 ? 73 : n;
        s.attrs.set(key, `${n}`);
      }
    }
    setSgr();
  }
  function lf() {
    if (s.y < rows - 1) s.y++;
    else {
      if (s.grid.length + (main?.grid.length ?? 0) >= 5000) { complete = false; stopped = true; return; }
      s.top++; s.grid.push([]);
    }
  }
  function eraseLine(mode) {
    const r = row(), x = Math.min(s.x, cols - 1);
    const start = mode === 0 ? x : 0, end = mode === 1 ? x + 1 : cols;
    if (!s.sgr && end === cols) r.length = Math.min(r.length, start);
    else for (let i = start; i < end; i++) r[i] = { ch: ' ', sgr: s.sgr };
  }
  const save = () => { s.saved = { x: s.x, y: s.y, attrs: new Map(s.attrs) }; };
  const restore = () => { if (s.saved) { s.x = s.saved.x; s.y = s.saved.y; s.attrs = new Map(s.saved.attrs); setSgr(); } };
  function csi(raw, final) {
    if (raw[0] === '?') {
      if ((final === 'h' || final === 'l') && raw.slice(1).split(';').some(v => ['47', '1047', '1049'].includes(v))) {
        if (final === 'h' && !main) {
          if (s.grid.length + rows > 5000) { complete = false; stopped = true; return; }
          main = s; s = fresh();
        } else if (final === 'l' && main) { s = main; main = null; }
      }
      return;
    }
    if (!/^[0-9;]*$/.test(raw)) return;
    if (final === 'm') { sgr(raw); return; }
    const p = raw.split(';').map(Number), n = p[0] || 1;
    switch (final) {
      case 'A': s.y = Math.max(0, s.y - n); break;
      case 'B': s.y = Math.min(rows - 1, s.y + n); break;
      case 'C': s.x = Math.min(cols - 1, s.x + n); break;
      case 'D': s.x = Math.max(0, s.x - n); break;
      case 'G': s.x = Math.min(cols - 1, n - 1); break;
      case 'H': case 'f': s.y = Math.min(rows - 1, n - 1); s.x = Math.min(cols - 1, (p[1] || 1) - 1); break;
      case 's': save(); break;
      case 'u': restore(); break;
      case 'K': if (p[0] <= 2) eraseLine(p[0]); break;
      case 'J': {
        const mode = p[0];
        if (mode === 3) { s.grid = s.grid.slice(s.top); s.top = 0; }
        else if (mode <= 2) {
          const y = s.y;
          if (mode === 0 || mode === 1) eraseLine(mode);
          const start = mode === 0 ? y + 1 : 0, end = mode === 1 ? y : rows;
          for (let i = start; i < end; i++) { s.y = i; eraseLine(2); }
          s.y = y;
        }
        break;
      }
    }
  }
  for (let i = 0; i < source.length && !stopped;) {
    const c = source.codePointAt(i), ch = String.fromCodePoint(c); i += ch.length;
    if (c === 27 || c === 0x9b || c === 0x9d || c === 0x90) {
      const kind = c === 27 ? source[i++] : c === 0x9b ? '[' : c === 0x9d ? ']' : 'P';
      if (kind === '[') {
        const start = i;
        while (i < source.length && !(source.charCodeAt(i) >= 0x40 && source.charCodeAt(i) <= 0x7e)) i++;
        if (i === source.length) { complete = false; break; }
        if (i - start <= 256) csi(source.slice(start, i), source[i]);
        i++;
      } else if ([']', 'P', '^', '_', 'X'].includes(kind)) {
        let ended = false;
        while (i < source.length) {
          if (source.charCodeAt(i) === 0x9c || (kind === ']' && source.charCodeAt(i) === 7)) { i++; ended = true; break; }
          if (source[i] === ESC && source[i + 1] === '\\') { i += 2; ended = true; break; }
          i++;
        }
        if (!ended) complete = false;
      } else if (kind === '7') save();
      else if (kind === '8') restore();
      else {
        // Consume ESC intermediates (charset selects etc.) and their final.
        if (kind === undefined) complete = false;
        else if (kind.charCodeAt(0) >= 0x20 && kind.charCodeAt(0) <= 0x2f) {
          while (i < source.length && source.charCodeAt(i) >= 0x20 && source.charCodeAt(i) <= 0x2f) i++;
          if (i < source.length) i++; else complete = false;
        }
      }
      continue;
    }
    if (c === 13) s.x = 0;
    else if (c === 10) lf();
    else if (c === 8) s.x = Math.max(0, s.x - 1);
    else if (c === 9) s.x = Math.min(cols - 1, (Math.floor(s.x / 8) + 1) * 8);
    else if (c >= 32 && !(c >= 0x7f && c <= 0x9f)) {
      if (MARK.test(ch)) {
        const prev = row()[Math.min(cols, s.x) - 1];
        if (prev) prev.ch += ch;
      } else {
        if (s.x >= cols) { s.x = 0; lf(); if (stopped) break; }
        row()[s.x++] = { ch, sgr: s.sgr };
      }
    }
  }
  const lines = s.grid.map(r => {
    let end = r.length;
    while (end && (!r[end - 1] || r[end - 1].ch === ' ')) end--;
    let text = '', attr = '';
    for (let i = 0; i < end; i++) {
      const cell = r[i], next = cell?.sgr ?? '';
      if (attr !== next) { if (attr) text += `${ESC}[0m`; text += next; attr = next; }
      text += cell?.ch ?? ' ';
    }
    return text + (attr ? `${ESC}[0m` : '');
  });
  return { lines, complete };
}
