import { useCallback, useEffect, useSyncExternalStore } from "react";
import { getUsage } from "./api";
import type { UsageReport } from "./usage";

// One shared poll for every component that shows quota (room nameplates, Home, alerts).
const POLL_MS = 2 * 60_000; // the server caches for 5 min, so this is cheap
const SETTLE_MS = 6_000; // the server answered with what it had and is measuring: come back for the result

interface UsageState { report: UsageReport | null; loading: boolean }
let state: UsageState = { report: null, loading: false };
const listeners = new Set<() => void>();
let subscribers = 0;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let settleTimer: ReturnType<typeof setTimeout> | undefined;
let inflight: Promise<void> | null = null;

const setState = (next: UsageState) => { state = next; for (const l of listeners) l(); };

function pull(fresh = false): Promise<void> {
  if (inflight) return inflight;
  setState({ ...state, loading: true });
  inflight = getUsage(fresh).then((r) => {
    // a failed request keeps what was on screen
    setState({ report: r?.ok ? r : state.report, loading: false });
    clearTimeout(settleTimer);
    if (r?.refreshing && subscribers > 0) settleTimer = setTimeout(() => void pull(), SETTLE_MS);
  }).finally(() => { inflight = null; });
  return inflight;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useUsage(): { report: UsageReport | null; loading: boolean; refresh: () => void } {
  const snap = useSyncExternalStore(subscribe, () => state);
  useEffect(() => {
    if (subscribers++ === 0) {
      void pull();
      pollTimer = setInterval(() => void pull(), POLL_MS);
    }
    return () => {
      if (--subscribers === 0) { clearInterval(pollTimer); clearTimeout(settleTimer); }
    };
  }, []);
  const refresh = useCallback(() => { void pull(true); }, []);
  return { report: snap.report, loading: snap.loading, refresh };
}
