// Classifies a failed `tmux list-panes` / `tmux list-sessions` call.
//
// Only a CONFIRMED "no tmux server" answer counts as an empty, successful listing. Everything else
// (permission denied, busy socket, timeouts, path too long, unknown text) is a transient failure:
// the caller keeps its previous pane/session names and sets lastListPanesOk=false, so a broken
// socket never reads as "every session is gone" (which would mark ledger entries missing and could
// trigger duplicate auto-restores).
//
// Shapes measured with tmux 3.8 on isolated `tmux -S <path>` sockets (2026-11-08):
//   socket path does not exist      → "error connecting to <path> (No such file or directory)"
//   socket file present, no server  → "no server running on <path>"   (tmux maps ECONNREFUSED to this)
//   socket mode 000                 → "error connecting to <path> (Permission denied)"      → transient
//   regular file at the socket path → "error connecting to <path> (Socket operation on non-socket)" → transient
//   socket path too long            → "error connecting to <path> (File name too long)"     → transient
// "error connecting to <path> (Connection refused)" is NOT accepted: tmux 3.8 never prints it
// (ECONNREFUSED becomes "no server running on"), so seeing it means something else is answering.
// psmux (Windows): its no-server text has not been measured, so it stays on the transient path.
const ABSENT_LINE_RES = [
  /^no server running on \S.*$/,
  /^error connecting to \S.* \(No such file or directory\)$/,
];

export function tmuxServerAbsent(stderr) {
  if (typeof stderr !== "string") return false;
  const text = stderr.replace(/\r\n/g, "\n").trim();
  if (!text || text.includes("\n")) return false; // a timeout appends "[timeout]" on its own line
  return ABSENT_LINE_RES.some((re) => re.test(text));
}
