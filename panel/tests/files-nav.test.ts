import assert from "node:assert/strict";
import test from "node:test";
import { decideLinkRequest, hostEffectAction, pendingAfterManualHost } from "../src/lib/files-nav.ts";

const base = { mounted: true, host: "", wantHost: "remote", path: "/r.txt", dirty: true };

test("dirty buffer + other host + user accepts: asked exactly once, switch queued with the discard already approved", () => {
  let asked = 0;
  const d = decideLinkRequest({ ...base, confirm: () => { asked++; return true; } });
  assert.equal(asked, 1);
  assert.deepEqual(d, { action: "queue", switchHost: true, pending: { path: "/r.txt", host: "remote", approved: true } });
});

test("dirty buffer + other host + user cancels: request dropped, nothing queued (buffer and host stay)", () => {
  let asked = 0;
  const d = decideLinkRequest({ ...base, confirm: () => { asked++; return false; } });
  assert.equal(asked, 1);
  assert.deepEqual(d, { action: "drop" });
});

test("clean buffer never asks; same host opens now (openAt asks about edits itself); first mount queues", () => {
  const never = () => { throw new Error("confirm called"); };
  assert.deepEqual(decideLinkRequest({ ...base, dirty: false, confirm: never }), { action: "queue", switchHost: true, pending: { path: "/r.txt", host: "remote", approved: false } });
  assert.deepEqual(decideLinkRequest({ ...base, wantHost: "", confirm: never }), { action: "open-now" });
  assert.deepEqual(decideLinkRequest({ ...base, mounted: false, wantHost: "", dirty: false, confirm: never }), { action: "queue", switchHost: false, pending: { path: "/r.txt", host: "", approved: false } });
});

test("host effect: waits for the queued switch, opens when hosts match, loads the remembered folder with nothing pending", () => {
  const p = { path: "/r.txt", host: "remote", approved: true };
  assert.equal(hostEffectAction(p, ""), "wait");
  assert.equal(hostEffectAction(p, "remote"), "open");
  assert.equal(hostEffectAction(null, "remote"), "load-start");
});

test("manual host pick while a link open is pending drops it, so the picked host loads normally", () => {
  const p = { path: "/r.txt", host: "remote", approved: false };
  assert.equal(pendingAfterManualHost(p, "other"), null);
  assert.equal(hostEffectAction(pendingAfterManualHost(p, "other"), "other"), "load-start");
  assert.equal(pendingAfterManualHost(p, "remote"), p);
  assert.equal(pendingAfterManualHost(null, "x"), null);
});
