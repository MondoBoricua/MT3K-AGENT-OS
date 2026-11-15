// Subscription quota per agent account, read from the `agent-usage` CLI when the host has it.
// The CLI is optional (it ships with the agent-bridge skill): without it the panel hides the feature.
// Everything here is pure or injected, so it runs under node --test with no CLI installed.
import { spawn as nodeSpawn } from "node:child_process";

const MAX_LABEL = 60;
const MAX_NOTE = 160;
const MAX_ACCOUNTS = 24;
const MAX_WINDOWS = 12;
const STATE_RE = /^[a-z_]{1,24}$/;
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/i;

// agent-usage account → panel agent id (several accounts can belong to one agent)
const ACCOUNT_AGENT = {
  claude: "claude",
  "claude-work": "claude",
  codex: "codex",
  cursor: "cursor",
  agy: "antigravity",
  "agy-bro": "antigravity",
  copilot: "copilot",
  opencode: "opencode",
  zai: "zcode",
};

const label = (v, max = MAX_LABEL) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** ISO string of a parseable date, or null. */
function isoOrNull(v) {
  if (typeof v !== "string" || !v) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function normalizeWindow(w) {
  if (!w || typeof w !== "object") return null;
  if (w.informational === true || w.applicable === false) return null;
  const pct = w.used_pct;
  if (typeof pct !== "number" || !Number.isFinite(pct)) return null;
  return {
    bucket: label(w.bucket),
    window: label(w.window),
    usedPct: Math.min(100, Math.max(0, Math.round(pct * 10) / 10)),
    resetsAt: isoOrNull(w.resets_at),
    state: typeof w.state === "string" && STATE_RE.test(w.state) ? w.state : "unknown",
  };
}

/** First human reason the CLI gave for having nothing measured (shown instead of an empty card). */
function unmeasuredNote(windows) {
  for (const w of windows) {
    if (w && typeof w === "object" && w.informational !== true) {
      const reason = label(w.reason, MAX_NOTE);
      if (reason) return reason;
    }
  }
  return "";
}

/**
 * agent-usage JSON → accounts the panel can render. Unknown shapes are dropped, never thrown:
 * the input comes from another program.
 */
export function normalizeUsage(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const accounts = [];
  for (const [id, entry] of Object.entries(raw)) {
    if (accounts.length >= MAX_ACCOUNTS) break;
    if (!ID_RE.test(id) || !entry || typeof entry !== "object") continue;
    const rawWindows = Array.isArray(entry.windows) ? entry.windows.slice(0, MAX_WINDOWS * 4) : [];
    const windows = rawWindows.map(normalizeWindow).filter(Boolean).slice(0, MAX_WINDOWS);
    const account = { id, agentId: ACCOUNT_AGENT[id] ?? id, windows };
    const plan = label(entry.plan);
    if (plan) account.plan = plan;
    if (!windows.length) {
      const note = unmeasuredNote(rawWindows);
      if (note) account.note = note;
    }
    accounts.push(account);
  }
  return accounts;
}

/**
 * Cached reader with one run at a time. It answers at once with what it has (nothing yet, or a
 * stale cache) and measures in the background: `refreshing` tells the caller to come back. Only
 * `fresh` waits for the run. A failed run keeps the last good data.
 *
 * @param {object} deps
 * @param {() => string | null} deps.findBin   absolute path of agent-usage, or null when absent
 * @param {(bin: string) => Promise<{ ok: boolean, out: string, err?: string }>} deps.exec
 * @param {() => number} [deps.now]
 * @param {number} [deps.ttlMs]         age after which a read triggers a background refresh
 * @param {number} [deps.minRefreshMs]  floor between two runs, also for `fresh` requests
 */
export function createUsageReader({ findBin, exec, now = Date.now, ttlMs = 5 * 60_000, minRefreshMs = 60_000 }) {
  let cache = null; // { at, accounts }
  let lastRunAt = 0;
  let lastErr = "";
  let inflight = null;

  const refresh = () => {
    if (inflight) return inflight;
    const bin = findBin();
    if (!bin) return Promise.resolve(false);
    lastRunAt = now();
    inflight = (async () => {
      try {
        await null; // an exec that throws synchronously must not clear `inflight` before it is assigned
        const r = await exec(bin);
        // the CLI exits non-zero when one account fails but still prints the rest: parse first
        let parsed = null;
        try { parsed = JSON.parse(r.out); } catch { /* not JSON */ }
        if (!parsed || typeof parsed !== "object") {
          lastErr = "agent-usage no devolvió JSON";
          return false;
        }
        cache = { at: now(), accounts: normalizeUsage(parsed) };
        lastErr = "";
        return true;
      } catch (e) {
        lastErr = "agent-usage falló";
        return false;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };

  const snapshot = () => ({
    ok: true,
    available: true,
    observedAt: cache ? new Date(cache.at).toISOString() : null,
    accounts: cache ? cache.accounts : [],
    refreshing: inflight !== null,
    ...(lastErr ? { err: lastErr } : {}),
  });

  return {
    async read({ fresh = false } = {}) {
      if (!findBin()) return { ok: true, available: false, observedAt: null, accounts: [], refreshing: false };
      const sinceRun = now() - lastRunAt;
      const canRun = lastRunAt === 0 || sinceRun >= minRefreshMs;
      const expired = !cache || now() - cache.at >= ttlMs;
      if (fresh && (inflight || canRun)) await refresh(); // joins the run in flight instead of starting another
      else if (expired && canRun) void refresh();
      return snapshot();
    },
  };
}

const KILL_GRACE_MS = 5_000;

/**
 * Runs the CLI in its own process group and resolves only when it has closed. On timeout, or when
 * it prints more than `maxBytes`, the whole group is killed: the CLI starts other CLIs, and killing
 * only the parent would leave them running while the reader starts another measurement. POSIX only.
 *
 * @returns {Promise<{ ok: boolean, out: string, err: string }>}
 */
export function runUsageCli(bin, args, { cwd, env, timeoutMs = 90_000, maxBytes = 2 * 1024 * 1024, spawn = nodeSpawn, killGroup = (pid) => process.kill(-pid, "SIGKILL") } = {}) {
  return new Promise((resolve) => {
    let ch;
    try { ch = spawn(bin, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { resolve({ ok: false, out: "", err: String(e) }); return; }
    let out = "", size = 0, stopped = "", settled = false, graceTimer;
    const finish = (r) => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(graceTimer); resolve(r); };
    const stop = (why) => {
      if (stopped) return;
      stopped = why;
      try { if (ch.pid) killGroup(ch.pid); } catch { try { ch.kill("SIGKILL"); } catch { /* already gone */ } }
      // a descendant that left the group can keep the pipes open: do not wait for it forever
      graceTimer = setTimeout(() => finish({ ok: false, out: "", err: stopped }), KILL_GRACE_MS);
    };
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    const take = (keep) => (d) => {
      size += d.length;
      if (size > maxBytes) { stop("salida demasiado grande"); return; }
      if (keep && !stopped) out += d;
    };
    ch.stdout.on("data", take(true));
    ch.stderr.on("data", take(false));
    ch.on("error", (e) => finish({ ok: false, out: "", err: String(e) }));
    ch.on("close", (code) => finish(stopped ? { ok: false, out: "", err: stopped } : { ok: code === 0, out: out.trim(), err: "" }));
  });
}
