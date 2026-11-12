import type { AlertKind } from "./alert-sounds.ts";

// Dos avisos sintetizados con Web Audio (sin archivos). Falla en silencio si no hay audio
// o si el navegador no deja sonar. Antes del primer gesto del usuario no se toca el contexto.

type Note = { freq: number; start: number; dur: number };
const PEAK_GAIN = 0.25; // techo antes de aplicar el volumen del usuario
const ATTACK_S = 0.012;
const CUE_GAP_S = 0.1; // pausa entre dos cues de una misma ráfaga
const CUES: Record<AlertKind, readonly Note[]> = {
  blocked: [{ freq: 660, start: 0, dur: 0.16 }, { freq: 880, start: 0.17, dur: 0.22 }], // dos notas ascendentes, ~0.4 s
  done: [{ freq: 440, start: 0, dur: 0.3 }], // una nota suave y grave
};
const cueLength = (kind: AlertKind) => Math.max(...CUES[kind].map((n) => n.start + n.dur));

let ctx: AudioContext | null = null;
let gestured = false; // hubo un gesto del usuario: ya se puede pedir resume()
let resuming: Promise<boolean> | null = null;

function getContext(): AudioContext | null {
  if (ctx) return ctx;
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
    return ctx;
  } catch {
    return null;
  }
}

// Safari puede dejar el contexto en "interrupted": se trata igual que "suspended".
const isRunning = (c: AudioContext) => c.state === "running";

/** Reanuda el contexto; resuelve true solo si queda "running". Nunca rechaza. */
function resumeContext(c: AudioContext): Promise<boolean> {
  if (isRunning(c)) return Promise.resolve(true);
  resuming ??= c.resume().then(() => isRunning(c), () => false).finally(() => { resuming = null; });
  return resuming;
}

/** Marca el gesto del usuario y reanuda el contexto. Llamar solo desde un gesto. */
export function unlockAudio(): Promise<boolean> {
  gestured = true;
  try {
    const c = getContext();
    return c ? resumeContext(c) : Promise.resolve(false);
  } catch {
    return Promise.resolve(false);
  }
}

/** Desbloquea con pointerdown/keydown; los listeners siguen hasta que un resume() sí funciona. */
export function installAudioUnlock(): () => void {
  const off = () => {
    window.removeEventListener("pointerdown", on);
    window.removeEventListener("keydown", on);
  };
  const on = () => { void unlockAudio().then((ok) => { if (ok) off(); }); };
  window.addEventListener("pointerdown", on);
  window.addEventListener("keydown", on);
  return off;
}

function scheduleCue(c: AudioContext, kind: AlertKind, at: number, peak: number): void {
  for (const n of CUES[kind]) {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = "sine";
    osc.frequency.value = n.freq;
    const s = at + n.start;
    gain.gain.setValueAtTime(0, s);
    gain.gain.linearRampToValueAtTime(peak, s + ATTACK_S);
    gain.gain.exponentialRampToValueAtTime(0.0001, s + n.dur);
    osc.connect(gain).connect(c.destination);
    osc.start(s);
    osc.stop(s + n.dur + 0.02);
  }
}

/**
 * Reproduce los cues en orden, sin solaparse. Con `fromGesture` (botón "Probar") cuenta como gesto;
 * sin él y sin gesto previo no hace nada. Las notas se programan DESPUÉS de que resume() termine.
 */
export async function playAlertSequence(kinds: readonly AlertKind[], volume: number, fromGesture = false): Promise<void> {
  try {
    if (fromGesture) gestured = true;
    if (!gestured || kinds.length === 0) return;
    const peak = PEAK_GAIN * Math.min(1, Math.max(0, volume));
    if (peak <= 0) return;
    const c = getContext();
    if (!c || !(await resumeContext(c))) return;
    let at = c.currentTime;
    for (const kind of kinds) {
      scheduleCue(c, kind, at, peak);
      at += cueLength(kind) + CUE_GAP_S;
    }
  } catch { /* sin audio: silencio */ }
}
