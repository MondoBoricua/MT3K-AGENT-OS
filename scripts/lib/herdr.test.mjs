import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import {
  addressOf,
  coreRunningFromStatus,
  coreSocketCandidates,
  probeUnixSocket,
  createHerdr,
  findHc,
  isHerdrId,
  mapAgent,
  mapStatus,
  parseHcGet,
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
  const h = createHerdr({ hcPath: "/bin/hc", exec, probe: async () => true });
  assert.deepEqual(await h.list(), []);
});

test("createHerdr: list desde ls cuando el core está activo", async () => {
  const exec = mockExec({
    "server\0status\0--json": () => ({ ok: true, out: '{"holder":{"current":true},"live":2}' }),
    "ls\0--json": () => ({ ok: true, out: LS_SAMPLE }),
  });
  const h = createHerdr({ hcPath: "/bin/hc", exec, probe: async () => true });
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
    "keys\0t9\0--\0enter\0esc": () => ({ ok: true }),
  });
  const h = createHerdr({ hcPath: "/bin/hc", exec });
  assert.deepEqual(await h.keys("hc:t9", ["enter", "esc"]), { ok: true });
  assert.deepEqual(await h.keys("hc:t9", ["bad key"]), { ok: false, err: "teclas inválidas" });
  assert.deepEqual(await h.keys("hc:t9", ["-h"]), { ok: false, err: "teclas inválidas" });
  assert.deepEqual(await h.keys("hc:t9", ["enter", "--help"]), { ok: false, err: "teclas inválidas" });
  assert.deepEqual(await h.keys("hc:t9", new Array(33).fill("a")), { ok: false, err: "teclas inválidas" });
});

test("createHerdr: running() cachea 5s con now inyectable", async () => {
  let n = 1000;
  let statusCalls = 0;
  const exec = (_f, argv, _o, cb) => {
    if (argv[0] === "server") statusCalls++;
    cb(null, '{"holder":{"current":true},"live":1}');
  };
  const h = createHerdr({ hcPath: "/bin/hc", exec, now: () => n, probe: async () => true });
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

test("coreSocketCandidates: XDG_STATE_HOME, HOME, HC_SESSION y XDG_RUNTIME_DIR", () => {
  assert.deepEqual(coreSocketCandidates({ env: { HOME: "/h" } }), ["/h/.local/state/herdr-core/default/default.sock"]);
  assert.deepEqual(
    coreSocketCandidates({ env: { XDG_STATE_HOME: "/x", HC_SESSION: "s1", HOME: "/h", XDG_RUNTIME_DIR: "/r" } }),
    ["/r/herdr-core/s1.sock", "/x/herdr-core/s1/s1.sock"],
  );
  assert.deepEqual(coreSocketCandidates({ env: {}, home: "/fallback" }), ["/fallback/.local/state/herdr-core/default/default.sock"]);
});

test("probeUnixSocket: acepta, ENOENT y ECONNREFUSED (socket huérfano)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-sock-"));
  const sock = join(dir, "a.sock");
  const srv = createServer((c) => c.end());
  await new Promise((r) => srv.listen(sock, r));
  assert.equal(await probeUnixSocket(sock, 300), true);
  await new Promise((r) => srv.close(r)); // node borra el archivo al cerrar
  assert.equal(await probeUnixSocket(sock, 300), false); // ENOENT
  assert.equal(await probeUnixSocket(join(dir, "nunca.sock"), 300), false);
  rmSync(dir, { recursive: true, force: true });
});

test("running() POSIX: socket muerto → false y NO se ejecuta hc (ni en list)", async () => {
  let execCalls = 0;
  const exec = (_f, _a, _o, cb) => { execCalls++; cb(null, '{"live":3}'); };
  const h = createHerdr({ hcPath: "/bin/hc", exec, platform: "darwin", probe: async () => false });
  assert.equal(await h.running(), false);
  assert.deepEqual(await h.list(), []);
  assert.equal(execCalls, 0);
});

test("running() POSIX: el probe recibe la ruta de HC_SESSION/XDG del env inyectado", async () => {
  const seen = [];
  const exec = (_f, _a, _o, cb) => cb(null, '{"holder":{"current":true},"live":1}');
  const h = createHerdr({
    hcPath: "/bin/hc", exec, platform: "linux",
    env: { HC_SESSION: "zz", XDG_STATE_HOME: "/st" },
    probe: async (p) => { seen.push(p); return true; },
  });
  assert.equal(await h.running(), true);
  assert.deepEqual(seen, ["/st/herdr-core/zz/zz.sock"]);
  assert.equal(coreSocketCandidates({ env: { HC_SESSION: "zz", XDG_STATE_HOME: "/st", XDG_RUNTIME_DIR: "/rt" } }).length, 2);
});

test("running() win32: no sondea socket, usa hc server status", async () => {
  let probed = 0;
  let statusCalls = 0;
  const exec = (_f, argv, _o, cb) => { if (argv[0] === "server") statusCalls++; cb(null, '{"live":1}'); };
  const h = createHerdr({ hcPath: "C:\\hc.exe", exec, platform: "win32", probe: async () => { probed++; return false; } });
  assert.equal(await h.running(), true);
  assert.equal(probed, 0);
  assert.equal(statusCalls, 1);
});

test("running() POSIX: socket vivo pero status sin sesiones → false", async () => {
  const exec = (_f, _a, _o, cb) => cb(null, '{"holder":null,"live":0}');
  const h = createHerdr({ hcPath: "/bin/hc", exec, platform: "darwin", probe: async () => true });
  assert.equal(await h.running(), false);
});

test("parseHcGet: foreground.cwd manda sobre cwd de lanzamiento; cols/rows y where", () => {
  const t9 = '{"address":"t9","cols":96,"rows":43,"cwd":"/Users/x","foreground":{"cwd":"/Users/x/proj","name":"2.1"},"labels":{"where":"P / 1"}}';
  assert.deepEqual(parseHcGet(t9), { cwd: "/Users/x/proj", cols: 96, rows: 43, where: "P / 1" });
  assert.deepEqual(parseHcGet('{"cwd":"/a","cols":0,"rows":"x"}'), { cwd: "/a", cols: null, rows: null, where: null });
  assert.equal(parseHcGet("nope"), null);
});

test("createHerdr: get usa argv fijo y valida el id", async () => {
  const calls = [];
  const exec = (_f, argv, _o, cb) => { calls.push(argv); cb(null, '{"cwd":"/a","cols":80,"rows":24}'); };
  const h = createHerdr({ hcPath: "/bin/hc", exec });
  assert.deepEqual(await h.get("hc:t9"), { ok: true, cwd: "/a", cols: 80, rows: 24, where: null });
  assert.deepEqual(calls, [["get", "t9", "--json"]]);
  assert.deepEqual(await h.get("hc:-x"), { ok: false, err: "terminal inválido" });
});
