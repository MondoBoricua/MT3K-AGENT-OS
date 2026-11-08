import { parseWaitCondition, parseWaitTimeout } from "./wait-until.mjs";

export const DEFAULT_CHUNK_SECONDS = 240;

export const WAIT_USAGE = `Usage: mt3k-wait <paneId> [--until blocked|idle|done|not-working|changed] [--timeout <seconds>] [--host <id>] [--url <url>] [--token <token>]

Blocks until the tmux pane reaches the requested state.
Exit codes: 0 = reached, 2 = timeout, 3 = gone, 1 = error.`;

export const PROMPT_USAGE = `Usage: mt3k-prompt <paneId> <text...> [--until blocked|idle|done|not-working|changed] [--timeout <seconds>] [--host <id>] [--url <url>] [--token <token>] [--no-enter]

Sends a prompt to the tmux pane and waits until the turn finishes.
Exit codes: 0 = reached, 2 = timeout, 3 = gone, 1 = error.`;

export function chunkPlan(totalSeconds, chunkSeconds = DEFAULT_CHUNK_SECONDS) {
  const total = Math.max(0, Math.trunc(Number(totalSeconds) || 0));
  const maxChunk = Math.max(1, Math.trunc(Number(chunkSeconds) || DEFAULT_CHUNK_SECONDS));
  const chunks = [];
  let rem = total;
  while (rem > 0) {
    const step = Math.min(rem, maxChunk);
    chunks.push(step);
    rem -= step;
  }
  return chunks;
}

// Chunks a long wait into requests of at most `chunkSeconds` against ONE wall-clock deadline
// (start + totalSeconds): each chunk asks only for what is left, so request/refresh/network
// overhead counts against the total, and `waitedMs` is the real elapsed time. Used by both CLIs
// and by the federated /api/wait and /api/prompt-wait proxy.
export async function runChunkedWait({
  totalSeconds,
  chunkSeconds = DEFAULT_CHUNK_SECONDS,
  initialBaseline = null,
  isAborted,
  requestChunk,
  now,
}) {
  const nowFn = typeof now === "function" ? now : () => Date.now();
  const totalSec = Math.max(0, Math.trunc(Number(totalSeconds) || 0));
  const maxChunk = Math.max(1, Math.trunc(Number(chunkSeconds) || DEFAULT_CHUNK_SECONDS));
  if (totalSec <= 0) {
    return { ok: false, status: 400, data: { ok: false, err: "timeout inválido" } };
  }
  const startMs = nowFn();
  const deadlineMs = startMs + totalSec * 1000;
  let baseline =
    typeof initialBaseline === "string" && initialBaseline.trim() && initialBaseline.trim() !== "unknown"
      ? initialBaseline.trim()
      : null;
  let sawWorking = false;
  let lastRes = null;
  let reportedMs = 0; // backstop: a server that answers `timeout` early can never make this loop spin
  const elapsed = () => Math.max(0, nowFn() - startMs);

  for (let i = 0; ; i++) {
    if (typeof isAborted === "function" && isAborted()) {
      return { aborted: true };
    }
    const remainingMs = deadlineMs - nowFn();
    // the first chunk always runs; later ones while any budget is left. The last chunk asks for the
    // full remainder rounded UP (minimum 1 s) so a fractional tail is still observed.
    if (i > 0 && (remainingMs <= 0 || reportedMs >= totalSec * 1000)) break;
    const chunkSec = Math.max(1, Math.min(maxChunk, Math.ceil(remainingMs / 1000)));
    const res = await requestChunk({
      chunkSec,
      chunkIndex: i,
      isFirst: i === 0,
      baseline,
      sawWorking,
    });
    if (typeof isAborted === "function" && isAborted()) {
      return { aborted: true };
    }
    lastRes = res;
    if (!res || !res.ok || !res.data || res.data.ok !== true) {
      return res;
    }
    // a `timeout` answer stands for at least the chunk it was asked for (never more chunks than the
    // old fixed plan, even if the server answers early or the clock is not advancing)
    reportedMs += Math.max(chunkSec * 1000, typeof res.data.waitedMs === "number" ? res.data.waitedMs : 0);
    if (res.data.sawWorking === true) sawWorking = true;
    if (!baseline) {
      if (typeof res.data.baseline === "string" && res.data.baseline && res.data.baseline !== "unknown") {
        baseline = res.data.baseline;
      } else if (typeof res.data.status === "string" && res.data.status && res.data.status !== "unknown") {
        baseline = res.data.status;
      }
    }
    if (res.data.reason !== "timeout") {
      // the deadline is wall-clock: a success that arrives after it reports `timeout` (with the
      // status it saw), never `reached`
      if (res.data.reason === "reached" && nowFn() > deadlineMs) {
        return { ...res, data: { ...res.data, reason: "timeout", waitedMs: elapsed() } };
      }
      return { ...res, data: { ...res.data, waitedMs: elapsed() } };
    }
  }

  return { ...lastRes, data: { ...lastRes.data, waitedMs: elapsed() } };
}

function splitFlagValue(arg, nextArg) {
  const eq = arg.indexOf("=");
  if (eq >= 0) {
    return { flag: arg.slice(0, eq), value: arg.slice(eq + 1), consumedNext: false };
  }
  return { flag: arg, value: nextArg, consumedNext: true };
}

export function parseWaitArgs(argv = [], env = process.env) {
  const positionals = [];
  let rawUntil;
  let rawTimeout;
  let host = "";
  let url = (env?.MT3K_URL || "http://localhost:4288").trim().replace(/\/$/, "");
  let token = (env?.MT3K_TOKEN || "").trim();

  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (a === "-h" || a === "--help") return { ok: true, help: true, usage: WAIT_USAGE };
    if (a.startsWith("--")) {
      const { flag, value, consumedNext } = splitFlagValue(a, argv[i + 1]);
      if (value === undefined) return { ok: false, err: `falta valor para ${flag}` };
      if (consumedNext) i++;
      if (flag === "--until") rawUntil = String(value);
      else if (flag === "--timeout") rawTimeout = String(value);
      else if (flag === "--host") host = String(value).trim();
      else if (flag === "--url") url = String(value).trim().replace(/\/$/, "");
      else if (flag === "--token") token = String(value).trim();
      else return { ok: false, err: `flag desconocido: ${flag}` };
      continue;
    }
    if (a.startsWith("-")) return { ok: false, err: `flag desconocido: ${a}` };
    positionals.push(a);
  }

  if (positionals.length === 0) return { ok: false, err: "falta <paneId>" };
  if (positionals.length > 1) return { ok: false, err: `argumento inesperado: ${positionals[1]}` };

  const condCheck = parseWaitCondition(rawUntil);
  if (!condCheck.ok) return { ok: false, err: condCheck.err };
  const timeoutCheck = parseWaitTimeout(rawTimeout);
  if (!timeoutCheck.ok) return { ok: false, err: timeoutCheck.err };

  return {
    ok: true,
    help: false,
    paneId: positionals[0],
    until: condCheck.until,
    timeout: timeoutCheck.timeout,
    host,
    url,
    token,
  };
}

export function parsePromptArgs(argv = [], env = process.env) {
  const positionals = [];
  let rawUntil;
  let rawTimeout;
  let host = "";
  let url = (env?.MT3K_URL || "http://localhost:4288").trim().replace(/\/$/, "");
  let token = (env?.MT3K_TOKEN || "").trim();
  let enter = true;
  let literalRest = false;

  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (literalRest) {
      positionals.push(a);
      continue;
    }
    if (a === "--") {
      literalRest = true;
      continue;
    }
    if (a === "-h" || a === "--help") return { ok: true, help: true, usage: PROMPT_USAGE };
    if (a === "--no-enter") {
      enter = false;
      continue;
    }
    if (a.startsWith("--")) {
      const { flag, value, consumedNext } = splitFlagValue(a, argv[i + 1]);
      if (value === undefined) return { ok: false, err: `falta valor para ${flag}` };
      if (consumedNext) i++;
      if (flag === "--until") rawUntil = String(value);
      else if (flag === "--timeout") rawTimeout = String(value);
      else if (flag === "--host") host = String(value).trim();
      else if (flag === "--url") url = String(value).trim().replace(/\/$/, "");
      else if (flag === "--token") token = String(value).trim();
      else return { ok: false, err: `flag desconocido: ${flag}` };
      continue;
    }
    positionals.push(a);
  }

  if (positionals.length === 0) return { ok: false, err: "falta <paneId>" };
  const paneId = positionals[0];
  const text = positionals.slice(1).join(" ").trim();
  if (!text) return { ok: false, err: "falta <text...>" };

  const condCheck = parseWaitCondition(rawUntil);
  if (!condCheck.ok) return { ok: false, err: condCheck.err };
  const timeoutCheck = parseWaitTimeout(rawTimeout);
  if (!timeoutCheck.ok) return { ok: false, err: timeoutCheck.err };

  return {
    ok: true,
    help: false,
    paneId,
    text,
    enter,
    until: condCheck.until,
    timeout: timeoutCheck.timeout,
    host,
    url,
    token,
  };
}

export function exitCodeForResult(httpOk, payload) {
  if (!httpOk || !payload || payload.ok !== true) return 1;
  if (payload.reason === "reached") return 0;
  if (payload.reason === "timeout") return 2;
  if (payload.reason === "gone") return 3;
  return 1;
}
