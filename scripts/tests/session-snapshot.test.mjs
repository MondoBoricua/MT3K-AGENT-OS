import assert from "node:assert/strict";
import test from "node:test";
import {
  SNAPSHOT_TTL_MS,
  buildSnapshot,
  diffSnapshot,
  dismissSnapshotSessions,
  isLedgerEntryEligible,
  readSnapshot,
  removeSnapshotSession,
  replaceRestoredSession,
} from "../lib/session-snapshot.mjs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("buildSnapshot captures local launchable agents only and upserts firstSeen/lastSeen", () => {
  const t1 = "2026-11-07T10:00:00.000Z";
  const t2 = "2026-11-07T10:05:00.000Z";
  const rows1 = [
    {
      id: "claude",
      launchable: true,
      panes: [
        { paneId: "%1", label: "mt3k-claude-repo-a-111:0.0", cwd: "~/repo-a", name: "revisor" },
      ],
    },
    {
      id: "shell",
      launchable: true,
      panes: [{ paneId: "%2", label: "mt3k-shell-home-222:0.0", cwd: "~" }],
    },
    {
      id: "deepseek",
      launchable: false,
      web: 3080,
      panes: [],
    },
    {
      id: "codex",
      host: "mondo",
      launchable: true,
      panes: [{ paneId: "%3", label: "mt3k-codex-remote-333:0.0", cwd: "~/remote" }],
    },
  ];

  const snap1 = buildSnapshot(rows1, { host: "mac-local", sessions: [] }, t1);
  assert.equal(snap1.savedAt, t1);
  assert.equal(snap1.host, "mac-local");
  assert.deepEqual(snap1.sessions, [
    {
      agentId: "claude",
      cwd: "~/repo-a",
      sessionName: "mt3k-claude-repo-a-111",
      name: "revisor",
      firstSeen: t1,
      lastSeen: t1,
    },
  ]);

  const rows2 = [
    {
      id: "claude",
      launchable: true,
      panes: [
        { paneId: "%1", label: "mt3k-claude-repo-a-111:0.0", cwd: "~/repo-a", name: "revisor" },
      ],
    },
    {
      id: "codex",
      launchable: true,
      panes: [{ paneId: "%4", label: "mt3k-codex-repo-b-444:0.0", cwd: "~/repo-b" }],
    },
  ];

  const snap2 = buildSnapshot(rows2, snap1, t2);
  assert.equal(snap2.savedAt, t2);
  assert.equal(snap2.sessions.length, 2);
  assert.equal(snap2.sessions[0].firstSeen, t1);
  assert.equal(snap2.sessions[0].lastSeen, t2);
  assert.equal(snap2.sessions[1].firstSeen, t2);
  assert.equal(snap2.sessions[1].lastSeen, t2);
  assert.equal("name" in snap2.sessions[1], false);
});

test("ledger persists missing entries across a new session launch after reboot", () => {
  const tBefore = "2026-11-07T09:00:00.000Z";
  const tAfterReboot = "2026-11-07T10:00:00.000Z";

  const prevSnap = {
    savedAt: tBefore,
    host: "mac-local",
    sessions: [
      {
        agentId: "claude",
        cwd: "~/repo-a",
        sessionName: "mt3k-claude-repo-a-111",
        name: "revisor",
        firstSeen: tBefore,
        lastSeen: tBefore,
      },
      {
        agentId: "codex",
        cwd: "~/repo-b",
        sessionName: "mt3k-codex-repo-b-222",
        firstSeen: tBefore,
        lastSeen: tBefore,
      },
    ],
  };

  // After reboot, user launches a single new session in ~/repo-c; both previous sessions must stay in ledger with missingSince!
  const liveAfterOneLaunch = [
    {
      id: "claude",
      launchable: true,
      panes: [{ paneId: "%1", label: "mt3k-claude-repo-c-999:0.0", cwd: "~/repo-c" }],
    },
  ];

  const nextSnap = buildSnapshot(liveAfterOneLaunch, prevSnap, tAfterReboot);
  assert.equal(nextSnap.sessions.length, 3);
  const diff = diffSnapshot(nextSnap, liveAfterOneLaunch);
  assert.equal(diff.present.length, 1);
  assert.equal(diff.present[0].sessionName, "mt3k-claude-repo-c-999");
  assert.equal(diff.missing.length, 2);
  assert.deepEqual(
    diff.missing.map((m) => m.sessionName),
    ["mt3k-claude-repo-a-111", "mt3k-codex-repo-b-222"]
  );
  assert.equal(diff.missing[0].missingSince, tAfterReboot);
  assert.equal(diff.missing[1].missingSince, tAfterReboot);
});

test("removeSnapshotSession removes killed session even when it is the last session", () => {
  const snap = {
    savedAt: "2026-11-07T10:00:00.000Z",
    host: "mac-local",
    sessions: [
      {
        agentId: "claude",
        cwd: "~/repo-a",
        sessionName: "mt3k-claude-repo-a-111",
        firstSeen: "2026-11-07T09:00:00.000Z",
        lastSeen: "2026-11-07T10:00:00.000Z",
      },
    ],
  };

  const afterKill = removeSnapshotSession(snap, "mt3k-claude-repo-a-111:0.0", "2026-11-07T10:01:00.000Z");
  assert.equal(afterKill.sessions.length, 0);
  const diff = diffSnapshot(afterKill, []);
  assert.equal(diff.missing.length, 0);
  assert.equal(diff.present.length, 0);
});

test("replaceRestoredSession, dismissSnapshotSessions, TTL pruning, and unattributed live tmux session", () => {
  const t0 = "2026-11-01T00:00:00.000Z";
  const tExpired = new Date(Date.parse(t0) + SNAPSHOT_TTL_MS + 1000).toISOString();

  const snapWithOldMissing = {
    savedAt: t0,
    host: "mac-local",
    sessions: [
      {
        agentId: "claude",
        cwd: "~/old",
        sessionName: "mt3k-claude-old-1",
        firstSeen: t0,
        lastSeen: t0,
        missingSince: t0,
      },
      {
        agentId: "codex",
        cwd: "~/fresh",
        sessionName: "mt3k-codex-fresh-2",
        firstSeen: t0,
        lastSeen: t0,
        missingSince: tExpired,
      },
    ],
  };

  const pruned = buildSnapshot([], snapWithOldMissing, tExpired);
  assert.deepEqual(
    pruned.sessions.map((s) => s.sessionName),
    ["mt3k-codex-fresh-2"]
  );

  // Replace restored session
  const replaced = replaceRestoredSession(
    pruned,
    "mt3k-codex-fresh-2",
    {
      agentId: "codex",
      cwd: "~/fresh",
      sessionName: "mt3k-codex-fresh-new",
      name: "restaurado",
      firstSeen: t0,
    },
    tExpired
  );
  assert.equal(replaced.sessions.length, 1);
  assert.equal(replaced.sessions[0].sessionName, "mt3k-codex-fresh-new");
  assert.equal(replaced.sessions[0].name, "restaurado");

  // Unattributed live pane: session is in liveSessionNames (tmux list-sessions) even though liveRows is empty
  const diffUnattributed = diffSnapshot(replaced, [], {
    liveSessionNames: new Set(["mt3k-codex-fresh-new"]),
  });
  assert.equal(diffUnattributed.present.length, 1);
  assert.equal(diffUnattributed.missing.length, 0);

  // Dismiss specific or all missing sessions
  const dismissedOne = dismissSnapshotSessions(
    replaced,
    { dismiss: ["mt3k-codex-fresh-new"], liveRows: [] },
    tExpired
  );
  assert.equal(dismissedOne.dismissed, 1);
  assert.equal(dismissedOne.snapshot.sessions.length, 0);

  const dismissedAll = dismissSnapshotSessions(
    replaced,
    { dismissAll: true, liveRows: [] },
    tExpired
  );
  assert.equal(dismissedAll.dismissed, 1);
  assert.equal(dismissedAll.snapshot.sessions.length, 0);
});

test("buildSnapshot keeps ONE entry per physical session; two unknown claimants → ambiguous (P2)", () => {
  const row = (id) => ({ id, launchable: true, panes: [{ paneId: "%0", label: "shared:0.0", cwd: "~/repo" }] });
  const snap = buildSnapshot([row("claude"), row("antigravity")], null, "2026-11-08T00:00:00Z");
  assert.equal(snap.sessions.length, 1);
  assert.equal(snap.sessions[0].agentId, "claude");
  assert.equal(snap.sessions[0].ambiguous, true);
  assert.deepEqual(snap.sessions[0].claimants, ["claude", "antigravity"]);
  // one claimant only → not ambiguous
  const single = buildSnapshot([row("codex")], null, "2026-11-08T00:00:00Z");
  assert.equal(single.sessions.length, 1);
  assert.equal(single.sessions[0].ambiguous, undefined);
});

test("buildSnapshot keeps the panel-launched agent as owner even when another agent claims the pane", () => {
  const prev = {
    sessions: [
      { agentId: "codex", cwd: "~/repo", sessionName: "mt3k-codex-repo-abc", launched: true, firstSeen: "2026-11-07T00:00:00Z" },
    ],
  };
  const row = (id) => ({ id, launchable: true, panes: [{ paneId: "%3", label: "mt3k-codex-repo-abc:0.0", cwd: "~/repo" }] });
  const snap = buildSnapshot([row("claude"), row("codex")], prev, "2026-11-08T00:00:00Z");
  assert.equal(snap.sessions.length, 1);
  assert.equal(snap.sessions[0].agentId, "codex");
  assert.equal(snap.sessions[0].launched, true);
  assert.equal(snap.sessions[0].ambiguous, undefined);
  assert.equal(snap.sessions[0].firstSeen, "2026-11-07T00:00:00Z");
});

test("readSnapshot migrates a ledger with duplicate session names (launch owner wins, else first + ambiguous)", () => {
  const dir = mkdtempSync(join(tmpdir(), "mt3k-snap-"));
  try {
    const file = join(dir, "session-snapshot.json");
    writeFileSync(
      file,
      JSON.stringify({
        savedAt: "2026-11-08T00:00:00Z",
        host: "h",
        sessions: [
          { agentId: "claude", cwd: "~/a", sessionName: "dup-1", firstSeen: "x" },
          { agentId: "codex", cwd: "~/a", sessionName: "dup-1", firstSeen: "x" },
          { agentId: "claude", cwd: "~/b", sessionName: "dup-2" },
          { agentId: "codex", cwd: "~/b", sessionName: "dup-2", launched: true },
          { agentId: "claude", cwd: "~/c", sessionName: "dup-3" },
          { agentId: "claude", cwd: "~/c", sessionName: "dup-3" },
        ],
      })
    );
    const snap = readSnapshot(file);
    assert.equal(snap.sessions.length, 3);
    const byName = Object.fromEntries(snap.sessions.map((s) => [s.sessionName, s]));
    assert.equal(byName["dup-1"].agentId, "claude");
    assert.equal(byName["dup-1"].ambiguous, true);
    assert.equal(byName["dup-2"].agentId, "codex");
    assert.equal(byName["dup-2"].ambiguous, undefined);
    assert.equal(byName["dup-3"].agentId, "claude");
    assert.equal(byName["dup-3"].ambiguous, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TTL applies on read: an expired entry is never planned before the writer prunes it (P3)", () => {
  const old = {
    sessions: [
      { agentId: "claude", cwd: "~/repo", sessionName: "missing-B", missingSince: "2026-10-01T00:00:00Z" },
      { agentId: "claude", cwd: "~/repo2", sessionName: "recent", missingSince: "2026-11-07T00:00:00Z" },
    ],
  };
  const now = Date.parse("2026-11-08T00:00:00Z");
  const { missing } = diffSnapshot(old, [], { now });
  assert.deepEqual(missing.map((m) => m.sessionName), ["recent"]);
  assert.equal(isLedgerEntryEligible(old.sessions[0], now), false);
  assert.equal(isLedgerEntryEligible(old.sessions[1], now), true);
  assert.equal(isLedgerEntryEligible({ agentId: "claude", cwd: "~/x", sessionName: "live" }, now), true);
  assert.equal(isLedgerEntryEligible({ agentId: "claude", cwd: "", sessionName: "x" }, now), false);
  assert.equal(buildSnapshot([], old, "2026-11-08T00:00:00Z").sessions.length, 1);
});
