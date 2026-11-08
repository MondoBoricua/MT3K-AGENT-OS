export const RESTORE_MAX_ITEMS = 12;
export const RESTORE_DELAY_MS = 1500;

let restoreInFlight = false;

export function isRestoreRunning() {
  return restoreInFlight;
}

function sessionKey(entry) {
  return typeof entry?.sessionName === "string" ? entry.sessionName.trim() : "";
}

function itemBase(entry) {
  return {
    agentId: entry.agentId,
    cwd: entry.cwd,
    ...(entry.name ? { name: entry.name } : {}),
    ...(entry.sessionName ? { sessionName: entry.sessionName } : {}),
  };
}

function skipResult(entry, reason, err) {
  return { ...itemBase(entry), ok: false, skipped: true, reason, ...(err ? { err } : {}) };
}

// `precheck(entry)` (optional) runs before an entry may use a launch slot; returning
// `{ skipped: true, reason, err }` (e.g. missing-dir) records a skip WITHOUT consuming the quota, so
// a prefix of dead folders can never starve the valid entries behind it.
export async function runRestore({
  items,
  missing,
  all = false,
  launch,
  precheck,
  sleep,
  log,
  delayMs = RESTORE_DELAY_MS,
  maxItems = RESTORE_MAX_ITEMS,
} = {}) {
  if (restoreInFlight) {
    return { ok: false, status: 409, err: "restore en curso" };
  }
  restoreInFlight = true;
  const sleepFn =
    typeof sleep === "function" ? sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  try {
    const missingList =
      typeof missing === "function"
        ? await missing()
        : Array.isArray(missing)
          ? missing
          : null;

    const planned = [];
    if (missingList !== null) {
      if (all && (!Array.isArray(items) || items.length === 0)) {
        for (const m of missingList) {
          planned.push({ ...m, _notMissing: false });
        }
      } else if (Array.isArray(items)) {
        const pool = [...missingList];
        for (const want of items) {
          if (!want || typeof want.agentId !== "string" || typeof want.cwd !== "string") continue;
          let idx = -1;
          if (typeof want.sessionName === "string" && want.sessionName.trim()) {
            // an explicit identity never falls back to another session in the same folder
            idx = pool.findIndex(
              (m) =>
                m.sessionName === want.sessionName.trim() &&
                m.agentId === want.agentId &&
                m.cwd === want.cwd
            );
          } else {
            idx = pool.findIndex((m) => m.agentId === want.agentId && m.cwd === want.cwd);
          }
          if (idx >= 0) {
            const matched = pool.splice(idx, 1)[0];
            planned.push({ ...matched, _notMissing: false });
          } else {
            planned.push({
              agentId: want.agentId,
              cwd: want.cwd,
              ...(want.name ? { name: want.name } : {}),
              ...(want.sessionName ? { sessionName: want.sessionName } : {}),
              _notMissing: true,
            });
          }
        }
      }
    } else if (Array.isArray(items)) {
      for (const want of items) {
        if (!want || typeof want.agentId !== "string" || typeof want.cwd !== "string") continue;
        const notMissing =
          want.missing === false || want.inMissing === false || want.reason === "not-missing";
        planned.push({ ...want, _notMissing: notMissing });
      }
    }

    const results = [];
    let launchedCount = 0;
    let launchAttempts = 0;
    let needDelay = false;
    const seenSessions = new Set();

    for (const entry of planned) {
      if (entry._notMissing) {
        results.push({
          ...skipResult(entry, "not-missing", "esa sesión no está pendiente de restaurar"),
        });
        continue;
      }

      // defensive: one physical session is relaunched at most once per run
      const key = sessionKey(entry);
      if (key) {
        if (seenSessions.has(key)) continue;
        seenSessions.add(key);
      }

      if (entry.ambiguous === true) {
        results.push(
          skipResult(entry, "ambiguous-owner", "varios agentes reclaman esta sesión; ábrela a mano o descártala")
        );
        continue;
      }

      if (typeof precheck === "function") {
        const pre = await precheck(entry);
        if (pre && (pre.skipped || pre.reason)) {
          results.push(skipResult(entry, pre.reason || "missing-dir", pre.err));
          continue;
        }
      }

      if (launchAttempts >= maxItems) {
        break;
      }

      if (needDelay) {
        await sleepFn(delayMs);
      }

      const res =
        typeof launch === "function"
          ? await launch(entry)
          : { ok: false, reason: "launch-failed", err: "launch no disponible" };

      if (res?.skipped || res?.reason === "missing-dir" || res?.missingDir) {
        needDelay = false;
        results.push(skipResult(entry, res.reason || "missing-dir", res.err));
        continue;
      }

      launchAttempts++;
      needDelay = true;
      const ok = Boolean(res?.ok);
      if (ok) launchedCount++;
      results.push({
        ...itemBase(entry),
        ...(res?.paneId ? { paneId: res.paneId } : {}),
        ...(res?.session ? { session: res.session } : {}),
        ...(typeof res?.resumed === "boolean" ? { resumed: res.resumed } : {}),
        ok,
        reason: res?.reason || (ok ? "ok" : "launch-failed"),
        ...(res?.err ? { err: res.err } : {}),
      });
    }

    const skippedCount = results.filter((r) => !r.ok).length;
    if (typeof log === "function") {
      log(`restore · ${launchedCount} lanzadas · ${skippedCount} omitidas`, {
        launched: launchedCount,
        skipped: skippedCount,
        results,
      });
    }
    return {
      ok: true,
      status: 200,
      results,
      launched: launchedCount,
      skipped: skippedCount,
    };
  } finally {
    restoreInFlight = false;
  }
}
