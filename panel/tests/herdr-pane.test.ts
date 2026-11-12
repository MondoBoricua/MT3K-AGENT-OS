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

import { KILL_CONFIRM_HERDR_FOREIGN, KILL_CONFIRM_HERDR_OWNED, KILL_CONFIRM_TMUX, herdrChoice, killPlan, needsForceRetry } from "../src/lib/herdr-pane.ts";

test("killPlan: tmux y Herdr del panel = confirmación normal sin force; Herdr ajeno = confirmación aparte con force", () => {
  assert.deepEqual(killPlan({ paneId: "%3" }), { confirm: KILL_CONFIRM_TMUX, force: false, title: "matar esta sesión de tmux" });
  assert.deepEqual(killPlan({ paneId: "hc:t9", backend: "herdr", killable: true }), { confirm: KILL_CONFIRM_HERDR_OWNED, force: false, title: "cerrar esta terminal de Herdr" });
  for (const p of [{ paneId: "hc:t9", backend: "herdr" }, { paneId: "hc:t9", backend: "herdr", killable: false }, { paneId: "hc:t9" }]) {
    assert.deepEqual(killPlan(p), { confirm: KILL_CONFIRM_HERDR_FOREIGN, force: true, title: "cerrar esta terminal de Herdr (no la abrió el panel)" });
  }
  assert.equal(KILL_CONFIRM_HERDR_FOREIGN, "Esta terminal la abriste tú en Herdr, no el panel. ¿Cerrarla de todos modos?");
  assert.equal(killPlan(null).force, false);
});

test("needsForceRetry: solo si se mandó sin force y el servidor pide confirmar", () => {
  assert.equal(needsForceRetry({ ok: false, needsConfirm: true }, false), true);
  assert.equal(needsForceRetry({ ok: false, needsConfirm: true }, true), false);
  assert.equal(needsForceRetry({ ok: false }, false), false);
  assert.equal(needsForceRetry({ ok: true, needsConfirm: true }, false), false);
  assert.equal(needsForceRetry(null, false), false);
});

test("herdrChoice: sin instalar = deshabilitado con aviso; instalado sin core = habilitado con aviso; corriendo = sin aviso", () => {
  assert.deepEqual(herdrChoice(null), { disabled: true, hint: "" }); // aún cargando
  assert.deepEqual(herdrChoice(undefined), { disabled: true, hint: "" });
  assert.deepEqual(herdrChoice({ installed: false, running: false, app: false }), { disabled: true, hint: "Herdr no está instalado en este host" });
  assert.deepEqual(herdrChoice({ installed: true, running: false, app: false }), { disabled: false, hint: "Herdr no está corriendo: se abrirá en tmux hasta que lo abras" });
  assert.deepEqual(herdrChoice({ installed: true, running: true, app: true }), { disabled: false, hint: "" });
});
