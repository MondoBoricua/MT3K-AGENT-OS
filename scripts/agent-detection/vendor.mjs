#!/usr/bin/env node
// Vendors herdr TOML detection manifests into scripts/agent-detection/manifests.json
// with preconverted JS RegExp patterns (u flag) and unsupported-pattern tracking.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MANIFESTS_DIR = path.join(__dirname, "manifests");
const OUTPUT_PATH = path.join(__dirname, "manifests.json");

const HERDR_REPO = "https://github.com/herdrdev/herdr";
const HERDR_COMMIT = "ee5bfb5041bb3e4a49d591c72308aae3c81ecdde";

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

function loadTomlManifests(dir) {
  const pyScript = `
import glob, json, os, sys, tomllib
manifests_dir = sys.argv[1]
files = sorted(glob.glob(os.path.join(manifests_dir, "*.toml")))
out = []
for fpath in files:
    with open(fpath, "rb") as f:
        data = tomllib.load(f)
    out.append(data)
print(json.dumps(out))
`;
  const stdout = execFileSync("python3", ["-c", pyScript, dir], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

function transformGate(manifestId, ruleId, gate, unsupportedList) {
  let hasUnsupported = false;
  const js = {};

  for (const kind of ["regex", "line_regex"]) {
    if (Array.isArray(gate[kind])) {
      js[kind] = [];
      for (const rawPattern of gate[kind]) {
        const res = convertRustRegex(rawPattern);
        if (res.unsupported) {
          hasUnsupported = true;
          unsupportedList.push({
            manifest: manifestId,
            rule: ruleId,
            pattern: rawPattern,
            reason: res.reason,
          });
          js[kind].push({ pattern: rawPattern, flags: "u", unsupported: true, reason: res.reason });
        } else {
          js[kind].push({ pattern: res.pattern, flags: res.flags });
        }
      }
    }
  }

  if (Object.keys(js).length > 0) {
    gate.js = js;
  }

  for (const groupKey of ["all", "any", "not"]) {
    if (Array.isArray(gate[groupKey])) {
      for (const childGate of gate[groupKey]) {
        if (transformGate(manifestId, ruleId, childGate, unsupportedList)) {
          hasUnsupported = true;
        }
      }
    }
  }

  return hasUnsupported;
}

export function buildManifestsPayload(generatedIso) {
  const rawList = loadTomlManifests(MANIFESTS_DIR);
  const manifests = {};
  const unsupported = [];

  for (const manifest of rawList) {
    const manifestId = manifest.id;
    if (Array.isArray(manifest.rules)) {
      for (const rule of manifest.rules) {
        const ruleUnsupported = transformGate(manifestId, rule.id, rule, unsupported);
        if (ruleUnsupported) {
          rule.unsupported = true;
        }
      }
    }
    manifests[manifestId] = manifest;
  }

  return {
    generated: generatedIso,
    source: {
      repo: HERDR_REPO,
      commit: HERDR_COMMIT,
    },
    unsupported,
    manifests,
  };
}

function main() {
  const isCheck = process.argv.includes("--check");
  let generatedIso = new Date().toISOString();

  if (isCheck && fs.existsSync(OUTPUT_PATH)) {
    try {
      const existing = JSON.parse(fs.readFileSync(OUTPUT_PATH, "utf8"));
      if (typeof existing.generated === "string") {
        generatedIso = existing.generated;
      }
    } catch {
      // ignore invalid existing JSON; comparison below will fail
    }
  }

  const payload = buildManifestsPayload(generatedIso);
  const serialized = JSON.stringify(payload, null, 2) + "\n";

  console.log(
    `[vendor] manifests=${Object.keys(payload.manifests).length} unsupported=${payload.unsupported.length}`
  );

  if (isCheck) {
    const tmpFile = path.join(os.tmpdir(), `herdr-manifests-check-${process.pid}.json`);
    fs.writeFileSync(tmpFile, serialized, "utf8");
    let committed = "";
    try {
      committed = fs.readFileSync(OUTPUT_PATH, "utf8");
    } catch {
      fs.unlinkSync(tmpFile);
      console.error(`[vendor] --check failed: ${OUTPUT_PATH} does not exist`);
      process.exit(1);
    }
    const matches = committed === serialized;
    fs.unlinkSync(tmpFile);
    if (!matches) {
      console.error(`[vendor] --check failed: ${OUTPUT_PATH} is out of date`);
      process.exit(1);
    }
    process.exit(0);
  }

  fs.writeFileSync(OUTPUT_PATH, serialized, "utf8");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
