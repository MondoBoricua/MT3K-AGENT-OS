// Pure decisions behind "open a terminal link in Files" (Files.tsx has no browser test harness).
export interface PendingOpen { path: string; host: string; approved: boolean }

export type LinkDecision =
  | { action: "drop" } // user refused to discard unsaved edits: keep buffer and host, forget the request
  | { action: "open-now" } // page mounted on the right host: open directly (openAt asks about unsaved edits itself)
  | { action: "queue"; switchHost: boolean; pending: PendingOpen };

// `confirm` is called at most once, and only when a host switch would discard unsaved edits.
// An accepted switch carries approved:true so the later openAt does not ask again.
export function decideLinkRequest(o: {
  mounted: boolean; host: string; wantHost: string; path: string; dirty: boolean; confirm: () => boolean;
}): LinkDecision {
  const differs = o.wantHost !== o.host;
  if (o.mounted && !differs) return { action: "open-now" };
  let approved = false;
  if (differs && o.dirty) {
    if (!o.confirm()) return { action: "drop" };
    approved = true;
  }
  return { action: "queue", switchHost: differs, pending: { path: o.path, host: o.wantHost, approved } };
}

// what the host effect does for the current host: wait for the queued switch, open the pending path, or load the remembered folder
export function hostEffectAction(pending: PendingOpen | null, host: string): "wait" | "open" | "load-start" {
  if (!pending) return "load-start";
  return pending.host === host ? "open" : "wait";
}

// the user picked a host by hand: a pending link open for another host is obsolete
export function pendingAfterManualHost(pending: PendingOpen | null, pickedHost: string): PendingOpen | null {
  return pending && pending.host === pickedHost ? pending : null;
}
