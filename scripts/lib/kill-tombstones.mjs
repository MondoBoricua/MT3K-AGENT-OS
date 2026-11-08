import { sessionNameOf } from "./pane-labels.mjs";

export const KILLED_SESSION_HOLD_MS = 60000;

// Sessions killed through /api/kill (their last pane died). A discovery that was already in flight
// when the pane died can still list them, and a ledger write from it would put the entry back.
//
// Discovery generations: every discovery run takes `seq = ++counter` at its START. A kill records
// `killedAtSeq` = the counter at kill time, so any scan with `seq <= killedAtSeq` began before the
// kill and can NEVER resurrect the session. A scan that began after the kill resurrects it only with
// new-generation evidence: a pane id the session never had (all ids are accumulated across scans
// via `observe`, so an old sibling id is not "new"), or a different `pane_pid` for a known id
// (Windows/psmux ids are `session:window.pane` labels and repeat on same-name recreation; the pid
// does not). New-generation evidence clears the tombstone. Killing one pane of a session whose
// other panes survive records no tombstone. Tombstones expire after `holdMs`.

const pidOf = (p) => {
  const n = Number(p?.panePid);
  return Number.isFinite(n) && n > 0 ? n : null;
};

// sessionName → [{ paneId, panePid }] for local rows (remote/federated rows are ignored)
export function livePanesBySession(rows) {
  const out = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r?.host) continue;
    for (const p of Array.isArray(r?.panes) ? r.panes : []) {
      const name = sessionNameOf(p?.session || p?.label);
      if (!name || !p?.paneId) continue;
      if (!out.has(name)) out.set(name, []);
      out.get(name).push({ paneId: p.paneId, panePid: pidOf(p) });
    }
  }
  return out;
}

export function livePaneIdsBySession(rows) {
  const out = new Map();
  for (const [name, panes] of livePanesBySession(rows)) out.set(name, new Set(panes.map((p) => p.paneId)));
  return out;
}

export function createKillTombstones({ now = () => Date.now(), holdMs = KILLED_SESSION_HOLD_MS } = {}) {
  const tombstones = new Map(); // sessionName → { paneIds: Set, pidById: Map, killedAtSeq, at }
  const history = new Map(); // sessionName → { paneIds: Set, pidById: Map } (live sessions only)
  const prune = () => {
    const t = now();
    for (const [name, ts] of tombstones) if (t - ts.at > holdMs) tombstones.delete(name);
  };
  const isNewGeneration = (ts, panes) =>
    panes.some((p) => {
      if (!ts.paneIds.has(p.paneId)) return true;
      const known = ts.pidById.get(p.paneId);
      return known != null && p.panePid != null && known !== p.panePid;
    });
  return {
    // accumulate every pane id/pid each live session ever had; `rows` are from one successful
    // discovery (sessions absent from it are dropped from the history). A scan that began before a
    // session's kill (`seq <= killedAtSeq`) adds nothing for it.
    observe(rows, seq = null) {
      const live = livePanesBySession(rows);
      for (const name of [...history.keys()]) if (!live.has(name)) history.delete(name);
      for (const [name, panes] of live) {
        const ts = tombstones.get(name);
        if (ts && Number.isFinite(seq) && ts.killedAtSeq != null && seq <= ts.killedAtSeq) continue;
        if (!history.has(name)) history.set(name, { paneIds: new Set(), pidById: new Map() });
        const h = history.get(name);
        for (const p of panes) {
          h.paneIds.add(p.paneId);
          if (p.panePid != null) h.pidById.set(p.paneId, p.panePid);
        }
      }
    },
    mark(sessionName, paneIds = [], { killedAtSeq = null, panePids = {} } = {}) {
      prune();
      const name = sessionNameOf(sessionName);
      if (!name) return;
      const h = history.get(name);
      const ids = new Set([...(h?.paneIds || []), ...paneIds]);
      const pidById = new Map(h?.pidById || []);
      for (const [id, pid] of Object.entries(panePids || {})) {
        const n = pidOf({ panePid: pid });
        if (n != null) pidById.set(id, n);
      }
      tombstones.set(name, {
        paneIds: ids,
        pidById,
        killedAtSeq: Number.isFinite(killedAtSeq) ? killedAtSeq : null,
        at: now(),
      });
      history.delete(name);
    },
    clear(sessionName) {
      tombstones.delete(sessionNameOf(sessionName));
    },
    size() {
      prune();
      return tombstones.size;
    },
    get(sessionName) {
      prune();
      const ts = tombstones.get(sessionNameOf(sessionName));
      return ts ? { paneIds: [...ts.paneIds], killedAtSeq: ts.killedAtSeq, panePids: Object.fromEntries(ts.pidById) } : null;
    },
    // `seq` = the discovery generation `rows` come from (omit when unknown: only pane evidence counts)
    filter(snapshot, rows = [], seq = null) {
      prune();
      if (!tombstones.size || !Array.isArray(snapshot?.sessions)) return snapshot;
      const live = livePanesBySession(rows);
      const drop = new Set();
      for (const [name, ts] of tombstones) {
        const staleScan = Number.isFinite(seq) && ts.killedAtSeq != null && seq <= ts.killedAtSeq;
        const panes = live.get(name) || [];
        if (!staleScan && isNewGeneration(ts, panes)) tombstones.delete(name);
        else drop.add(name);
      }
      if (!drop.size) return snapshot;
      return { ...snapshot, sessions: snapshot.sessions.filter((s) => !drop.has(sessionNameOf(s?.sessionName))) };
    },
  };
}
