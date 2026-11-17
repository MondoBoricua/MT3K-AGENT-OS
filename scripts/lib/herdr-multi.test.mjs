import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHerdr9 } from "./herdr9.mjs";
import { createHerdr9Panes, herdr9KeyArgs } from "./herdr9-panes.mjs";
import { createHerdr9Launcher } from "./herdr9-launch.mjs";
import { createHerdrLauncher } from "./herdr-launch.mjs";
import { createHerdrPanes, herdrFailure } from "./herdr-panes.mjs";
import { containsHerdrId, createHerdrMulti, createHerdrMultiLauncher, detectBackends, isHerdrId } from "./herdr-multi.mjs";

const FX = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "herdr9");
const fx = (name) => readFileSync(join(FX, name), "utf8");

function fakeExec(routes) {
  const calls = [];
  const exec = (bin, argv, opts, cb) => {
    calls.push({ bin, argv });
    const key = argv.join(" ");
    const hit = Object.entries(routes).find(([k]) => key === k || key.startsWith(`${k} `));
    const r = typeof hit?.[1] === "function" ? hit[1](argv) : hit?.[1];
    if (!r) return cb(Object.assign(new Error("no route"), { code: 1 }), "", "");
    if (r.err) return cb(Object.assign(new Error("fail"), { code: r.code ?? 1 }), r.out ?? "", "");
    return cb(null, r.out ?? "", "");
  };
  return { exec, calls };
}

const ROUTES = {
  "pane list": { out: fx("pane-list.json") },
  "tab create": { out: fx("tab-create.json") },
  "pane run": { out: "" },
  "pane read": { out: fx("pane-read-ansi.txt") },
  "pane send-keys": { out: "" },
};

// Panes de herdr 0.9 con un exec falso y la CLI "instalada" (o no)
function h9Panes({ installed = true, up = true, routes = ROUTES, color = true, log = () => {} } = {}) {
  const f = fakeExec(routes);
  const panes = createHerdr9Panes({
    findCli: () => (installed ? "/usr/bin/herdr" : null),
    createHerdr9: ({ herdrPath }) => createHerdr9({ herdrPath, exec: f.exec, probe: async () => up, platform: "linux", home: "/h", isSocket: () => false, env: {} }),
    color,
    log,
    ttlMs: 0,
  });
  return { panes, ...f };
}

// Panes hc mínimos: nada instalado, o con una lista fija
const hcPanes = ({ installed = false } = {}) => createHerdrPanes({
  findHc: () => (installed ? "/usr/local/bin/hc" : null),
  createHerdr: () => ({
    list: async () => [{ id: "hc:t1", address: "t1", agent: "claude", app: "claude", status: "working", cwd: "/p", where: null, name: "n", turn: 1, state: "live" }],
    invalidate() {}, hcEnv: async () => ({}), coreUp: async () => true, coreAlive: async () => true,
    get: async () => ({ ok: false }), send: async () => ({ ok: true }), read: async () => ({ ok: true, text: "hc" }),
    killTerminal: async (id, o) => ({ ok: true, via: "hc", id, force: o.force }),
  }),
  color: false,
  ttlMs: 0,
});

test("detectBackends: hc solo / herdr solo / ambos / ninguno (independientes)", () => {
  const cases = [
    [{ hc: true, h9: false }, { hc: true, herdr9: false }],
    [{ hc: false, h9: true }, { hc: false, herdr9: true }],
    [{ hc: true, h9: true }, { hc: true, herdr9: true }],
    [{ hc: false, h9: false }, { hc: false, herdr9: false }],
  ];
  for (const [have, want] of cases) {
    const got = detectBackends({ hcPanes: hcPanes({ installed: have.hc }), h9Panes: h9Panes({ installed: have.h9 }).panes });
    assert.deepEqual(got, want);
  }
});

test("detección independiente: un backend con servidor caído no afecta al otro", async () => {
  const multi = createHerdrMulti({ hcPanes: hcPanes({ installed: true }), h9Panes: h9Panes({ up: false }).panes });
  const rows = await multi.refresh(true);
  assert.deepEqual(rows.map((r) => r.id), ["hc:t1"]);
  const both = createHerdrMulti({ hcPanes: hcPanes({ installed: false }), h9Panes: h9Panes({}).panes });
  assert.equal((await both.refresh(true)).length, 6);
});

test("isHerdrId / containsHerdrId aceptan ambos formatos y nada más", () => {
  for (const ok of ["hc:t9", "h9:w1:p3"]) assert.equal(isHerdrId(ok), true);
  for (const bad of ["%3", "w1:p3", "h9:x", "hc:", null]) assert.equal(isHerdrId(bad), false);
  assert.equal(containsHerdrId({ a: [{ b: "h9:w1:pA" }] }), true);
  assert.equal(containsHerdrId({ a: ["%1", "x"] }), false);
  // cuerpos de /api/restore: ids h9: anidados en items y dismiss, y mezclados con ids de tmux
  assert.equal(containsHerdrId({ items: [{ sessionName: "h9:w1:p3" }] }), true);
  assert.equal(containsHerdrId({ items: [{ sessionName: "mt3k-claude-x" }], dismiss: ["h9:w2:pA"] }), true);
  assert.equal(containsHerdrId({ items: [{ sessionName: "hc:t9" }] }), true);
  assert.equal(containsHerdrId({ items: [{ sessionName: "mt3k-claude-x" }], dismiss: ["%1"], all: true }), false);
});

test("listado: los panes de herdr 0.9 salen bajo su agente con backend herdr, estado y carpeta", async () => {
  const { panes } = h9Panes();
  const agentRows = ["codex", "cursor", "antigravity", "claude", "shell"].map((id) => ({ id, name: id, panes: [] }));
  const merged = await panes.applyTo(agentRows);
  const byId = Object.fromEntries(merged.map((r) => [r.id, r]));
  assert.equal(byId.codex.running, true);
  assert.deepEqual(byId.codex.panes.map((p) => [p.paneId, p.backend, p.status, p.cwd]), [["h9:w1:p1", "herdr", "idle", "/home/mondo"]]);
  assert.equal(byId.antigravity.panes[0].paneId, "h9:w1:p8");
  assert.equal(byId.claude.panes?.length ?? 0, 0);
  assert.equal(byId.shell.panes.length, 3); // p5, p6, pA: sin agente reconocido
  assert.ok(byId.cursor.panes[0].statusSource === "herdr" && byId.cursor.panes[0].label === "Cursor Agent");
});

test("applyTo combina hc y herdr 0.9 sin pisarse", async () => {
  const multi = createHerdrMulti({ hcPanes: hcPanes({ installed: true }), h9Panes: h9Panes().panes });
  const merged = await multi.applyTo(["claude", "codex", "shell"].map((id) => ({ id, name: id, panes: [] })));
  const ids = merged.flatMap((r) => r.panes.map((p) => p.paneId)).sort();
  assert.deepEqual(ids, ["h9:w1:p1", "h9:w1:p5", "h9:w1:p6", "h9:w1:p7", "h9:w1:p8", "h9:w1:pA", "hc:t1"].sort());
});

test("enrutado por prefijo: read/send/keys/has/kill van al backend del id", async () => {
  const f = h9Panes();
  const multi = createHerdrMulti({ hcPanes: hcPanes({ installed: true }), h9Panes: f.panes });
  await multi.refresh(true);
  assert.equal(await multi.has("h9:w1:p7"), true);
  assert.equal(await multi.has("hc:t1"), true);
  assert.equal(await multi.has("h9:w1:p99"), false);
  assert.deepEqual(await multi.send("hc:t1", "x"), { ok: true });
  assert.deepEqual(await multi.send("h9:w1:pB", "hola"), { ok: true });
  assert.deepEqual(f.calls.at(-1).argv, ["pane", "run", "w1:pB", "hola"]);
  assert.equal((await multi.read("hc:t1", 0)).text, "hc");
  assert.match((await multi.read("h9:w1:pB", 0)).text, /command not found/);
  assert.deepEqual(await multi.keys("h9:w1:pB", "SendNow"), { ok: true });
  assert.deepEqual(f.calls.at(-1).argv, ["pane", "send-keys", "w1:pB", "ctrl+x", "ctrl+s"]);
  assert.deepEqual((await multi.keys("h9:w1:pB", "Home")), { ok: false, err: "tecla no permitida", status: 400 });
  assert.deepEqual(await multi.kill("hc:t1", { force: true }), { ok: true, via: "hc", id: "hc:t1", force: true });
});

test("view: color con --ansi; el respaldo en texto plano funciona en las dos direcciones y con MT3K_HERDR_COLOR=0", async () => {
  const PLAIN = "texto plano\n";
  const ANSI = "\x1b[1mcolor\x1b[0m\n";
  const readRoute = (argv) => {
    const ansi = argv.includes("--ansi");
    if (ansi) return mode.ansi === "fail" ? { err: true, code: 1 } : { out: mode.ansi === "empty" ? "" : ANSI };
    return mode.plain === "fail" ? { err: true, code: 1 } : { out: PLAIN };
  };
  const mode = { ansi: "ok", plain: "ok" };
  const f = h9Panes({ routes: { ...ROUTES, "pane read": readRoute } });
  // ambas bien → color
  assert.deepEqual(await f.panes.view("h9:w1:pB"), { ok: true, text: ANSI, colored: true });
  assert.ok(f.calls.some((c) => c.argv.includes("--ansi")));
  // falla el color, el texto responde → texto plano (sin colored)
  mode.ansi = "fail";
  assert.deepEqual(await f.panes.view("h9:w1:pB"), { ok: true, text: PLAIN });
  // el color responde vacío → también cae a texto plano
  mode.ansi = "empty";
  assert.deepEqual(await f.panes.view("h9:w1:pB"), { ok: true, text: PLAIN });
  // el color responde, falla el texto → se devuelve el color y la lectura plana ni se intenta
  mode.ansi = "ok"; mode.plain = "fail";
  const before = f.calls.length;
  assert.deepEqual(await f.panes.view("h9:w1:pB"), { ok: true, text: ANSI, colored: true });
  assert.equal(f.calls.slice(before).filter((c) => !c.argv.includes("--ansi")).length, 0);
  // fallan las dos → error
  mode.ansi = "fail";
  assert.deepEqual(await f.panes.view("h9:w1:pB"), { ok: false, err: "lectura falló" });
  // color apagado: nunca se pide --ansi
  mode.ansi = "ok"; mode.plain = "ok";
  const plain = h9Panes({ color: false, routes: { ...ROUTES, "pane read": readRoute } });
  assert.deepEqual(await plain.panes.view("h9:w1:pB"), { ok: true, text: PLAIN });
  assert.ok(!plain.calls.some((c) => c.argv.includes("--ansi")));
});

test("MT3K_HERDR=0 (enabled:false) o sin CLI → no se ejecuta nada y la lista es []", async () => {
  const f = fakeExec(ROUTES);
  const off = createHerdr9Panes({ enabled: false, findCli: () => { throw new Error("no debe buscarse"); } });
  assert.deepEqual(await off.refresh(true), []);
  const none = h9Panes({ installed: false });
  assert.deepEqual(await none.panes.refresh(true), []);
  assert.deepEqual(await none.panes.send("h9:w1:p1", "x"), { ok: false, err: "herdr no disponible" });
  assert.equal(f.calls.length + none.calls.length, 0);
});

test("un backend roto no rompe la lista PERO el fallo queda registrado (una vez por cambio de estado) y visible en status()", async () => {
  const logs = [];
  let mode = "timeout";
  const routes = { ...ROUTES, "pane list": () => (mode === "timeout" ? { err: true, code: "ETIMEDOUT" } : mode === "garbage" ? { out: "basura" } : { out: fx("pane-list.json") }) };
  const f = h9Panes({ routes, log: (m) => logs.push(m) });
  const multi = createHerdrMulti({ hcPanes: hcPanes({ installed: true }), h9Panes: f.panes });
  const poll = async () => { multi.invalidate(); return multi.refresh(true); }; // sin caché: cada llamada ejecuta herdr de verdad
  const listCalls = () => f.calls.filter((c) => c.argv.join(" ") === "pane list").length;
  // el otro backend (hc) sigue listando aunque herdr 0.9 falle
  assert.deepEqual((await poll()).map((r) => r.id), ["hc:t1"]);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /herdr 0\.9: herdr pane list falló \(ETIMEDOUT\)/);
  // consultas repetidas con el MISMO fallo no vuelven a registrar
  for (let i = 0; i < 3; i++) await poll();
  assert.equal(listCalls(), 4); // se consultó 4 veces…
  assert.equal(logs.length, 1); // …y se registró 1
  // se expone donde hc expone el suyo: el status del lanzador
  const launcher = createHerdrMultiLauncher({
    hcLauncher: { status: async () => ({ installed: true, running: true, app: false }), launch: async () => ({ ok: true }) },
    h9Launcher: createHerdr9Launcher({ getHerdr9: () => f.panes.herdr9() }),
  });
  const st = await launcher.status();
  assert.equal(st.installed, true);
  assert.match(st.errors.herdr9, /ETIMEDOUT/);
  assert.deepEqual(f.panes.health(), { ok: false, err: logs[0].replace("[mt3k] herdr 0.9: ", "") });
  // otro tipo de fallo = otro estado = otro registro
  mode = "garbage";
  await poll();
  assert.equal(logs.length, 2);
  assert.match(logs[1], /ilegible/);
  // recuperación: se registra y el error desaparece del status
  mode = "ok";
  assert.equal((await poll()).length, 7);
  assert.equal(logs.length, 3);
  assert.match(logs[2], /vuelve a responder/);
  assert.equal((await launcher.status()).errors, undefined);
  assert.deepEqual(f.panes.health(), { ok: true });
});

test("un `tab list` roto también queda registrado y visible por la fachada (filas degradadas, lista entera)", async () => {
  const logs = [];
  let tabMode = "timeout";
  const tabsOk = JSON.stringify({ result: { tabs: [{ tab_id: "w1:t7", label: "mt3k-cursor-0a1b2c-x1" }] } });
  const routes = { ...ROUTES, "tab list": () => (tabMode === "timeout" ? { err: true, code: "ETIMEDOUT" } : tabMode === "garbage" ? { out: "basura" } : { out: tabsOk }) };
  const f = fakeExec(routes);
  const ledger = new Map([["term_6606d374946717", { terminal: "term_6606d374946717", pane: "w1:p7", tab: "w1:t7", label: "mt3k-cursor-0a1b2c-x1", at: 0 }]]); // el terminal de w1:p7
  const panes = createHerdr9Panes({
    findCli: () => "/usr/bin/herdr",
    createHerdr9: ({ herdrPath }) => createHerdr9({ herdrPath, exec: f.exec, probe: async () => true, platform: "linux", home: "/h", env: { HERDR_SOCKET_PATH: "" }, ledger }),
    log: (m) => logs.push(m),
    ttlMs: 0,
  });
  const multi = createHerdrMulti({ hcPanes: hcPanes({ installed: true }), h9Panes: panes });
  const poll = async () => { multi.invalidate(); return multi.refresh(true); };
  let rows = await poll();
  assert.equal(rows.filter((r) => r.id.startsWith("h9:")).length, 6); // la lista llega entera
  assert.ok(rows.every((r) => !r.killable));
  assert.equal(logs.length, 1);
  assert.match(logs[0], /herdr tab list falló \(ETIMEDOUT\)/);
  await poll();
  assert.equal(logs.length, 1); // mismo fallo: no se repite
  const launcher = createHerdrMultiLauncher({
    hcLauncher: { status: async () => ({ installed: true, running: true, app: false }), launch: async () => ({ ok: true }) },
    h9Launcher: createHerdr9Launcher({ getHerdr9: () => panes.herdr9() }),
  });
  assert.match((await launcher.status()).errors.herdr9, /tab list falló \(ETIMEDOUT\)/);
  tabMode = "garbage";
  await poll();
  assert.equal(logs.length, 2);
  assert.match(logs[1], /tab list devolvió una salida ilegible/);
  tabMode = "ok";
  rows = await poll();
  assert.equal(logs.length, 3);
  assert.match(logs[2], /vuelve a responder/);
  assert.deepEqual(rows.filter((r) => r.killable).map((r) => r.id), ["h9:w1:p7"]);
  assert.equal((await launcher.status()).errors, undefined);
});

test("servidor caído no es un fallo del backend: lista [] sin ejecutar nada ni registrar", async () => {
  const logs = [];
  const down = h9Panes({ up: false, log: (m) => logs.push(m) });
  assert.deepEqual(await down.panes.refresh(true), []);
  assert.equal(down.calls.length, 0);
  assert.deepEqual(logs, []);
  assert.deepEqual(down.panes.health(), { ok: true });
});

test("herdr9KeyArgs: tabla del panel y teclas que 0.9.5 no soporta", () => {
  assert.deepEqual(herdr9KeyArgs("BSpace"), ["backspace"]);
  assert.deepEqual(herdr9KeyArgs("Escape"), ["esc"]);
  for (const k of ["Home", "End", "PageUp", "PageDown", "constructor", "enter; rm", undefined]) assert.equal(herdr9KeyArgs(k), null);
});

test("lanzador herdr 0.9: pestaña con nombre del panel y argv; razones de fallo sin arrancar nada", async () => {
  const f = fakeExec(ROUTES);
  const mk = (up, installed = true) => createHerdr9Launcher({
    getHerdr9: () => (installed ? createHerdr9({ herdrPath: "/usr/bin/herdr", exec: f.exec, probe: async () => up, platform: "linux", home: "/h", isSocket: () => false, env: {} }) : null),
    nameSuffix: "ab",
  });
  assert.deepEqual(await mk(true).status(), { installed: true, running: true, app: false });
  assert.deepEqual(await mk(false).status(), { installed: true, running: false, app: false });
  assert.deepEqual(await mk(true, false).status(), { installed: false, running: false, app: false });
  assert.deepEqual(await mk(true, false).launch({ agentId: "claude", cwd: "/tmp", argv: [] }), { ok: false, reason: "not-installed" });
  assert.deepEqual(await mk(false).launch({ agentId: "claude", cwd: "/tmp", argv: [] }), { ok: false, reason: "no-core" });
  assert.equal(f.calls.length, 0);
  const made = await mk(true).launch({ agentId: "claude", cwd: "/tmp", argv: ["/usr/bin/env", "PATH=/x", "claude"] });
  assert.equal(made.ok, true);
  assert.equal(made.paneId, "h9:w1:pB");
  assert.match(made.name, /^mt3k-claude-[0-9a-f]{6}-ab$/);
  assert.deepEqual(f.calls[0].argv, ["tab", "create", "--no-focus", "--label", made.name, "--cwd", "/tmp"]);
  assert.deepEqual(f.calls[1].argv, ["pane", "run", "w1:pB", "'/usr/bin/env' 'PATH=/x' 'claude'"]);
  const bad = await mk(true).launch({ agentId: "claude", cwd: "relativa", argv: [] });
  assert.deepEqual([bad.ok, bad.reason], [false, "error"]);
});

test("lanzador combinado: con ambos prefiere hc si su core está vivo; si no, herdr 0.9; not-installed solo si no hay ninguno", async () => {
  const stub = (st, tag) => ({ status: async () => st, launch: async () => ({ ok: true, tag }) });
  const L = (a, b) => createHerdrMultiLauncher({ hcLauncher: stub(a, "hc"), h9Launcher: stub(b, "h9") });
  const S = (installed, running) => ({ installed, running, app: false });
  assert.equal((await L(S(true, true), S(true, true)).launch({})).tag, "hc");
  assert.equal((await L(S(true, false), S(true, true)).launch({})).tag, "h9");
  assert.equal((await L(S(false, false), S(true, true)).launch({})).tag, "h9");
  assert.equal((await L(S(true, true), S(false, false)).launch({})).tag, "hc");
  assert.deepEqual(await L(S(true, false), S(true, false)).launch({}), { ok: false, reason: "no-core" });
  assert.deepEqual(await L(S(false, false), S(false, false)).launch({}), { ok: false, reason: "not-installed" });
  assert.deepEqual(await L(S(true, false), S(true, true)).status(), { installed: true, running: true, app: false });
  assert.deepEqual(await L(S(false, false), S(false, false)).status(), { installed: false, running: false, app: false });
});

test("hc vivo en status() pero que cae antes de despachar → se prueba herdr 0.9; tras un posible despacho NUNCA (no se abren dos terminales)", async () => {
  const S = { installed: true, running: true, app: false };
  const run = async (hcResult, h9Status = S) => {
    let hcAttempts = 0, h9Attempts = 0;
    const l = createHerdrMultiLauncher({
      hcLauncher: { status: async () => S, launch: async () => { hcAttempts++; return hcResult; } },
      h9Launcher: { status: async () => h9Status, launch: async () => { h9Attempts++; return { ok: true, tag: "h9" }; } },
    });
    return { r: await l.launch({}), hcAttempts, h9Attempts };
  };
  // prueba de que NO se despachó nada → se cae a herdr 0.9
  for (const reason of ["no-core", "not-installed"]) {
    const o = await run({ ok: false, reason });
    assert.deepEqual([o.r.tag, o.hcAttempts, o.h9Attempts], ["h9", 1, 1], reason);
  }
  // pudo haberse creado el terminal (error / timeout) → NO se reintenta
  for (const bad of [{ ok: false, reason: "error", err: "x" }, { ok: false, reason: "error" }]) {
    const o = await run(bad);
    assert.deepEqual([o.r, o.hcAttempts, o.h9Attempts], [bad, 1, 0]);
  }
  // hc funcionó → herdr 0.9 ni se toca
  const ok = await run({ ok: true, tag: "hc" });
  assert.deepEqual([ok.r.tag, ok.h9Attempts], ["hc", 0]);
  // hc cae pero herdr 0.9 tampoco está vivo → se devuelve el no-core de hc (el servidor abrirá en tmux)
  const none = await run({ ok: false, reason: "no-core" }, { installed: true, running: false, app: false });
  assert.deepEqual([none.r, none.h9Attempts], [{ ok: false, reason: "no-core" }, 0]);
});

test("hc→herdr 0.9 con lanzadores reales y exec/sondeos simulados: hc cae tras el sondeo y se abre el terminal con herdr 0.9", async () => {
  const f = fakeExec(ROUTES);
  const h9 = createHerdr9({ herdrPath: "/usr/bin/herdr", exec: f.exec, probe: async () => true, platform: "linux", home: "/h", isSocket: () => false, env: {} });
  let probes = 0;
  const hcLauncher = createHerdrLauncher({
    getHerdr: () => ({
      coreUp: async () => ++probes === 1, // vivo para status(), muerto cuando launch() lo vuelve a sondear
      hcEnv: async () => null, run: async () => ({ ok: false, err: "x", code: "NOCORE" }), markOwned: async () => ({ ok: true }), invalidate() {},
    }),
    findApp: () => null,
  });
  const l = createHerdrMultiLauncher({ hcLauncher, h9Launcher: createHerdr9Launcher({ getHerdr9: () => h9 }) });
  const r = await l.launch({ agentId: "claude", cwd: "/tmp", argv: ["claude"] });
  assert.equal(r.ok, true);
  assert.equal(r.paneId, "h9:w1:pB");
  assert.equal(f.calls.filter((c) => c.argv[0] === "tab" && c.argv[1] === "create").length, 1);
});

test("kill de herdr 0.9 por la fachada: ajeno sin force → 409 y nada cerrado", async () => {
  const tab = JSON.stringify({ result: { tab: { label: "trabajo", pane_count: 1, tab_id: "w1:tB" } } });
  const f = h9Panes({ routes: { ...ROUTES, "pane get w1:pB": { out: fx("pane-get-owned.json") }, "tab get w1:tB": { out: tab }, "pane close": { out: "" }, "tab close": { out: "" } } });
  const multi = createHerdrMulti({ hcPanes: hcPanes(), h9Panes: f.panes });
  const r = await multi.kill("h9:w1:pB", { force: false });
  assert.deepEqual([r.ok, r.status, r.needsConfirm], [false, 409, true]);
  assert.ok(!f.calls.some((c) => c.argv[1] === "close"));
  assert.equal((await multi.kill("h9:w1:pB", { force: true })).ok, true);
  assert.deepEqual(f.calls.at(-1).argv, ["pane", "close", "w1:pB"]);
  assert.ok(!f.calls.some((c) => c.argv[0] === "tab" && c.argv[1] === "close"));
});

test("herdrFailure respeta un 4xx explícito de cualquier backend; sin status mantiene el mapa de siempre", () => {
  assert.deepEqual(herdrFailure({ ok: false, status: 400, err: "tecla no permitida" }), { status: 400, body: { ok: false, err: "tecla no permitida" } });
  assert.equal(herdrFailure({ ok: false, status: 404, err: "x" }).status, 404);
  assert.equal(herdrFailure({ ok: false, status: 500, err: "x" }).status, 500); // un 5xx no se promueve
  assert.equal(herdrFailure({ ok: false, status: 200, err: "x" }).status, 500);
  assert.equal(herdrFailure({ ok: false, status: "400", err: "x" }).status, 500);
  assert.equal(herdrFailure({ ok: false, err: "texto vacío" }).status, 400);
  assert.equal(herdrFailure({ ok: false, err: "envío falló" }).status, 500);
  assert.equal(herdrFailure({ ok: false, err: "bloqueado: requiere a la persona" }).status, 409);
});

test("tecla no soportada por herdr 0.9 (Home) en un pane h9 → 400 por la fachada, no 500", async () => {
  const f = h9Panes();
  const multi = createHerdrMulti({ hcPanes: hcPanes(), h9Panes: f.panes });
  for (const key of ["Home", "End", "PageUp", "PageDown"]) {
    const r = await multi.keys("h9:w1:pB", key);
    assert.equal(r.ok, false);
    assert.equal(multi.failure(r).status, 400, key);
    assert.deepEqual(multi.failure(r).body, { ok: false, err: "tecla no permitida" });
  }
  assert.ok(!f.calls.some((c) => c.argv[1] === "send-keys"));
  const bad = await multi.keys("h9:w1:pB", "Enter"); // control: una tecla válida sí se ejecuta
  assert.deepEqual(bad, { ok: true });
});
