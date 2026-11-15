// Subscription quota per agent account (server: GET /api/usage). Pure helpers: no fetch, no DOM.

export interface UsageWindow { bucket: string; window: string; usedPct: number; resetsAt: string | null; state: string }
export interface UsageAccount { id: string; agentId: string; plan?: string; note?: string; windows: UsageWindow[] }
export interface UsageReport { ok: boolean; available: boolean; observedAt: string | null; accounts: UsageAccount[]; refreshing: boolean; err?: string }

export type UsageTone = "emerald" | "amber" | "red";
/** From this point a channel stops receiving work until it resets. */
export const HIGH_PCT = 85;
export const MID_PCT = 50;

export const usageTone = (pct: number): UsageTone => (pct >= HIGH_PCT ? "red" : pct >= MID_PCT ? "amber" : "emerald");

/** A window whose reset time has passed describes the previous period, not this one. */
export function isExpired(w: Pick<UsageWindow, "resetsAt">, now: number): boolean {
  if (!w.resetsAt) return false;
  const at = Date.parse(w.resetsAt);
  return Number.isFinite(at) && at <= now;
}

/** The current window with the highest use, or null when nothing current is measured. */
export function worstWindow(account: Pick<UsageAccount, "windows">, now: number): UsageWindow | null {
  let worst: UsageWindow | null = null;
  for (const w of account.windows) {
    if (isExpired(w, now)) continue;
    if (!worst || w.usedPct > worst.usedPct) worst = w;
  }
  return worst;
}

const MACHINE_BUCKET = /^[a-z0-9_]+$/;
/** The bucket when it is a real name ("Gemini Models"); "" when it is an identifier ("seven_day") next to a window. */
export function bucketName(w: Pick<UsageWindow, "bucket" | "window">): string {
  if (!w.bucket) return "";
  return MACHINE_BUCKET.test(w.bucket) && w.window ? "" : w.bucket;
}
/** "7 días" for buckets named like identifiers, "Gemini Models · 7 días" when the bucket is a real name. */
export function windowLabel(w: Pick<UsageWindow, "bucket" | "window">): string {
  const name = bucketName(w);
  if (!name) return w.window;
  return w.window ? `${name} · ${w.window}` : name;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** "en 25 min", "en 3 h", "mié 12:12"; "" without a reset time, "reinicio vencido" once it has passed. */
export function fmtReset(resetsAt: string | null, now: number, timeZone?: string): string {
  if (!resetsAt) return "";
  const at = Date.parse(resetsAt);
  if (!Number.isFinite(at)) return "";
  const left = at - now;
  if (left <= 0) return "reinicio vencido";
  if (left < HOUR) return `en ${Math.max(1, Math.round(left / MIN))} min`;
  if (left < DAY) return `en ${Math.round(left / HOUR)} h`;
  const d = new Date(at);
  const opts = timeZone ? { timeZone } : {};
  const day = d.toLocaleDateString("es", { weekday: "short", ...opts }).replace(".", "");
  const time = d.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit", hour12: false, ...opts });
  return `${day} ${time}`;
}

/** Short tag that tells two accounts of one agent apart: "claude-work" → "work"; the main one has none. */
export function accountTag(id: string): string {
  const cut = id.lastIndexOf("-");
  return cut > 0 ? id.slice(cut + 1) : "";
}

export function usageByAgent(accounts: UsageAccount[]): Record<string, UsageAccount[]> {
  const out: Record<string, UsageAccount[]> = {};
  for (const a of accounts) (out[a.agentId] ??= []).push(a);
  return out;
}

export interface UsageCrossing { accountId: string; window: UsageWindow }
const windowKey = (accountId: string, w: UsageWindow) => `${accountId}|${w.bucket}|${w.window}`;
/**
 * Windows that went from below HIGH_PCT to HIGH_PCT or more since the previous report.
 * `prev` null = first report: nothing is announced, only remembered.
 */
export function highCrossings(
  prev: Record<string, number> | null,
  accounts: UsageAccount[],
  now: number,
): { crossings: UsageCrossing[]; next: Record<string, number> } {
  const next: Record<string, number> = {};
  const crossings: UsageCrossing[] = [];
  for (const a of accounts) for (const w of a.windows) {
    if (isExpired(w, now)) continue;
    const key = windowKey(a.id, w);
    next[key] = w.usedPct;
    if (prev && w.usedPct >= HIGH_PCT && (prev[key] ?? 0) < HIGH_PCT) crossings.push({ accountId: a.id, window: w });
  }
  return { crossings, next };
}
