// Traduce gestos de rueda del visor en WheelUp/WheelDown (SGR vía /api/key) para TUIs en pantalla alterna (Codex).
// Un solo drenaje por pane: el acumulador es compartido; generaciones viejas no pisan el estado nuevo.

/** Line-height real del <pre> (filas de tmux); sin piso artificial. */
export function measuredLineHeightPx(el: HTMLElement, fontPx: number): number {
  const raw = parseFloat(getComputedStyle(el).lineHeight);
  return Number.isFinite(raw) && raw > 0 ? raw : fontPx;
}

/** Umbral mínimo de píxeles por “línea” de rueda (evita micro-deltas en fuentes chicas). */
export function wheelLineThresholdPx(el: HTMLElement, fontPx: number): number {
  return Math.max(16, measuredLineHeightPx(el, fontPx));
}

/** deltaMode DOM: 0 px, 1 líneas × lineHeight, 2 páginas × alto visible del pre. */
export function normalizeWheelDeltaPx(
  deltaY: number,
  deltaMode: number,
  lineHeightPx: number,
  visibleHeightPx: number,
): number {
  if (deltaMode === 1) return deltaY * lineHeightPx;
  if (deltaMode === 2) return deltaY * visibleHeightPx;
  return deltaY;
}

/** Cupo de 6 teclas por GESTO: se reinicia tras GESTURE_GAP_MS sin eventos de rueda. */
export const GESTURE_GAP_MS = 150;

export type AltWheelSession = {
  remainder: number;
  lastSendAt: number;
  gestureKeysLeft: number;
  lastWheelAt: number;
  generation: number;
  draining: boolean;
};

export const initialAltWheelSession = (generation = 0): AltWheelSession => ({
  remainder: 0,
  lastSendAt: 0,
  gestureKeysLeft: 0,
  lastWheelAt: 0,
  generation,
  draining: false,
});

/** Suma delta normalizado; reinicia cupo del gesto si pasó la pausa entre eventos. */
export function accumulateWheelDelta(session: AltWheelSession, deltaY: number, now = Date.now()): void {
  if (now - session.lastWheelAt > GESTURE_GAP_MS) session.gestureKeysLeft = 6;
  session.lastWheelAt = now;
  session.remainder += deltaY;
}

/**
 * Drenaje único: si ya hay uno corriendo, solo deja que el loop actual consuma el remainder actualizado.
 * Commits viejos: el caller no debe aplicar nada si generation cambió al terminar.
 */
export async function runAltWheelDrain(
  session: AltWheelSession,
  lineHeightPx: number,
  sendKey: (k: "WheelUp" | "WheelDown") => Promise<void>,
  isAlive: () => boolean,
): Promise<void> {
  if (session.draining) return;
  session.draining = true;
  const gen = session.generation;
  try {
    while (
      isAlive()
      && session.generation === gen
      && session.gestureKeysLeft > 0
      && Math.abs(session.remainder) >= lineHeightPx
    ) {
      const now = Date.now();
      const wait = Math.max(0, 40 - (now - session.lastSendAt));
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      if (!isAlive() || session.generation !== gen) break;
      const up = session.remainder < 0;
      await sendKey(up ? "WheelUp" : "WheelDown");
      session.remainder += up ? lineHeightPx : -lineHeightPx;
      session.lastSendAt = Date.now();
      session.gestureKeysLeft -= 1;
    }
  } finally {
    session.draining = false;
    if (
      isAlive()
      && session.generation === gen
      && session.gestureKeysLeft > 0
      && Math.abs(session.remainder) >= lineHeightPx
    ) {
      void runAltWheelDrain(session, lineHeightPx, sendKey, isAlive);
    }
  }
}
