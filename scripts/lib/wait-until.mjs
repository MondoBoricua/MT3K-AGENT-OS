export const WAIT_CONDITIONS = Object.freeze([
  "blocked",
  "idle",
  "done",
  "not-working",
  "changed",
]);

export const VALID_PANE_STATUSES = Object.freeze([
  "working",
  "blocked",
  "idle",
  "done",
]);

export function parseWaitCondition(raw) {
  if (raw === null || raw === undefined) return { ok: true, until: "not-working" };
  if (typeof raw !== "string") return { ok: false, err: "condición inválida (blocked|idle|done|not-working|changed)" };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, until: "not-working" };
  if (!WAIT_CONDITIONS.includes(trimmed)) {
    return { ok: false, err: "condición inválida (blocked|idle|done|not-working|changed)" };
  }
  return { ok: true, until: trimmed };
}

export function parseWaitBaseline(raw) {
  if (raw === null || raw === undefined) return { ok: true, baseline: null };
  if (typeof raw !== "string") return { ok: false, err: "baseline inválido" };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, baseline: null };
  if (!VALID_PANE_STATUSES.includes(trimmed)) {
    return { ok: false, err: "baseline inválido" };
  }
  return { ok: true, baseline: trimmed };
}

export function conditionMet(cond, status, initialStatus, { sawWorking = false } = {}) {
  if (typeof status !== "string" || !status || status === "unknown") return false;
  const c = cond === undefined || cond === null || cond === "" ? "not-working" : cond;
  if (c === "not-working") return status !== "working";
  if (c === "changed") {
    return (
      typeof initialStatus === "string" &&
      initialStatus.length > 0 &&
      initialStatus !== "unknown" &&
      status !== initialStatus
    );
  }
  if (c === "done") {
    return status === "done" || (Boolean(sawWorking) && status === "idle");
  }
  if (c === "blocked" || c === "idle") return status === c;
  return false;
}

export function clampTimeout(raw, { min = 1, max = 600, fallback = 180 } = {}) {
  if (raw === null || raw === undefined || typeof raw === "boolean") return fallback;
  if (typeof raw === "string" && raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function parseWaitTimeout(raw, opts) {
  if (raw === null || raw === undefined) return { ok: true, timeout: clampTimeout(raw, opts) };
  if (typeof raw === "boolean") return { ok: false, err: "timeout inválido" };
  if (typeof raw === "string" && raw.trim() === "") return { ok: true, timeout: clampTimeout(raw, opts) };
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, err: "timeout inválido" };
  return { ok: true, timeout: clampTimeout(n, opts) };
}

export function promptWaitGateOpen({ sawWorking, statusSource, elapsedMs, graceMs = 10000 }) {
  const workingQualifies =
    Boolean(sawWorking) && (statusSource === undefined || statusSource === "manifest");
  return workingQualifies || (typeof elapsedMs === "number" && elapsedMs >= graceMs);
}
