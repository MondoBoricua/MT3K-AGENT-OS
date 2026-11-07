import type { PaneRef } from "./api.ts";

export type PaneStatus = "working" | "blocked" | "idle" | "unknown";

export function paneStatus(p: Pick<PaneRef, "waiting" | "status">): PaneStatus {
  if (p.status === "working" || p.status === "blocked" || p.status === "idle") {
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
    case "idle":
      return "○ idle";
    case "unknown":
      return "○ sin estado";
  }
}

export function statusTone(s: PaneStatus): "emerald" | "amber" | "muted" {
  if (s === "working") return "emerald";
  if (s === "blocked") return "amber";
  return "muted";
}
