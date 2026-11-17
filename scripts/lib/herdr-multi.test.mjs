import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHerdr9 } from "./herdr9.mjs";
import { createHerdr9Panes, herdr9KeyArgs } from "./herdr9-panes.mjs";
import { createHerdr9Launcher } from "./herdr9-launch.mjs";
import { createHerdrPanes } from "./herdr-panes.mjs";
import { containsHerdrId, createHerdrMulti, createHerdrMultiLauncher, detectBackends, isHerdrId } from "./herdr-multi.mjs";

const FX = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "herdr9");
const fx = (name) => readFileSync(join(FX, name), "utf8");

function fakeExec(routes) {
  const calls = [];
  const exec = (bin, argv, opts, cb) => {
    calls.push({ bin, argv });
    const key = argv.join(" ");
    const hit = Object.entries(routes).find(([k]) => key === k || key.startsWith(`${k} `));
    const r = hit?.[1];
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
function h9Panes({ installed = true, up = true, routes = ROUTES, color = true } = {}) {
  const f = fakeExec(routes);
  const panes = createHerdr9Panes({
    findCli: () => (installed ? "/usr/bin/herdr" : null),
    createHerdr9: ({ herdrPath }) => createHerdr9({ herdrPath, exec: f.exec, probe: async () => up, platform: "linux", home: "/h", isSocket: () => false, env: {} }),
    color,
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

test("view: color con --ansi y cae a texto plano si la lectura en color falla o MT3K_HERDR_COLOR=0", async () => {
  const ansi = h9Panes();
  const v = await ansi.panes.view("h9:w1:pB");
  assert.equal(v.colored, true);
  assert.ok(ansi.calls.some((c) => c.argv.includes("--ansi")));
  const plain = h9Panes({ color: false });
  assert.equal((await plain.panes.view("h9:w1:pB")).colored, undefined);
  assert.ok(!plain.calls.some((c) => c.argv.includes("--ansi")));
  const failing = h9Panes({ routes: { ...ROUTES, "pane read": { err: true, code: 1 } } });
  assert.deepEqual(await failing.panes.view("h9:w1:pB"), { ok: false, err: "lectura falló" });
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

test("errores del lister no salen: exec que falla y servidor caído devuelven []", async () => {
  const bad = h9Panes({ routes: { "pane list": { err: true, code: "ETIMEDOUT" } } });
  assert.deepEqual(await bad.panes.refresh(true), []);
  const down = h9Panes({ up: false });
  assert.deepEqual(await down.panes.refresh(true), []);
  assert.equal(down.calls.length, 0);
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

test("kill de herdr 0.9 por la fachada: ajeno sin force → 409 y nada cerrado", async () => {
  const tab = JSON.stringify({ result: { tab: { label: "trabajo", pane_count: 1, tab_id: "w1:tB" } } });
  const f = h9Panes({ routes: { ...ROUTES, "pane get w1:pB": { out: fx("pane-get-owned.json") }, "tab get w1:tB": { out: tab }, "pane close": { out: "" }, "tab close": { out: "" } } });
  const multi = createHerdrMulti({ hcPanes: hcPanes(), h9Panes: f.panes });
  const r = await multi.kill("h9:w1:pB", { force: false });
  assert.deepEqual([r.ok, r.status, r.needsConfirm], [false, 409, true]);
  assert.ok(!f.calls.some((c) => c.argv[1] === "close"));
  assert.equal((await multi.kill("h9:w1:pB", { force: true })).ok, true);
  assert.deepEqual(f.calls.at(-1).argv, ["pane", "close", "w1:pB"]);
});
