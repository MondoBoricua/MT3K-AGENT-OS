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
  findHerdrApp,
  isHerdrId,
  isNameTaken,
  parseHcAddress,
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
  const h = createHerdr({ probe: async () => true, hcPath: "/bin/hc", exec });
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
  const h = createHerdr({ probe: async () => true, hcPath: "/bin/hc", exec });
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
  assert.deepEqual(parseHcGet(t9), { cwd: "/Users/x/proj", cols: 96, rows: 43, where: "P / 1", labels: { where: "P / 1" } });
  assert.deepEqual(parseHcGet('{"cwd":"/a","cols":0,"rows":"x"}'), { cwd: "/a", cols: null, rows: null, where: null, labels: {} });
  assert.deepEqual(parseHcGet('{"cwd":"/a","labels":{"mt3k.panel":"1","n":5,"x":null}}').labels, { "mt3k.panel": "1" });
  assert.equal(parseHcGet("nope"), null);
});

test("createHerdr: get usa argv fijo y valida el id", async () => {
  const calls = [];
  const exec = (_f, argv, _o, cb) => { calls.push(argv); cb(null, '{"cwd":"/a","cols":80,"rows":24}'); };
  const h = createHerdr({ probe: async () => true, hcPath: "/bin/hc", exec });
  assert.deepEqual(await h.get("hc:t9"), { ok: true, cwd: "/a", cols: 80, rows: 24, where: null, labels: {} });
  assert.deepEqual(calls, [["get", "t9", "--json"]]);
  assert.deepEqual(await h.get("hc:-x"), { ok: false, err: "terminal inválido" });
});

test("B2: con el core muerto NINGÚN método ejecuta hc (running, list, get, read, send, keys, interrupt)", async () => {
  let execs = 0;
  const exec = (_f, _a, _o, cb) => { execs++; cb(null, "{}"); };
  const h = createHerdr({ hcPath: "/bin/hc", exec, platform: "darwin", probe: async () => false });
  assert.equal(await h.running(), false);
  assert.deepEqual(await h.list(), []);
  assert.equal((await h.get("hc:t1")).ok, false);
  assert.deepEqual(await h.read("hc:t1"), { ok: false, err: "hc no disponible" });
  assert.deepEqual(await h.send("hc:t1", "x"), { ok: false, err: "hc no disponible" });
  assert.deepEqual(await h.keys("hc:t1", ["enter"]), { ok: false, err: "hc no disponible" });
  assert.deepEqual(await h.interrupt("hc:t1"), { ok: false, err: "hc no disponible" });
  assert.equal(execs, 0);
});

test("B2: el sondeo previo al exec es SIN caché positiva; el negativo se reutiliza ≤ 2 s", async () => {
  let alive = true;
  let probes = 0;
  let execs = 0;
  let t = 1000;
  const exec = (_f, _a, _o, cb) => { execs++; cb(null, "pantalla"); };
  const h = createHerdr({ hcPath: "/bin/hc", exec, now: () => t, platform: "linux", probe: async () => { probes++; return alive; } });
  assert.equal((await h.read("hc:t1")).ok, true);
  assert.equal((await h.read("hc:t1")).ok, true);
  assert.equal(probes, 2); // un sondeo por exec
  alive = false; // el core muere con la lista aún "caliente"
  assert.equal((await h.read("hc:t1")).ok, false);
  assert.equal(execs, 2);
  const p0 = probes;
  alive = true;
  assert.equal((await h.read("hc:t1")).ok, false); // negativo cacheado
  assert.equal(probes, p0);
  t += 2100;
  assert.equal((await h.read("hc:t1")).ok, true);
});

test("B2: running() cacheado en true no hace que list() ejecute hc tras morir el core", async () => {
  let alive = true;
  let lsCalls = 0;
  const exec = (_f, argv, _o, cb) => { if (argv[0] === "ls") lsCalls++; cb(null, argv[0] === "ls" ? LS_SAMPLE : '{"live":2}'); };
  const h = createHerdr({ hcPath: "/bin/hc", exec, platform: "darwin", probe: async () => alive });
  assert.equal((await h.list()).length, 5);
  alive = false;
  assert.deepEqual(await h.list(), []);
  assert.equal(lsCalls, 1);
});

test("B2: win32 no sondea socket en ninguna invocación", async () => {
  let probed = 0;
  const exec = (_f, _a, _o, cb) => cb(null, "x");
  const h = createHerdr({ hcPath: "C:\\hc.exe", exec, platform: "win32", probe: async () => { probed++; return false; } });
  assert.equal((await h.read("hc:t1")).ok, true);
  assert.equal(probed, 0);
});

test("N5: NUL y controles C0 se rechazan en send; ningún método lanza", async () => {
  const exec = (_f, argv, _o, cb) => { if (argv.some((a) => a.includes("\u0000"))) throw new TypeError("ERR_INVALID_ARG_VALUE"); cb(null, ""); };
  const h = createHerdr({ hcPath: "/bin/hc", exec, probe: async () => true });
  assert.deepEqual(await h.send("hc:t1", "a\u0000b"), { ok: false, err: "texto inválido" });
  assert.deepEqual(await h.send("hc:t1", "a\u001bb"), { ok: false, err: "texto inválido" });
  assert.deepEqual(await h.send("hc:t1", "línea\ncon\ttab\r"), { ok: true });
  // si execFile lanzara de todos modos, el adaptador no propaga la excepción
  const throwing = createHerdr({ hcPath: "/bin/hc", exec: () => { throw new TypeError("boom"); }, probe: async () => true });
  assert.deepEqual(await throwing.read("hc:t1"), { ok: false, err: "lectura falló" });
  assert.deepEqual(await throwing.send("hc:t1", "x"), { ok: false, err: "envío falló" });
});

test("N7: HC_SOCKET absoluto a un socket existente se respeta; si no, se ignora", () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-hcsock-"));
  const sock = join(dir, "c.sock");
  const srv = createServer();
  return new Promise((resolve) => srv.listen(sock, () => {
    const withIt = coreSocketCandidates({ env: { HOME: "/h", HC_SOCKET: sock } });
    assert.equal(withIt[0], sock);
    assert.equal(withIt.length, 2);
    assert.equal(coreSocketCandidates({ env: { HOME: "/h", HC_SOCKET: join(dir, "no.sock") } }).length, 1);
    assert.equal(coreSocketCandidates({ env: { HOME: "/h", HC_SOCKET: "relativo.sock" } }).length, 1);
    srv.close(() => { rmSync(dir, { recursive: true, force: true }); resolve(); });
  }));
});

// --- crear / cerrar terminales del panel (launch-backend) ---

const mkHerdr = (replies, { alive = true, platform = "darwin" } = {}) => {
  const calls = [];
  const exec = (_f, argv, opts, cb) => {
    calls.push({ argv, opts });
    const r = replies.shift() ?? { out: "{}" };
    if (r.err) { const e = new Error("x"); e.code = r.err; cb(e, r.out ?? ""); } else cb(null, r.out);
  };
  return { h: createHerdr({ hcPath: "/bin/hc", exec, platform, probe: async () => alive }), calls };
};

test("run: argv fijo con --label y -- ; la dirección sale del JSON de hc", async () => {
  const { h, calls } = mkHerdr([{ out: '{"address":"t7","agent":"env","name":"mt3k-x"}' }]);
  const r = await h.run({ argv: ["/usr/bin/env", "PATH=/a", "/b/claude", "--settings", "{\"a\":1}", "-x"], cwd: "/tmp/p", name: "mt3k-claude-abc123-x1y" });
  assert.deepEqual(r, { ok: true, address: "t7", id: "hc:t7" });
  assert.deepEqual(calls[0].argv, ["run", "--bg", "--no-parent", "--json", "--name", "mt3k-claude-abc123-x1y", "--cwd", "/tmp/p", "--label", "mt3k.panel=1", "--", "/usr/bin/env", "PATH=/a", "/b/claude", "--settings", '{"a":1}', "-x"]);
  assert.ok(calls[0].opts.timeout <= 8000 && calls[0].opts.maxBuffer <= 256 * 1024);
});

test("run: shell = sin `--`; entradas inválidas no ejecutan nada", async () => {
  const { h, calls } = mkHerdr([{ out: '{"address":"t2"}' }]);
  assert.equal((await h.run({ argv: [], cwd: "/tmp/p", name: "mt3k-shell-abc123-001" })).ok, true);
  assert.equal(calls[0].argv.includes("--"), false);
  for (const bad of [
    { argv: [], cwd: "rel/dir", name: "ok-name" },
    { argv: [], cwd: "/tmp/p", name: "-flag" },
    { argv: [], cwd: "/tmp/p", name: "UPPER" },
    { argv: [], cwd: "/tmp/p", name: "a".repeat(33) },
    { argv: ["x\0y"], cwd: "/tmp/p", name: "ok-name" },
    { argv: [""], cwd: "/tmp/p", name: "ok-name" },
    { argv: [1], cwd: "/tmp/p", name: "ok-name" },
    { argv: new Array(65).fill("a"), cwd: "/tmp/p", name: "ok-name" },
    { argv: "ls", cwd: "/tmp/p", name: "ok-name" },
  ]) assert.equal((await h.run(bad)).ok, false, JSON.stringify(bad).slice(0, 60));
  assert.equal(calls.length, 1);
});

test("run: fallo de hc, name_taken, JSON sin dirección y core caído", async () => {
  let m = mkHerdr([{ err: 1, out: '{"error":{"kind":"name_taken"}}' }]);
  const taken = await m.h.run({ argv: [], cwd: "/tmp/p", name: "ok" });
  assert.deepEqual([taken.ok, taken.nameTaken], [false, true]);
  m = mkHerdr([{ err: 1, out: '{"error":{"kind":"spawn_failed"}}' }]);
  assert.deepEqual([(await m.h.run({ argv: [], cwd: "/tmp/p", name: "ok" })).nameTaken], [false]);
  m = mkHerdr([{ out: '{"address":"../etc"}' }]);
  assert.equal((await m.h.run({ argv: [], cwd: "/tmp/p", name: "ok" })).ok, false);
  m = mkHerdr([{ out: "nope" }]);
  assert.equal((await m.h.run({ argv: [], cwd: "/tmp/p", name: "ok" })).ok, false);
  m = mkHerdr([], { alive: false });
  assert.deepEqual(await m.h.run({ argv: [], cwd: "/tmp/p", name: "ok" }), { ok: false, err: "hc no disponible", code: "NOCORE" });
  assert.equal(m.calls.length, 0); // sin core NO se ejecuta hc (no arranca uno)
  assert.equal(parseHcAddress('{"address":"t12b"}'), "t12b");
  assert.equal(isNameTaken('{"error":{"kind":"name_taken"}}'), true);
  assert.equal(isNameTaken("x"), false);
});

test("coreUp: POSIX = sondeo; win32 = `hc server status`; sin hc = false", async () => {
  assert.equal(await mkHerdr([], { alive: true }).h.coreUp(), true);
  assert.equal(await mkHerdr([], { alive: false }).h.coreUp(), false);
  const w = mkHerdr([{ out: '{"core":{"id":"x"},"live":0}' }], { platform: "win32" });
  assert.equal(await w.h.coreUp(), true);
  assert.deepEqual(w.calls[0].argv, ["server", "status", "--json"]);
  assert.equal(await mkHerdr([{ err: 1, out: "" }], { platform: "win32" }).h.coreUp(), false);
  assert.equal(await createHerdr({ hcPath: null }).coreUp(), false);
});

test("markOwned: hc label <t> mt3k.panel=1", async () => {
  const { h, calls } = mkHerdr([{ out: "{}" }]);
  assert.deepEqual(await h.markOwned("hc:t4"), { ok: true });
  assert.deepEqual(calls[0].argv, ["label", "t4", "--json", "mt3k.panel=1"]);
  assert.equal((await h.markOwned("hc:-x")).ok, false);
});

test("killOwned: solo con etiqueta mt3k.panel=1 releída; kill y luego rm", async () => {
  const owned = '{"address":"t4","cwd":"/a","labels":{"mt3k.panel":"1"}}';
  let m = mkHerdr([{ out: owned }, { out: "{}" }, { out: '{"removed":"t4"}' }]);
  assert.deepEqual(await m.h.killOwned("hc:t4"), { ok: true, removed: true });
  assert.deepEqual(m.calls.map((c) => c.argv), [["get", "t4", "--json"], ["kill", "t4", "--json"], ["rm", "t4", "--json"]]);
  // rm falla (aún no terminado): sigue siendo éxito
  m = mkHerdr([{ out: owned }, { out: "{}" }, { err: 1, out: "" }]);
  assert.deepEqual(await m.h.killOwned("hc:t4"), { ok: true, removed: false });
  // terminal ajeno (sin etiqueta o con otro valor): ni kill ni rm
  for (const labels of ["{}", '{"mt3k.panel":"0"}', '{"where":"x"}']) {
    m = mkHerdr([{ out: `{"address":"t5","cwd":"/a","labels":${labels}}` }]);
    const r = await m.h.killOwned("hc:t5");
    assert.deepEqual([r.ok, r.status], [false, 400]);
    assert.equal(m.calls.length, 1);
  }
  // desaparecido / id inválido / core caído
  m = mkHerdr([{ err: 3, out: "" }]);
  assert.deepEqual([(await m.h.killOwned("hc:t9")).status], [404]);
  assert.deepEqual([(await m.h.killOwned("nope")).status], [400]);
  m = mkHerdr([], { alive: false });
  assert.deepEqual([(await m.h.killOwned("hc:t9")).status], [404]);
  assert.equal(m.calls.length, 0);
  // kill falla → 500 y no se intenta rm
  m = mkHerdr([{ out: owned }, { err: 1, out: "" }]);
  assert.deepEqual([(await m.h.killOwned("hc:t4")).status], [500]);
  assert.equal(m.calls.length, 2);
});

test("findHerdrApp: ~/.local/bin primero, luego PATH absoluto; ignora relativos y '.'", () => {
  const ok = (p) => p === "/h/.local/bin/herdr-app" || p === "/opt/bin/herdr-app" || p === "rel/herdr-app";
  assert.equal(findHerdrApp({ home: "/h", pathEnv: "/opt/bin", platform: "darwin", exists: ok }), "/h/.local/bin/herdr-app");
  assert.equal(findHerdrApp({ home: "/zz", pathEnv: "rel:.:/opt/bin", platform: "darwin", exists: ok }), "/opt/bin/herdr-app");
  assert.equal(findHerdrApp({ home: "/zz", pathEnv: "rel:.", platform: "darwin", exists: ok }), null);
  const win = (p) => p === "C:\\L\\Programs\\herdr-app\\herdr-app.exe";
  assert.equal(findHerdrApp({ platform: "win32", localAppData: "C:\\L", pathEnv: "", exists: win }), "C:\\L\\Programs\\herdr-app\\herdr-app.exe");
});
