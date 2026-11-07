export function paneStatusFor(watch, now, { workingMs = 5000 } = {}) {
  if (!watch) return "idle";
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
