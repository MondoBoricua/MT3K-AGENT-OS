import type { PaneStatus } from "./pane-status.ts";

// Avisos sonoros: lógica pura (sin DOM, sin audio). El audio vive en alert-audio.ts.

export const ALERT_COOLDOWN_MS = 30_000;
export const SOUND_SETTINGS_KEY = "mt3k.sounds";

export type AlertKind = "blocked" | "done";
export type AlertEvent = { key: string; kind: AlertKind };
/** Foto de un pane: estado y, si el backend lo da (Herdr), el contador de turnos. Un estado suelto = sin turno. */
export type PaneSnapshot = PaneStatus | { readonly status: PaneStatus; readonly turn?: number };
export type StatusMap = Readonly<Record<string, PaneSnapshot>>;
type Snap = { readonly status: PaneStatus; readonly turn?: number };

/** Estado que se arrastra entre polls: última foto por pane, última alerta por pane+tipo y último turno ya avisado. */
export type AlertState = {
  readonly statuses: Readonly<Record<string, Snap>>;
  readonly lastAlert: Readonly<Record<string, number>>;
  readonly alertedTurn: Readonly<Record<string, number>>;
};

const validTurn = (t: unknown): t is number => typeof t === "number" && Number.isInteger(t) && t >= 0;
function toSnap(v: PaneSnapshot): Snap {
  if (typeof v === "string") return { status: v };
  return validTurn(v.turn) ? { status: v.status, turn: v.turn } : { status: v.status };
}

export type DiffOptions = {
  /** Pane que la persona está mirando ahora (terminal abierto Y pestaña visible). */
  focusedKey?: string | null;
};

/** Clave de un pane en el mapa: `${agentKey}|${paneId}`. */
export const paneAlertKey = (agentKey: string, paneId: string) => `${agentKey}|${paneId}`;

const finished = (s: PaneStatus) => s === "done" || s === "idle";

// Se desconoce si hc incrementa `turn` al empezar o al terminar un turno, así que la regla sirve para ambos:
// turno subido + ahora idle/done = terminó al menos un turno desde el poll anterior (aunque nunca se viera
// "working"). Subido + working: aún no se avisa; lo hará working→idle/done o un poll posterior.
function eventKind(before: Snap, after: Snap, alertedTurn: number | undefined): AlertKind | null {
  if (after.status === "blocked" && before.status !== "blocked") return "blocked";
  if (before.status === "working" && finished(after.status)) return "done";
  const grew = before.turn !== undefined && after.turn !== undefined && after.turn > before.turn;
  if (grew && finished(after.status) && (alertedTurn === undefined || after.turn! > alertedTurn)) return "done";
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
  const alertedTurn: Record<string, number> = {};
  const statuses: Record<string, Snap> = {};
  const focusedKey = opts.focusedKey ?? null;

  for (const [key, raw] of Object.entries(next)) {
    const after = toSnap(raw);
    statuses[key] = after;
    const before = prev?.statuses[key];
    // un turno que baja (terminal reemplazado) reinicia lo ya avisado
    const turnReset = before?.turn !== undefined && after.turn !== undefined && after.turn < before.turn;
    const alerted = turnReset ? undefined : prev?.alertedTurn[key];
    if (alerted !== undefined) alertedTurn[key] = alerted;
    // conservar solo el cooldown de panes que siguen vivos (memoria acotada)
    for (const kind of ["blocked", "done"] as const) {
      const stamp = prev?.lastAlert[`${key}|${kind}`];
      if (stamp !== undefined) lastAlert[`${key}|${kind}`] = stamp;
    }
    if (before === undefined) continue;
    const kind = eventKind(before, after, alerted);
    if (!kind) continue;
    if (kind === "done" && key === focusedKey) continue;
    const stampKey = `${key}|${kind}`;
    const last = lastAlert[stampKey];
    if (last !== undefined && now - last < ALERT_COOLDOWN_MS) continue;
    lastAlert[stampKey] = now;
    if (kind === "done" && after.turn !== undefined) alertedTurn[key] = after.turn;
    events.push({ key, kind });
  }

  return { events, state: { statuses, lastAlert, alertedTurn } };
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
