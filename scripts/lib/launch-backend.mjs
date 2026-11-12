// Ajuste "dónde se abren las sesiones nuevas" (data/launch-backend.json): parte pura, sin disco.
export const LAUNCH_BACKENDS = ["tmux", "herdr"];

/** Texto crudo del archivo → "tmux" | "herdr". Ausente, JSON corrupto o valor fuera de la lista → "tmux". */
export function parseLaunchBackend(rawText) {
  if (typeof rawText !== "string") return "tmux";
  try {
    const b = JSON.parse(rawText)?.backend;
    return LAUNCH_BACKENDS.includes(b) ? b : "tmux";
  } catch {
    return "tmux";
  }
}
