import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPasteToPane, makeBufferName } from "./tmux-paste.mjs";

/** run falso que registra cada invocación para asserts unitarios. */
function captureRun(handler) {
  const calls = [];
  const run = async (cmd, args, cwd, timeoutMs) => {
    calls.push({ cmd, args, cwd, timeoutMs });
    if (handler) return handler(calls.length, { cmd, args });
    return { ok: true, out: "", err: "" };
  };
  return { run, calls };
}

test("makeBufferName: 1000 llamadas producen 1000 nombres distintos", () => {
  const seen = new Set();
  for (let i = 0; i < 1000; i++) {
    const name = makeBufferName(42, i + 1);
    assert.match(name, /^mt3k_send_42_\d+_[0-9a-f]{4}$/);
    seen.add(name);
  }
  assert.equal(seen.size, 1000);
});

test("set-buffer y paste-buffer del mismo envío comparten el nombre único", async () => {
  const { run, calls } = captureRun();
  const paste = createPasteToPane({ run, cwd: "/tmp" });
  await paste("%0", "hola", false);
  const setCall = calls.find((c) => c.args.includes("set-buffer"));
  const pasteCall = calls.find((c) => c.args.includes("paste-buffer"));
  assert.ok(setCall && pasteCall);
  const bufSet = setCall.args[setCall.args.indexOf("-b") + 1];
  const bufPaste = pasteCall.args[pasteCall.args.indexOf("-b") + 1];
  assert.equal(bufSet, bufPaste);
  assert.notEqual(bufSet, "mt3k_send");
});

test("paste-buffer lleva -d y -p", async () => {
  const { run, calls } = captureRun();
  const paste = createPasteToPane({ run, cwd: "/x" });
  await paste("%1", "t", false);
  const pasteCall = calls.find((c) => c.args.includes("paste-buffer"));
  assert.ok(pasteCall.args.includes("-d"));
  assert.ok(pasteCall.args.includes("-p"));
});

test("enter=true envía send-keys Enter después del paste", async () => {
  const { run, calls } = captureRun();
  const paste = createPasteToPane({ run, cwd: "/x" });
  await paste("%2", "t", true);
  const enterCall = calls.find((c) => c.args[0] === "send-keys" && c.args.includes("Enter"));
  assert.ok(enterCall);
  const pasteIdx = calls.findIndex((c) => c.args.includes("paste-buffer"));
  const enterIdx = calls.findIndex((c) => c === enterCall);
  assert.ok(pasteIdx >= 0 && enterIdx > pasteIdx);
});

test("enter=false no llama send-keys", async () => {
  const { run, calls } = captureRun();
  const paste = createPasteToPane({ run, cwd: "/x" });
  await paste("%3", "t", false);
  assert.ok(!calls.some((c) => c.args[0] === "send-keys"));
});

test("fallo de set-buffer devuelve error sin paste-buffer", async () => {
  const { run, calls } = captureRun((n, { args }) => {
    if (args.includes("set-buffer")) return { ok: false, err: "set roto" };
    return { ok: true, out: "", err: "" };
  });
  const paste = createPasteToPane({ run, cwd: "/x" });
  const r = await paste("%4", "t", false);
  assert.deepEqual(r, { ok: false, err: "set roto" });
  assert.ok(!calls.some((c) => c.args.includes("paste-buffer")));
});

test("fallo de paste-buffer dispara delete-buffer del mismo nombre", async () => {
  let bufName = "";
  const { run, calls } = captureRun((n, { args }) => {
    if (args.includes("set-buffer")) {
      bufName = args[args.indexOf("-b") + 1];
      return { ok: true, out: "", err: "" };
    }
    if (args.includes("paste-buffer")) return { ok: false, err: "paste roto" };
    return { ok: true, out: "", err: "" };
  });
  const paste = createPasteToPane({ run, cwd: "/x" });
  const r = await paste("%5", "t", false);
  assert.deepEqual(r, { ok: false, err: "paste roto" });
  const del = calls.find((c) => c.args.includes("delete-buffer"));
  assert.ok(del);
  assert.equal(del.args[del.args.indexOf("-b") + 1], bufName);
});

test("tmuxArgs se antepone a cada subcomando tmux", async () => {
  const { run, calls } = captureRun();
  const paste = createPasteToPane({ run, cwd: "/w", tmuxArgs: ["-L", "sock-test"] });
  await paste("%6", "z", false);
  for (const c of calls) {
    assert.equal(c.cmd, "tmux");
    assert.deepEqual(c.args.slice(0, 2), ["-L", "sock-test"]);
  }
});

/** Mismo spawn pattern que server.mjs run() — para integración con tmux real. */
function realRun(cmd, args, cwd, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const ch = spawn(cmd, args, { cwd, env: process.env });
    let out = "";
    let err = "";
    const t = setTimeout(() => {
      ch.kill("SIGKILL");
      resolve({ ok: false, out, err: err + "\n[timeout]" });
    }, timeoutMs);
    ch.stdout.on("data", (d) => (out += d));
    ch.stderr.on("data", (d) => (err += d));
    ch.on("close", (code) => {
      clearTimeout(t);
      resolve({ ok: code === 0, out: out.trim(), err: err.trim() });
    });
    ch.on("error", (e) => {
      clearTimeout(t);
      resolve({ ok: false, out, err: String(e) });
    });
  });
}

function analyzePasteResults(aRaw, bRaw, n) {
  const expected = new Set();
  for (let i = 0; i < n; i++) {
    const id = String(i).padStart(3, "0");
    expected.add(`A-${id}`);
    expected.add(`B-${id}`);
  }
  const counts = new Map();
  let correct = 0;
  let crossed = 0;
  for (const [pane, raw] of [["A", aRaw], ["B", bRaw]]) {
    const lines = raw.split("\n").filter((x) => x !== "");
    for (const line of lines) {
      if (!expected.has(line)) continue;
      counts.set(line, (counts.get(line) || 0) + 1);
      if (line.startsWith(`${pane}-`)) correct++;
      else crossed++;
    }
  }
  const missing = [...expected].filter((x) => !counts.has(x));
  const duplicateExtras = [...counts].reduce((s, [, c]) => s + Math.max(0, c - 1), 0);
  return { correct, crossed, missing: missing.length, duplicateExtras, missingMarkers: missing };
}

test("integración: 100 pares concurrentes sin cruces (tmux real)", async (t) => {
  const tmuxPath = spawnSync("tmux", ["-V"], { encoding: "utf8" });
  if (tmuxPath.error || tmuxPath.status !== 0) {
    t.skip("tmux no está en PATH");
    return;
  }

  const socketName = `mt3kpaste-${process.pid}`;
  const tmuxArgs = ["-L", socketName];
  const cwd = mkdtempSync(join(tmpdir(), "mt3k-paste-"));
  const fileA = join(cwd, "A.txt");
  const fileB = join(cwd, "B.txt");
  const N = 100;

  const kill = () => realRun("tmux", [...tmuxArgs, "kill-server"], cwd);

  try {
    const sess = await realRun(
      "tmux",
      [...tmuxArgs, "-f", "/dev/null", "new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "t", "-c", cwd, "cat > A.txt"],
      cwd,
      10000,
    );
    if (!sess.ok) {
      t.skip(`no se pudo crear servidor tmux aislado: ${sess.err || "unknown"}`);
      return;
    }
    const paneA = sess.out.trim();
    const winB = await realRun(
      "tmux",
      [...tmuxArgs, "new-window", "-P", "-F", "#{pane_id}", "-c", cwd, "cat > B.txt"],
      cwd,
      10000,
    );
    if (!winB.ok) {
      t.skip(`no se pudo abrir segunda ventana tmux: ${winB.err || "unknown"}`);
      return;
    }
    const paneB = winB.out.trim();

    const pasteToPane = createPasteToPane({ run: realRun, cwd, tmuxArgs });
    const jobs = [];
    for (let i = 0; i < N; i++) {
      const id = String(i).padStart(3, "0");
      jobs.push(pasteToPane(paneA, `A-${id}\n`, false));
      jobs.push(pasteToPane(paneB, `B-${id}\n`, false));
    }
    const outcomes = await Promise.all(jobs);
    const errors = outcomes.filter((o) => !o.ok);
    assert.equal(errors.length, 0, `paste errors: ${errors.map((e) => e.err).join("; ")}`);

    const deadline = Date.now() + 10000;
    let aRaw = "";
    let bRaw = "";
    while (Date.now() < deadline) {
      try {
        aRaw = readFileSync(fileA, "utf8");
        bRaw = readFileSync(fileB, "utf8");
        const linesA = aRaw.split("\n").filter((x) => x !== "").length;
        const linesB = bRaw.split("\n").filter((x) => x !== "").length;
        if (linesA >= N && linesB >= N) break;
      } catch {
        /* archivos aún no listos */
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    const stats = analyzePasteResults(aRaw, bRaw, N);
    assert.equal(stats.crossed, 0, `cruzados: ${stats.crossed}`);
    assert.equal(stats.missing, 0, `faltantes: ${stats.missingMarkers.slice(0, 5).join(",")}`);
    assert.equal(stats.duplicateExtras, 0, `duplicados extra: ${stats.duplicateExtras}`);
    assert.equal(stats.correct, N * 2, `correctos: ${stats.correct}`);
    t.diagnostic(`concurrent integration: correct=${stats.correct} crossed=${stats.crossed} missing=${stats.missing} dupExtra=${stats.duplicateExtras} pasteErrors=${errors.length}`);
  } finally {
    await kill();
    rmSync(cwd, { recursive: true, force: true });
  }
});

// Control negativo documentado: con buffer fijo `mt3k_send`, 100 pares concurrentes suelen cruzar o fallar paste
// (ver data/research/2026-10-27-mt3k-send-race.md). No se ejecuta para no hacer flaky la suite en CI.
test.skip("NEGATIVO: nombre fijo mt3k_send bajo concurrencia — reproducir con harness mt3k-send-repro", () => {});
