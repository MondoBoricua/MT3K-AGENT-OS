const ALLOWED = new Set([
  "Up", "Down", "Left", "Right", "Enter", "Escape", "Tab", "ShiftTab", "Space", "BSpace",
  "PageUp", "PageDown", "Home", "End", "SendNow",
  // Rueda SGR (tmux -l): Codex TUI con mouse_sgr escucha esto — ~1 línea por evento. Coordenadas 10;8 = dentro del transcript: en 1;1 (cabecera) el TUI ignora el evento (medido 2026-10-27).
  "WheelUp", "WheelDown",
]);

// Solo nombres lógicos; SendNow y la rueda expanden a secuencias distintas de una tecla suelta.
export function keyArgs(name) {
  if (typeof name !== "string" || !ALLOWED.has(name)) return null;
  if (name === "SendNow") return ["C-x", "C-s"];
  if (name === "ShiftTab") return ["BTab"];
  if (name === "WheelUp") return ["-l", "\x1b[<64;10;8M"];
  if (name === "WheelDown") return ["-l", "\x1b[<65;10;8M"];
  return [name];
}
