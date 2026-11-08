import assert from "node:assert/strict";
import test from "node:test";
import { chunkPlan, exitCodeForResult, parsePromptArgs, parseWaitArgs, runChunkedWait } from "../lib/wait-cli.mjs";

test("parseWaitArgs parses defaults, env vars, and explicit flags", () => {
  const def = parseWaitArgs(["%3"], {});
  assert.deepEqual(def, {
    ok: true,
    help: false,
    paneId: "%3",
    until: "not-working",
    timeout: 180,
    host: "",
    url: "http://localhost:4288",
    token: "",
  });

  const fromEnv = parseWaitArgs(["%7", "--until", "changed", "--timeout=45", "--host", "mondo"], {
    MT3K_URL: "http://10.0.0.1:4288/",
    MT3K_TOKEN: "sec-123",
  });
  assert.deepEqual(fromEnv, {
    ok: true,
    help: false,
    paneId: "%7",
    until: "changed",
    timeout: 45,
    host: "mondo",
    url: "http://10.0.0.1:4288",
    token: "sec-123",
  });

  const override = parseWaitArgs(["%1", "--url", "http://localhost:4299/", "--token", "tok"], {
    MT3K_URL: "http://10.0.0.1:4288",
    MT3K_TOKEN: "env-tok",
  });
  assert.equal(override.url, "http://localhost:4299");
  assert.equal(override.token, "tok");
});

test("parseWaitArgs handles --help and rejects invalid arguments", () => {
  const help = parseWaitArgs(["--help"], {});
  assert.equal(help.ok, true);
  assert.equal(help.help, true);

  assert.equal(parseWaitArgs([], {}).ok, false);
  assert.equal(parseWaitArgs(["%1", "%2"], {}).ok, false);
  assert.equal(parseWaitArgs(["%1", "--until", "invalid"], {}).ok, false);
  assert.equal(parseWaitArgs(["%1", "--timeout", "0"], {}).ok, false);
  assert.equal(parseWaitArgs(["%1", "--unknown", "1"], {}).ok, false);
});

test("parsePromptArgs joins text words and parses flags", () => {
  const res = parsePromptArgs(["%5", "sleep 3;", "echo hola", "--until", "not-working", "--timeout", "30"], {});
  assert.deepEqual(res, {
    ok: true,
    help: false,
    paneId: "%5",
    text: "sleep 3; echo hola",
    enter: true,
    until: "not-working",
    timeout: 30,
    host: "",
    url: "http://localhost:4288",
    token: "",
  });

  const noEnter = parsePromptArgs(["%5", "--no-enter", "--", "-ls", "-la"], {});
  assert.equal(noEnter.ok, true);
  assert.equal(noEnter.enter, false);
  assert.equal(noEnter.text, "-ls -la");

  assert.equal(parsePromptArgs(["%5"], {}).ok, false);
  assert.equal(parsePromptArgs(["--help"], {}).help, true);
});

test("exitCodeForResult maps reached/timeout/gone/error to 0/2/3/1", () => {
  assert.equal(exitCodeForResult(true, { ok: true, reason: "reached" }), 0);
  assert.equal(exitCodeForResult(true, { ok: true, reason: "timeout" }), 2);
  assert.equal(exitCodeForResult(true, { ok: true, reason: "gone" }), 3);
  assert.equal(exitCodeForResult(true, { ok: false, reason: "reached" }), 1);
  assert.equal(exitCodeForResult(false, { ok: true, reason: "reached" }), 1);
  assert.equal(exitCodeForResult(true, null), 1);
});

test("chunkPlan splits totalSeconds into <= 240s chunks", () => {
  assert.deepEqual(chunkPlan(180), [180]);
  assert.deepEqual(chunkPlan(240), [240]);
  assert.deepEqual(chunkPlan(241), [240, 1]);
  assert.deepEqual(chunkPlan(400), [240, 160]);
  assert.deepEqual(chunkPlan(600), [240, 240, 120]);
});

test("runChunkedWait chains chunks, forwards baseline across chunks, and reports wall-clock waitedMs", async () => {
  const calls = [];
  let t = 0;
  const res = await runChunkedWait({
    totalSeconds: 400,
    chunkSeconds: 240,
    now: () => t,
    requestChunk: async ({ chunkSec, chunkIndex, baseline }) => {
      calls.push({ chunkSec, chunkIndex, baseline });
      t += chunkIndex === 0 ? 240_000 : 12_000;
      if (chunkIndex === 0) {
        return {
          ok: true,
          status: 200,
          data: {
            ok: true,
            paneId: "%3",
            status: "working",
            statusRule: "spinner",
            reason: "timeout",
            waitedMs: 240_000,
            tail: "still working",
          },
        };
      }
      return {
        ok: true,
        status: 200,
        data: {
          ok: true,
          paneId: "%3",
          status: "idle",
          statusRule: "prompt",
          reason: "reached",
          waitedMs: 12_000,
          tail: "done!",
        },
      };
    },
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { chunkSec: 240, chunkIndex: 0, baseline: null });
  assert.deepEqual(calls[1], { chunkSec: 160, chunkIndex: 1, baseline: "working" });
  assert.equal(res.ok, true);
  assert.equal(res.data.reason, "reached");
  assert.equal(res.data.waitedMs, 252_000);
});

test("runChunkedWait forwards sawWorking once a chunk reports it", async () => {
  const seen = [];
  const res = await runChunkedWait({
    totalSeconds: 600,
    chunkSeconds: 240,
    requestChunk: async ({ chunkIndex, sawWorking }) => {
      seen.push(sawWorking);
      const reason = chunkIndex < 2 ? "timeout" : "reached";
      return {
        ok: true,
        status: 200,
        data: { ok: true, status: chunkIndex === 0 ? "working" : "idle", reason, waitedMs: 1, sawWorking: chunkIndex === 0 },
      };
    },
  });
  assert.deepEqual(seen, [false, true, true]);
  assert.equal(res.data.reason, "reached");
});

test("runChunkedWait carries one wall-clock deadline: request overhead shrinks later chunks (P4)", async () => {
  let t = 0;
  const calls = [];
  const res = await runChunkedWait({
    totalSeconds: 400,
    now: () => t,
    requestChunk: async ({ chunkSec }) => {
      calls.push({ chunkSec, start: t });
      t += (chunkSec + 10) * 1000; // 10 s of network/refresh overhead per chunk
      return { ok: true, status: 200, data: { ok: true, reason: "timeout", status: "working", waitedMs: (chunkSec + 10) * 1000 } };
    },
  });
  assert.deepEqual(calls, [
    { chunkSec: 240, start: 0 },
    { chunkSec: 150, start: 250_000 },
  ]);
  assert.equal(res.data.reason, "timeout");
  assert.equal(res.data.waitedMs, 410_000); // only the last request's own overhead runs past 400 s
});

test("runChunkedWait never issues more chunks than the fixed plan when the clock does not move", async () => {
  let n = 0;
  const res = await runChunkedWait({
    totalSeconds: 400,
    now: () => 0,
    requestChunk: async () => {
      n++;
      return { ok: true, status: 200, data: { ok: true, reason: "timeout", status: "working", waitedMs: 5 } };
    },
  });
  assert.equal(n, 2);
  assert.equal(res.data.reason, "timeout");
});

test("R1: a chunk answering `reached` after the overall deadline becomes timeout (status kept)", async () => {
  let t = 0;
  const calls = [];
  const res = await runChunkedWait({
    totalSeconds: 400,
    now: () => t,
    requestChunk: async (p) => {
      calls.push(p.chunkSec);
      t += (p.chunkSec + 10) * 1000;
      return { ok: true, data: { ok: true, reason: p.isFirst ? "timeout" : "reached", status: "idle" } };
    },
  });
  assert.deepEqual(calls, [240, 150]);
  assert.equal(res.ok, true);
  assert.equal(res.data.reason, "timeout");
  assert.equal(res.data.status, "idle");
  assert.equal(res.data.waitedMs, 410_000);
  assert.equal(exitCodeForResult(Boolean(res.ok), res.data), 2);
});

test("R1: the last chunk uses the full fractional remainder (ceil), so the whole budget is covered", async () => {
  let t = 0;
  const calls = [];
  const res = await runChunkedWait({
    totalSeconds: 400,
    now: () => t,
    requestChunk: async (p) => {
      calls.push(p.chunkSec);
      t += p.chunkSec * 1000 + 123;
      return { ok: true, data: { ok: true, reason: "timeout" } };
    },
  });
  assert.deepEqual(calls, [240, 160]);
  assert.equal(res.data.reason, "timeout");
  assert.ok(res.data.waitedMs >= 400_000, `waited ${res.data.waitedMs}`);
});

test("a chunk that reaches the condition before the deadline still returns reached", async () => {
  let t = 0;
  const res = await runChunkedWait({
    totalSeconds: 10,
    now: () => t,
    requestChunk: async () => { t += 4000; return { ok: true, data: { ok: true, reason: "reached", status: "idle" } }; },
  });
  assert.equal(res.data.reason, "reached");
  assert.equal(res.data.waitedMs, 4000);
});
