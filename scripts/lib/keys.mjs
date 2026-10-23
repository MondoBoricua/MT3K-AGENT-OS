const ALLOWED = new Set(["Up", "Down", "Left", "Right", "Enter", "Escape", "Tab", "ShiftTab", "Space", "BSpace", "PageUp", "PageDown", "Home", "End", "SendNow"]);

// Only logical names are accepted; SendNow alone expands into a chord.
export function keyArgs(name) {
  if (typeof name !== "string" || !ALLOWED.has(name)) return null;
  if (name === "SendNow") return ["C-x", "C-s"];
  if (name === "ShiftTab") return ["BTab"];
  return [name];
}
