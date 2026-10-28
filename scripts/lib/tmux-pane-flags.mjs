// Parsea la salida de un solo `tmux display -p` con #{alternate_on} y #{mouse_sgr_flag}.

/** @param {string} raw — p.ej. "1 1" o "0 0" */
export function parseAlternateMouseSgr(raw) {
  const parts = String(raw ?? "").trim().split(/\s+/);
  return {
    alternate: parts[0] === "1",
    mouse_sgr: parts[1] === "1",
  };
}

/** Formato tmux para pedir ambos flags en una sola llamada display-message. */
export const TMUX_ALT_MOUSE_DISPLAY = "#{alternate_on} #{mouse_sgr_flag}";
