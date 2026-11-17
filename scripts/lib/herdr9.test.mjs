import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PANEL_TAB_RE, createHerdr9, herdr9SocketCandidates, isHerdr9Id, openInputError, paneOf,
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
const up = async () => true;
const down = async () => false;
const make = (routes, extra = {}) => {
  const f = fakeExec(routes);
  const h = createHerdr9({ herdrPath: "/usr/bin/herdr", exec: f.exec, probe: up, platform: "linux", home: "/h", isSocket: () => false, env: {}, ...extra });
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

test("herdr9SocketCandidates: ~/.config/herdr/herdr.sock y HERDR_SOCKET_PATH solo si es un socket absoluto", () => {
  assert.deepEqual(herdr9SocketCandidates({ env: {}, home: "/home/u", isSocket: () => false }), ["/home/u/.config/herdr/herdr.sock"]);
  assert.deepEqual(herdr9SocketCandidates({ env: { XDG_CONFIG_HOME: "/x" }, home: "/home/u", isSocket: () => false }), ["/x/herdr/herdr.sock"]);
  assert.deepEqual(herdr9SocketCandidates({ env: { HERDR_SOCKET_PATH: "/run/h.sock" }, home: "/home/u", isSocket: (p) => p === "/run/h.sock" }), ["/run/h.sock", "/home/u/.config/herdr/herdr.sock"]);
  assert.deepEqual(herdr9SocketCandidates({ env: { HERDR_SOCKET_PATH: "rel.sock" }, home: "/home/u", isSocket: () => true }), ["/home/u/.config/herdr/herdr.sock"]);
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

test("list: error o salida ilegible → [] sin lanzar", async () => {
  assert.deepEqual(await make({ "pane list": { err: true, code: 1, out: "" } }).h.list(), []);
  assert.deepEqual(await make({ "pane list": { out: "basura" } }).h.list(), []);
  assert.deepEqual(await make({}).h.list(), []);
  assert.deepEqual(await make({ "pane list": { err: true, code: "ETIMEDOUT" } }).h.list(), []);
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
  const ledger = new Set();
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

  const c = make({ "tab create": { out: fx("tab-create.json") }, "pane run": { err: true, code: 1 }, "tab close": { out: "" } });
  assert.deepEqual(await c.h.openTab({ cwd: "/tmp", label: "mt3k-a-0a1b2c-x1", argv: ["x"] }), { ok: false, err: "no se pudo escribir el comando" });
  assert.deepEqual(c.calls.at(-1).argv, ["tab", "close", "w1:tB"]);

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
  assert.equal((await mk(new Set([mine]), "mt3k-claude-0a1b2c-x1").h.get("h9:w1:pB")).labels["mt3k.panel"], "1");
  assert.deepEqual((await mk(new Set(), "mt3k-claude-0a1b2c-x1").h.get("h9:w1:pB")).labels, {}); // nombre del panel pero otro proceso/arranque
  assert.deepEqual((await mk(new Set([mine]), "mt3k-fixture").h.get("h9:w1:pB")).labels, {}); // en el ledger pero renombrada
  const g = await mk(new Set([mine]), "mt3k-claude-0a1b2c-x1").h.get("h9:w1:pB");
  assert.equal(g.cwd, "/tmp");
  assert.equal(g.state, "live");
  assert.equal(g.tabPaneCount, 1);
  assert.deepEqual(await make({}).h.get("hc:t1"), { ok: false, err: "terminal inválido" });
});

test("killTerminal: del panel → cierra la pestaña; ajeno sin force → 409 sin tocar nada; ajeno con force:true → pane close; force no booleano no vale", async () => {
  const tabNamed = (label) => JSON.stringify({ result: { tab: { label, pane_count: 1, tab_id: "w1:tB" } } });
  const mine = "term_6606d82b37789b";
  const routes = (label) => ({ ...OWNED_ROUTES, "tab get w1:tB": { out: tabNamed(label) }, "tab close": { out: fx("tab-close.txt") }, "pane close": { out: "" } });
  const closes = (calls) => calls.filter((c) => c.argv[1] === "close" || c.argv[0] === "tab" && c.argv[1] === "close");

  const own = make(routes("mt3k-claude-0a1b2c-x1"), { ledger: new Set([mine]) });
  assert.deepEqual(await own.h.killTerminal("h9:w1:pB"), { ok: true, removed: true, forced: false });
  assert.deepEqual(closes(own.calls).map((c) => c.argv), [["tab", "close", "w1:tB"]]);

  const foreign = make(routes("trabajo"), { ledger: new Set([mine]) });
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

test("killTerminal: un fallo de `close` no lanza y se informa", async () => {
  const tabNamed = JSON.stringify({ result: { tab: { label: "mt3k-claude-0a1b2c-x1", pane_count: 1, tab_id: "w1:tB" } } });
  const m = make({ ...OWNED_ROUTES, "tab get w1:tB": { out: tabNamed }, "tab close": { err: true, code: 1 } }, { ledger: new Set(["term_6606d82b37789b"]) });
  const r = await m.h.killTerminal("h9:w1:pB");
  assert.deepEqual([r.ok, r.status], [false, 500]);
});

test("list marca killable solo los terminales del panel (ledger + nombre de pestaña)", async () => {
  const ledger = new Set(["term_6606d374946717"]); // el de w1:p7 (pestaña w1:t7)
  const labels = (l) => JSON.stringify({ result: { tabs: [{ tab_id: "w1:t7", label: l }] } });
  const run = async (l) => (await make({ "pane list": { out: fx("pane-list.json") }, "tab list": { out: labels(l) } }, { ledger }).h.list()).filter((r) => r.killable).map((r) => r.id);
  assert.deepEqual(await run("mt3k-cursor-0a1b2c-x1"), ["h9:w1:p7"]);
  assert.deepEqual(await run("4"), []);
});

test("timeouts: se pasan a execFile y un timeout no lanza fuera del adaptador", async () => {
  const { h, calls } = make({ "pane read": { err: true, code: "ETIMEDOUT" } });
  assert.deepEqual(await h.read("h9:w1:p1"), { ok: false, err: "lectura falló" });
  assert.equal(calls[0].opts.timeout, 8000);
  const throwing = createHerdr9({ herdrPath: "/x", exec: () => { throw Object.assign(new Error("boom"), { code: "ERR_INVALID_ARG_VALUE" }); }, probe: up, platform: "linux", home: "/h", isSocket: () => false, env: {} });
  assert.deepEqual(await throwing.list(), []);
});
