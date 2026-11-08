import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_KNOWN_AGENT_IDLE_FALLBACK,
  PANEL_AGENT_TO_MANIFEST,
  detectState,
  extractRegion,
  loadManifests,
} from "../lib/agent-detect.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MANIFESTS_JSON_PATH = path.join(__dirname, "../agent-detection/manifests.json");
const FIXTURES_DIR = path.join(__dirname, "fixtures/agent-detect");

const rawJson = JSON.parse(fs.readFileSync(MANIFESTS_JSON_PATH, "utf8"));
const compiled = loadManifests(rawJson);

function readFixture(name) {
  const screen = fs.readFileSync(path.join(FIXTURES_DIR, `${name}.txt`), "utf8");
  const titlePath = path.join(FIXTURES_DIR, `${name}.title`);
  const oscTitle = fs.existsSync(titlePath) ? fs.readFileSync(titlePath, "utf8").trim() : "";
  return { screen, oscTitle };
}

test("loadManifests loads all 22 herdr manifests with zero unsupported regexes for target agents", () => {
  const ids = Object.keys(compiled.manifests);
  assert.equal(ids.length, 22);
  assert.equal(compiled.unsupported.length, 0);
  assert.equal(compiled.droppedRules.length, 0);

  const requiredAgents = [
    "claude",
    "codex",
    "antigravity",
    "cursor",
    "opencode",
    "grok",
    "github-copilot",
    "gemini",
    "hermes",
  ];
  for (const agent of requiredAgents) {
    const m = compiled.resolve(agent);
    assert.ok(m, `Expected manifest for ${agent}`);
    assert.ok(m.rules.length > 0, `Expected rules for ${agent}`);
    assert.equal(m.droppedRuleIds.length, 0, `Expected 0 dropped rules for ${agent}`);
  }

  for (const [panelId, target] of Object.entries(PANEL_AGENT_TO_MANIFEST)) {
    const m = compiled.resolve(panelId);
    assert.ok(m, `Expected PANEL_AGENT_TO_MANIFEST[${panelId}] (${target}) to resolve`);
    assert.ok(compiled.manifests[target], `Expected manifests[${target}] lookup to work`);
  }

  assert.equal(compiled.resolve("zcode"), null);
  assert.equal(compiled.resolve("deepseek"), null);
  assert.equal(compiled.resolve("shell"), null);
});

test("extractRegion matches herdr manifest.rs region semantics", () => {
  const input = {
    oscTitle: "✳ Session Title",
    oscProgress: "4;3",
    screen: "first\n\nsecond\n\nthird\n\nfourth\n",
  };
  assert.equal(extractRegion(input, "osc_title"), "✳ Session Title");
  assert.equal(extractRegion(input, "osc_progress"), "4;3");
  assert.equal(extractRegion(input, "whole_recent"), input.screen);
  assert.equal(extractRegion(input, "bottom_lines(2)"), "\nfourth\n");
  assert.equal(extractRegion(input, "bottom_non_empty_lines(2)"), "third\n\nfourth\n");
  assert.equal(extractRegion(input, "top_non_empty_lines(2)"), "first\n\nsecond\n");

  const promptScreen = [
    "• Ran git status",
    "✻ Worked for 4s",
    "────────────────────",
    "❯ draft prompt",
    "  second line",
    "────────────────────",
    "  ⏵⏵ bypass permissions on",
  ].join("\n");
  assert.equal(
    extractRegion({ screen: promptScreen, oscTitle: "" }, "prompt_box_body"),
    "❯ draft prompt\n  second line\n" // Rust slices to the start of the bottom border: newline kept
  );
  assert.equal(
    extractRegion({ screen: promptScreen, oscTitle: "" }, "above_prompt_box"),
    "• Ran git status\n✻ Worked for 4s\n"
  );
  assert.equal(
    extractRegion({ screen: promptScreen, oscTitle: "" }, "last_non_empty_above_prompt_box"),
    "✻ Worked for 4s"
  );
  assert.equal(
    extractRegion({ screen: promptScreen, oscTitle: "" }, "after_last_horizontal_rule"),
    "  ⏵⏵ bypass permissions on"
  );

  const codexScreen = [
    "• Edited src/main.rs",
    "› summarize changes",
    "  ◦ (4s • esc to interrupt)",
  ].join("\n");
  assert.equal(
    extractRegion({ screen: codexScreen, oscTitle: "" }, "after_last_prompt_marker"),
    "  ◦ (4s • esc to interrupt)"
  );
  assert.equal(
    extractRegion({ screen: codexScreen, oscTitle: "" }, "before_current_prompt_marker"),
    "• Edited src/main.rs\n" // Rust sums line.len()+1 for every line before the marker
  );
  assert.equal(
    extractRegion({ screen: codexScreen, oscTitle: "" }, "whole_recent_without_current_prompt_marker"),
    ""
  );
  assert.equal(
    extractRegion({ screen: codexScreen, oscTitle: "" }, "current_prompt_block_marker"),
    "• Edited src/main.rs"
  );
});

test("detectState classifies real and synthetic fixture files accurately", () => {
  const claude = compiled.resolve("claude");
  const codex = compiled.resolve("codex");
  const agy = compiled.resolve("antigravity");

  const claudeIdle = detectState(claude, readFixture("claude-idle"));
  assert.equal(claudeIdle.state, "idle");

  const claudeIdleCoding = detectState(claude, readFixture("claude-idle-coding"));
  assert.equal(claudeIdleCoding.state, "idle");

  const claudeWorking = detectState(claude, readFixture("claude-working"));
  assert.equal(claudeWorking.state, "working");

  const claudeBlocked = detectState(claude, readFixture("claude-blocked"));
  assert.equal(claudeBlocked.state, "blocked");
  assert.equal(claudeBlocked.ruleId, "bash_permission_prompt");

  const codexIdle = detectState(codex, readFixture("codex-idle"));
  assert.equal(codexIdle.state, "idle");

  const codexIdle2 = detectState(codex, readFixture("codex-idle-squishypos"));
  assert.equal(codexIdle2.state, "idle");

  const codexBlocked = detectState(codex, readFixture("codex-blocked"));
  assert.equal(codexBlocked.state, "blocked");
  assert.equal(codexBlocked.ruleId, "live_strong_blocker");

  const agyWorking = detectState(agy, readFixture("antigravity-working"));
  assert.equal(agyWorking.state, "working");
  assert.equal(agyWorking.ruleId, "esc_cancel_footer_working");

  const agyIdle = detectState(agy, readFixture("antigravity-idle"));
  assert.equal(agyIdle.state, "idle");
  assert.equal(agyIdle.ruleId, DEFAULT_KNOWN_AGENT_IDLE_FALLBACK);
});

test("ported inline samples from herdr claude and codex tests", () => {
  const claude = compiled.resolve("claude");
  const codex = compiled.resolve("codex");

  // 1. Claude transcript viewer preserves previous state (skip_state_update: true)
  const transcriptInput = {
    oscTitle: "",
    screen: "Showing detailed transcript · ctrl+o to toggle · ctrl+e to show all at once\n",
  };
  const preservedWorking = detectState(claude, transcriptInput, {
    state: "working",
    ruleId: "live_turn_working",
  });
  assert.equal(preservedWorking.state, "working");
  assert.equal(preservedWorking.ruleId, "transcript_viewer");

  const preservedBlocked = detectState(claude, transcriptInput, {
    state: "blocked",
    ruleId: "bash_permission_prompt",
  });
  assert.equal(preservedBlocked.state, "blocked");
  assert.equal(preservedBlocked.ruleId, "transcript_viewer");

  // 2. Claude MCP elicitation prompt -> blocked
  const mcpPrompt = detectState(claude, {
    oscTitle: "",
    screen: [
      'MCP server "github" requests your input',
      "  Please confirm repository scope",
      "❯ Accept",
      "  Decline",
      "Enter to submit · Esc to cancel",
    ].join("\n"),
  });
  assert.equal(mcpPrompt.state, "blocked");
  assert.equal(mcpPrompt.ruleId, "mcp_elicitation_prompt");

  // 3. Codex trust directory prompt -> blocked
  const codexTrust = detectState(codex, {
    oscTitle: "",
    screen: [
      "> You are in /Users/mondo/MT3K-AGENT-OS",
      "",
      "Do you trust the contents of this directory?",
      "Press enter to continue",
    ].join("\n"),
  });
  assert.equal(codexTrust.state, "blocked");
  assert.equal(codexTrust.ruleId, "trust_directory");

  // 4. Codex live working turn with timer and interrupt hint -> working
  const codexWorking = detectState(codex, {
    oscTitle: "",
    screen: [
      "› run full test suite",
      "• Running tests (12s • esc to interrupt)",
      "› ",
    ].join("\n"),
  });
  assert.equal(codexWorking.state, "working");
  assert.equal(codexWorking.ruleId, "screen_working_fallback");
});

test("convertRustRegex: \\b, \\w and \\d follow Rust's Unicode semantics", async () => {
  const { convertRustRegex } = await import("../agent-detection/vendor.mjs");
  const re = (raw) => { const c = convertRustRegex(raw); assert.equal(c.unsupported, false, raw); return new RegExp(c.pattern, c.flags); };
  // Rust: é is a word character, so there is no boundary after "cancel" in "cancelé"
  assert.equal(re("(?m)^\\s*─{3,}\\s*esc to cancel\\b").test("─── esc to cancelé"), false);
  assert.equal(re("esc to cancel\\b").test("esc to cancel "), true);
  assert.equal(re("^\\w+$").test("señal"), true);
  assert.equal(re("^\\d+$").test("٣٤"), true); // Arabic-Indic digits are \p{Nd}
  assert.equal(re("^[\\w-]+$").test("peña-x"), true);
  assert.equal(re("^\\W$").test("é"), false);
  assert.equal(re("[\\b]").test("\b"), true); // inside a class \b is still a backspace
  assert.equal(convertRustRegex("[\\W]").unsupported, true);
});

test("convertRustRegex: \\s is Unicode White_Space (U+0085 included), like Rust", async () => {
  const { convertRustRegex } = await import("../agent-detection/vendor.mjs");
  const c = convertRustRegex("(?m)^\\s*─{3,}\\s*esc to cancel\\b");
  assert.equal(c.unsupported, false);
  const re = new RegExp(c.pattern, c.flags);
  assert.equal(re.test("\u0085─── esc to cancel"), true);
  assert.equal(re.test("─── esc to cancelé"), false);
  const s = convertRustRegex("^\\S+$");
  assert.equal(new RegExp(s.pattern, s.flags).test("a\u0085b"), false);
  assert.equal(convertRustRegex("[\\S]").unsupported, false); // \P{White_Space} is legal inside a class
});
