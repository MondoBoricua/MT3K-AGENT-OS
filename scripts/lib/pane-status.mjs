export function paneStatusFor(watch, now, { workingMs = 5000, smoothingMs = 2000 } = {}) {
  if (!watch) return "idle";
  // an explicit heuristic source wins even if a stale manifest `state` string is still on the entry
  if (watch.source !== "heuristic" && (watch.source === "manifest" || typeof watch.state === "string")) {
    if (watch.state === "blocked") return "blocked";
    if (watch.state === "working") return "working";
    const doneAt = typeof watch.doneAt === "number" ? watch.doneAt : 0;
    const seenAt = typeof watch.seenAt === "number" ? watch.seenAt : 0;
    if (doneAt > 0 && doneAt > seenAt) return "done";
    if (
      typeof watch.changedAt === "number" &&
      watch.changedAt > 0 &&
      now - watch.changedAt >= 0 &&
      now - watch.changedAt < smoothingMs
    ) {
      return "working";
    }
    return "idle";
  }
  if (watch.waiting) return "blocked";
  if (typeof watch.changedAt === "number" && now - watch.changedAt < workingMs) return "working";
  return "idle";
}

export function clampTick(raw, { min = 250, max = 3000, fallback = 500 } = {}) {
  if (raw === null || raw === undefined || typeof raw === "boolean") return fallback;
  if (typeof raw === "string" && raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
