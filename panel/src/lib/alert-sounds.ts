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

// Copia en memoria del último guardado que el storage rechazó (modo privado): UI y App coinciden
// mientras viva la página. Se limpia en cuanto un guardado sí persiste.
let unpersisted: SoundSettings | null = null;
export function resetSoundSettingsMemory(): void { unpersisted = null; }

export function loadSoundSettings(storage: KeyValueStorage | null = defaultStorage()): SoundSettings {
  if (unpersisted) return { ...unpersisted };
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
  const normalized: SoundSettings = { ...s, volume: clampVolume(s.volume) };
  try {
    if (!storage) throw new Error("sin storage");
    storage.setItem(SOUND_SETTINGS_KEY, JSON.stringify(normalized));
    unpersisted = null;
  } catch {
    unpersisted = normalized; // modo privado: se queda en memoria
  }
}

// ---- ráfagas: un solo aviso por tipo y poll ----

export type AlertLabel = { who: string; where: string };
export type AlertSummary = {
  /** Sonidos a reproducir, en orden y sin repetir tipo: "blocked" antes que "done". */
  cues: AlertKind[];
  toasts: { text: string; kind: AlertKind }[];
};

const KINDS: readonly AlertKind[] = ["blocked", "done"];

/** Agrupa los eventos de un poll: un cue por tipo y un toast por tipo (específico si es uno, conteo si son varios). */
export function summarizeAlerts(
  events: readonly AlertEvent[],
  enabledKinds: Readonly<Record<AlertKind, boolean>>,
  describe: (key: string) => AlertLabel,
): AlertSummary {
  const cues: AlertKind[] = [];
  const toasts: AlertSummary["toasts"] = [];
  for (const kind of KINDS) {
    if (!enabledKinds[kind]) continue;
    const of = events.filter((e) => e.kind === kind);
    if (of.length === 0) continue;
    cues.push(kind);
    if (of.length === 1) {
      const { who, where } = describe(of[0].key);
      toasts.push({ kind, text: `${who} ${kind === "blocked" ? "necesita input" : "terminó"} · ${where}` });
    } else {
      toasts.push({ kind, text: `${of.length} agentes ${kind === "blocked" ? "necesitan input" : "terminaron"}` });
    }
  }
  return { cues, toasts };
}
