// Pure rule engine ported from herdr (src/detect/manifest.rs, Apache-2.0).
// Evaluates per-agent screen/OSC rules compiled in scripts/agent-detection/manifests.json.

import { convertRustRegex } from "../agent-detection/vendor.mjs";

export const DEFAULT_KNOWN_AGENT_IDLE_FALLBACK = "default_known_agent_idle_fallback";

export const PANEL_AGENT_TO_MANIFEST = {
  claude: "claude",
  codex: "codex",
  opencode: "opencode",
  grok: "grok",
  copilot: "github-copilot",
  antigravity: "antigravity",
  cursor: "cursor",
};

export function splitLinesWithOffsets(content) {
  if (!content) return [];
  const lines = [];
  let start = 0;
  const len = content.length;
  while (start < len) {
    const nl = content.indexOf("\n", start);
    if (nl === -1) {
      lines.push({ start, end: len, line: content.slice(start) });
      break;
    }
    const end = nl > start && content[nl - 1] === "\r" ? nl - 1 : nl;
    lines.push({ start, end, line: content.slice(start, end) });
    start = nl + 1;
  }
  return lines;
}

const codexPromptLine = (line) => line === "›" || line.startsWith("› ");
const codexBlockMarkerLine = (line) => /^[•■✗✓]/u.test(line);

function currentCodexPromptIndex(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!codexPromptLine(lines[i].line)) continue;
    let hasBlockAfter = false;
    for (let j = i + 1; j < lines.length; j++) {
      if (codexBlockMarkerLine(lines[j].line)) {
        hasBlockAfter = true;
        break;
      }
    }
    if (!hasBlockAfter) return i;
  }
  return -1;
}

function isHorizontalRule(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("─")) return false;
  let allDashes = true;
  let leadingDashes = 0;
  let countingLeading = true;
  for (const ch of trimmed) {
    if (ch === "─") {
      if (countingLeading) leadingDashes++;
    } else {
      allDashes = false;
      countingLeading = false;
    }
  }
  return allDashes || leadingDashes >= 3;
}

function promptBoxTopBorderIndex(lines) {
  const borders = [];
  for (let i = 0; i < lines.length; i++) {
    if (isHorizontalRule(lines[i].line)) borders.push(i);
  }
  return borders.length >= 2 ? borders[borders.length - 2] : -1;
}

// Rust slices up to the START of the border line, so the previous line's newline stays in
function abovePromptBox(content, lines) {
  const top = promptBoxTopBorderIndex(lines);
  if (top === -1) return content;
  return content.slice(0, lines[top].start);
}

export function extractRegion(input, spec = "whole_recent") {
  const regionSpec = spec || "whole_recent";
  if (regionSpec === "osc_title") return input?.oscTitle ?? "";
  if (regionSpec === "osc_progress") return input?.oscProgress ?? "";
  const content = input?.screen ?? "";
  if (regionSpec === "whole_recent") return content;

  const bottomLinesMatch = regionSpec.match(/^bottom_lines\((\d+)\)$/);
  if (bottomLinesMatch) {
    const count = Number(bottomLinesMatch[1]);
    if (count === 0) return "";
    const lines = splitLinesWithOffsets(content);
    if (lines.length === 0) return "";
    return content.slice(lines[Math.max(0, lines.length - count)].start);
  }

  const bottomNonEmptyMatch = regionSpec.match(/^bottom_non_empty_lines\((\d+)\)$/);
  if (bottomNonEmptyMatch) {
    const count = Number(bottomNonEmptyMatch[1]);
    if (count === 0) return "";
    const nonEmpty = splitLinesWithOffsets(content).filter((l) => l.line.trim().length > 0);
    if (nonEmpty.length === 0) return "";
    return content.slice(nonEmpty[Math.max(0, nonEmpty.length - count)].start);
  }

  const topNonEmptyMatch = regionSpec.match(/^top_non_empty_lines\((\d+)\)$/);
  if (topNonEmptyMatch) {
    const count = Number(topNonEmptyMatch[1]);
    if (count === 0) return "";
    const nonEmpty = splitLinesWithOffsets(content).filter((l) => l.line.trim().length > 0);
    if (nonEmpty.length === 0) return "";
    const chosen = nonEmpty[Math.min(nonEmpty.length - 1, count - 1)];
    const rest = content.slice(chosen.end);
    const suffix = rest.startsWith("\r\n") ? 2 : rest.startsWith("\n") ? 1 : 0;
    return content.slice(0, chosen.end + suffix);
  }

  const lines = splitLinesWithOffsets(content);
  if (regionSpec === "after_last_prompt_marker") {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (codexPromptLine(lines[i].line)) return i + 1 < lines.length ? content.slice(lines[i + 1].start) : "";
    }
    return content;
  }
  if (regionSpec === "before_current_prompt_marker") {
    const idx = currentCodexPromptIndex(lines);
    return idx === -1 ? content : content.slice(0, lines[idx].start); // keeps the newline before the marker, like Rust
  }
  if (regionSpec === "whole_recent_without_current_prompt_marker") {
    return currentCodexPromptIndex(lines) !== -1 ? "" : content;
  }
  if (regionSpec === "current_prompt_block_marker" || regionSpec === "after_current_prompt_block_marker") {
    const pIdx = currentCodexPromptIndex(lines);
    if (pIdx === -1) return "";
    for (let i = pIdx - 1; i >= 0; i--) {
      if (codexBlockMarkerLine(lines[i].line)) {
        return regionSpec === "current_prompt_block_marker" ? lines[i].line : content.slice(lines[i].start);
      }
    }
    return "";
  }
  if (regionSpec === "prompt_box_body") {
    const top = promptBoxTopBorderIndex(lines);
    if (top === -1) return "";
    const bottom = lines.findIndex((l, i) => i > top && isHorizontalRule(l.line));
    // Rust: from the start of the line after the top border to the START of the bottom border
    // (so the body keeps its trailing newline); no bottom border → to the end of the content
    const start = top + 1 < lines.length ? lines[top + 1].start : content.length;
    const end = bottom === -1 ? content.length : lines[bottom].start;
    return content.slice(start, Math.max(start, end));
  }
  if (regionSpec === "above_prompt_box") return abovePromptBox(content, lines);
  if (regionSpec === "last_non_empty_above_prompt_box") {
    const aboveLines = splitLinesWithOffsets(abovePromptBox(content, lines));
    for (let i = aboveLines.length - 1; i >= 0; i--) {
      if (aboveLines[i].line.trim().length > 0) return aboveLines[i].line;
    }
    return "";
  }
  if (regionSpec === "after_last_horizontal_rule") {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (isHorizontalRule(lines[i].line)) return i + 1 < lines.length ? content.slice(lines[i + 1].start) : "";
    }
    return content;
  }
  return "";
}

function compileRegexList(rawList, precompiledList) {
  if (!Array.isArray(rawList) || rawList.length === 0) return [];
  const out = [];
  for (let i = 0; i < rawList.length; i++) {
    const pre = Array.isArray(precompiledList) ? precompiledList[i] : null;
    if (pre && pre.unsupported) return null;
    const spec = pre && pre.pattern !== undefined ? pre : convertRustRegex(rawList[i]);
    if (spec.unsupported) return null;
    out.push(new RegExp(spec.pattern, spec.flags));
  }
  return out;
}

function compileGate(rawGate) {
  const containsLower = Array.isArray(rawGate.contains) ? rawGate.contains.map((s) => String(s).toLowerCase()) : [];
  const regexes = compileRegexList(rawGate.regex, rawGate.js?.regex);
  const lineRegexes = compileRegexList(rawGate.line_regex, rawGate.js?.line_regex);
  if (!regexes || !lineRegexes) return null;

  const compileChildren = (arr) => {
    if (!Array.isArray(arr) || arr.length === 0) return [];
    const res = [];
    for (const child of arr) {
      const c = compileGate(child);
      if (!c) return null;
      res.push(c);
    }
    return res;
  };
  const all = compileChildren(rawGate.all);
  const any = compileChildren(rawGate.any);
  const not = compileChildren(rawGate.not);
  if (!all || !any || !not) return null;
  return { containsLower, regexes, lineRegexes, all, any, not };
}

function evalGate(gate, regionText, cachedLower, cachedLines) {
  let matchedSample = null;
  const getLower = () => (cachedLower.value ??= regionText.toLowerCase());
  const getLines = () => (cachedLines.value ??= splitLinesWithOffsets(regionText).map((l) => l.line));

  for (const needle of gate.containsLower) {
    const idx = getLower().indexOf(needle);
    if (idx === -1) return { ok: false, matched: null };
    if (matchedSample === null) matchedSample = regionText.slice(idx, idx + needle.length);
  }
  for (const re of gate.regexes) {
    const m = re.exec(regionText);
    if (!m) return { ok: false, matched: null };
    if (matchedSample === null) matchedSample = m[0];
  }
  for (const re of gate.lineRegexes) {
    let lineMatch = null;
    for (const line of getLines()) {
      const m = re.exec(line);
      if (m) {
        lineMatch = m[0];
        break;
      }
    }
    if (lineMatch === null) return { ok: false, matched: null };
    if (matchedSample === null) matchedSample = lineMatch;
  }
  for (const child of gate.all) {
    const res = evalGate(child, regionText, cachedLower, cachedLines);
    if (!res.ok) return { ok: false, matched: null };
    if (matchedSample === null && res.matched !== null) matchedSample = res.matched;
  }
  if (gate.any.length > 0) {
    let anyOk = false;
    for (const child of gate.any) {
      const res = evalGate(child, regionText, cachedLower, cachedLines);
      if (res.ok) {
        anyOk = true;
        if (matchedSample === null && res.matched !== null) matchedSample = res.matched;
        break;
      }
    }
    if (!anyOk) return { ok: false, matched: null };
  }
  for (const child of gate.not) {
    if (evalGate(child, regionText, cachedLower, cachedLines).ok) return { ok: false, matched: null };
  }
  return { ok: true, matched: matchedSample };
}

export function loadManifests(json) {
  const manifests = {};
  const aliases = {};
  const droppedRules = [];

  for (const [key, rawManifest] of Object.entries(json?.manifests || {})) {
    const id = rawManifest.id || key;
    const compiledRules = [];
    const manifestDropped = [];

    for (const rawRule of rawManifest.rules || []) {
      const gate = rawRule.unsupported ? null : compileGate(rawRule);
      if (!gate) {
        manifestDropped.push(rawRule.id);
        droppedRules.push({ manifest: id, ruleId: rawRule.id });
        continue;
      }
      compiledRules.push({
        id: rawRule.id,
        priority: typeof rawRule.priority === "number" ? rawRule.priority : 0,
        region: rawRule.region || "whole_recent",
        state: rawRule.state || "idle",
        skipStateUpdate: Boolean(rawRule.skip_state_update),
        gate,
      });
    }

    const compiledManifest = {
      id,
      displayName: rawManifest.display_name || id,
      aliases: Array.isArray(rawManifest.aliases) ? rawManifest.aliases : [],
      rules: compiledRules,
      droppedRuleIds: manifestDropped,
    };
    manifests[id] = compiledManifest;
    aliases[id.toLowerCase()] = compiledManifest;
    for (const alias of compiledManifest.aliases) {
      aliases[String(alias).toLowerCase()] = compiledManifest;
      if (!(alias in manifests)) {
        Object.defineProperty(manifests, alias, { value: compiledManifest, enumerable: false, configurable: true });
      }
    }
  }

  return {
    manifests,
    aliases,
    droppedRules,
    unsupported: Array.isArray(json?.unsupported) ? json.unsupported : [],
    resolve(agentId) {
      if (!agentId) return null;
      const mapped = PANEL_AGENT_TO_MANIFEST[agentId] || agentId;
      return manifests[mapped] || aliases[String(mapped).toLowerCase()] || null;
    },
  };
}

export function detectState(manifest, input, prev = null) {
  if (!manifest || !Array.isArray(manifest.rules)) {
    return { state: "unknown", ruleId: null, region: null, matched: null };
  }
  let bestRule = null;
  let bestMatched = null;
  const regionCache = new Map();

  for (const rule of manifest.rules) {
    if (bestRule !== null && bestRule.priority >= rule.priority) continue;
    const regionSpec = rule.region || "whole_recent";
    let entry = regionCache.get(regionSpec);
    if (!entry) {
      entry = { text: extractRegion(input, regionSpec), lower: { value: null }, lines: { value: null } };
      regionCache.set(regionSpec, entry);
    }
    const res = evalGate(rule.gate, entry.text, entry.lower, entry.lines);
    if (res.ok) {
      bestRule = rule;
      bestMatched = res.matched;
    }
  }

  if (!bestRule) {
    return { state: "idle", ruleId: DEFAULT_KNOWN_AGENT_IDLE_FALLBACK, region: null, matched: null };
  }
  const state = bestRule.skipStateUpdate ? prev?.state || "idle" : bestRule.state;
  return { state, ruleId: bestRule.id, region: bestRule.region, matched: bestMatched };
}
