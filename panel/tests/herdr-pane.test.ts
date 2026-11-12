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

import { HERDR_NOT_KILLABLE_TITLE, herdrChoice, isPaneKillable } from "../src/lib/herdr-pane.ts";

test("isPaneKillable: tmux siempre; Herdr solo si el servidor lo marcó killable", () => {
  assert.equal(isPaneKillable({ paneId: "%3" }), true);
  assert.equal(isPaneKillable({ paneId: "hc:t9", backend: "herdr" }), false);
  assert.equal(isPaneKillable({ paneId: "hc:t9", backend: "herdr", killable: false }), false);
  assert.equal(isPaneKillable({ paneId: "hc:t9", backend: "herdr", killable: true }), true);
  assert.equal(isPaneKillable({ paneId: "hc:t9", killable: true }), true);
  assert.equal(isPaneKillable(null), true);
  assert.match(HERDR_NOT_KILLABLE_TITLE, /panel/);
});

test("herdrChoice: sin instalar = deshabilitado con aviso; instalado sin core = habilitado con aviso; corriendo = sin aviso", () => {
  assert.deepEqual(herdrChoice(null), { disabled: true, hint: "Herdr no está instalado en este host" });
  assert.deepEqual(herdrChoice({ installed: false, running: false, app: false }), { disabled: true, hint: "Herdr no está instalado en este host" });
  assert.deepEqual(herdrChoice({ installed: true, running: false, app: false }), { disabled: false, hint: "Herdr no está corriendo: se abrirá en tmux hasta que lo abras" });
  assert.deepEqual(herdrChoice({ installed: true, running: true, app: true }), { disabled: false, hint: "" });
});
