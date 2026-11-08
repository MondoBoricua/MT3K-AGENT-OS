// Rust `regex` crate → JS RegExp conversion shared by the vendoring script and the server engine.
// Lives in scripts/lib so the fleet update bundle (server.mjs + scripts/lib + panel/dist) carries it.
// Rust's regex crate treats \w, \d and \b as Unicode by default; JS keeps them ASCII even with
// the `u` flag ("cancel\b" must NOT match "cancelé"). Rewrite them with Unicode properties:
// \w = [\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\p{Join_Control}] (the crate's definition), \d = \p{Nd},
// \s = \p{White_Space}, \b/\B = lookarounds on the word class. Inside a character class \b is a
// backspace and stays as is. Compiling is not equivalence: the differential test in
// scripts/tests/agent-detect.test.mjs pins the cases that matter (é, Arabic digits, U+0085).
export const RUST_WORD_CLASS = "\\p{Alphabetic}\\p{M}\\p{Nd}\\p{Pc}\\p{Join_Control}";
export function unicodeClassEscapes(pattern) {
  const W = RUST_WORD_CLASS;
  let out = "";
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      const next = pattern[i + 1];
      i++;
      if (next === undefined) return { unsupported: true, reason: "Trailing backslash" };
      if (!inClass && next === "b") { out += `(?:(?<![${W}])(?=[${W}])|(?<=[${W}])(?![${W}]))`; continue; }
      if (!inClass && next === "B") { out += `(?:(?<![${W}])(?![${W}])|(?<=[${W}])(?=[${W}]))`; continue; }
      if (next === "w") { out += inClass ? W : `[${W}]`; continue; }
      if (next === "d") { out += "\\p{Nd}"; continue; }
      // Rust \s is the Unicode White_Space property (includes U+0085); JS \s lacks U+0085 and adds U+FEFF
      // single property escapes are legal inside classes too, so [^\S\n] → [^\P{White_Space}\n]
      if (next === "s") { out += "\\p{White_Space}"; continue; }
      if (next === "S") { out += "\\P{White_Space}"; continue; }
      if (next === "D") { out += "\\P{Nd}"; continue; }
      // \W is the negation of a UNION of properties: expressible only outside a class
      if (next === "W") { if (inClass) return { unsupported: true, reason: "\\W inside a character class" }; out += `[^${W}]`; continue; }
      out += "\\" + next;
      continue;
    }
    if (ch === "[" && !inClass) {
      inClass = true;
      out += ch;
      if (pattern[i + 1] === "^") { out += "^"; i++; }
      if (pattern[i + 1] === "]") { out += "]"; i++; } // a leading ] is literal
      continue;
    }
    if (ch === "]" && inClass) { inClass = false; out += ch; continue; }
    out += ch;
  }
  return { unsupported: false, pattern: out };
}

export function convertRustRegex(raw) {
  let pattern = raw;
  const flagSet = new Set(["u"]);

  while (true) {
    const m = pattern.match(/^\(\?([ims]+)\)/);
    if (!m) break;
    for (const ch of m[1]) flagSet.add(ch);
    pattern = pattern.slice(m[0].length);
  }

  if (/\\h|\\H/.test(pattern)) {
    return { unsupported: true, reason: "Rust horizontal whitespace escape (\\h/\\H)" };
  }
  if (/(?<!\\)(?:[+*?]\+|\{\d+(?:,\d*)?\}\+)/.test(pattern)) {
    return { unsupported: true, reason: "Possessive quantifier" };
  }
  if (/\(\?>/.test(pattern)) {
    return { unsupported: true, reason: "Atomic group (?>...)" };
  }
  if (/\(\?[-imsux]+[:)]/.test(pattern)) {
    return { unsupported: true, reason: "Mid-pattern or scoped inline flags" };
  }

  pattern = pattern.replace(/\\x\{([0-9a-fA-F]+)\}/g, "\\u{$1}");
  pattern = pattern.replace(/\\A/g, "(?<![\\s\\S])");
  pattern = pattern.replace(/\\z/g, "(?![\\s\\S])");
  const unicode = unicodeClassEscapes(pattern);
  if (unicode.unsupported) return { unsupported: true, reason: unicode.reason };
  pattern = unicode.pattern;

  const flags = ["i", "m", "s", "u"].filter((f) => flagSet.has(f)).join("");
  try {
    new RegExp(pattern, flags);
    return { unsupported: false, pattern, flags };
  } catch (err) {
    return { unsupported: true, reason: err.message };
  }
}
