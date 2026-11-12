import type { AlertKind } from "./alert-sounds.ts";

// Dos avisos sintetizados con Web Audio (sin archivos). Falla en silencio si no hay audio
// o si el navegador mantiene el contexto suspendido (hace falta un gesto del usuario).

type Note = { freq: number; start: number; dur: number };
const PEAK_GAIN = 0.25; // techo antes de aplicar el volumen del usuario
const ATTACK_S = 0.012;
const CUES: Record<AlertKind, readonly Note[]> = {
  blocked: [{ freq: 660, start: 0, dur: 0.16 }, { freq: 880, start: 0.17, dur: 0.22 }], // dos notas ascendentes, ~0.4 s
  done: [{ freq: 440, start: 0, dur: 0.3 }], // una nota suave y grave
};

let ctx: AudioContext | null = null;

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

/** Reanuda el contexto (sin error si no se puede). Llamar desde un gesto del usuario. */
export function unlockAudio(): void {
  try {
    const c = getContext();
    if (c && c.state === "suspended") void c.resume().catch(() => {});
  } catch { /* sin audio */ }
}

/** Desbloquea con el primer pointerdown/keydown tras cargar. */
export function installAudioUnlock(): () => void {
  const off = () => {
    window.removeEventListener("pointerdown", on);
    window.removeEventListener("keydown", on);
  };
  const on = () => { unlockAudio(); off(); };
  window.addEventListener("pointerdown", on);
  window.addEventListener("keydown", on);
  return off;
}

export function playAlertSound(kind: AlertKind, volume: number): void {
  try {
    const c = getContext();
    if (!c || c.state !== "running") { unlockAudio(); if (!c || c.state !== "running") return; }
    const peak = PEAK_GAIN * Math.min(1, Math.max(0, volume));
    if (peak <= 0) return;
    const t0 = c.currentTime;
    for (const n of CUES[kind]) {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = "sine";
      osc.frequency.value = n.freq;
      const s = t0 + n.start;
      gain.gain.setValueAtTime(0, s);
      gain.gain.linearRampToValueAtTime(peak, s + ATTACK_S);
      gain.gain.exponentialRampToValueAtTime(0.0001, s + n.dur);
      osc.connect(gain).connect(c.destination);
      osc.start(s);
      osc.stop(s + n.dur + 0.02);
    }
  } catch { /* sin audio: silencio */ }
}
