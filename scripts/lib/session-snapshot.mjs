import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { sessionNameOf } from "./pane-labels.mjs";

export const SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function toIso(now) {
  if (typeof now === "number") return new Date(now).toISOString();
  if (now instanceof Date) return now.toISOString();
  if (typeof now === "string" && now.trim()) return now.trim();
  return new Date().toISOString();
}

function toMs(now) {
  if (typeof now === "number") return now;
  if (now instanceof Date) return now.getTime();
  if (typeof now === "string" && now.trim()) return Date.parse(now.trim());
  return Date.now();
}

// One shared rule for "may this ledger entry still be planned / kept": well-formed, and not missing
// for longer than the TTL. Used by the writer (buildSnapshot), the reader (diffSnapshot → GET
// /api/restore, POST /api/restore, auto-restore) so an expired entry is never planned even before
// the writer gets to prune it.
export function isLedgerEntryEligible(entry, now = Date.now(), ttlMs = SNAPSHOT_TTL_MS) {
  if (!entry || typeof entry.agentId !== "string" || !entry.agentId) return false;
  if (typeof entry.cwd !== "string" || !entry.cwd) return false;
  if (!sessionNameOf(entry.sessionName)) return false;
  if (typeof entry.missingSince !== "string" || !entry.missingSince) return true;
  const missingMs = Date.parse(entry.missingSince);
  const nowMs = toMs(now);
  if (!Number.isFinite(missingMs) || !Number.isFinite(nowMs)) return true;
  return nowMs - missingMs <= ttlMs;
}

// One restorable owner per physical tmux session. A session name can be claimed by several rows
// (claude + a descendant CLI in the same pane, or two windows running different agents):
//   1. the agent the panel launched it with (`launched: true`, written by recordLaunchInSnapshot /
//      replaceRestoredSession) is the owner;
//   2. otherwise the first claimant (AGENT_DEFS / ledger order);
//   3. two different agents and no launch record → ONE entry marked `ambiguous: true` (restore
//      skips it with reason "ambiguous-owner"; it is never relaunched twice or as a guess).
function pickOwner(group) {
  const launched = group.find((e) => e.launched === true);
  if (launched) {
    const { ambiguous: _a, claimants: _c, ...rest } = launched;
    return rest;
  }
  const first = group[0];
  const agents = [...new Set(group.map((e) => e.agentId))];
  const { ambiguous: _a, claimants: _c, ...rest } = first;
  if (agents.length > 1 || first.ambiguous === true) {
    const claimants = agents.length > 1 ? agents : Array.isArray(first.claimants) ? first.claimants : agents;
    return { ...rest, ambiguous: true, claimants };
  }
  return rest;
}

// Collapse ledger entries that share a sessionName (migration for ledgers written before the
// one-owner rule; also a defensive pass for every reader).
export function dedupeLedgerSessions(sessions) {
  const groups = new Map();
  for (const s of Array.isArray(sessions) ? sessions : []) {
    const name = sessionNameOf(s?.sessionName);
    if (!name || typeof s?.agentId !== "string" || typeof s?.cwd !== "string") continue;
    const entry = { ...s, sessionName: name };
    const g = groups.get(name);
    if (g) g.push(entry);
    else groups.set(name, [entry]);
  }
  return [...groups.values()].map(pickOwner);
}

function isSnapshotEligibleAgent(row) {
  if (!row || typeof row.id !== "string" || !row.id) return false;
  if (row.host) return false; // local panes only
  if (row.id === "shell") return false;
  if (row.web || row.webPort || row.webOff || row.adapter === "web-external") return false;
  if (row.launchable === false) return false;
  return Array.isArray(row.panes);
}

function collectLiveSessionNames(rows, extraSessionNames) {
  const names = new Set();
  if (extraSessionNames) {
    for (const n of extraSessionNames) {
      const clean = sessionNameOf(String(n || ""));
      if (clean) names.add(clean);
    }
  }
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r?.host) continue;
    for (const p of Array.isArray(r?.panes) ? r.panes : []) {
      const sName = sessionNameOf(p?.session || p?.label);
      if (sName) names.add(sName);
    }
  }
  return names;
}

export function buildSnapshot(
  rows,
  prev = null,
  now = new Date().toISOString(),
  { liveSessionNames = null, ttlMs = SNAPSHOT_TTL_MS } = {}
) {
  const nowIso = toIso(now);
  const prevSessions = dedupeLedgerSessions(prev?.sessions);
  const prevByName = new Map(prevSessions.map((s) => [s.sessionName, s]));
  const allLiveNames = collectLiveSessionNames(rows, liveSessionNames);

  // claims per session name, in row (AGENT_DEFS) order
  const claimsByName = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!isSnapshotEligibleAgent(r)) continue;
    for (const p of r.panes) {
      if (!p || typeof p.cwd !== "string" || !p.cwd) continue;
      const sessionName = sessionNameOf(p.session || p.label);
      if (!sessionName) continue;
      const name = typeof p.name === "string" && p.name.trim() ? p.name.trim() : undefined;
      const claim = { agentId: r.id, cwd: p.cwd, name };
      const list = claimsByName.get(sessionName);
      if (list) list.push(claim);
      else claimsByName.set(sessionName, [claim]);
    }
  }

  const sessions = [];
  for (const [sessionName, claims] of claimsByName) {
    const prevEntry = prevByName.get(sessionName) || null;
    const firstSeen =
      typeof prevEntry?.firstSeen === "string" && prevEntry.firstSeen ? prevEntry.firstSeen : nowIso;
    const agents = [...new Set(claims.map((c) => c.agentId))];
    let ownerId;
    let ambiguous = false;
    if (prevEntry?.launched === true) {
      ownerId = prevEntry.agentId;
    } else {
      ownerId = claims[0].agentId;
      ambiguous = agents.length > 1;
    }
    const ownerClaim = claims.find((c) => c.agentId === ownerId) || null;
    const cwd = ownerClaim?.cwd || prevEntry?.cwd || claims[0].cwd;
    const name = ownerClaim?.name || claims.find((c) => c.name)?.name;
    sessions.push({
      agentId: ownerId,
      cwd,
      sessionName,
      ...(name ? { name } : {}),
      ...(prevEntry?.launched === true ? { launched: true } : {}),
      ...(ambiguous ? { ambiguous: true, claimants: agents } : {}),
      firstSeen,
      lastSeen: nowIso,
    });
  }

  for (const prevEntry of prevSessions) {
    const sessionName = prevEntry.sessionName;
    if (claimsByName.has(sessionName)) continue;
    const firstSeen =
      typeof prevEntry.firstSeen === "string" && prevEntry.firstSeen ? prevEntry.firstSeen : nowIso;
    const name = typeof prevEntry.name === "string" && prevEntry.name.trim() ? prevEntry.name.trim() : undefined;
    const keep = {
      agentId: prevEntry.agentId,
      cwd: prevEntry.cwd,
      sessionName,
      ...(name ? { name } : {}),
      ...(prevEntry.launched === true ? { launched: true } : {}),
      ...(prevEntry.ambiguous === true
        ? { ambiguous: true, ...(Array.isArray(prevEntry.claimants) ? { claimants: prevEntry.claimants } : {}) }
        : {}),
      firstSeen,
    };

    if (allLiveNames.has(sessionName)) {
      sessions.push({ ...keep, lastSeen: nowIso });
      continue;
    }

    const missingSince =
      typeof prevEntry.missingSince === "string" && prevEntry.missingSince ? prevEntry.missingSince : nowIso;
    const candidate = {
      ...keep,
      ...(typeof prevEntry.lastSeen === "string" && prevEntry.lastSeen ? { lastSeen: prevEntry.lastSeen } : {}),
      missingSince,
    };
    if (!isLedgerEntryEligible(candidate, nowIso, ttlMs)) continue;
    sessions.push(candidate);
  }

  return {
    savedAt: nowIso,
    host: typeof prev?.host === "string" && prev.host ? prev.host : hostname(),
    sessions,
  };
}

export function diffSnapshot(
  snapshot,
  liveRows,
  { liveSessionNames = null, now = Date.now(), ttlMs = SNAPSHOT_TTL_MS } = {}
) {
  const snapSessions = dedupeLedgerSessions(snapshot?.sessions).filter((s) =>
    isLedgerEntryEligible(s, now, ttlMs)
  );
  if (snapSessions.length === 0) return { missing: [], present: [] };

  const allLiveNames = collectLiveSessionNames(liveRows, liveSessionNames);
  const livePanes = [];
  for (const r of Array.isArray(liveRows) ? liveRows : []) {
    if (!isSnapshotEligibleAgent(r)) continue;
    for (const p of r.panes) {
      if (!p || typeof p.cwd !== "string") continue;
      livePanes.push({
        agentId: r.id,
        cwd: p.cwd,
        sessionName: sessionNameOf(p.session || p.label),
      });
    }
  }

  const usedLive = new Set();
  const matchedSnap = new Set();

  // Pass 1: exact sessionName match against live panes or tmux list-sessions
  snapSessions.forEach((s, sIdx) => {
    const sName = sessionNameOf(s?.sessionName);
    if (!sName) return;
    const lIdx = livePanes.findIndex((lp, idx) => !usedLive.has(idx) && lp.sessionName === sName);
    if (lIdx >= 0) {
      usedLive.add(lIdx);
      matchedSnap.add(sIdx);
    } else if (allLiveNames.has(sName)) {
      matchedSnap.add(sIdx);
    }
  });

  // Pass 2: (agentId, cwd) fallback for entries not yet marked missingSince in the ledger
  snapSessions.forEach((s, sIdx) => {
    if (matchedSnap.has(sIdx)) return;
    if (s?.missingSince) return;
    const lIdx = livePanes.findIndex(
      (lp, idx) => !usedLive.has(idx) && lp.agentId === s.agentId && lp.cwd === s.cwd
    );
    if (lIdx >= 0) {
      usedLive.add(lIdx);
      matchedSnap.add(sIdx);
    }
  });

  const missing = [];
  const present = [];
  snapSessions.forEach((s, sIdx) => {
    if (matchedSnap.has(sIdx)) present.push(s);
    else missing.push(s);
  });

  return { missing, present };
}

export function removeSnapshotSession(snapshot, sessionName, now = new Date().toISOString()) {
  const target = sessionNameOf(sessionName);
  const prevSessions = Array.isArray(snapshot?.sessions) ? snapshot.sessions : [];
  const nextSessions = target
    ? prevSessions.filter((s) => sessionNameOf(s?.sessionName) !== target)
    : [...prevSessions];
  return {
    savedAt: toIso(now),
    host: typeof snapshot?.host === "string" && snapshot.host ? snapshot.host : hostname(),
    sessions: nextSessions,
  };
}

export function replaceRestoredSession(
  snapshot,
  oldSessionName,
  newEntry,
  now = new Date().toISOString()
) {
  const nowIso = toIso(now);
  const prevSessions = dedupeLedgerSessions(snapshot?.sessions);
  const oldTarget = sessionNameOf(oldSessionName);
  let removedIdx = -1;
  if (oldTarget) {
    removedIdx = prevSessions.findIndex((s) => sessionNameOf(s?.sessionName) === oldTarget);
  }
  if (removedIdx < 0 && newEntry?.agentId && newEntry?.cwd) {
    removedIdx = prevSessions.findIndex(
      (s) => s?.missingSince && s.agentId === newEntry.agentId && s.cwd === newEntry.cwd
    );
  }
  if (removedIdx < 0 && newEntry?.agentId && newEntry?.cwd) {
    removedIdx = prevSessions.findIndex(
      (s) => s?.agentId === newEntry.agentId && s?.cwd === newEntry.cwd
    );
  }
  const removed = removedIdx >= 0 ? prevSessions.splice(removedIdx, 1)[0] : null;
  const newSessionName = sessionNameOf(newEntry?.sessionName);
  if (newSessionName && newEntry?.agentId && newEntry?.cwd) {
    const existingNewIdx = prevSessions.findIndex((s) => sessionNameOf(s?.sessionName) === newSessionName);
    const entryObj = {
      agentId: newEntry.agentId,
      cwd: newEntry.cwd,
      sessionName: newSessionName,
      ...(newEntry.name ? { name: newEntry.name } : removed?.name ? { name: removed.name } : {}),
      launched: true,
      firstSeen: removed?.firstSeen || newEntry.firstSeen || nowIso,
      lastSeen: nowIso,
    };
    if (existingNewIdx >= 0) {
      prevSessions[existingNewIdx] = entryObj;
    } else {
      prevSessions.push(entryObj);
    }
  }
  return {
    savedAt: nowIso,
    host: typeof snapshot?.host === "string" && snapshot.host ? snapshot.host : hostname(),
    sessions: prevSessions,
  };
}

export function dismissSnapshotSessions(
  snapshot,
  { dismiss = [], dismissAll = false, liveRows = [], liveSessionNames = null } = {},
  now = new Date().toISOString()
) {
  const nowIso = toIso(now);
  const prevSessions = Array.isArray(snapshot?.sessions) ? snapshot.sessions : [];
  let nextSessions = prevSessions;

  if (dismissAll) {
    const { missing } = diffSnapshot(snapshot, liveRows, { liveSessionNames });
    const missingNames = new Set(missing.map((m) => sessionNameOf(m?.sessionName)).filter(Boolean));
    nextSessions = prevSessions.filter(
      (s) => !s?.missingSince && !missingNames.has(sessionNameOf(s?.sessionName))
    );
  } else if (Array.isArray(dismiss) && dismiss.length > 0) {
    const targets = new Set(dismiss.map((d) => sessionNameOf(String(d || ""))).filter(Boolean));
    nextSessions = prevSessions.filter((s) => !targets.has(sessionNameOf(s?.sessionName)));
  }

  return {
    snapshot: {
      savedAt: nowIso,
      host: typeof snapshot?.host === "string" && snapshot.host ? snapshot.host : hostname(),
      sessions: nextSessions,
    },
    dismissed: prevSessions.length - nextSessions.length,
  };
}

export function readSnapshot(file) {
  if (!file || !existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.sessions)) return null;
    // migration: ledgers written before the one-owner rule can list a session once per claimant
    return { ...raw, sessions: dedupeLedgerSessions(raw.sessions) };
  } catch {
    return null;
  }
}

export function writeSnapshot(file, snapshot) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.mt3k-tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  try {
    writeFileSync(tmp, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
    renameSync(tmp, file);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}
