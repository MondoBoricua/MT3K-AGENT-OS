import type { PaneEvent } from "./api";

// Each diff replaces the entire suffix, including when the capture shrinks.
export function applyPaneEvent(lines: readonly string[], event: PaneEvent): string[] {
  return typeof event === "string"
    ? event.split("\n")
    : [...lines.slice(0, event.from), ...event.lines];
}
