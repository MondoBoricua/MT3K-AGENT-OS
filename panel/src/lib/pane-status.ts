import type { PaneRef } from "./api.ts";

export type PaneStatus = "working" | "blocked" | "idle" | "done" | "unknown";

export function paneStatus(p: Pick<PaneRef, "waiting" | "status">): PaneStatus {
  if (
    p.status === "working" ||
    p.status === "blocked" ||
    p.status === "idle" ||
    p.status === "done"
  ) {
    return p.status;
  }
  if (p.waiting) return "blocked";
  return "unknown";
}

export function statusLabel(s: PaneStatus): string {
  switch (s) {
    case "working":
      return "● trabajando";
    case "blocked":
      return "⏳ esperando input";
    case "done":
      return "✓ terminó";
    case "idle":
      return "○ idle";
    case "unknown":
      return "○ sin estado";
  }
}

export function statusTone(s: PaneStatus): "emerald" | "amber" | "sky" | "muted" {
  if (s === "working") return "emerald";
  if (s === "blocked") return "amber";
  if (s === "done") return "sky";
  return "muted";
}
