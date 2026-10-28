import assert from "node:assert/strict";
import test from "node:test";
import {
  accumulateWheelDelta,
  initialAltWheelSession,
  runAltWheelDrain,
  GESTURE_GAP_MS,
  normalizeWheelDeltaPx,
} from "../src/lib/alt-pane-wheel.ts";

test("drenaje único: dos eventos de 40px a 5ms con envío de 20ms respeta 40ms entre teclas", async () => {
  const session = initialAltWheelSession(1);
  const lh = 20;
  const sendTimes: number[] = [];
  const sendKey = async () => {
    sendTimes.push(Date.now());
    await new Promise((r) => setTimeout(r, 20));
  };
  accumulateWheelDelta(session, 40);
  void runAltWheelDrain(session, lh, sendKey, () => true);
  await new Promise((r) => setTimeout(r, 5));
  accumulateWheelDelta(session, 40);
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(sendTimes.length, 4, "80px / 20px por tecla → 4 envíos en un solo drenaje");
  for (let i = 1; i < sendTimes.length; i++) {
    assert.ok(sendTimes[i] - sendTimes[i - 1] >= 40, `gap ${sendTimes[i] - sendTimes[i - 1]} < 40`);
  }
  assert.equal(session.remainder, 0);
});

test("cleanup: generación nueva corta el drenaje", async () => {
  const session = initialAltWheelSession(1);
  let sends = 0;
  const sendKey = async () => {
    sends += 1;
    await new Promise((r) => setTimeout(r, 5));
  };
  accumulateWheelDelta(session, 200);
  void runAltWheelDrain(session, 20, sendKey, () => session.generation === 1);
  await new Promise((r) => setTimeout(r, 5));
  session.generation = 2;
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(sends <= 2, `expected early stop, got ${sends} sends`);
});

test("cupo por gesto: dos eventos separados 150ms reinician las 6 teclas", () => {
  const session = initialAltWheelSession(0);
  const t0 = 1_000_000;
  accumulateWheelDelta(session, 120, t0);
  assert.equal(session.gestureKeysLeft, 6);
  accumulateWheelDelta(session, 120, t0 + GESTURE_GAP_MS + 1);
  assert.equal(session.gestureKeysLeft, 6);
});

test("normalizeWheelDeltaPx convierte líneas y páginas", () => {
  assert.equal(normalizeWheelDeltaPx(3, 0, 16, 800), 3);
  assert.equal(normalizeWheelDeltaPx(2, 1, 13, 800), 26);
  assert.equal(normalizeWheelDeltaPx(1, 2, 13, 800), 800);
});
