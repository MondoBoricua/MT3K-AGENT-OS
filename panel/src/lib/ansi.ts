// Minimal ANSI SGR → HTML converter for the live terminal viewer.
// tmux `capture-pane -e` emits the already-rendered screen with SGR color codes,
// so we only need to translate colors/styles — no cursor or layout emulation.

const C16 = [
  "#1c1c1c", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#cccccc",
  "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff",
];

const hex = (n: number) => Math.max(0, Math.min(255, n | 0)).toString(16).padStart(2, "0");

function color256(n: number): string {
  if (n < 16) return C16[n];
  if (n < 232) {
    const i = n - 16;
    const lvl = (x: number) => (x === 0 ? 0 : 55 + x * 40);
    return `#${hex(lvl(Math.floor(i / 36)))}${hex(lvl(Math.floor((i % 36) / 6)))}${hex(lvl(i % 6))}`;
  }
  const v = 8 + (n - 232) * 10;
  return `#${hex(v)}${hex(v)}${hex(v)}`;
}

interface Style { fg?: string; bg?: string; bold?: boolean; dim?: boolean; italic?: boolean; underline?: boolean; inverse?: boolean }

function applyCodes(prev: Style, codes: number[]): Style {
  let s: Style = { ...prev };
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i];
    if (c === 0) s = {};
    else if (c === 1) s = { ...s, bold: true };
    else if (c === 2) s = { ...s, dim: true };
    else if (c === 3) s = { ...s, italic: true };
    else if (c === 4) s = { ...s, underline: true };
    else if (c === 7) s = { ...s, inverse: true };
    else if (c === 22) s = { ...s, bold: false, dim: false };
    else if (c === 23) s = { ...s, italic: false };
    else if (c === 24) s = { ...s, underline: false };
    else if (c === 27) s = { ...s, inverse: false };
    else if (c >= 30 && c <= 37) s = { ...s, fg: C16[c - 30] };
    else if (c === 38 && codes[i + 1] === 5) { s = { ...s, fg: color256(codes[i + 2]) }; i += 2; }
    else if (c === 38 && codes[i + 1] === 2) { s = { ...s, fg: `#${hex(codes[i + 2])}${hex(codes[i + 3])}${hex(codes[i + 4])}` }; i += 4; }
    else if (c === 39) s = { ...s, fg: undefined };
    else if (c >= 40 && c <= 47) s = { ...s, bg: C16[c - 40] };
    else if (c === 48 && codes[i + 1] === 5) { s = { ...s, bg: color256(codes[i + 2]) }; i += 2; }
    else if (c === 48 && codes[i + 1] === 2) { s = { ...s, bg: `#${hex(codes[i + 2])}${hex(codes[i + 3])}${hex(codes[i + 4])}` }; i += 4; }
    else if (c === 49) s = { ...s, bg: undefined };
    else if (c >= 90 && c <= 97) s = { ...s, fg: C16[c - 90 + 8] };
    else if (c >= 100 && c <= 107) s = { ...s, bg: C16[c - 100 + 8] };
  }
  return s;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function styleAttr(s: Style): string {
  let fg = s.fg, bg = s.bg;
  if (s.inverse) { const t = fg ?? "#cccccc"; fg = bg ?? "#1c1c1c"; bg = t; }
  const css: string[] = [];
  if (fg) css.push(`color:${fg}`);
  if (bg) css.push(`background:${bg}`);
  if (s.bold) css.push("font-weight:600");
  if (s.dim) css.push("opacity:.6");
  if (s.italic) css.push("font-style:italic");
  if (s.underline) css.push("text-decoration:underline");
  return css.join(";");
}

// Returns sanitized HTML: all text is escaped; spans only carry numeric-derived colors.
export function ansiToHtml(input: string): string {
  let st: Style = {};
  let out = "";
  let open = false;
  const flush = (t: string) => {
    if (!t) return;
    if (!open) { out += `<span style="${styleAttr(st)}">`; open = true; }
    out += esc(t);
  };
  const closeSpan = () => { if (open) { out += "</span>"; open = false; } };

  const re = /\x1b\[([0-9;]*)m/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input))) {
    flush(input.slice(last, m.index));
    last = re.lastIndex;
    closeSpan();
    const codes = m[1] === "" ? [0] : m[1].split(";").map((x) => Number(x) || 0);
    st = applyCodes(st, codes);
  }
  flush(input.slice(last));
  closeSpan();
  return out;
}
