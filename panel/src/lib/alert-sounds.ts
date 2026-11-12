import type { PaneStatus } from "./pane-status.ts";

// Avisos sonoros: lógica pura (sin DOM, sin audio). El audio vive en alert-audio.ts.

export const ALERT_COOLDOWN_MS = 30_000;
export const SOUND_SETTINGS_KEY = "mt3k.sounds";

export type AlertKind = "blocked" | "done";
export type AlertEvent = { key: string; kind: AlertKind };
export type StatusMap = Readonly<Record<string, PaneStatus>>;

/** Estado que se arrastra entre polls: último estado por pane y última alerta por pane+tipo. */
export type AlertState = {
  readonly statuses: StatusMap;
  readonly lastAlert: Readonly<Record<string, number>>;
};

export type DiffOptions = {
  /** Pane que la persona está mirando ahora (terminal abierto Y pestaña visible). */
  focusedKey?: string | null;
};

/** Clave de un pane en el mapa: `${agentKey}|${paneId}`. */
export const paneAlertKey = (agentKey: string, paneId: string) => `${agentKey}|${paneId}`;

function eventKind(before: PaneStatus, after: PaneStatus): AlertKind | null {
  if (after === "blocked" && before !== "blocked") return "blocked";
  if (before === "working" && (after === "done" || after === "idle")) return "done";
  return null;
}

/**
 * Compara dos snapshots y devuelve las alertas nuevas más el estado para el próximo poll.
 * `prev === null` es el primer snapshot: nunca alerta. Un pane sin entrada previa tampoco.
 */
export function diffAlerts(
  prev: AlertState | null,
  next: StatusMap,
  now: number,
  opts: DiffOptions = {},
): { events: AlertEvent[]; state: AlertState } {
  const events: AlertEvent[] = [];
  const lastAlert: Record<string, number> = {};
  const focusedKey = opts.focusedKey ?? null;

  for (const [key, after] of Object.entries(next)) {
    const before = prev?.statuses[key];
    // conservar solo el cooldown de panes que siguen vivos (memoria acotada)
    for (const kind of ["blocked", "done"] as const) {
      const stamp = prev?.lastAlert[`${key}|${kind}`];
      if (stamp !== undefined) lastAlert[`${key}|${kind}`] = stamp;
    }
    if (before === undefined) continue;
    const kind = eventKind(before, after);
    if (!kind) continue;
    if (kind === "done" && key === focusedKey) continue;
    const stampKey = `${key}|${kind}`;
    const last = lastAlert[stampKey];
    if (last !== undefined && now - last < ALERT_COOLDOWN_MS) continue;
    lastAlert[stampKey] = now;
    events.push({ key, kind });
  }

  return { events, state: { statuses: { ...next }, lastAlert } };
}

// ---- ajustes (por dispositivo) ----

export type SoundSettings = { enabled: boolean; volume: number; blocked: boolean; done: boolean };
export type KeyValueStorage = Pick<Storage, "getItem" | "setItem">;

export const DEFAULT_SOUND_SETTINGS: SoundSettings = { enabled: false, volume: 0.6, blocked: true, done: true };

const clampVolume = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : DEFAULT_SOUND_SETTINGS.volume;
const asBool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);

function defaultStorage(): KeyValueStorage | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

export function loadSoundSettings(storage: KeyValueStorage | null = defaultStorage()): SoundSettings {
  try {
    const raw = storage?.getItem(SOUND_SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SOUND_SETTINGS };
    const o = JSON.parse(raw) as Record<string, unknown> | null;
    if (!o || typeof o !== "object") return { ...DEFAULT_SOUND_SETTINGS };
    return {
      enabled: asBool(o.enabled, DEFAULT_SOUND_SETTINGS.enabled),
      volume: clampVolume(o.volume),
      blocked: asBool(o.blocked, DEFAULT_SOUND_SETTINGS.blocked),
      done: asBool(o.done, DEFAULT_SOUND_SETTINGS.done),
    };
  } catch {
    return { ...DEFAULT_SOUND_SETTINGS };
  }
}

export function saveSoundSettings(s: SoundSettings, storage: KeyValueStorage | null = defaultStorage()): void {
  try {
    storage?.setItem(SOUND_SETTINGS_KEY, JSON.stringify({ ...s, volume: clampVolume(s.volume) }));
  } catch { /* modo privado: se queda en memoria */ }
}
