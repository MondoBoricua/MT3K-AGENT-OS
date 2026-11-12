import test from "node:test";
import assert from "node:assert/strict";
import { HERDR_UNAVAILABLE_TITLE, isHerdrPane, isHerdrPaneId } from "../src/lib/herdr-pane.ts";

test("isHerdrPaneId: solo ids hc:", () => {
  assert.equal(isHerdrPaneId("hc:t9"), true);
  assert.equal(isHerdrPaneId("%12"), false);
  assert.equal(isHerdrPaneId("mt3k-claude-x:0.0"), false);
  assert.equal(isHerdrPaneId(undefined), false);
  assert.equal(isHerdrPaneId(null), false);
});

test("isHerdrPane: backend herdr o id hc:; los panes tmux no", () => {
  assert.equal(isHerdrPane({ backend: "herdr", paneId: "hc:t9" }), true);
  assert.equal(isHerdrPane({ paneId: "hc:t4" }), true);
  assert.equal(isHerdrPane({ paneId: "%3" }), false);
  assert.equal(isHerdrPane(null), false);
  assert.match(HERDR_UNAVAILABLE_TITLE, /Herdr/);
});
