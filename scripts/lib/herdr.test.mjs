import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addressOf,
  coreRunningFromStatus,
  createHerdr,
  findHc,
  isHerdrId,
  mapAgent,
  mapStatus,
  parseHcLs,
} from "./herdr.mjs";

// Muestra real de `hc ls --json` en esta Mac (2026-11-11, hc 0.1.20); solo paths locales.
const LS_SAMPLE = `{"hidden_finished":0,"terminals":[{"address":"t4","agent":"zsh","cwd":"/Users/mondo","state":"live","turn":0},{"address":"t5","agent":"zsh","cwd":"/Users/mondo","state":"live","turn":0},{"address":"t9","agent":"claude-code","cwd":"/Users/mondo","state":"live","status":"done","turn":7,"where":"MT3K-AGENT-OS / 1"},{"address":"t11","agent":"claude-code","cwd":"/Users/mondo/Developer/YOUTUBE","state":"live","status":"idle","turn":0,"where":"YOUTUBE / 1"},{"address":"t12","agent":"claude-code","cwd":"/Users/mondo/.proxmox","state":"live","status":"idle","turn":0,"where":"PROXMOX / 1"}]}`;

const STATUS_OBJECT = { app: "claude-code", state: "done" };

test("mapAgent: tabla del panel", () => {
  assert.equal(mapAgent("claude-code"), "claude");
  assert.equal(mapAgent("claude"), "claude");
  assert.equal(mapAgent("codex"), "codex");
  assert.equal(mapAgent("cursor-agent"), "cursor");
  assert.equal(mapAgent("agy"), "antigravity");
  assert.equal(mapAgent("zsh"), "shell");
  assert.equal(mapAgent(null), "shell");
});

test("mapStatus: string de ls, objeto de get, error y desconocidos", () => {
  assert.equal(mapStatus("working"), "working");
  assert.equal(mapStatus("idle"), "idle");
  assert.equal(mapStatus("done"), "done");
  assert.equal(mapStatus("error"), "blocked");
  assert.equal(mapStatus(STATUS_OBJECT), "done");
  assert.equal(mapStatus({ app: "x", state: "blocked" }), "blocked");
  assert.equal(mapStatus("weird"), null);
  assert.equal(mapStatus(undefined), null);
});

test("ids Herdr y rechazo de opciones inyectadas", () => {
  assert.equal(isHerdrId("hc:t9"), true);
  assert.equal(isHerdrId("hc:t1b"), true);
  assert.equal(isHerdrId("hc:t999999"), true);
  assert.equal(isHerdrId("t9"), false);
  assert.equal(isHerdrId("hc:box/t3"), false);
  assert.equal(addressOf("hc:t9"), "t9");
  assert.equal(addressOf("hc:-flag"), null);
});

test("parseHcLs: JSON real de ls", () => {
  const rows = parseHcLs(LS_SAMPLE);
  assert.equal(rows.length, 5);
  const t9 = rows.find((r) => r.address === "t9");
  assert.deepEqual(t9, {
    id: "hc:t9",
    address: "t9",
    agent: "claude",
    app: "claude-code",
    status: "done",
    cwd: "/Users/mondo",
    where: "MT3K-AGENT-OS / 1",
    name: null,
    turn: 7,
    parent: null,
    state: "live",
  });
  assert.equal(rows.find((r) => r.address === "t4").agent, "shell");
  assert.equal(rows.find((r) => r.address === "t4").status, null);
});

test("coreRunningFromStatus: holder vs autostart vacío", () => {
  const live = `{"holder":{"current":true},"live":5}`;
  const empty = `{"holder":null,"live":0,"pid":35880}`;
  assert.equal(coreRunningFromStatus(live), true);
  assert.equal(coreRunningFromStatus(empty), false);
  assert.equal(coreRunningFromStatus("nope"), false);
});

function mockExec(handlers) {
  return (file, argv, _opts, cb) => {
    const key = argv.join("\0");
    const fn = handlers[key] ?? handlers["*"];
    if (!fn) return cb(new Error("unexpected"), "");
    const r = fn(file, argv);
    if (r.ok) cb(null, r.out ?? "");
    else {
      const err = new Error("fail");
      err.code = r.code;
      cb(err, r.out ?? "");
    }
  };
}

test("createHerdr: list vacío si running false o hc falla", async () => {
  const exec = mockExec({
    "server\0status\0--json": () => ({ ok: true, out: '{"holder":null,"live":0}' }),
  });
  const h = createHerdr({ hcPath: "/bin/hc", exec });
  assert.deepEqual(await h.list(), []);
});

test("createHerdr: list desde ls cuando el core está activo", async () => {
  const exec = mockExec({
    "server\0status\0--json": () => ({ ok: true, out: '{"holder":{"current":true},"live":2}' }),
    "ls\0--json": () => ({ ok: true, out: LS_SAMPLE }),
  });
  const h = createHerdr({ hcPath: "/bin/hc", exec });
  const rows = await h.list();
  assert.equal(rows.length, 5);
  assert.equal(rows[2].id, "hc:t9");
});

test("createHerdr: read, send con --, límites y bloqueado código 9", async () => {
  const calls = [];
  const exec = (file, argv, _opts, cb) => {
    calls.push(argv);
    if (argv[0] === "send" && argv[2] === "--") cb(null, "");
    else if (argv[0] === "send") cb(Object.assign(new Error("x"), { code: 9 }), "");
    else cb(null, "pantalla\n");
  };
  const h = createHerdr({ hcPath: "/bin/hc", exec });
  assert.deepEqual(await h.read("hc:t9", { lines: 9999 }), { ok: true, text: "pantalla\n" });
  assert.ok(calls.some((a) => a[0] === "read" && a.includes("2000")));
  assert.deepEqual(await h.send("hc:t9", "-opt"), { ok: true });
  assert.ok(calls.some((a) => a[0] === "send" && a[2] === "--" && a[3] === "-opt"));
  assert.deepEqual(await h.send("hc:t9", "hola"), { ok: false, err: "bloqueado: requiere a la persona" });
  assert.deepEqual(await h.send("hc:t9", ""), { ok: false, err: "texto vacío" });
  assert.deepEqual(await h.send("hc:t9", "x".repeat(70000)), { ok: false, err: "texto demasiado largo" });
  assert.deepEqual(await h.read("box/t3"), { ok: false, err: "terminal inválido" });
});

test("createHerdr: keys válidas e inválidas", async () => {
  const exec = mockExec({
    "keys\0t9\0enter\0esc": () => ({ ok: true }),
  });
  const h = createHerdr({ hcPath: "/bin/hc", exec });
  assert.deepEqual(await h.keys("hc:t9", ["enter", "esc"]), { ok: true });
  assert.deepEqual(await h.keys("hc:t9", ["bad key"]), { ok: false, err: "teclas inválidas" });
  assert.deepEqual(await h.keys("hc:t9", new Array(33).fill("a")), { ok: false, err: "teclas inválidas" });
});

test("createHerdr: running() cachea 5s con now inyectable", async () => {
  let n = 1000;
  let statusCalls = 0;
  const exec = (_f, argv, _o, cb) => {
    if (argv[0] === "server") statusCalls++;
    cb(null, '{"holder":{"current":true},"live":1}');
  };
  const h = createHerdr({ hcPath: "/bin/hc", exec, now: () => n });
  assert.equal(await h.running(), true);
  assert.equal(await h.running(), true);
  assert.equal(statusCalls, 1);
  n += 6000;
  assert.equal(await h.running(), true);
  assert.equal(statusCalls, 2);
});

test("findHc: POSIX home y PATH confiable", () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-hc-"));
  const hc = join(dir, "hc");
  writeFileSync(hc, "#!/bin/sh\necho hc\n");
  chmodSync(hc, 0o755);
  const found = findHc({
    platform: "linux",
    home: dir,
    pathEnv: `${dir}:${dir}/nope`,
    exists: (p) => p === hc || p === join(dir, ".local", "bin", "hc"),
  });
  mkdirSync(join(dir, ".local", "bin"), { recursive: true });
  const homeHc = join(dir, ".local", "bin", "hc");
  writeFileSync(homeHc, "#!/bin/sh\necho hc\n");
  chmodSync(homeHc, 0o755);
  assert.equal(findHc({ platform: "linux", home: dir, pathEnv: "", exists: (p) => statOk(p, hc, homeHc) }), homeHc);
  assert.equal(findHc({ platform: "linux", home: "/tmp", pathEnv: dir, exists: (p) => p === hc }), hc);
  function statOk(p, ...ok) { return ok.includes(p); }
});

test("findHc: win32 localAppData y .exe en PATH calificado", () => {
  const appData = "C:\\Users\\x\\AppData\\Local";
  const bundled = `${appData}\\Programs\\herdr-core\\hc.exe`;
  const pathHc = "D:\\tools\\hc.exe";
  const exists = (p) => p === bundled || p === pathHc;
  assert.equal(findHc({ platform: "win32", localAppData: appData, pathEnv: "", exists }), bundled);
  assert.equal(findHc({ platform: "win32", localAppData: "", pathEnv: "D:\\tools", exists }), pathHc);
  assert.equal(findHc({ platform: "win32", pathEnv: "tools", exists }), null);
});
