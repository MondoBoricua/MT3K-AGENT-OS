import test from "node:test";
import assert from "node:assert/strict";
import {
  HERDR_UNAVAILABLE,
  containsHerdrId,
  createHerdrPanes,
  herdrKeyArgs,
  mergeHerdrPanes,
  streamFrame,
  toPane,
} from "./herdr-panes.mjs";

const ROWS = [
  { id: "hc:t4", address: "t4", agent: "shell", app: "zsh", status: null, cwd: "/Users/x", where: null, name: null, turn: 0, parent: null, state: "live" },
  { id: "hc:t9", address: "t9", agent: "claude", app: "claude-code", status: "working", cwd: "/Users/x/proj", where: "PROJ / 1", name: null, turn: 3, parent: null, state: "live" },
  { id: "hc:t12", address: "t12", agent: "claude", app: "claude-code", status: "blocked", cwd: "/w", where: null, name: "rev", turn: 1, parent: null, state: "live" },
  { id: "hc:t13", address: "t13", agent: "deepseek", app: "dsh", status: "idle", cwd: "/w", where: null, name: null, turn: 0, parent: null, state: "live" },
];
const tildify = (p) => (p.startsWith("/Users/x") ? "~" + p.slice(8) : p);
const AGENTS = [
  { id: "claude", name: "Claude", online: true, running: false, panes: [{ paneId: "%1", label: "s:0.0", window: "w", cwd: "~" }] },
  { id: "codex", name: "Codex", online: true, running: false, panes: [] },
  { id: "shell", name: "Terminal", online: true, running: false, panes: [] },
];

test("toPane: forma del pane, label where||name||address y cwd tildificado", () => {
  assert.deepEqual(toPane(ROWS[1], tildify), {
    paneId: "hc:t9", label: "PROJ / 1", window: "t9", cwd: "~/proj", backend: "herdr",
    status: "working", waiting: false, statusRule: "herdr", statusSource: "herdr",
  });
  assert.equal(toPane(ROWS[2], tildify).label, "rev");
  assert.equal(toPane(ROWS[2], tildify).waiting, true);
  const shell = toPane(ROWS[0], tildify);
  assert.equal(shell.label, "t4");
  assert.equal(shell.status, "idle");
});

test("mergeHerdrPanes: añade al agente correcto, running, sin mutar la entrada", () => {
  const before = JSON.stringify(AGENTS);
  const out = mergeHerdrPanes(AGENTS, ROWS, tildify);
  assert.equal(JSON.stringify(AGENTS), before);
  const claude = out.find((r) => r.id === "claude");
  assert.deepEqual(claude.panes.map((p) => p.paneId), ["%1", "hc:t9", "hc:t12"]);
  assert.equal(claude.panes[0].backend, undefined); // tmux: sin campo nuevo
  assert.equal(claude.running, true);
  assert.equal(claude.waiting, true);
  const shell = out.find((r) => r.id === "shell");
  assert.deepEqual(shell.panes.map((p) => p.paneId), ["hc:t4", "hc:t13"]); // deepseek sin fila → shell
  assert.equal(shell.running, true);
  const codex = out.find((r) => r.id === "codex");
  assert.equal(codex, AGENTS[1]); // intacto
  assert.equal(codex.running, false);
});

test("mergeHerdrPanes: sin terminales devuelve la misma lista; sin fila shell se omite", () => {
  assert.equal(mergeHerdrPanes(AGENTS, [], tildify), AGENTS);
  const noShell = mergeHerdrPanes([AGENTS[1]], [ROWS[0]], tildify);
  assert.deepEqual(noShell[0].panes, []);
});

test("herdrKeyArgs: tabla del panel, SendNow y teclas no soportadas", () => {
  assert.deepEqual(herdrKeyArgs("Enter"), ["enter"]);
  assert.deepEqual(herdrKeyArgs("Escape"), ["esc"]);
  assert.deepEqual(herdrKeyArgs("ShiftTab"), ["shift+tab"]);
  assert.deepEqual(herdrKeyArgs("SendNow"), ["ctrl+x", "ctrl+s"]);
  assert.equal(herdrKeyArgs("WheelUp"), null);
  assert.equal(herdrKeyArgs("constructor"), null);
  assert.equal(herdrKeyArgs("enter; rm"), null);
  assert.equal(herdrKeyArgs(undefined), null);
});

test("containsHerdrId: body de restore anidado", () => {
  assert.equal(containsHerdrId({ items: [{ sessionName: "hc:t9" }] }), true);
  assert.equal(containsHerdrId({ dismiss: ["hc:t1b"] }), true);
  assert.equal(containsHerdrId({ items: [{ sessionName: "mt3k-claude-x" }], all: true }), false);
  assert.equal(containsHerdrId(null), false);
});

test("streamFrame: completa, igual y diffs por línea", () => {
  const a = streamFrame(null, "uno\ndos", true);
  assert.equal(a.payload, JSON.stringify("uno\ndos"));
  assert.equal(streamFrame(a.lines, "uno\ndos", true).same, true);
  const b = streamFrame(a.lines, "uno\ntres\ncuatro", true);
  assert.deepEqual(JSON.parse(b.payload), { from: 1, lines: ["tres", "cuatro"], alt: false, mouse_sgr: false });
  assert.equal(streamFrame(a.lines, "uno\ntres", false).payload, JSON.stringify("uno\ntres"));
});

function fakeHerdr({ list = ROWS, readText = "pantalla", sendResult = { ok: true } } = {}) {
  const calls = { list: 0, read: [], send: [], keys: [] };
  return {
    calls,
    herdr: {
      async list() { calls.list++; return typeof list === "function" ? list() : list; },
      async read(id, o) { calls.read.push([id, o]); return typeof readText === "function" ? readText() : { ok: true, text: readText }; },
      async send(id, t) { calls.send.push([id, t]); return sendResult; },
      async keys(id, k) { calls.keys.push([id, k]); return { ok: true }; },
    },
  };
}

test("MT3K_HERDR=0: no busca hc, no consulta nada", async () => {
  let finds = 0;
  const p = createHerdrPanes({ enabled: false, findHc: () => { finds++; return "/x/hc"; } });
  assert.equal(await p.applyTo(AGENTS), AGENTS);
  assert.equal(await p.has("hc:t9"), false);
  assert.equal(finds, 0);
});

test("sin hc en el sistema: lista vacía y reintento de búsqueda solo cada 30 s", async () => {
  let n = 0;
  let t = 1000;
  const p = createHerdrPanes({ findHc: () => { n++; return null; }, now: () => t });
  assert.equal(await p.applyTo(AGENTS), AGENTS);
  await p.refresh();
  assert.equal(n, 1);
  t += 31000;
  await p.refresh();
  assert.equal(n, 2);
});

test("lista cacheada 2 s: peticiones seguidas hacen una sola consulta", async () => {
  const { herdr, calls } = fakeHerdr();
  let t = 5000;
  const p = createHerdrPanes({ findHc: () => "/x/hc", createHerdr: () => herdr, now: () => t });
  await Promise.all([p.refresh(), p.refresh(), p.applyTo(AGENTS)]);
  await p.refresh();
  assert.equal(calls.list, 1);
  t += 2100;
  await p.refresh();
  assert.equal(calls.list, 2);
  t += 600;
  await p.refresh(true); // forzada, pero ≥ 500 ms
  assert.equal(calls.list, 3);
});

test("send/keys pasan por el adaptador; tecla no soportada no lo toca", async () => {
  const { herdr, calls } = fakeHerdr();
  const p = createHerdrPanes({ findHc: () => "/x/hc", createHerdr: () => herdr });
  assert.deepEqual(await p.send("hc:t9", "hola"), { ok: true });
  assert.deepEqual(calls.send, [["hc:t9", "hola"]]);
  assert.deepEqual(await p.keys("hc:t9", "Escape"), { ok: true });
  assert.deepEqual(calls.keys, [["hc:t9", ["esc"]]]);
  const bad = await p.keys("hc:t9", "WheelUp");
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 400);
  assert.equal(calls.keys.length, 1);
});

test("failure: bloqueado → 409, otro error → 500", () => {
  const p = createHerdrPanes({ enabled: false });
  assert.deepEqual(p.failure({ ok: false, err: "bloqueado: requiere a la persona" }), { status: 409, body: { ok: false, err: "bloqueado: requiere a la persona" } });
  assert.equal(p.failure({ ok: false, err: "envío falló" }).status, 500);
  assert.equal(p.failure({ ok: false, err: "texto demasiado largo" }).status, 400);
  assert.match(HERDR_UNAVAILABLE, /Herdr/);
});

test("explain: estado de Herdr y tail de la pantalla", async () => {
  const { herdr } = fakeHerdr({ readText: "a\n\nb\n" });
  const p = createHerdrPanes({ findHc: () => "/x/hc", createHerdr: () => herdr });
  assert.equal(await p.explain("hc:t9"), null); // aún sin lista
  await p.refresh();
  const ex = await p.explain("hc:t9");
  assert.equal(ex.source, "herdr");
  assert.equal(ex.state, "working");
  assert.deepEqual(ex.tail, ["a", "b"]);
});

test("wait: llega a idle cuando el estado cambia y reporta gone si desaparece", async () => {
  let status = "working";
  let present = true;
  const { herdr } = fakeHerdr({
    list: () => (present ? [{ ...ROWS[1], status }] : []),
  });
  let t = 10000;
  const p = createHerdrPanes({ findHc: () => "/x/hc", createHerdr: () => herdr, now: () => t });
  await p.refresh();
  // runWait duerme de verdad (setTimeout): cambiamos el estado a mitad de la espera
  setTimeout(() => { t += 2000; status = "done"; }, 50);
  const r = await p.wait({ id: "hc:t9", until: "done", timeoutSec: 4, onAbort: () => () => {} });
  assert.equal(r.reason, "reached");
  assert.equal(r.status, "done");
  present = false;
  t += 5000;
  const g = await p.wait({ id: "hc:t9", until: "done", timeoutSec: 4, onAbort: () => () => {} });
  assert.equal(g.reason, "gone");
});

test("stream: alt una vez, cadena completa, diff, gone tras 2 ausencias", async () => {
  let text = "uno";
  let present = true;
  const { herdr } = fakeHerdr({
    list: () => (present ? ROWS : []),
    readText: () => ({ ok: true, text }),
  });
  let t = 1000;
  const p = createHerdrPanes({ findHc: () => "/x/hc", createHerdr: () => herdr, now: () => (t += 3000) });
  const out = [];
  let ended = false;
  const s = p.startStream({ id: "hc:t9", tickMs: 1, minTickMs: 5, lineDiffs: true, write: (c) => out.push(c), end: () => { ended = true; } });
  await new Promise((r) => setTimeout(r, 40));
  text = "uno\ndos";
  await new Promise((r) => setTimeout(r, 40));
  present = false;
  await new Promise((r) => setTimeout(r, 60));
  s.stop();
  assert.equal(out[0], `event: alt\ndata: {"alt":false,"mouse_sgr":false}\n\n`);
  assert.equal(out[1], `data: ${JSON.stringify("uno")}\n\n`);
  assert.deepEqual(JSON.parse(out[2].replace(/^data: /, "")), { from: 1, lines: ["uno", "dos"].slice(1), alt: false, mouse_sgr: false });
  assert.equal(out.filter((c) => c.startsWith("event: alt")).length, 1);
  assert.equal(out.at(-1), "event: gone\ndata: {}\n\n");
  assert.equal(ended, true);
});

test("stream: lectura que falla dos veces → gone", async () => {
  const { herdr } = fakeHerdr({ readText: () => ({ ok: false, err: "lectura falló" }) });
  let t = 1000;
  const p = createHerdrPanes({ findHc: () => "/x/hc", createHerdr: () => herdr, now: () => (t += 3000) });
  const out = [];
  p.startStream({ id: "hc:t9", tickMs: 1, minTickMs: 5, lineDiffs: false, write: (c) => out.push(c), end: () => {} });
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(out, ["event: gone\ndata: {}\n\n"]);
});

function richHerdr({ rows = ROWS, getFn, readText = "plano" } = {}) {
  const calls = { get: [], read: 0, list: 0 };
  return {
    calls,
    herdr: {
      async list() { calls.list++; return typeof rows === "function" ? rows() : rows; },
      async get(id) { calls.get.push(id); return getFn ? getFn(id) : { ok: true, cwd: `/cur/${id.slice(3)}`, cols: 90, rows: 30, where: null }; },
      async read() { calls.read++; return { ok: true, text: readText }; },
    },
  };
}
const mk = (opts) => { let t = 1000; const clock = { t: () => t, adv: (n) => { t += n; } }; return { clock, panes: createHerdrPanes({ findHc: () => "/x/hc", now: clock.t, ...opts }) }; };

test("cwd actual: hc get en la primera lista, máx. 5 por ciclo, TTL 30 s y cambio de where/estado", async () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ ...ROWS[0], id: `hc:t${i}`, address: `t${i}` }));
  const { herdr, calls } = richHerdr({ rows: many });
  const { clock, panes } = mk({ createHerdr: () => herdr });
  let out = await panes.refresh();
  assert.equal(calls.get.length, 5);
  assert.equal(out.filter((r) => r.cwd.startsWith("/cur/")).length, 5);
  clock.adv(2100);
  await panes.refresh();
  assert.equal(calls.get.length, 8); // los 3 restantes
  clock.adv(2100);
  await panes.refresh();
  assert.equal(calls.get.length, 8); // sin cambios ni TTL
  clock.adv(31000);
  await panes.refresh();
  assert.equal(calls.get.length, 13); // 5 caducados
});

test("cwd actual: cambio de where dispara un get; fallo de get conserva la carpeta de lanzamiento", async () => {
  let where = "A / 1";
  const { herdr, calls } = richHerdr({ rows: () => [{ ...ROWS[1], where }], getFn: () => ({ ok: false }) });
  const { clock, panes } = mk({ createHerdr: () => herdr });
  let out = await panes.refresh();
  assert.equal(out[0].cwd, "/Users/x/proj");
  where = "B / 1";
  clock.adv(2100);
  await panes.refresh();
  assert.equal(calls.get.length, 2);
});

test("color: snapshot con el tamaño ACTUAL, SGR unido con \\n; read plano no se usa", async () => {
  const { herdr, calls } = richHerdr();
  const snaps = [];
  const conn = { snapshot: async (a, o) => { snaps.push([a, o]); return { ok: true, bytes: Buffer.from("b"), cols: 90, rows: 30 }; }, close() { this.closed = true; } };
  const { panes } = mk({ createHerdr: () => herdr, createConn: () => conn, paint: () => ({ lines: ["\x1b[31mrojo\x1b[0m", "x"], complete: true }) });
  await panes.refresh();
  const v = await panes.view("hc:t9");
  assert.deepEqual(v, { ok: true, text: "\x1b[31mrojo\x1b[0m\nx", colored: true });
  assert.deepEqual(snaps[0], ["t9", { cols: 90, rows: 30, history: 1000 }]);
  assert.equal(calls.read, 0);
  panes.close();
  assert.equal(conn.closed, true);
});

test("color: fallo, complete:false o cero líneas → texto plano; 3 fallos → 60 s sin snapshot", async () => {
  const { herdr, calls } = richHerdr();
  let n = 0;
  const conn = { snapshot: async () => { n++; return { ok: false, err: "x" }; }, close() {} };
  const { clock, panes } = mk({ createHerdr: () => herdr, createConn: () => conn });
  await panes.refresh();
  for (let i = 0; i < 3; i++) assert.deepEqual(await panes.view("hc:t9"), { ok: true, text: "plano" });
  assert.equal(n, 3);
  await panes.view("hc:t9");
  assert.equal(n, 3); // en pausa
  clock.adv(61000);
  await panes.view("hc:t9");
  assert.equal(n, 4);
  assert.equal(calls.read, 5);
  const incomplete = mk({ createHerdr: () => richHerdr().herdr, createConn: () => ({ snapshot: async () => ({ ok: true, bytes: Buffer.alloc(1), cols: 90, rows: 30 }), close() {} }), paint: () => ({ lines: ["a"], complete: false }) });
  await incomplete.panes.refresh();
  assert.equal((await incomplete.panes.view("hc:t9")).text, "plano");
});

test("color: sin tamaño conocido no se pide snapshot; color=false nunca crea la conexión", async () => {
  let created = 0;
  const noSize = mk({ createHerdr: () => richHerdr({ getFn: () => ({ ok: false }) }).herdr, createConn: () => { created++; return { snapshot: async () => ({ ok: false }), close() {} }; } });
  await noSize.panes.refresh();
  assert.equal((await noSize.panes.view("hc:t9")).text, "plano");
  assert.equal(created, 0);
  const off = mk({ color: false, createHerdr: () => richHerdr().herdr, createConn: () => { created++; return {}; } });
  await off.panes.refresh();
  assert.equal((await off.panes.view("hc:t9")).text, "plano");
  assert.equal(created, 0);
  assert.equal(off.panes.connStats(), null);
});

test("color: el tamaño se refresca con get si tiene más de 5 s", async () => {
  const { herdr, calls } = richHerdr();
  const conn = { snapshot: async () => ({ ok: true, bytes: Buffer.alloc(1), cols: 90, rows: 30 }), close() {} };
  const { clock, panes } = mk({ createHerdr: () => herdr, createConn: () => conn, paint: () => ({ lines: ["a"], complete: true }) });
  await panes.refresh();
  await panes.view("hc:t9"); // primera vista: S0 fresco + verificación posterior
  const g0 = calls.get.length;
  await panes.view("hc:t9");
  assert.equal(calls.get.length, g0);
  clock.adv(6000);
  await panes.view("hc:t9");
  assert.equal(calls.get.length, g0 + 1);
});

test("B1: una conversión lenta (>150 ms) o incompleta cuenta como fallo; 3 → 60 s en texto plano", async () => {
  const { herdr } = richHerdr();
  let n = 0;
  let clock = 0;
  const conn = { snapshot: async () => { n++; return { ok: true, bytes: Buffer.alloc(1), cols: 90, rows: 30 }; }, close() {} };
  const { clock: c, panes } = mk({
    createHerdr: () => herdr, createConn: () => conn,
    paint: () => { clock += 200; return { lines: ["a"], complete: true }; },
    perfNow: () => clock,
  });
  await panes.refresh();
  for (let i = 0; i < 3; i++) assert.equal((await panes.view("hc:t9")).text, "plano");
  assert.equal(n, 3);
  await panes.view("hc:t9");
  assert.equal(n, 3);
  c.adv(61000);
  await panes.view("hc:t9");
  assert.equal(n, 4);
});

function guardHarness({ startSize, snapSize, afterSize }) {
  let cur = startSize;
  const calls = { get: 0, snap: [] };
  const herdr = {
    async list() { return ROWS; },
    async get() { calls.get++; return { ok: true, cwd: "/c", cols: cur.cols, rows: cur.rows, where: null }; },
    async read() { return { ok: true, text: "plano" }; },
    async coreAlive() { return true; },
  };
  const conn = { snapshot: async (a, o) => { calls.snap.push(o); cur = afterSize || cur; return { ok: true, bytes: Buffer.alloc(1), cols: snapSize.cols, rows: snapSize.rows }; }, close() {} };
  const logs = [];
  const m = mk({ createHerdr: () => herdr, createConn: () => conn, paint: () => ({ lines: ["c"], complete: true }), log: (x) => logs.push(x) });
  return { ...m, calls, logs };
}

test("S3: si el attach cambió el tamaño (sin visor) → una línea de log y 10 min de texto plano, luego reintento", async () => {
  const { clock, panes, calls, logs } = guardHarness({ startSize: { cols: 91, rows: 17 }, snapSize: { cols: 200, rows: 120 }, afterSize: { cols: 200, rows: 120 } });
  await panes.refresh();
  assert.equal((await panes.view("hc:t9")).colored, true); // la primera vista sí se sirve
  assert.deepEqual(logs, ["[mt3k] herdr: t9 sin visor; vista en texto plano"]);
  assert.equal(calls.snap.length, 1);
  for (let i = 0; i < 5; i++) { clock.adv(2000); assert.equal((await panes.view("hc:t9")).text, "plano"); }
  assert.equal(calls.snap.length, 1); // sin más attaches
  assert.equal(logs.length, 1);
  clock.adv(10 * 60 * 1000);
  await panes.view("hc:t9");
  assert.equal(calls.snap.length, 2);
});

test("S3: un `hc get` posterior al primer snapshot también detecta el resize", async () => {
  const { panes, calls, logs } = guardHarness({ startSize: { cols: 91, rows: 17 }, snapSize: { cols: 91, rows: 17 }, afterSize: { cols: 200, rows: 120 } });
  await panes.refresh();
  await panes.view("hc:t9");
  assert.equal(logs.length, 1);
  await panes.view("hc:t9");
  assert.equal(calls.snap.length, 1);
});

test("S3: tamaño estable (hay visor) → snapshots siempre; tamaño headless 200x120 → siempre permitido", async () => {
  const stable = guardHarness({ startSize: { cols: 96, rows: 43 }, snapSize: { cols: 96, rows: 43 } });
  await stable.panes.refresh();
  for (let i = 0; i < 4; i++) { stable.clock.adv(2000); assert.equal((await stable.panes.view("hc:t9")).colored, true); }
  assert.equal(stable.calls.snap.length, 4);
  assert.equal(stable.logs.length, 0);
  const head = guardHarness({ startSize: { cols: 200, rows: 120 }, snapSize: { cols: 200, rows: 120 } });
  await head.panes.refresh();
  for (let i = 0; i < 3; i++) await head.panes.view("hc:t9");
  assert.equal(head.calls.snap.length, 3);
  assert.deepEqual(head.calls.snap[0], { cols: 200, rows: 120, history: 1000 });
});

test("B2: con el core muerto se cierra el hc connect, se vacía el estado y no se llama a hc", async () => {
  let alive = true;
  let closed = 0;
  const herdr = {
    async list() { return alive ? ROWS : []; },
    async get() { return { ok: true, cwd: "/c", cols: 96, rows: 43, where: null }; },
    async read() { return { ok: true, text: "plano" }; },
    async coreAlive() { return alive; },
  };
  const conn = { snapshot: async () => ({ ok: true, bytes: Buffer.alloc(1), cols: 96, rows: 43 }), close() { closed++; } };
  const { clock, panes } = mk({ createHerdr: () => herdr, createConn: () => conn, paint: () => ({ lines: ["c"], complete: true }) });
  await panes.refresh();
  await panes.view("hc:t9");
  alive = false;
  clock.adv(2100);
  assert.deepEqual(await panes.refresh(), []);
  assert.equal(closed, 1);
  assert.equal(panes.connStats(), null);
});

test("N10: explain lee solo la pantalla (lines 0), no 1000 líneas", async () => {
  const reads = [];
  const herdr = { async list() { return ROWS; }, async read(id, o) { reads.push(o.lines); return { ok: true, text: "a\nb" }; } };
  const { panes } = mk({ createHerdr: () => herdr });
  await panes.refresh();
  await panes.explain("hc:t9");
  assert.deepEqual(reads, [0]);
  assert.equal(panes.failure({ ok: false, err: "texto inválido" }).status, 400);
});
