import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFile, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHerdr9Panes } from "./herdr9-panes.mjs";
import { createHerdr9Launcher } from "./herdr9-launch.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PANEL_TAB_RE, createHerdr9, herdr9SocketPath, isHerdr9Id, openInputError, paneOf,
  parseErrorCode, parsePaneList, parseTabCreate, parseTabLabels, shellQuote,
} from "./herdr9.mjs";

const FX = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "herdr9");
const fx = (name) => readFileSync(join(FX, name), "utf8");

// exec falso: registra (bin, argv) y responde según argv.join(" ")
function fakeExec(routes) {
  const calls = [];
  const exec = (bin, argv, opts, cb) => {
    calls.push({ bin, argv, opts });
    const key = argv.join(" ");
    const hit = Object.entries(routes).find(([k]) => key === k || key.startsWith(`${k} `));
    const r = typeof hit?.[1] === "function" ? hit[1](argv) : hit?.[1];
    if (!r) return cb(Object.assign(new Error("no route"), { code: 1 }), "", "");
    if (r.err) return cb(Object.assign(new Error("fail"), { code: r.code ?? 1 }), r.out ?? "", "");
    return cb(null, r.out ?? "", "");
  };
  return { exec, calls };
}
// ledger = REGISTRO de lo que `tab create` devolvió: terminal_id + pane + pestaña + nombre exacto
const REC = {
  term_6606d82b37789b: { pane: "w1:pB", tab: "w1:tB", label: "mt3k-claude-0a1b2c-x1" },
  term_6606d374946717: { pane: "w1:p7", tab: "w1:t7", label: "mt3k-cursor-0a1b2c-x1" },
  term_old: { pane: "w1:p9", tab: "w1:t9", label: "mt3k-claude-0a1b2c-x1" },
};
const L = (...ids) => new Map(ids.map((id) => [id, { terminal: id, ...REC[id], at: 0 }]));
const up = async () => true;
const down = async () => false;
const make = (routes, extra = {}) => {
  const f = fakeExec(routes);
  const h = createHerdr9({ herdrPath: "/usr/bin/herdr", exec: f.exec, probe: up, platform: "linux", home: "/h", env: { HERDR_SOCKET_PATH: "" }, ...extra });
  return { h, ...f };
};

test("isHerdr9Id / paneOf: solo h9:w<n>:p<x>", () => {
  for (const ok of ["h9:w1:p3", "h9:w12:pA", "h9:w1:p1f"]) { assert.equal(isHerdr9Id(ok), true, ok); }
  for (const bad of ["hc:t9", "w1:p3", "h9:", "h9:w1:p", "h9:w1:p3;rm", "h9:w1:p3 x", "h9:w1:t3", "h9:-w1:p3", "h9:w1:p3\n", "h9:w:p3", "h9:w1:p123456789", 7, null, undefined]) {
    assert.equal(isHerdr9Id(bad), false, String(bad));
  }
  assert.equal(paneOf("h9:w1:pA"), "w1:pA");
  assert.equal(paneOf("hc:t1"), null);
});

test("parsePaneList: fixture real de herdr 0.9.5 → filas con agente, estado y carpeta actual", () => {
  const rows = parsePaneList(fx("pane-list.json"));
  assert.equal(rows.length, 6);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(byId["h9:w1:p1"].agent, "codex");
  assert.equal(byId["h9:w1:p1"].status, "idle");
  assert.equal(byId["h9:w1:p7"].agent, "cursor");
  assert.equal(byId["h9:w1:p8"].agent, "antigravity"); // `agy` → antigravity
  assert.equal(byId["h9:w1:pA"].agent, "shell"); // pane sin agente reconocido
  assert.equal(byId["h9:w1:pA"].status, null); // "unknown" → sin estado
  assert.equal(byId["h9:w1:p7"].where, "Cursor Agent");
  assert.equal(byId["h9:w1:p7"].address, "w1:p7");
  assert.equal(byId["h9:w1:p7"].tabId, "w1:t7");
  assert.match(byId["h9:w1:p7"].terminalId, /^term_/);
  assert.ok(rows.every((r) => isHerdr9Id(r.id) && r.state === "live" && r.turn === 0));
});

test("parsePaneList: entradas inválidas se descartan y nunca lanza", () => {
  assert.deepEqual(parsePaneList("no es json"), []);
  assert.deepEqual(parsePaneList(""), []);
  assert.deepEqual(parsePaneList('{"result":{"panes":"x"}}'), []);
  const rows = parsePaneList(JSON.stringify({ result: { panes: [null, 3, { pane_id: "w1:p1; rm -rf" }, { pane_id: "w1:p2", agent: "claude", agent_status: "working", cwd: "/a", foreground_cwd: "/b" }] } }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].agent, "claude");
  assert.equal(rows[0].status, "working");
  assert.equal(rows[0].cwd, "/b"); // gana la carpeta del primer plano
});

test("parseTabLabels / parseTabCreate / parseErrorCode con fixtures", () => {
  const labels = parseTabLabels(fx("tab-list.json"));
  assert.equal(labels.get("w1:t5"), "codex");
  assert.equal(labels.size, 6);
  assert.deepEqual(parseTabCreate(fx("tab-create.json")), { pane: "w1:pB", tab: "w1:tB", terminal: "term_6606d82b37789b" });
  assert.equal(parseTabCreate('{"result":{}}'), null);
  assert.equal(parseTabCreate("x"), null);
  assert.equal(parseErrorCode(fx("pane-get-missing.json")), "pane_not_found");
  assert.equal(parseErrorCode("nope"), null);
});

test("shellQuote / openInputError: comillas simples y validación estricta", () => {
  assert.equal(shellQuote("a b"), "'a b'");
  assert.equal(shellQuote("c'd"), "'c'\\''d'");
  assert.equal(openInputError({ cwd: "/tmp", label: "mt3k-claude-abc123-x1", argv: ["a"] }), null);
  assert.equal(openInputError({ cwd: "/tmp", label: "mt3k-claude-abc123-x1", argv: [] }), null);
  for (const bad of [
    { cwd: "tmp", label: "mt3k-claude-abc123-x1", argv: [] },
    { cwd: "/tmp\n", label: "mt3k-claude-abc123-x1", argv: [] },
    { cwd: "/tmp", label: "otro", argv: [] },
    { cwd: "/tmp", label: "-mt3k-claude-abc123-x1", argv: [] },
    { cwd: "/tmp", label: "mt3k-claude-abc123-x1", argv: ["a\nb"] },
    { cwd: "/tmp", label: "mt3k-claude-abc123-x1", argv: ["a\0b"] },
    { cwd: "/tmp", label: "mt3k-claude-abc123-x1", argv: [""] },
    { cwd: "/tmp", label: "mt3k-claude-abc123-x1", argv: [7] },
    { cwd: "/tmp", label: "mt3k-claude-abc123-x1", argv: "x" },
  ]) assert.ok(openInputError(bad), JSON.stringify(bad));
  assert.ok(PANEL_TAB_RE.test("mt3k-claude-0a1b2c-x1"));
});

test("herdr9SocketPath: UN solo endpoint (override si existe, si no el de ~/.config); override inválido = ninguno", () => {
  assert.equal(herdr9SocketPath({ env: {}, home: "/home/u" }), "/home/u/.config/herdr/herdr.sock");
  assert.equal(herdr9SocketPath({ env: { XDG_CONFIG_HOME: "/x" }, home: "/home/u" }), "/x/herdr/herdr.sock");
  assert.equal(herdr9SocketPath({ env: { HERDR_SOCKET_PATH: "/run/h.sock" }, home: "/home/u" }), "/run/h.sock");
  assert.equal(herdr9SocketPath({ env: { HERDR_SOCKET_PATH: "rel.sock" }, home: "/home/u" }), null);
  assert.equal(herdr9SocketPath({ env: { HERDR_SOCKET_PATH: "" }, home: "/home/u" }), "/home/u/.config/herdr/herdr.sock");
});

test("override caído + socket por defecto vivo → NO corriendo y cero exec (no se valida un socket distinto del que usaría la CLI)", async () => {
  const probed = [];
  const probe = async (sock) => { probed.push(sock); return sock === "/h/.config/herdr/herdr.sock"; }; // el por defecto vive, el override no
  const { h, calls } = make({ "pane list": { out: fx("pane-list.json") } }, { probe, env: { HERDR_SOCKET_PATH: "/run/muerto.sock", HOME: "/h" } });
  assert.equal(await h.coreUp(), false);
  assert.deepEqual(await h.list(), []);
  assert.equal((await h.send("h9:w1:p1", "x")).ok, false);
  assert.equal(calls.length, 0);
  assert.ok(probed.length >= 1 && probed.every((p) => p === "/run/muerto.sock"), probed.join(","));
  assert.deepEqual(h.health(), { ok: true }); // servidor no corriendo ≠ backend roto
});

test("la CLI se ejecuta con HERDR_SOCKET_PATH = el socket que se sondeó (override o por defecto)", async () => {
  for (const [env, want] of [[{ HERDR_SOCKET_PATH: "/run/h.sock" }, "/run/h.sock"], [{ HERDR_SOCKET_PATH: "", HOME: "/h", XDG_CONFIG_HOME: "" }, "/h/.config/herdr/herdr.sock"]]) {
    const { h, calls } = make({ "pane list": { out: fx("pane-list.json") } }, { env, probe: async (s) => s === want });
    assert.equal((await h.list()).length, 6);
    assert.equal(calls[0].opts.env.HERDR_SOCKET_PATH, want);
  }
  assert.equal(herdr9SocketPath({ env: { HERDR_SOCKET_PATH: "rel.sock" } }), null);
  const bad = make({ "pane list": { out: fx("pane-list.json") } }, { env: { HERDR_SOCKET_PATH: "rel.sock" } });
  assert.deepEqual(await bad.h.list(), []);
  assert.equal(bad.calls.length, 0);
});

test("sin servidor vivo (o win32, o sin binario) NINGÚN método ejecuta herdr", async () => {
  for (const extra of [{ probe: down }, { platform: "win32" }, { herdrPath: null }]) {
    const { h, calls } = make({}, extra);
    assert.deepEqual(await h.list(), []);
    assert.equal((await h.read("h9:w1:p1")).ok, false);
    assert.equal((await h.send("h9:w1:p1", "x")).ok, false);
    assert.equal((await h.keys("h9:w1:p1", ["enter"])).ok, false);
    assert.equal((await h.get("h9:w1:p1")).ok, false);
    assert.equal((await h.openTab({ cwd: "/tmp", label: "mt3k-a-abc123-x1", argv: [] })).ok, false);
    assert.equal((await h.killTerminal("h9:w1:p1")).ok, false);
    assert.equal(await h.coreUp(), false);
    assert.equal(calls.length, 0);
  }
});

test("list: argv fijo `pane list`; sin terminales del panel no se lee `tab list`", async () => {
  const { h, calls } = make({ "pane list": { out: fx("pane-list.json") } });
  const rows = await h.list();
  assert.equal(rows.length, 6);
  assert.deepEqual(calls.map((c) => c.argv), [["pane", "list"]]);
  assert.ok(rows.every((r) => !r.killable));
  assert.equal(calls[0].bin, "/usr/bin/herdr");
  assert.ok(calls[0].opts.timeout > 0 && calls[0].opts.maxBuffer > 0);
});

test("list: error, timeout o salida ilegible → [] sin lanzar PERO el fallo queda registrado en health()", async () => {
  for (const routes of [{ "pane list": { err: true, code: 1, out: "" } }, { "pane list": { out: "basura" } }, {}, { "pane list": { err: true, code: "ETIMEDOUT" } }, { "pane list": { out: '{"result":{"panes":"x"}}' } }]) {
    const { h } = make(routes);
    assert.equal(h.health().ok, true); // antes de listar no hay nada que reportar
    assert.deepEqual(await h.list(), []);
    const hh = h.health();
    assert.equal(hh.ok, false, JSON.stringify(routes));
    assert.match(hh.err, /herdr pane list/);
  }
  const ok = make({ "pane list": { out: fx("pane-list.json") } });
  assert.equal((await ok.h.list()).length, 6);
  assert.deepEqual(ok.h.health(), { ok: true });
  // una lista legítimamente vacía NO es un fallo
  const empty = make({ "pane list": { out: '{"result":{"panes":[]}}' } });
  assert.deepEqual(await empty.h.list(), []);
  assert.deepEqual(empty.h.health(), { ok: true });
  // servidor caído = "no corriendo", no un backend roto
  const off = make({}, { probe: down });
  assert.deepEqual(await off.h.list(), []);
  assert.deepEqual(off.h.health(), { ok: true });
});

test("fallo de `tab list`: las filas vuelven degradadas (sin killable) y el fallo queda en health()", async () => {
  const ledger = L("term_6606d374946717");
  const lbl = JSON.stringify({ result: { tabs: [{ tab_id: "w1:t7", label: "mt3k-cursor-0a1b2c-x1" }] } });
  const variants = [
    [{ err: true, code: "ETIMEDOUT" }, /herdr tab list falló \(ETIMEDOUT\)/],
    [{ err: true, code: 1 }, /herdr tab list falló \(1\)/],
    [{ out: "basura" }, /tab list devolvió una salida ilegible/],
    [{ out: '{"result":{"tabs":"x"}}' }, /ilegible/],
  ];
  for (const [tabRoute, re] of variants) {
    const { h } = make({ "pane list": { out: fx("pane-list.json") }, "tab list": tabRoute }, { ledger: new Map(ledger) });
    const rows = await h.list();
    assert.equal(rows.length, 6); // la lista sigue entera
    assert.ok(rows.every((r) => !r.killable));
    assert.equal(h.health().ok, false);
    assert.match(h.health().err, re);
  }
  // con `tab list` sano el mismo ledger sí marca killable y health queda ok
  const ok = make({ "pane list": { out: fx("pane-list.json") }, "tab list": { out: lbl } }, { ledger: new Map(ledger) });
  assert.deepEqual((await ok.h.list()).filter((r) => r.killable).map((r) => r.id), ["h9:w1:p7"]);
  assert.deepEqual(ok.h.health(), { ok: true });
});

test("health se recupera cuando la lista vuelve a responder", async () => {
  let fail = true;
  const { h } = make({ "pane list": () => (fail ? { err: true, code: 1 } : { out: fx("pane-list.json") }) });
  await h.list();
  assert.equal(h.health().ok, false);
  fail = false;
  assert.equal((await h.list()).length, 6);
  assert.deepEqual(h.health(), { ok: true });
});

test("read: argv por fuente/líneas/color, id inválido rechazado sin ejecutar", async () => {
  const ansi = fx("pane-read-ansi.txt");
  const { h, calls } = make({ "pane read": { out: ansi } });
  assert.deepEqual(await h.read("h9:w1:pB", { lines: 0 }), { ok: true, text: ansi });
  assert.deepEqual(calls.at(-1).argv, ["pane", "read", "w1:pB", "--source", "visible"]);
  await h.read("h9:w1:pB", { lines: 99999, ansi: true });
  assert.deepEqual(calls.at(-1).argv, ["pane", "read", "w1:pB", "--source", "recent", "--lines", "2000", "--ansi"]);
  await h.read("h9:w1:pB", { lines: -5 });
  assert.deepEqual(calls.at(-1).argv, ["pane", "read", "w1:pB", "--source", "visible"]);
  const n = calls.length;
  for (const bad of ["hc:t1", "h9:w1:p1; ls", "w1:p1", "h9:w1:p-1", "", null]) assert.deepEqual(await h.read(bad), { ok: false, err: "terminal inválido" });
  assert.equal(calls.length, n);
  assert.match(ansi, /\x1b\[0m/); // la fixture lleva SGR real
  const fail = make({ "pane read": { err: true, code: 1, out: fx("pane-get-missing.json") } });
  assert.deepEqual(await fail.h.read("h9:w1:pZ"), { ok: false, err: "lectura falló" });
});

test("send: `pane run` con el texto tal cual (incluido el que empieza por -), validaciones y errores", async () => {
  const { h, calls } = make({ "pane run": { out: "" } });
  assert.deepEqual(await h.send("h9:w1:p3", "hola mundo"), { ok: true });
  assert.deepEqual(calls.at(-1).argv, ["pane", "run", "w1:p3", "hola mundo"]);
  await h.send("h9:w1:p3", "--help");
  assert.deepEqual(calls.at(-1).argv, ["pane", "run", "w1:p3", "--help"]); // sin `--`: herdr lo escribiría literal
  const n = calls.length;
  assert.deepEqual(await h.send("hc:t1", "x"), { ok: false, err: "terminal inválido" });
  assert.deepEqual(await h.send("h9:w1:p3", ""), { ok: false, err: "texto vacío" });
  assert.deepEqual(await h.send("h9:w1:p3", "a\u0000b"), { ok: false, err: "texto inválido" });
  assert.deepEqual(await h.send("h9:w1:p3", "x".repeat(70000)), { ok: false, err: "texto demasiado largo" });
  assert.equal(calls.length, n);
  assert.equal((await make({ "pane run": { err: true, code: 1 } }).h.send("h9:w1:p3", "x")).err, "envío falló");
});

test("keys: send-keys con teclas validadas", async () => {
  const { h, calls } = make({ "pane send-keys": { out: "" } });
  assert.deepEqual(await h.keys("h9:w1:p3", ["ctrl+x", "ctrl+s"]), { ok: true });
  assert.deepEqual(calls.at(-1).argv, ["pane", "send-keys", "w1:p3", "ctrl+x", "ctrl+s"]);
  const n = calls.length;
  for (const bad of [[], ["-h"], ["a b"], ["enter;ls"], [7], Array(40).fill("up"), ["--help"]]) assert.deepEqual(await h.keys("h9:w1:p3", bad), { ok: false, err: "teclas inválidas" });
  assert.equal(calls.length, n);
  assert.equal((await make({ "pane send-keys": { err: true, code: 1 } }).h.keys("h9:w1:p3", ["up"])).err, "teclas fallaron");
});

test("openTab: crea pestaña sin foco con nombre del panel y escribe el argv entre comillas; el terminal queda en el ledger", async () => {
  const ledger = new Map();
  const { h, calls } = make({ "tab create": { out: fx("tab-create.json") }, "pane run": { out: "" } }, { ledger });
  const r = await h.openTab({ cwd: "/tmp", label: "mt3k-claude-0a1b2c-x1", argv: ["/usr/bin/env", "PATH=/a b", "claude", "it's"] });
  assert.deepEqual(r, { ok: true, pane: "w1:pB", id: "h9:w1:pB", tab: "w1:tB" });
  assert.deepEqual(calls[0].argv, ["tab", "create", "--no-focus", "--label", "mt3k-claude-0a1b2c-x1", "--cwd", "/tmp"]);
  assert.deepEqual(calls[1].argv, ["pane", "run", "w1:pB", "'/usr/bin/env' 'PATH=/a b' 'claude' 'it'\\''s'"]);
  assert.ok(ledger.has("term_6606d82b37789b"));
});

test("openTab: sin argv solo crea la pestaña; entrada inválida no ejecuta nada; fallo al escribir cierra la pestaña propia", async () => {
  const a = make({ "tab create": { out: fx("tab-create.json") } });
  assert.equal((await a.h.openTab({ cwd: "/tmp", label: "mt3k-shell-0a1b2c-x1", argv: [] })).ok, true);
  assert.equal(a.calls.length, 1);

  const b = make({});
  assert.deepEqual(await b.h.openTab({ cwd: "rel", label: "mt3k-a-0a1b2c-x1", argv: [] }), { ok: false, err: "carpeta inválida" });
  assert.equal(b.calls.length, 0);

  const c = make({ "tab create": { out: fx("tab-create.json") }, "pane run": { err: true, code: 1 }, "pane close": { out: "" } });
  assert.deepEqual(await c.h.openTab({ cwd: "/tmp", label: "mt3k-a-0a1b2c-x1", argv: ["x"] }), { ok: false, err: "no se pudo escribir el comando" });
  assert.deepEqual(c.calls.at(-1).argv, ["pane", "close", "w1:pB"]); // pane propio recién creado; nunca `tab close`

  assert.equal((await make({ "tab create": { err: true, code: 1 } }).h.openTab({ cwd: "/tmp", label: "mt3k-a-0a1b2c-x1", argv: [] })).err, "no se pudo crear el terminal");
  assert.equal((await make({ "tab create": { out: "{}" } }).h.openTab({ cwd: "/tmp", label: "mt3k-a-0a1b2c-x1", argv: [] })).err, "herdr no devolvió el terminal");
});

const OWNED_ROUTES = {
  "pane get w1:pB": { out: fx("pane-get-owned.json") },
  "tab get w1:tB": { out: fx("tab-get.json") }, // etiqueta real de la fixture: mt3k-fixture (NO es nombre del panel)
};

test("get: etiqueta mt3k.panel solo con terminal en el ledger Y pestaña con nombre del panel", async () => {
  const tabNamed = (label) => JSON.stringify({ result: { tab: { label, pane_count: 1, tab_id: "w1:tB" } } });
  const mk = (ledger, label) => make({ ...OWNED_ROUTES, "tab get w1:tB": { out: tabNamed(label) } }, { ledger });
  const mine = "term_6606d82b37789b";
  assert.equal((await mk(L(mine), "mt3k-claude-0a1b2c-x1").h.get("h9:w1:pB")).labels["mt3k.panel"], "1");
  assert.deepEqual((await mk(new Map(), "mt3k-claude-0a1b2c-x1").h.get("h9:w1:pB")).labels, {}); // nombre del panel pero otro proceso/arranque
  assert.deepEqual((await mk(L(mine), "mt3k-fixture").h.get("h9:w1:pB")).labels, {}); // en el ledger pero renombrada
  const g = await mk(L(mine), "mt3k-claude-0a1b2c-x1").h.get("h9:w1:pB");
  assert.equal(g.cwd, "/tmp");
  assert.equal(g.state, "live");
  assert.deepEqual(await make({}).h.get("hc:t1"), { ok: false, err: "terminal inválido" });
});

test("killTerminal: del panel → `pane close` de ESE pane; ajeno sin force → 409 sin tocar nada; ajeno con force:true → pane close; force no booleano no vale", async () => {
  const tabNamed = (label) => JSON.stringify({ result: { tab: { label, pane_count: 1, tab_id: "w1:tB" } } });
  const mine = "term_6606d82b37789b";
  const routes = (label) => ({ ...OWNED_ROUTES, "tab get w1:tB": { out: tabNamed(label) }, "tab close": { out: fx("tab-close.txt") }, "pane close": { out: "" } });
  const closes = (calls) => calls.filter((c) => c.argv[1] === "close");

  const own = make(routes("mt3k-claude-0a1b2c-x1"), { ledger: L(mine) });
  assert.deepEqual(await own.h.killTerminal("h9:w1:pB"), { ok: true, removed: true, forced: false });
  assert.deepEqual(closes(own.calls).map((c) => c.argv), [["pane", "close", "w1:pB"]]);

  const foreign = make(routes("trabajo"), { ledger: L(mine) });
  const denied = await foreign.h.killTerminal("h9:w1:pB");
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 409);
  assert.equal(denied.needsConfirm, true);
  assert.equal(closes(foreign.calls).length, 0);
  for (const f of ["true", 1, "yes", {}]) {
    assert.equal((await foreign.h.killTerminal("h9:w1:pB", { force: f })).status, 409);
  }
  assert.equal(closes(foreign.calls).length, 0);

  const forced = await foreign.h.killTerminal("h9:w1:pB", { force: true });
  assert.deepEqual(forced, { ok: true, removed: true, forced: true });
  assert.deepEqual(closes(foreign.calls).map((c) => c.argv), [["pane", "close", "w1:pB"]]); // nunca cierra la pestaña de un terminal ajeno

  const gone = await make({ "pane get": { err: true, code: 1, out: fx("pane-get-missing.json") } }).h.killTerminal("h9:w1:pZ");
  assert.deepEqual([gone.ok, gone.status], [false, 404]);
  assert.equal((await make({}).h.killTerminal("hc:t1")).status, 400);
});

test("killTerminal: otro pane añadido a la pestaña entre la lectura y el cierre NUNCA provoca `tab close`", async () => {
  const mine = "term_6606d82b37789b";
  let tabReads = 0;
  // la primera lectura ve 1 pane; cualquier otra (o el estado real al cerrar) ya tendría 2: el cierre no puede depender de ese conteo
  const tab = () => { tabReads++; return { out: JSON.stringify({ result: { tab: { label: "mt3k-claude-0a1b2c-x1", pane_count: tabReads === 1 ? 1 : 2, tab_id: "w1:tB" } } }) }; };
  const m = make({ ...OWNED_ROUTES, "tab get w1:tB": tab, "pane close": { out: "" }, "tab close": { out: "" } }, { ledger: L(mine) });
  assert.deepEqual(await m.h.killTerminal("h9:w1:pB"), { ok: true, removed: true, forced: false });
  assert.ok(!m.calls.some((c) => c.argv[0] === "tab" && c.argv[1] === "close"), JSON.stringify(m.calls.map((c) => c.argv)));
  assert.deepEqual(m.calls.at(-1).argv, ["pane", "close", "w1:pB"]);
  // tampoco forzado ni con una pestaña que ya traía varios panes
  const f = make({ ...OWNED_ROUTES, "tab get w1:tB": { out: JSON.stringify({ result: { tab: { label: "x", pane_count: 3, tab_id: "w1:tB" } } }) }, "pane close": { out: "" }, "tab close": { out: "" } });
  assert.equal((await f.h.killTerminal("h9:w1:pB", { force: true })).ok, true);
  assert.ok(!f.calls.some((c) => c.argv[0] === "tab" && c.argv[1] === "close"));
});

test("killTerminal: un fallo de `close` no lanza y se informa", async () => {
  const tabNamed = JSON.stringify({ result: { tab: { label: "mt3k-claude-0a1b2c-x1", pane_count: 1, tab_id: "w1:tB" } } });
  const m = make({ ...OWNED_ROUTES, "tab get w1:tB": { out: tabNamed }, "pane close": { err: true, code: 1 } }, { ledger: L("term_6606d82b37789b") });
  const r = await m.h.killTerminal("h9:w1:pB");
  assert.deepEqual([r.ok, r.status], [false, 500]);
});

test("list marca killable solo los terminales del panel (ledger + nombre de pestaña)", async () => {
  const ledger = L("term_6606d374946717"); // el de w1:p7 (pestaña w1:t7)
  const labels = (l) => JSON.stringify({ result: { tabs: [{ tab_id: "w1:t7", label: l }] } });
  const run = async (l) => (await make({ "pane list": { out: fx("pane-list.json") }, "tab list": { out: labels(l) } }, { ledger }).h.list()).filter((r) => r.killable).map((r) => r.id);
  assert.deepEqual(await run("mt3k-cursor-0a1b2c-x1"), ["h9:w1:p7"]);
  assert.deepEqual(await run("4"), []);
});

test("el ledger olvida un terminal que ya no aparece en la lista: un id reutilizado con nombre mt3k-… NO hereda 'abierto por el panel'", async () => {
  let t = 1000;
  const ledger = new Map();
  const X = "term_6606d82b37789b"; // el id de tab-create.json
  const listJson = (terminals) => JSON.stringify({ result: { panes: terminals.map((tid, i) => ({ pane_id: i === 0 ? "w1:pB" : `w1:p${i + 1}`, tab_id: "w1:tB", terminal_id: tid, cwd: "/tmp" })) } });
  const tabsJson = JSON.stringify({ result: { tabs: [{ tab_id: "w1:tB", label: "mt3k-claude-0a1b2c-x1" }] } });
  let panes = listJson([X]);
  const { h } = make({
    "tab create": { out: fx("tab-create.json") }, "pane run": { out: "" },
    "pane list": () => ({ out: panes }), "tab list": { out: tabsJson },
    "pane get": { out: fx("pane-get-owned.json") }, "tab get": { out: JSON.stringify({ result: { tab: { label: "mt3k-claude-0a1b2c-x1", pane_count: 1, tab_id: "w1:tB" } } }) },
    "pane close": { out: "" },
  }, { ledger, now: () => t });
  await h.openTab({ cwd: "/tmp", label: "mt3k-claude-0a1b2c-x1", argv: ["x"] });
  assert.ok(ledger.has(X));
  assert.equal((await h.list())[0].killable, true); // propio y presente
  // desaparece fuera del panel; dentro del margen de creación todavía se conserva (una lista previa no lo poda)…
  panes = listJson([]);
  t += 2000;
  await h.list();
  assert.ok(ledger.has(X));
  // …pasado el margen, una lista válida sin él lo olvida
  t += 20000;
  await h.list();
  assert.equal(ledger.has(X), false);
  // más tarde otro terminal recibe el mismo id y una pestaña mt3k-…: NO es del panel
  panes = listJson([X]);
  const again = await h.list();
  assert.equal(again[0].killable, undefined);
  assert.deepEqual((await h.get("h9:w1:pB")).labels, {});
  const closed = await h.killTerminal("h9:w1:pB");
  assert.deepEqual([closed.ok, closed.status, closed.needsConfirm], [false, 409, true]);
});

test("el ledger NO se poda con una lista fallida", async () => {
  let t = 1000;
  const ledger = L("term_old");
  let mode = "bad";
  const { h } = make({ "pane list": () => (mode === "bad" ? { err: true, code: 1 } : { out: '{"result":{"panes":[]}}' }), "tab list": { out: '{"result":{"tabs":[]}}' } }, { ledger, now: () => t });
  t += 60000;
  await h.list();
  assert.ok(ledger.has("term_old")); // el fallo no prueba que el terminal haya desaparecido
  mode = "ok";
  await h.list();
  assert.equal(ledger.has("term_old"), false); // sin registro de creación (inyectado) se poda en la primera lista válida
});

test("un terminal_id reutilizado sin ver su ausencia NO hereda la propiedad: otro pane/pestaña u otro nombre mt3k-… → no killable, cierre sin force 409 y ningún `pane close`", async () => {
  const X = "term_6606d82b37789b"; // creado por el panel en w1:pB / w1:tB como mt3k-claude-0a1b2c-x1
  const label = (l) => JSON.stringify({ result: { tab: { label: l, pane_count: 1, tab_id: "w2:t2" } } });
  const scenario = (paneId, tabId, tabLabel) => {
    const lst = JSON.stringify({ result: { panes: [{ pane_id: paneId, tab_id: tabId, terminal_id: X, cwd: "/tmp" }] } });
    const tabs = JSON.stringify({ result: { tabs: [{ tab_id: tabId, label: tabLabel }] } });
    const get = JSON.stringify({ result: { pane: { pane_id: paneId, tab_id: tabId, terminal_id: X, cwd: "/tmp" } } });
    const tab = JSON.stringify({ result: { tab: { label: tabLabel, pane_count: 1, tab_id: tabId } } });
    return { "pane list": { out: lst }, "tab list": { out: tabs }, [`pane get ${paneId}`]: { out: get }, [`tab get ${tabId}`]: { out: tab }, "pane close": { out: "" } };
  };
  const cases = [
    ["otro pane y otra pestaña, nombre del panel idéntico", "w2:p2", "w2:t2", "mt3k-claude-0a1b2c-x1"],
    ["mismos pane y pestaña, otro nombre mt3k-…", "w1:pB", "w1:tB", "mt3k-claude-ffffff-z9"],
    ["mismo pane, otra pestaña", "w1:pB", "w2:t2", "mt3k-claude-0a1b2c-x1"],
  ];
  for (const [name, pane, tabId, tabLabel] of cases) {
    const ledger = L(X);
    const { h, calls } = make(scenario(pane, tabId, tabLabel), { ledger, now: () => 5 }); // sin lista vacía entre medias; dentro del margen de gracia
    const rows = await h.list();
    assert.equal(rows.length, 1, name);
    assert.equal(rows[0].killable, undefined, name);
    assert.equal(ledger.has(X), false, `${name}: la entrada vieja se borra`);
    // y con la entrada restaurada, `get`/`killTerminal` tampoco la heredan
    const again = make(scenario(pane, tabId, tabLabel), { ledger: L(X) });
    assert.deepEqual((await again.h.get(`h9:${pane}`)).labels, {}, name);
    const k = await make(scenario(pane, tabId, tabLabel), { ledger: L(X) }).h.killTerminal(`h9:${pane}`);
    assert.deepEqual([k.ok, k.status, k.needsConfirm], [false, 409, true], name);
    const kc = make(scenario(pane, tabId, tabLabel), { ledger: L(X) });
    await kc.h.killTerminal(`h9:${pane}`);
    assert.ok(!kc.calls.some((c) => c.argv[1] === "close"), `${name}: no debe emitir close`);
    void calls;
  }
  // control: con pane, pestaña y nombre exactos SÍ es del panel
  const ok = make(scenario("w1:pB", "w1:tB", "mt3k-claude-0a1b2c-x1"), { ledger: L(X) });
  assert.equal((await ok.h.list())[0].killable, true);
});

test("un fallo al leer el nombre de la pestaña niega la propiedad pero NO borra la entrada", async () => {
  const X = "term_6606d82b37789b";
  const ledger = L(X);
  const { h } = make({ ...OWNED_ROUTES, "tab get w1:tB": { err: true, code: "ETIMEDOUT" }, "pane close": { out: "" } }, { ledger });
  assert.deepEqual((await h.get("h9:w1:pB")).labels, {});
  assert.equal(ledger.has(X), true);
});

test("abrir y cerrar 20 terminales no deja residuo: un solo registro (ledger) y queda vacío", async () => {
  const ledger = new Map();
  let n = 0;
  const create = () => { n++; return { out: JSON.stringify({ result: { root_pane: { pane_id: `w1:p${n}`, tab_id: `w1:t${n}`, terminal_id: `term_${n}` }, tab: { tab_id: `w1:t${n}` } } }) }; };
  let cur = 0;
  const labelOf = (i) => `mt3k-claude-0a1b2c-${(i % 36).toString(36)}`;
  const { h } = make({
    "tab create": create, "pane run": { out: "" }, "pane close": { out: "" }, "pane list": { out: '{"result":{"panes":[]}}' }, "tab list": { out: '{"result":{"tabs":[]}}' },
    "pane get": (argv) => ({ out: JSON.stringify({ result: { pane: { pane_id: argv[2], tab_id: `w1:t${cur}`, terminal_id: `term_${cur}` } } }) }),
    "tab get": () => ({ out: JSON.stringify({ result: { tab: { label: labelOf(cur), pane_count: 1, tab_id: `w1:t${cur}` } } }) }),
  }, { ledger });
  for (let i = 1; i <= 20; i++) {
    cur = i;
    const r = await h.openTab({ cwd: "/tmp", label: labelOf(i), argv: ["x"] });
    assert.equal(r.ok, true);
    assert.equal(ledger.size, 1);
    assert.equal((await h.killTerminal(r.id)).ok, true);
    assert.equal(ledger.size, 0);
  }
  await h.list();
  assert.equal(ledger.size, 0);
});

test("LEDGER_MAX: pasados 512 lanzamientos se descarta el más antiguo (FIFO) aunque siga vivo → pasa a ajeno (dirección segura)", async () => {
  const ledger = new Map();
  let n = 0;
  const create = () => { n++; return { out: JSON.stringify({ result: { root_pane: { pane_id: `w1:p${n}`, tab_id: `w1:t${n}`, terminal_id: `term_${n}` }, tab: { tab_id: `w1:t${n}` } } }) }; };
  const { h } = make({ "tab create": create }, { ledger });
  for (let i = 1; i <= 513; i++) await h.openTab({ cwd: "/tmp", label: "mt3k-claude-0a1b2c-x1", argv: [] });
  assert.equal(ledger.size, 512);
  assert.equal(ledger.has("term_1"), false);
  assert.equal(ledger.has("term_513"), true);
});

test("timeout y maxBuffer llegan a execFile en CADA llamada de cada operación", async () => {
  const tab = JSON.stringify({ result: { tab: { label: "mt3k-claude-0a1b2c-x1", pane_count: 1, tab_id: "w1:tB" } } });
  const { h, calls } = make({
    "pane list": { out: fx("pane-list.json") }, "tab list": { out: fx("tab-list.json") },
    "pane get w1:pB": { out: fx("pane-get-owned.json") }, "tab get w1:tB": { out: tab },
    "pane read": { out: "x" }, "pane run": { out: "" }, "pane send-keys": { out: "" },
    "tab create": { out: fx("tab-create.json") }, "pane close": { out: "" },
  }, { ledger: L("term_6606d82b37789b") });
  const MARK = () => calls.length;
  const slices = {};
  const step = async (name, fn) => { const from = MARK(); await fn(); slices[name] = calls.slice(from); };
  await step("list", () => h.list());
  await step("get", () => h.get("h9:w1:pB"));
  await step("read", () => h.read("h9:w1:pB", { lines: 10 }));
  await step("send", () => h.send("h9:w1:pB", "x"));
  await step("keys", () => h.keys("h9:w1:pB", ["up"]));
  await step("openTab", () => h.openTab({ cwd: "/tmp", label: "mt3k-claude-0a1b2c-x1", argv: ["x"] }));
  await step("kill", () => h.killTerminal("h9:w1:pB"));
  const want = {
    list: [["pane list", 5000], ["tab list", 5000]],
    get: [["pane get w1:pB", 5000], ["tab get w1:tB", 5000]],
    read: [["pane read w1:pB --source recent --lines 10", 8000]],
    send: [["pane run w1:pB x", 5000]],
    keys: [["pane send-keys w1:pB up", 5000]],
    openTab: [["tab create --no-focus --label mt3k-claude-0a1b2c-x1 --cwd /tmp", 8000], ["pane run w1:pB 'x'", 8000]],
    kill: [["pane get w1:pB", 5000], ["tab get w1:tB", 5000], ["pane close w1:pB", 5000]],
  };
  for (const [name, expected] of Object.entries(want)) {
    assert.deepEqual(slices[name].map((c) => [c.argv.join(" "), c.opts.timeout]), expected, name);
    for (const c of slices[name]) assert.equal(c.opts.maxBuffer, 4 * 1024 * 1024, `${name}: ${c.argv.join(" ")}`);
  }
  // simulado (NO prueba el corte de un proceso lento: eso lo hace el test con un proceso real): solo la traducción del error
  const t = make({ "pane read": { err: true, code: "ETIMEDOUT" } });
  assert.deepEqual(await t.h.read("h9:w1:p1"), { ok: false, err: "lectura falló" });
  const throwing = createHerdr9({ herdrPath: "/x", exec: () => { throw Object.assign(new Error("boom"), { code: "ERR_INVALID_ARG_VALUE" }); }, probe: up, platform: "linux", home: "/h", isSocket: () => false, env: {} });
  assert.deepEqual(await throwing.list(), []);
});

test("timeout REAL: el proceso ARRANCA y lo corta el timeout de execFile (no un fallo de arranque ni un fallo inmediato)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mt3k-h9-slow-"));
  const TIMEOUT = 600;
  try {
    // seam: `herdrPath` es un script inofensivo (nunca el `herdr` real) que deja una marca y duerme; exec = el execFile real
    const marker = join(dir, "started");
    const slow = join(dir, "herdr-slow");
    writeFileSync(slow, `#!/bin/sh\necho started >> '${marker}'\nexec sleep 8\n`);
    chmodSync(slow, 0o755);
    const errors = [];
    const spy = (bin, argv, opts, cb) => execFile(bin, argv, opts, (err, so, se) => { errors.push(err); cb(err, so, se); });
    const h = createHerdr9({ herdrPath: slow, exec: spy, probe: up, platform: "linux", home: dir, env: { HERDR_SOCKET_PATH: "" }, timeoutMs: TIMEOUT });
    for (const [name, fn] of [["read", () => h.read("h9:w1:p1")], ["send", () => h.send("h9:w1:p1", "x")], ["list", () => h.list()]]) {
      const before = errors.length;
      const t0 = Date.now();
      const r = await fn();
      const took = Date.now() - t0;
      assert.ok(took >= TIMEOUT - 50, `${name} volvió en ${took} ms: no esperó al timeout (fallo inmediato)`);
      assert.ok(took < 3000, `${name} tardó ${took} ms: el timeout no cortó el proceso`);
      assert.ok(Array.isArray(r) ? r.length === 0 : r.ok === false, name);
      const err = errors[before];
      assert.ok(err, `${name}: execFile devolvió error`);
      assert.notEqual(err.code, "ENOENT", `${name}: fallo de arranque, no timeout`);
      assert.equal(err.killed, true, `${name}: no fue cortado por el timeout`);
      assert.equal(err.signal, "SIGTERM", name);
    }
    // el script llegó a ejecutarse (con la máquina cargada el timeout puede cortar alguna llamada antes de que escriba su marca)
    assert.ok(readFileSync(marker, "utf8").trim().split("\n").length >= 1);
    assert.equal(h.health().ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- comillas: la línea que se escribe en el terminal nuevo se EJECUTA de verdad en cada shell ---
const NASTY = ["a\\' ; echo INJECTED #", "termina en barra\\", "$(id)", "`id`", 'comillas "dobles"', "dos\\\\barras", "con  espacios", "", "ñandú ✓ 日本", "$HOME ${HOME} ~", "a;b&c|d>e", "'", "''", "\\'"];
const SHELLS = [["sh", "/bin/sh"], ["zsh", "/bin/zsh"], ["fish", "/opt/homebrew/bin/fish"], ["bash", "/bin/bash"]];
for (const [name, bin] of SHELLS) {
  const have = existsSync(bin);
  test(`shellQuote ejecutado en ${name}: cada argumento sale literal y nunca el marcador inyectado`, { skip: have ? false : `${name} no está instalado (${bin})` }, () => {
    const line = ["printf", "<%s>\\n", ...NASTY].map(shellQuote).join(" ");
    const r = spawnSync(bin, ["-c", line], { encoding: "utf8", timeout: 10000 });
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    assert.equal(r.stdout, NASTY.map((a) => `<${a}>\n`).join(""), name);
    assert.ok(!r.stdout.split("\n").includes("INJECTED"), name);
  });
}

test("servidor caído tras un fallo: health vuelve a ok, status() sin error y el log de recuperación sale UNA vez", async () => {
  const logs = [];
  let mode = "fail";
  let upNow = true;
  const f = fakeExec({ "pane list": () => (mode === "fail" ? { err: true, code: 1 } : { out: fx("pane-list.json") }) });
  const panes = createHerdr9Panes({
    findCli: () => "/usr/bin/herdr",
    createHerdr9: ({ herdrPath }) => createHerdr9({ herdrPath, exec: f.exec, probe: async () => upNow, platform: "linux", home: "/h", env: { HERDR_SOCKET_PATH: "" } }),
    log: (m) => logs.push(m),
    ttlMs: 0,
  });
  const launcher = createHerdr9Launcher({ getHerdr9: () => panes.herdr9() });
  const poll = async () => { panes.invalidate(); return panes.refresh(true); };
  await poll();
  assert.equal(logs.length, 1);
  assert.deepEqual(await launcher.status(), { installed: true, running: true, app: false, error: logs[0].replace("[mt3k] herdr 0.9: ", "") });
  upNow = false; // el servidor se cae
  assert.deepEqual(await poll(), []);
  assert.deepEqual(panes.health(), { ok: true });
  assert.deepEqual(await launcher.status(), { installed: true, running: false, app: false }); // sin `error` ni `errors`
  assert.equal(logs.length, 2);
  assert.match(logs[1], /vuelve a responder/);
  for (let i = 0; i < 3; i++) await poll();
  assert.equal(logs.length, 2); // una sola línea de recuperación
  upNow = true; mode = "ok"; // vuelve sano: no hay nada más que registrar
  assert.equal((await poll()).length, 6);
  assert.equal(logs.length, 2);
});

test("win32: el backend 0.9 está apagado del todo: no se busca el binario y status() dice installed:false", async () => {
  let looked = 0;
  const panes = createHerdr9Panes({ platform: "win32", findCli: () => { looked++; return "C:\\x\\herdr.exe"; }, now: (() => { let t = 0; return () => (t += 60000); })() });
  assert.equal(panes.herdr9(), null);
  assert.deepEqual(await panes.refresh(true), []);
  assert.deepEqual(await createHerdr9Launcher({ getHerdr9: () => panes.herdr9() }).status(), { installed: false, running: false, app: false });
  assert.deepEqual(await createHerdr9Launcher({ getHerdr9: () => panes.herdr9() }).launch({ agentId: "claude", cwd: "/tmp", argv: [] }), { ok: false, reason: "not-installed" });
  assert.equal(looked, 0);
  const posix = createHerdr9Panes({ platform: "linux", findCli: () => { looked++; return "/usr/bin/herdr"; } });
  assert.ok(posix.herdr9());
  assert.equal(looked, 1); // control: en Linux sí se busca
});

test("openTab: si `pane run` falla y el cierre del pane propio funciona, la entrada del ledger se borra; si el cierre falla se conserva", async () => {
  const a = new Map();
  const ok = make({ "tab create": { out: fx("tab-create.json") }, "pane run": { err: true, code: 1 }, "pane close": { out: "" } }, { ledger: a });
  assert.equal((await ok.h.openTab({ cwd: "/tmp", label: "mt3k-a-0a1b2c-x1", argv: ["x"] })).ok, false);
  assert.equal(a.size, 0);
  const b = new Map();
  const bad = make({ "tab create": { out: fx("tab-create.json") }, "pane run": { err: true, code: 1 }, "pane close": { err: true, code: 1 } }, { ledger: b });
  assert.equal((await bad.h.openTab({ cwd: "/tmp", label: "mt3k-a-0a1b2c-x1", argv: ["x"] })).ok, false);
  assert.equal(b.size, 1); // el pane pudo quedar vivo: se conserva hasta que la poda lo resuelva
});

test("fixtures sin uso previo: pane-get.json (terminal ajeno → labels vacío) y agent-list.json (coherente con pane-list.json)", async () => {
  const g = await make({ "pane get w1:p7": { out: fx("pane-get.json") }, "tab get": { out: fx("tab-list.json") } }).h.get("h9:w1:p7");
  assert.equal(g.ok, true);
  assert.equal(g.cwd, "/home/mondo");
  assert.equal(g.tabId, "w1:t7");
  assert.deepEqual(g.labels, {});
  const agents = JSON.parse(fx("agent-list.json")).result.agents;
  const byPane = Object.fromEntries(parsePaneList(fx("pane-list.json")).map((r) => [r.address, r]));
  assert.ok(agents.length >= 3);
  for (const a of agents) {
    assert.equal(byPane[a.pane_id]?.app, a.agent, a.pane_id);
    assert.equal(byPane[a.pane_id]?.terminalId, a.terminal_id, a.pane_id);
  }
});
