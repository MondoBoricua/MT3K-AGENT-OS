const ALLOWED = new Set(["Up", "Down", "Left", "Right", "Enter", "Escape", "Tab", "Space", "BSpace", "PageUp", "PageDown", "Home", "End", "SendNow"]);

// Only logical names are accepted; SendNow alone expands into a chord.
export function keyArgs(name) {
  if (typeof name !== "string" || !ALLOWED.has(name)) return null;
  return name === "SendNow" ? ["C-x", "C-s"] : [name];
}
