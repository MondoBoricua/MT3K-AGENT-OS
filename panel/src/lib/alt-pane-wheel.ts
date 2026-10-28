// Traduce gestos de rueda del visor en teclas de línea para TUIs en pantalla alterna (Codex).
// El delta sobrante se guarda; el drenaje async respeta 40 ms entre teclas y tope 6 por gesto.

export function measuredLineHeightPx(el: HTMLElement, fontPx: number): number {
  const raw = parseFloat(getComputedStyle(el).lineHeight);
  const lh = Number.isFinite(raw) && raw > 0 ? raw : fontPx;
  return Math.max(16, lh);
}

export type AltWheelState = {
  remainder: number;
  lastSendAt: number;
  gestureKeysLeft: number;
  drainVersion: number;
};

export const initialAltWheelState = (): AltWheelState => ({
  remainder: 0,
  lastSendAt: 0,
  gestureKeysLeft: 0,
  drainVersion: 0,
});

/** Suma el delta del gesto y deja listo el cupo de hasta 6 teclas para este evento de rueda. */
export function accumulateWheelDelta(state: AltWheelState, deltaY: number): AltWheelState {
  return {
    ...state,
    remainder: state.remainder + deltaY,
    gestureKeysLeft: 6,
    drainVersion: state.drainVersion + 1,
  };
}

/**
 * Envía teclas mientras haya remainder y cupo del gesto; espera 40 ms entre envíos.
 * `isAlive` corta si cambió el pane o se cerró la ficha.
 */
export async function drainAltWheel(
  start: AltWheelState,
  lineHeightPx: number,
  sendKey: (k: "Up" | "Down") => Promise<void>,
  isAlive: () => boolean,
): Promise<AltWheelState> {
  let cur = start;
  const version = start.drainVersion;
  while (isAlive() && cur.drainVersion === version && cur.gestureKeysLeft > 0 && Math.abs(cur.remainder) >= lineHeightPx) {
    const now = Date.now();
    const wait = Math.max(0, 40 - (now - cur.lastSendAt));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (!isAlive() || cur.drainVersion !== version) break;
    const up = cur.remainder < 0;
    await sendKey(up ? "Up" : "Down");
    cur = {
      ...cur,
      remainder: cur.remainder + (up ? lineHeightPx : -lineHeightPx),
      lastSendAt: Date.now(),
      gestureKeysLeft: cur.gestureKeysLeft - 1,
    };
  }
  return cur;
}
