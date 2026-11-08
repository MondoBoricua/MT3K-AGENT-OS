import { conditionMet, promptWaitGateOpen } from "./wait-until.mjs";

export async function runWait({
  cond = "not-working",
  timeoutMs = 180000,
  refresh,
  readStatus,
  isAlive,
  sleep,
  now,
  onAbort,
  baseline = null,
  sawWorkingBefore = false,
  isPromptWait = false,
  sentAt = null,
  pollIntervalMs = 2000,
  graceMs = 10000,
} = {}) {
  const nowFn = typeof now === "function" ? now : () => Date.now();
  const pollMs = typeof pollIntervalMs === "number" && pollIntervalMs > 0 ? pollIntervalMs : 2000;
  const totalMs = Math.max(0, Number(timeoutMs) || 0);
  const startMs = nowFn();
  const deadline = startMs + totalMs;
  // prompt-wait: the gate trusts only a manifest `working` SAMPLED after the send (a cached sample
  // from the previous turn must not open it); the 10 s grace also counts from the send
  const sentAtMs = typeof sentAt === "number" && Number.isFinite(sentAt) ? sentAt : startMs;

  let initialStatus =
    typeof baseline === "string" && baseline.trim() && baseline.trim() !== "unknown"
      ? baseline.trim()
      : null;
  // a chunked client (wait-cli) passes what earlier chunks saw, so `done` keeps its meaning across requests
  let sawWorking = Boolean(sawWorkingBefore);
  let sawManifestWorking = false;
  let lastStatus = "unknown";
  let lastRule = "unknown";
  let aborted = false;
  let cancelPendingSleep = null;

  const triggerAbort = () => {
    if (aborted) return;
    aborted = true;
    if (cancelPendingSleep) {
      const c = cancelPendingSleep;
      cancelPendingSleep = null;
      c();
    }
  };

  const unsubAbort = typeof onAbort === "function" ? onAbort(triggerAbort) : null;

  const waitStep = (ms) => {
    if (aborted) return Promise.resolve();
    if (typeof sleep === "function") {
      return new Promise((resolve) => {
        let settled = false;
        let clearCustom = null;
        const done = () => {
          if (settled) return;
          settled = true;
          cancelPendingSleep = null;
          if (typeof clearCustom === "function") {
            const c = clearCustom;
            clearCustom = null;
            c();
          }
          resolve();
        };
        cancelPendingSleep = done;
        const maybePromise = sleep(ms, (cancelFn) => {
          clearCustom = cancelFn;
        });
        if (aborted) {
          done();
          return;
        }
        Promise.resolve(maybePromise).then(done, done);
      });
    }
    return new Promise((resolve) => {
      let timer = setTimeout(() => {
        timer = null;
        cancelPendingSleep = null;
        resolve();
      }, ms);
      cancelPendingSleep = () => {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        resolve();
      };
    });
  };

  const evaluate = async (doRefresh = false) => {
    if (doRefresh && typeof refresh === "function") {
      await refresh(false);
    }
    if (aborted) return { done: true, reason: "aborted" };

    let alive = typeof isAlive === "function" ? await isAlive() : true;
    if (aborted) return { done: true, reason: "aborted" };
    if (!alive && typeof refresh === "function") {
      // the pane list may predate the pane (a new or unattributed pane): never report `gone`
      // without a forced refresh confirming it
      await refresh(true);
      if (aborted) return { done: true, reason: "aborted" };
      alive = typeof isAlive === "function" ? await isAlive() : true;
      if (aborted) return { done: true, reason: "aborted" };
    }
    if (!alive) {
      return {
        done: true,
        reason: "gone",
        status: lastStatus === "unknown" ? "idle" : lastStatus,
        statusRule: "gone",
      };
    }

    let st = typeof readStatus === "function" ? await readStatus() : null;
    if (aborted) return { done: true, reason: "aborted" };

    if (st === null || st === undefined) {
      if (typeof refresh === "function") {
        await refresh(true);
      }
      if (aborted) return { done: true, reason: "aborted" };
      const stillAlive = typeof isAlive === "function" ? await isAlive() : true;
      if (aborted) return { done: true, reason: "aborted" };
      if (!stillAlive) {
        return {
          done: true,
          reason: "gone",
          status: lastStatus === "unknown" ? "idle" : lastStatus,
          statusRule: "gone",
        };
      }
      st = typeof readStatus === "function" ? await readStatus() : null;
      if (aborted) return { done: true, reason: "aborted" };
    }

    if (st === null || st === undefined || typeof st.status !== "string" || !st.status || st.status === "unknown") {
      lastStatus = "unknown";
      lastRule = st?.statusRule || "unknown";
      return { done: false };
    }

    lastStatus = st.status;
    lastRule = st.statusRule || "unknown";
    if (initialStatus === null) {
      initialStatus = st.status;
    }
    if (st.status === "working") {
      sawWorking = true;
      const fromManifest = st.source === "manifest" || st.source === undefined;
      const postSend = typeof st.sampledAt === "number" && st.sampledAt >= sentAtMs;
      if (fromManifest && (!isPromptWait || postSend)) {
        sawManifestWorking = true;
      }
    }

    const elapsedMs = nowFn() - sentAtMs;
    const gateOpen =
      !isPromptWait ||
      promptWaitGateOpen({
        sawWorking: sawManifestWorking,
        statusSource: sawManifestWorking ? "manifest" : st.source || "heuristic",
        elapsedMs,
        graceMs,
      });

    if (gateOpen && conditionMet(cond, st.status, initialStatus, { sawWorking })) {
      return { done: true, reason: "reached", status: st.status, statusRule: lastRule };
    }
    return { done: false };
  };

  // the deadline is wall-clock: a refresh that finished after it cannot turn an expired wait into
  // success (a slow sample may still finish late, but it reports `timeout`). Applies to the initial
  // evaluation as well as every poll.
  const lateSuccess = (step) => step.done && step.reason === "reached" && nowFn() > deadline;
  const timeoutResult = () => ({
    reason: "timeout",
    status: lastStatus,
    statusRule: lastRule,
    waitedMs: Math.max(0, nowFn() - startMs),
    sawWorking,
    baseline: initialStatus,
  });

  try {
    const first = await evaluate(false);
    if (lateSuccess(first)) return timeoutResult();
    if (first.done) {
      return {
        reason: first.reason,
        status: first.status ?? lastStatus,
        statusRule: first.statusRule ?? lastRule,
        waitedMs: Math.max(0, nowFn() - startMs),
        sawWorking,
        baseline: initialStatus,
      };
    }

    while (!aborted) {
      const remaining = deadline - nowFn();
      if (remaining <= 0) return timeoutResult();
      await waitStep(Math.min(pollMs, Math.max(1, remaining)));
      if (aborted) break;
      const step = await evaluate(true);
      if (lateSuccess(step)) return timeoutResult();
      if (step.done) {
        return {
          reason: step.reason,
          status: step.status ?? lastStatus,
          statusRule: step.statusRule ?? lastRule,
          waitedMs: Math.max(0, nowFn() - startMs),
          sawWorking,
          baseline: initialStatus,
        };
      }
    }

    return {
      reason: "aborted",
      status: lastStatus,
      statusRule: lastRule,
      waitedMs: Math.max(0, nowFn() - startMs),
      sawWorking,
      baseline: initialStatus,
    };
  } finally {
    if (cancelPendingSleep) {
      const c = cancelPendingSleep;
      cancelPendingSleep = null;
      c();
    }
    if (typeof unsubAbort === "function") {
      unsubAbort();
    }
  }
}
