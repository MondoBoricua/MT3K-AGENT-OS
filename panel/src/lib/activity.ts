// Activity page: parse the daily logs into events, count kinds and filter. Pure: no fetch, no DOM.

export interface ActivityLog { date: string; content: string }
export interface ActivityEvent { date: string; time: string; kind: string; text: string }

const LINE = /^-\s+(\d{2}:\d{2}:\d{2})\s+—\s+(.+)$/;
const KIND = /^([a-z][a-z0-9-]{0,31})(?:\s+·|\s*$)/i;
export const OTHER_KIND = "otros";

/** "send · hc:t20 · …" → "send". Lines that do not start with a kind go to "otros". */
export function kindOf(text: string): string {
  const m = KIND.exec(text);
  return m ? m[1].toLowerCase() : OTHER_KIND;
}

/** Newest first: days descending (the server already sends them so), lines of each day bottom-up. */
export function parseLogs(logs: ActivityLog[]): ActivityEvent[] {
  const out: ActivityEvent[] = [];
  const days = [...logs].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  for (const log of days) {
    const lines = log.content.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = LINE.exec(lines[i]);
      if (m) out.push({ date: log.date, time: m[1], kind: kindOf(m[2]), text: m[2] });
    }
  }
  return out;
}

/** Kinds with their counts, most frequent first (ties by name so the chips do not jump around). */
export function kindCounts(events: ActivityEvent[]): { kind: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const e of events) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
  return [...counts.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count || (a.kind < b.kind ? -1 : 1));
}

/** High-volume housekeeping kinds, hidden until the person turns them on. */
export const NOISY_KINDS: readonly string[] = ["waiting", "key", "pane-resize", "done", "uploads-sweep"];

export function filterEvents(events: ActivityEvent[], hidden: ReadonlySet<string>, query: string): ActivityEvent[] {
  const q = query.trim().toLowerCase();
  if (!hidden.size && !q) return events;
  return events.filter((e) => !hidden.has(e.kind) && (!q || e.text.toLowerCase().includes(q) || e.date.includes(q)));
}

/** Consecutive events of one day, in the order given. */
export function groupByDay(events: ActivityEvent[]): { date: string; events: ActivityEvent[] }[] {
  const groups: { date: string; events: ActivityEvent[] }[] = [];
  for (const e of events) {
    const last = groups[groups.length - 1];
    if (last && last.date === e.date) last.events.push(e);
    else groups.push({ date: e.date, events: [e] });
  }
  return groups;
}
