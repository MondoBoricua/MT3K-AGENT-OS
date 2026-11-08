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

export { RUST_WORD_CLASS, unicodeClassEscapes, convertRustRegex } from "../lib/rust-regex.mjs";
import { convertRustRegex } from "../lib/rust-regex.mjs";

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
