import assert from "node:assert/strict";
import test from "node:test";
import { paneStatus, statusLabel, statusTone } from "../src/lib/pane-status.ts";

test("paneStatus returns known server status directly", () => {
  assert.equal(paneStatus({ status: "working", waiting: false }), "working");
  assert.equal(paneStatus({ status: "working", waiting: true }), "working");
  assert.equal(paneStatus({ status: "blocked", waiting: false }), "blocked");
  assert.equal(paneStatus({ status: "idle", waiting: false }), "idle");
  assert.equal(paneStatus({ status: "done", waiting: false }), "done");
});

test("paneStatus falls back to waiting or unknown when status is missing", () => {
  assert.equal(paneStatus({ waiting: true }), "blocked");
  assert.equal(paneStatus({ waiting: false }), "unknown");
  assert.equal(paneStatus({}), "unknown");
});

test("statusLabel and statusTone map all PaneStatus values", () => {
  assert.equal(statusLabel("working"), "● trabajando");
  assert.equal(statusLabel("blocked"), "⏳ esperando input");
  assert.equal(statusLabel("done"), "✓ terminó");
  assert.equal(statusLabel("idle"), "○ idle");
  assert.equal(statusLabel("unknown"), "○ sin estado");

  assert.equal(statusTone("working"), "emerald");
  assert.equal(statusTone("blocked"), "amber");
  assert.equal(statusTone("done"), "sky");
  assert.equal(statusTone("idle"), "muted");
  assert.equal(statusTone("unknown"), "muted");
});
