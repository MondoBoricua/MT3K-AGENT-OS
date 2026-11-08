// One in-memory session ledger (data/session-snapshot.json) plus a mutation queue.
//
// Every ledger change (kill, launch record, periodic/after-launch writer, dismiss, restore) goes
// through `mutate(name, fn, opts)`: mutations run one at a time on a promise chain, `fn(current)`
// always sees the LATEST state (never a copy read before an await), and the result is persisted
// atomically (writeSnapshot = tmp + rename) before it becomes the in-memory state. `fn` returning
// null/undefined or the same object is a no-op. Callers must finish any awaited discovery BEFORE
// calling `mutate`; `fn` itself should be synchronous.
//
// Discovery generations: a write derived from a scan passes `scanSeq` (the discovery sequence number
// taken when that scan STARTED); a kill passes `killSeq` (the discovery counter at kill time). A scan
// with `scanSeq <= lastKillSeq` began before a kill and is rejected (no-op + log), so a stale writer
// can never put a killed session back.
//
// Persistence failures: when the disk write throws (EACCES, ENOSPC…) the previous state stays
// current and the caller gets `{ applied: false, reason: "error" }`. A mutation passed with
// `retry: true` (kill, launch record) is kept as a pending intent: it is re-applied before the next
// mutation (and persisted with it), and `projected()` returns the current state WITH the pending
// intents applied, so restore planning never offers a session whose removal only failed to persist.
export function createLedgerStore({ file, readSnapshot, writeSnapshot, now = () => Date.now(), log = () => {} }) {
  let loaded = false;
  let state = null;
  let lastKillSeq = 0;
  let chain = Promise.resolve();
  const pendingIntents = []; // [{ name, fn }] mutations whose write failed; re-applied on the next mutation

  const load = () => {
    if (!loaded) {
      loaded = true;
      try {
        state = readSnapshot(file);
      } catch {
        state = null;
      }
    }
    return state;
  };

  const withPending = (base) => {
    let s = base;
    for (const intent of pendingIntents) {
      const next = intent.fn(s);
      if (next !== null && next !== undefined) s = next;
    }
    return s;
  };

  const apply = (name, fn, scanSeq, retry) => {
    const current = load();
    if (Number.isFinite(scanSeq) && scanSeq <= lastKillSeq) {
      log(`ledger · ${name} rechazado: escaneo #${scanSeq} anterior al kill #${lastKillSeq}`);
      return { applied: false, reason: "stale-scan", state: current };
    }
    const base = withPending(current);
    const produced = fn(base);
    const next = produced === null || produced === undefined ? base : produced;
    if (next === current) {
      return { applied: false, reason: "unchanged", state: current };
    }
    try {
      writeSnapshot(file, next);
    } catch (err) {
      if (retry) pendingIntents.push({ name, fn });
      throw Object.assign(err instanceof Error ? err : new Error(String(err)), { ledgerWriteFailed: true, queued: !!retry });
    }
    state = next;
    pendingIntents.length = 0; // the write carried every pending intent
    return { applied: true, state: next, at: now() };
  };

  return {
    get: () => load(),
    // current state plus the intents whose write failed: what restore planning must see
    projected: () => withPending(load()),
    pendingCount: () => pendingIntents.length,
    lastKillSeq: () => lastKillSeq,
    mutate(name, fn, { scanSeq = null, killSeq = null, retry = false } = {}) {
      // a kill takes effect for every queued or later scan write immediately, not when its turn comes
      if (Number.isFinite(killSeq) && killSeq > lastKillSeq) lastKillSeq = killSeq;
      const run = chain.then(() => {
        try {
          return apply(name, fn, scanSeq, retry);
        } catch (err) {
          log(`ledger · ${name} falló: ${err?.message || err}${err?.queued ? " (reintento pendiente)" : ""}`);
          return { applied: false, reason: "error", queued: !!err?.queued, error: err, state };
        }
      });
      chain = run.then(() => {}, () => {});
      return run;
    },
    // resolves after every mutation queued so far has run (tests, shutdown)
    idle: () => chain,
  };
}
