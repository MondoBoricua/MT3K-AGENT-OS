import { spawn as spawnChild } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

// Explicit blocked rule IDs from agent-detection/manifests/*.toml. OSC rules
// qualify only for the agents whose rule explicitly contains "Action Required".
// Rules that also match plain questions or menus are NOT approvals (they would cause false
// "needs your authorization" voice alerts) and stay needs_input: see demotedRules.
export const approvalRules = Object.freeze({
  amp: ["approval_footer"],
  agy: ["permission_prompt", "trust_prompt", "legacy_permission_prompt"],
  claude: ["mcp_elicitation_prompt", "bash_permission_prompt", "generic_permission_prompt"],
  cline: ["tool_permission", "inline_tool_permission"],
  codex: ["osc_title_blocked", "trust_directory"],
  cursor: ["write_file_approval", "approval_prompt"],
  devin: ["workspace_trust_prompt", "permission_prompt"],
  droid: ["execute_selection_blocker"],
  grok: ["osc_title_blocked", "permission_hints_blocked", "permission_scope_selector"],
  hermes: ["dangerous_command_approval"],
  kilo: ["opencode_permission"],
  kimi: ["current_approval_panel", "legacy_approval_panel"],
  kiro: ["tool_approval", "tool_approval_edit", "crew_approval"],
  letta: ["command_approval"],
  maki: ["permission_prompt"],
  muse: ["workspace_trust_blocked", "blocked_approval"],
  opencode: ["permission_required"],
  qwen: ["folder_trust_dialog"],
});
export const demotedRules = Object.freeze({
  claude: ["legacy_no_prompt_blocker"],
  codex: ["weak_blocker", "live_strong_blocker"],
  droid: ["selection_menu_blocker"],
  copilot: ["selection_blocker"],
  qodercli: ["confirmation_or_input_blocker"],
});
const bridgeAgent = (id) => ({ antigravity: "agy", "github-copilot": "copilot", deepseek: "dsh" })[id] || id;

/** Pure policy: accepts metadata only. The caller owns transitions and rate limits. */
export function decidePaneNotification({ state, agentId, statusSource, ruleId, session, paneId }, env = {}) {
  if (env.MT3K_BRIDGE_NOTIFY === "0") return null;
  const agent = bridgeAgent(agentId);
  const skip = (env.MT3K_NOTIFY_SKIP_AGENTS ?? "claude,grok").split(",").map((id) => bridgeAgent(id.trim()));
  if (!agent || skip.includes(agent)) return null;
  if (state !== "blocked" && !(state === "done" && env.MT3K_NOTIFY_DONE === "1")) return null;
  // A reason must be a rule identifier, never a matched snippet or screen text.
  if (typeof ruleId !== "string" || !/^[a-zA-Z0-9_.:-]+$/.test(ruleId)) return null;
  const kind = state === "done" ? "done"
    : statusSource === "manifest" && approvalRules[agent]?.includes(ruleId) ? "needs_approval" : "needs_input";
  return { kind, agent, session, paneId, reason: ruleId };
}

/** Best effort, detached sender. Async filesystem discovery is shared and cached
 * for five minutes, including misses; PATH/bin directories are supplied at startup. */
export function createPaneNotifier({ binDirs, env = process.env, spawn = spawnChild, now = Date.now, binaryName = "bridge-notify" }) {
  let checkedAt = -Infinity;
  let pending;
  const resolveBinary = () => {
    if (now() - checkedAt >= 300000) {
      checkedAt = now();
      pending = (async () => {
        for (const dir of binDirs) {
          if (!dir) continue;
          const candidate = join(dir, binaryName);
          try {
            await access(candidate, constants.X_OK);
            if ((await stat(candidate)).isFile()) return candidate;
          } catch { /* missing/non-executable is optional */ }
        }
        return null;
      })().catch(() => null);
    }
    return pending;
  };
  if (env.MT3K_BRIDGE_NOTIFY !== "0") resolveBinary();
  return (event) => {
    try {
      const decision = decidePaneNotification(event, env);
      if (!decision) return;
      resolveBinary().then((binary) => {
        if (!binary) return;
        const { kind, agent, session, paneId, reason } = decision;
        const child = spawn(binary, [kind, "--agent", agent, "--session", session, "--pane", paneId, "--reason", reason, "--source", "panel"], { detached: true, stdio: "ignore", windowsHide: true });
        child.on("error", () => {});
        child.unref();
      }).catch(() => {});
    } catch { /* notification must never interrupt the detector */ }
  };
}
