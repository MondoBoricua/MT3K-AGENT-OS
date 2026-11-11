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
const escAttr = (s: string) => esc(s).replace(/"/g, "&quot;");

// capture-pane passes through more than SGR colors: OSC 8 hyperlinks (Claude Code emits
// these), title sets, cursor/erase CSI codes… anything we don't render must be stripped
// or it shows up as literal "]8;id=…" garbage in the viewer. Visible text is kept.
const stripNonSgr = (s: string) =>
  s
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "") // OSC …(BEL|ST): hyperlinks, titles
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, (seq) => (seq.endsWith("m") ? seq : "")) // CSI other than SGR
    .replace(/\x1b[=>78]|\x1b\([0AB]/g, ""); // keypad modes, cursor save/restore, charset selects

// Clickable text inside the terminal. Three kinds, all produced here and nowhere else:
//   1. bare http(s) URLs  -> <a href="https://…" target="_blank" rel="noopener noreferrer">
//   2. absolute file-system paths (/abs, ~/x, C:\x, optional :LINE[:COL]) -> <a data-fs-path="…">
//   3. git branch names (exact token, code-styled run only)               -> <a data-git-branch="…">
// SAFETY INVARIANT: only (1) carries an href, and its scheme is anchored by URL_RE itself.
// (2) and (3) carry ONLY escaped data- attributes (no href, no event handlers, no file:/javascript:
// scheme, nothing computed): ONE delegated click listener on the terminal container reads them
// (see lib/use-terminal-links.ts). Paths and branches are never turned into URLs here.
const URL_RE = /https?:\/\/[^\s<>"']+/g;
// `(^|prefix)` stands in for a lookbehind (old Safari throws on lookbehind at parse time): a path must
// start the text or follow whitespace/an opening quote/bracket, so `src/Users/x`, `a/b` and
// `https://h/Users/x` (consumed as a URL first) are never paths. A POSIX path needs two segments
// (`/Users/x`), so slash commands like `/review` are left alone; `~/x` and `C:\x` need one.
const PATH_RE = /(^|[\s"'`(\[<=,{])(~\/[^\s<>"'`|*?]+|\/[^\s\/<>"'`|*?][^\s<>"'`|*?]*|[A-Za-z]:\\[^\s<>"'`|*?]+)/g;
const TRAIL_PUNCT_RE = /[.,;:!?)\]}]+$/;
const LINE_SUFFIX_RE = /:\d+(?::\d+)?$/;
const BRANCH_TOKEN_RE = /[A-Za-z0-9_.\/+@-]+/g;
const LINK_STYLE = 'style="color:inherit;text-decoration:underline dotted;cursor:pointer"';
const URL_STYLE = 'style="color:inherit;text-decoration:underline"';

export type BranchTitles = ReadonlyMap<string, string>; // branch name -> tooltip text

// text between URLs/paths: only here can a branch token be linked
function linkBranches(text: string, branches: BranchTitles | undefined): string {
  if (!branches || branches.size === 0 || !text) return esc(text);
  let html = "";
  let i = 0;
  for (const m of text.matchAll(BRANCH_TOKEN_RE)) {
    const tok = m[0].replace(/\.+$/, ""); // "on master." -> master
    const title = branches.get(tok);
    if (title === undefined) continue;
    const at = m.index ?? 0;
    html += esc(text.slice(i, at));
    html += `<a data-git-branch="${escAttr(tok)}" title="${escAttr(title)}" ${LINK_STYLE}>${esc(tok)}</a>`;
    i = at + tok.length;
  }
  return html + esc(text.slice(i));
}

// "/a/b" or "~/a" or "C:\a" after trimming; POSIX roots need a second segment
const pathOk = (p: string) => (p.startsWith("/") ? p.indexOf("/", 1) > 0 : p.length > 2);

function linkify(raw: string, branches?: BranchTitles): string {
  let html = "";
  let i = 0;
  const hits: { at: number; end: number; kind: "url" | "path"; text: string }[] = [];
  for (const m of raw.matchAll(URL_RE)) {
    const url = m[0].replace(/[.,;:!?)\]]+$/, ""); // trailing prose punctuation isn't part of the URL
    hits.push({ at: m.index ?? 0, end: (m.index ?? 0) + url.length, kind: "url", text: url });
  }
  for (const m of raw.matchAll(PATH_RE)) {
    const at = (m.index ?? 0) + m[1].length;
    if (hits.some((h) => at >= h.at && at < h.end)) continue; // inside a URL
    const text = m[2].replace(TRAIL_PUNCT_RE, "");
    if (!pathOk(text.replace(LINE_SUFFIX_RE, ""))) continue;
    hits.push({ at, end: at + text.length, kind: "path", text });
  }
  hits.sort((a, b) => a.at - b.at);
  for (const h of hits) {
    if (h.at < i) continue;
    html += linkBranches(raw.slice(i, h.at), branches);
    if (h.kind === "url") {
      html += `<a href="${escAttr(h.text)}" target="_blank" rel="noopener noreferrer" ${URL_STYLE}>${esc(h.text)}</a>`;
    } else {
      const fsPath = h.text.replace(LINE_SUFFIX_RE, "");
      html += `<a data-fs-path="${escAttr(fsPath)}" title="abrir en Files" ${LINK_STYLE}>${esc(h.text)}</a>`;
    }
    i = h.end;
  }
  return html + linkBranches(raw.slice(i), branches);
}

// Inline code in Claude Code is drawn with a non-default, non-grey foreground (measured on its dark
// theme: 38;5;153 for branch/skill names; tool output and chrome use greys 244/246/231). A branch
// name only counts as one when the run is coloured like that. Heuristic, theme-dependent.
function codeStyled(s: Style): boolean {
  if (!s.fg || s.inverse) return false;
  const h = s.fg.slice(1);
  const ch = [0, 2, 4].map((k) => parseInt(h.slice(k, k + 2), 16));
  return Math.max(...ch) - Math.min(...ch) > 24;
}

function styleAttr(s: Style): string {
  let fg = s.fg, bg = s.bg;
  if (s.inverse) { const t = fg ?? "#cccccc"; fg = bg ?? "#1c1c1c"; bg = t; }
  const css: string[] = [];
  if (fg) css.push(`color:${fg}`);
  // With leading-none on the viewer, inline backgrounds cover the whole line box, so full-screen TUIs render solid.
  if (bg) css.push(`background:${bg}`);
  if (s.bold) css.push("font-weight:600");
  if (s.dim) css.push("opacity:.6");
  if (s.italic) css.push("font-style:italic");
  if (s.underline) css.push("text-decoration:underline");
  return css.join(";");
}

// Returns sanitized HTML: all text is escaped; spans only carry numeric-derived colors; the only other
// element is <a>: either an http(s)-anchored, attribute-escaped href, or an href-less link carrying only
// escaped data-fs-path / data-git-branch / title attributes (see the invariant above linkify).
// Pure: `opts.branches` (name -> tooltip) enables branch links; without it the output is the same
// minus branch links.
export function ansiToHtml(input: string, opts: { branches?: BranchTitles } = {}): string {
  input = stripNonSgr(input);
  let st: Style = {};
  let out = "";
  let open = false;
  const flush = (t: string) => {
    if (!t) return;
    if (!open) { out += `<span style="${styleAttr(st)}">`; open = true; }
    out += linkify(t, codeStyled(st) ? opts.branches : undefined);
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
