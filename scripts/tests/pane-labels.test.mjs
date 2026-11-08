import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyLabels, labelKey, readLabels, sanitizePaneLabel, writeLabels } from "../lib/pane-labels.mjs";

test("labelKey normalizes sessionName whether or not window.pane is attached", () => {
  assert.equal(
    labelKey("claude", "~/repo", "mt3k-claude-repo-abc"),
    "claude|~/repo|mt3k-claude-repo-abc"
  );
  assert.equal(
    labelKey("claude", "~/repo", "mt3k-claude-repo-abc:0.0"),
    "claude|~/repo|mt3k-claude-repo-abc"
  );
});

test("readLabels and writeLabels persist atomically and drop empty labels", () => {
  const dir = mkdtempSync(join(tmpdir(), "mt3k-labels-"));
  try {
    const file = join(dir, "pane-labels.json");
    assert.deepEqual(readLabels(file), {});

    const k1 = labelKey("claude", "~/repo", "mt3k-claude-repo-111");
    const k2 = labelKey("codex", "~/other", "mt3k-codex-other-222");
    writeLabels(file, {
      [k1]: { label: "revisor", at: "2026-11-07T10:00:00.000Z" },
      [k2]: { label: "   ", at: "2026-11-07T10:00:00.000Z" },
    });

    const loaded = readLabels(file);
    assert.deepEqual(loaded, {
      [k1]: { label: "revisor", at: "2026-11-07T10:00:00.000Z" },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applyLabels attaches name to matching panes and clears removed labels", () => {
  const k = labelKey("claude", "~/repo", "mt3k-claude-repo-111");
  const rows = [
    {
      id: "claude",
      panes: [
        { paneId: "%1", label: "mt3k-claude-repo-111:0.0", window: "0", cwd: "~/repo" },
        { paneId: "%2", label: "mt3k-claude-repo-222:0.0", window: "0", cwd: "~/repo", name: "stale" },
      ],
    },
  ];

  applyLabels(rows, { [k]: { label: "ejecutor del mosaico", at: "2026-11-07T12:00:00.000Z" } });
  assert.equal(rows[0].panes[0].name, "ejecutor del mosaico");
  assert.equal(rows[0].panes[1].name, undefined);
});

test("sanitizePaneLabel strips control chars, collapses whitespace, trims, and rejects >40 chars", () => {
  assert.deepEqual(sanitizePaneLabel("  revisor\n\tdel   mosaico\x07 "), {
    ok: true,
    name: "revisor del mosaico",
  });
  assert.deepEqual(sanitizePaneLabel("   \n\t\x00  "), { ok: true, name: "" });
  assert.deepEqual(sanitizePaneLabel("a".repeat(40)), { ok: true, name: "a".repeat(40) });
  const tooLong = sanitizePaneLabel("a".repeat(41));
  assert.equal(tooLong.ok, false);
});
