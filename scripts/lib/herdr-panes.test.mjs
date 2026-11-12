import test from "node:test";
import assert from "node:assert/strict";
import {
  HERDR_UNAVAILABLE,
  containsHerdrId,
  createHerdrPanes,
  herdrKeyArgs,
  herdrOccupies,
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

test("S3: cambio de tamaño que NO es el headless (un visor acomodó la pestaña) → sin pausa ni log; se vuelve a verificar", async () => {
  // snapshot devuelve otro tamaño que el leído, pero no 200x120: lo movió la app, no nuestro attach
  const viaSnap = guardHarness({ startSize: { cols: 80, rows: 24 }, snapSize: { cols: 160, rows: 41 }, afterSize: { cols: 160, rows: 41 } });
  await viaSnap.panes.refresh();
  for (let i = 0; i < 3; i++) { viaSnap.clock.adv(2000); assert.equal((await viaSnap.panes.view("hc:t9")).colored, true); }
  assert.equal(viaSnap.calls.snap.length, 3); // sigue pidiendo snapshots: no hay pausa de 10 min
  assert.deepEqual(viaSnap.calls.snap[1], { cols: 160, rows: 41, history: 1000 }); // con el tamaño nuevo, releído
  assert.equal(viaSnap.logs.length, 0);
  // el cambio lo detecta el `hc get` posterior
  const viaGet = guardHarness({ startSize: { cols: 80, rows: 24 }, snapSize: { cols: 80, rows: 24 }, afterSize: { cols: 160, rows: 41 } });
  await viaGet.panes.refresh();
  await viaGet.panes.view("hc:t9");
  viaGet.clock.adv(2000);
  assert.equal((await viaGet.panes.view("hc:t9")).colored, true);
  assert.equal(viaGet.calls.snap.length, 2);
  assert.equal(viaGet.logs.length, 0);
});

test("S3: pausado por sin visor, pero un visor llega y saca el terminal del tamaño headless → vuelve el color sin esperar 10 min", async () => {
  let cur = { cols: 91, rows: 17 };
  const snaps = [];
  const herdr = {
    async list() { return ROWS; },
    async get() { return { ok: true, cwd: "/c", cols: cur.cols, rows: cur.rows, where: null }; },
    async read() { return { ok: true, text: "plano" }; },
    async coreAlive() { return true; },
  };
  const conn = { snapshot: async (a, o) => { snaps.push(o); if (snaps.length === 1) cur = { cols: 200, rows: 120 }; return { ok: true, bytes: Buffer.alloc(1), cols: cur.cols, rows: cur.rows }; }, close() {} };
  const logs = [];
  const { clock, panes } = mk({ createHerdr: () => herdr, createConn: () => conn, paint: () => ({ lines: ["c"], complete: true }), log: (x) => logs.push(x) });
  await panes.refresh();
  await panes.view("hc:t9"); // nuestro attach lo llevó a 200x120 → pausa
  assert.equal(logs.length, 1);
  clock.adv(6000);
  assert.equal((await panes.view("hc:t9")).text, "plano"); // sigue en 200x120: sin visor
  assert.equal(snaps.length, 1);
  cur = { cols: 160, rows: 41 }; // la app abre la pestaña y la acomoda
  clock.adv(6000);
  assert.equal((await panes.view("hc:t9")).colored, true);
  assert.deepEqual(snaps[1], { cols: 160, rows: 41, history: 1000 });
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

test("R4-2: terminales fuera de 20-500 x 5-300 no se atachan (texto plano, sin pausa falsa)", async () => {
  for (const [cols, rows] of [[520, 60], [18, 40], [100, 4], [100, 301]]) {
    let snaps = 0;
    const herdr = { async list() { return ROWS; }, async get() { return { ok: true, cwd: "/c", cols, rows, where: null }; }, async read() { return { ok: true, text: "plano" }; }, async coreAlive() { return true; } };
    const logs = [];
    const { panes } = mk({ createHerdr: () => herdr, createConn: () => ({ snapshot: async () => { snaps++; return { ok: true, bytes: Buffer.alloc(1), cols, rows }; }, close() {} }), log: (x) => logs.push(x) });
    await panes.refresh();
    assert.equal((await panes.view("hc:t9")).text, "plano");
    assert.equal(snaps, 0);
    assert.equal(logs.length, 0);
  }
});

test("R4-4: la pausa de 10 min sobrevive a un dropState por sonda fallida", async () => {
  let alive = true;
  let snaps = 0;
  const herdr = {
    async list() { return alive ? ROWS : []; },
    async get() { return { ok: true, cwd: "/c", ...(snaps ? { cols: 200, rows: 120 } : { cols: 91, rows: 17 }), where: null }; }, // tras el attach se queda en headless
    async read() { return { ok: true, text: "plano" }; },
    async coreAlive() { return alive; },
  };
  const conn = { snapshot: async () => { snaps++; return { ok: true, bytes: Buffer.alloc(1), cols: 200, rows: 120 }; }, close() {} };
  const { clock, panes } = mk({ createHerdr: () => herdr, createConn: () => conn, paint: () => ({ lines: ["c"], complete: true }), log: () => {} });
  await panes.refresh();
  await panes.view("hc:t9"); // se redimensiona → pausa
  assert.equal(snaps, 1);
  alive = false; clock.adv(2100); await panes.refresh(); // dropState
  alive = true; clock.adv(2100); await panes.refresh();
  assert.equal((await panes.view("hc:t9")).text, "plano");
  assert.equal(snaps, 1);
});

// --- launch-backend: killable, invalidate, hc() ---

test("toPane: killable solo si la fila lo trae", () => {
  assert.equal(toPane(ROWS[1], tildify).killable, undefined);
  assert.equal(toPane({ ...ROWS[1], killable: true }, tildify).killable, true);
});

test("killable sale de la etiqueta mt3k.panel=1 de `hc get`; el resto de terminales no", async () => {
  const gets = [];
  const herdr = {
    async list() { return ROWS.slice(0, 2); },
    async get(id) { gets.push(id); return { ok: true, cwd: null, cols: 80, rows: 24, where: null, labels: id === "hc:t9" ? { "mt3k.panel": "1" } : { "mt3k.panel": "0" } }; },
  };
  const p = createHerdrPanes({ findHc: () => "/x/hc", createHerdr: () => herdr });
  const rows = await p.refresh();
  assert.deepEqual(rows.map((r) => [r.id, r.killable === true]), [["hc:t4", false], ["hc:t9", true]]);
  const merged = await p.applyTo(AGENTS);
  assert.equal(merged.find((r) => r.id === "claude").panes.find((x) => x.paneId === "hc:t9").killable, true);
  assert.equal(merged.find((r) => r.id === "shell").panes.find((x) => x.paneId === "hc:t4").killable, undefined);
});

test("invalidate: la siguiente refresh() relee la lista (sin esperar el TTL) y avisa al adaptador", async () => {
  const { herdr, calls } = fakeHerdr();
  let inv = 0;
  herdr.invalidate = () => { inv++; };
  const p = createHerdrPanes({ findHc: () => "/x/hc", createHerdr: () => herdr, now: () => 5000 });
  await p.refresh();
  await p.refresh();
  assert.equal(calls.list, 1);
  p.invalidate();
  await p.refresh();
  assert.equal(calls.list, 2);
  assert.equal(inv, 1);
});

test("hc(): el adaptador, o null con MT3K_HERDR=0 / sin hc", () => {
  const { herdr } = fakeHerdr();
  assert.equal(createHerdrPanes({ findHc: () => "/x/hc", createHerdr: () => herdr }).hc(), herdr);
  assert.equal(createHerdrPanes({ enabled: false }).hc(), null);
  assert.equal(createHerdrPanes({ findHc: () => null }).hc(), null);
});

test("invalidate durante un refresh en vuelo: el resultado viejo no repuebla la caché", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let call = 0;
  const herdr = { async list() { call++; if (call === 1) { await gate; return ROWS.slice(0, 1); } return ROWS.slice(0, 2); } };
  const p = createHerdrPanes({ findHc: () => "/x/hc", createHerdr: () => herdr, now: () => 5000 });
  const stale = p.refresh();
  await new Promise((r) => setImmediate(r));
  p.invalidate(); // p. ej. justo después de crear un terminal
  const freshP = p.refresh(); // se une al mismo ciclo, que repite la consulta tras el invalidate
  release();
  const fresh = await freshP;
  assert.deepEqual(fresh.map((r) => r.id), ["hc:t4", "hc:t9"]);
  assert.deepEqual((await stale).map((r) => r.id), ["hc:t4", "hc:t9"]); // nadie recibe la lista anterior al invalidate
  assert.equal(call, 2);
  assert.deepEqual(p.cachedRows().map((r) => r.id), ["hc:t4", "hc:t9"]);
});

test("herdrOccupies: mismo agente + misma carpeta normalizada; otra carpeta/agente o carpeta ilegible no", () => {
  const norm = (p) => { if (p === "BAD") throw new Error("x"); return p.replace(/\/+$/, ""); };
  const rows = [{ agent: "claude", cwd: "/w/p/" }, { agent: "codex", cwd: "/w/q" }, { agent: "claude", cwd: "BAD" }, { agent: "claude", cwd: "" }];
  assert.equal(herdrOccupies(rows, "claude", "/w/p", norm), true);
  assert.equal(herdrOccupies(rows, "claude", "/w/q", norm), false);
  assert.equal(herdrOccupies(rows, "codex", "/w/q", norm), true);
  assert.equal(herdrOccupies([], "claude", "/w/p", norm), false);
});

test("invalidate con un refresh viejo en vuelo (con get): lo viejo no escribe details ni cache, y nunca hay 2 consultas a la vez", async () => {
  const defer = () => { let resolve; const p = new Promise((r) => { resolve = r; }); return { p, resolve }; };
  const listGate = defer();
  const getGate = defer();
  let lists = 0, gets = 0, active = 0, maxActive = 0;
  const row = { ...ROWS[1] };
  const herdr = {
    async list() {
      lists++; active++; maxActive = Math.max(maxActive, active);
      try { if (lists === 1) await listGate.p; return [row]; } finally { active--; }
    },
    async get() {
      gets++;
      if (gets === 1) { await getGate.p; return { ok: true, cwd: "/old", cols: 80, rows: 24, where: null, labels: {} }; }
      return { ok: true, cwd: "/new", cols: 80, rows: 24, where: null, labels: {} };
    },
    invalidate() {},
  };
  const p = createHerdrPanes({ findHc: () => "/x/hc", createHerdr: () => herdr, now: () => 5000 });
  const stale = p.refresh();
  await new Promise((r) => setImmediate(r));
  p.invalidate();
  const fresh1 = p.refresh();
  const fresh2 = p.refresh(true); // varias peticiones tras el invalidate comparten UNA consulta en espera
  listGate.resolve();
  await new Promise((r) => setImmediate(r));
  assert.equal(lists, 1); // la nueva espera a que acabe la vieja: sin consultas simultáneas
  getGate.resolve();
  const [s, f1, f2] = await Promise.all([stale, fresh1, fresh2]);
  assert.equal(s[0].cwd, "/new"); // el ciclo repite la consulta: nadie recibe lo anterior al invalidate
  assert.equal(f1[0].cwd, "/new");
  assert.equal(f1, f2);
  assert.equal(p.cachedRows()[0].cwd, "/new");
  assert.equal(lists, 2);
  assert.equal(gets, 2); // el get viejo NO quedó en details: la consulta nueva tuvo que repetirlo
  assert.equal(maxActive, 1);
});

test("muchos invalidate durante una consulta: una sola `hc ls` a la vez, repeticiones acotadas y gana la última lista", async () => {
  const gates = [];
  let lists = 0, active = 0, maxActive = 0;
  const herdr = {
    async list() {
      const n = ++lists; active++; maxActive = Math.max(maxActive, active);
      try { await new Promise((r) => gates.push(r)); return [{ ...ROWS[1], where: `lista-${n}` }]; } finally { active--; }
    },
    invalidate() {},
  };
  const p = createHerdrPanes({ findHc: () => "/x/hc", createHerdr: () => herdr, now: () => 5000 });
  const waiting = [p.refresh()];
  await new Promise((r) => setImmediate(r));
  for (let i = 0; i < 50; i++) { p.invalidate(); waiting.push(p.refresh()); }
  for (let i = 0; i < 10 && lists <= 4; i++) { // suelta una consulta cada vez; nunca aparecen dos abiertas
    gates.shift()?.();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  }
  const all = await Promise.all(waiting);
  assert.equal(maxActive, 1);
  assert.equal(lists, 2); // la inicial + UNA repetición: los 50 invalidate llegaron durante la primera
  for (const rows of all) assert.equal(rows[0].where, "lista-2");
  assert.equal(p.cachedRows()[0].where, "lista-2");
});

test("consulta anterior a un invalidate que vuelve vacía: no poda `details` ni tira el estado del core", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let lists = 0, gets = 0, probes = 0;
  let t = 5000;
  const herdr = {
    async list() { lists++; if (lists === 2) { await gate; return []; } return [{ ...ROWS[1] }]; },
    async get() { gets++; return { ok: true, cwd: "/w", cols: 80, rows: 24, where: null, labels: {} }; },
    async coreAlive() { probes++; return false; },
    invalidate() {},
  };
  const p = createHerdrPanes({ findHc: () => "/x/hc", createHerdr: () => herdr, now: () => t });
  await p.refresh(); // siembra details (1 get)
  assert.equal(gets, 1);
  t += 2100; // caché caducada, details aún vigente
  const old = p.refresh(); // consulta 2: quedará obsoleta y devolverá []
  await new Promise((r) => setImmediate(r));
  p.invalidate();
  release();
  const rows = await old; // el ciclo repite: consulta 3 trae la fila
  assert.equal(rows.length, 1);
  assert.equal(lists, 3);
  assert.equal(gets, 1); // la lista vacía obsoleta no borró details: no hizo falta otro get
  assert.equal(probes, 0); // ni sondeó/tiró el core por una lista obsoleta
});

test("invalidate justo cuando el ciclo termina: el refresh siguiente no se une al ciclo acabado y trae lista nueva", async () => {
  for (let ticks = 0; ticks <= 12; ticks++) { // barre el punto exacto del invalidate entre microtareas
    let lists = 0;
    const herdr = { async list() { return [{ ...ROWS[1], where: String(++lists) }]; }, invalidate() {} };
    const p = createHerdrPanes({ findHc: () => "/x/hc", createHerdr: () => herdr, now: () => 5000 });
    const first = p.refresh();
    for (let i = 0; i < ticks; i++) await Promise.resolve();
    const before = lists;
    p.invalidate();
    const rows = await p.refresh();
    await first;
    assert.ok(Number(rows[0].where) > before || before === 0, `ticks=${ticks}: lista ${rows[0].where} anterior al invalidate (${before})`);
    assert.equal(p.cachedRows()[0]?.where, rows[0].where, `ticks=${ticks}: caché y resultado difieren`);
    assert.equal(await p.has(ROWS[1].id), true, `ticks=${ticks}`);
  }
});

test("tope de repeticiones agotado: no se guarda nada (una muestra anterior a un invalidate no decide) y el siguiente refresh consulta", async () => {
  let lists = 0;
  let p;
  const herdr = { async list() { lists++; p.invalidate(); return [{ ...ROWS[1], where: String(lists) }]; }, invalidate() {} };
  p = createHerdrPanes({ findHc: () => "/x/hc", createHerdr: () => herdr, now: () => 5000 });
  const rows = await p.refresh();
  assert.equal(lists, 4); // 1 + MAX_REPOLLS
  assert.equal(rows[0].where, "4");
  assert.deepEqual(p.cachedRows(), []);
  await p.refresh();
  assert.equal(lists, 8); // caducada: volvió a consultar
});
