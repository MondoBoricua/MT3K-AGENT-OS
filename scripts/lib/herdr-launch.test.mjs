import test from "node:test";
import assert from "node:assert/strict";
import {
  appDoArgv,
  createHerdrLauncher,
  findSpaceByFolder,
  herdrLaunchArgv,
  launchName,
  parseAppSpaces,
  parseAppTerminal,
} from "./herdr-launch.mjs";

const APP = "/h/.local/bin/herdr-app";
const LS = JSON.stringify({
  spaces: [
    { id: "sp1", name: "MT3K", folder: "/Users/x/proj", machine: null, tabs: [] },
    { id: "sp2", name: "REMOTE", folder: "/Users/x/other", machine: "vps", tabs: [] },
    { id: "sp3", name: "NOFOLDER", tabs: [] },
  ],
});

/** Falso `hc` (adaptador) que registra qué le piden. */
function fakeHc({ up = true, runs = [], mark = { ok: true } } = {}) {
  const calls = [];
  return {
    calls,
    coreUp: async () => up,
    hcEnv: async () => (up ? {} : null),
    invalidate: () => calls.push(["invalidate"]),
    run: async (input) => { calls.push(["run", input]); return runs.shift() ?? { ok: true, address: "t7", id: "hc:t7" }; },
    markOwned: async (id) => { calls.push(["mark", id]); return mark; },
  };
}

/** Falso `execFile` de herdr-app: `script` mapea el primer argumento al resultado. */
function fakeApp(script) {
  const calls = [];
  const exec = (file, argv, _opts, cb) => {
    calls.push({ file, argv });
    const r = script[argv[0]] ?? { err: 2, out: "" };
    const typeOf = typeof r === "function" ? r(argv) : r;
    if (typeOf.err) { const e = new Error("x"); if (typeOf.err === "TIMEOUT") { e.killed = true; e.signal = "SIGTERM"; e.code = null; } else e.code = typeOf.err; cb(e, typeOf.out ?? ""); } else cb(null, typeOf.out ?? "");
  };
  return { exec, calls };
}

const mk = ({ hc, app, appPath = APP, nameSuffix = "abc" } = {}) =>
  createHerdrLauncher({ getHerdr: () => hc ?? null, findApp: () => appPath, exec: app?.exec ?? fakeApp({}).exec, nameSuffix });

const INPUT = { agentId: "claude", cwd: "/Users/x/proj", argv: ["/usr/bin/env", "PATH=/a", "COLORTERM=truecolor", "/bin/claude", "--yolo"] };

test("launchName: a-z 0-9 - _ y ≤ 32 con cualquier agente/carpeta", () => {
  const n = launchName("antigravity", "/Users/x/Mi Proyecto");
  assert.match(n, /^mt3k-antigravity-[0-9a-f]{6}-[a-z0-9]{1,3}$/);
  assert.ok(n.length <= 32);
  assert.equal(launchName("claude", "/a", "xyz"), launchName("claude", "/a", "xyz"));
  assert.notEqual(launchName("claude", "/a", "xyz"), launchName("claude", "/b", "xyz"));
  assert.match(launchName("../..;", "/a", "!!"), /^mt3k-x-[0-9a-f]{6}-0$/);
});

test("parseAppSpaces / findSpaceByFolder: carpeta igual (sin barra final), solo locales y con id", () => {
  const spaces = parseAppSpaces(LS);
  assert.deepEqual(spaces.map((s) => s.id), ["sp1", "sp2"]);
  assert.equal(findSpaceByFolder(spaces, "/Users/x/proj")?.id, "sp1");
  assert.equal(findSpaceByFolder(spaces, "/Users/x/proj/")?.id, "sp1");
  assert.equal(findSpaceByFolder(spaces, "/Users/x/other"), null); // espacio remoto: no se reutiliza
  assert.equal(findSpaceByFolder(spaces, "/Users/x/pro"), null);
  assert.deepEqual(parseAppSpaces("nope"), []);
  assert.deepEqual(parseAppSpaces('{"spaces":"x"}'), []);
});

test("appDoArgv: UN objeto JSON; ningún valor se lee como opción aunque empiece por '-'", () => {
  const tab = appDoArgv({ space: "sp1", folder: "/Users/x/-weird", argv: ["/bin/a", "--b"], agentName: "claude", spaceName: "-weird" });
  assert.equal(tab.length, 3);
  assert.deepEqual(tab.slice(0, 2), ["do", "tab.new"]);
  assert.deepEqual(JSON.parse(tab[2]), { space: "sp1", name: "claude", folder: "/Users/x/-weird", argv: ["/bin/a", "--b"] });
  const space = appDoArgv({ space: undefined, folder: "/p", argv: [], agentName: "shell", spaceName: "p" });
  assert.deepEqual(space.slice(0, 2), ["do", "space.new"]);
  assert.deepEqual(JSON.parse(space[2]), { name: "p", folder: "/p" }); // shell: sin argv
});

test("parseAppTerminal: solo direcciones válidas", () => {
  assert.equal(parseAppTerminal('{"pane":"p1","terminal":"t12"}'), "t12");
  assert.equal(parseAppTerminal('{"terminal":"../x"}'), null);
  assert.equal(parseAppTerminal('{"error":"no"}'), null);
  assert.equal(parseAppTerminal("nope"), null);
});

test("herdrLaunchArgv: env PATH/COLORTERM como los -e de tmux; shell vacío; win32 directo", () => {
  assert.deepEqual(herdrLaunchArgv({ cmd: ["/bin/claude", "--x"], path: "/a:/b", platform: "darwin" }), ["/usr/bin/env", "PATH=/a:/b", "COLORTERM=truecolor", "/bin/claude", "--x"]);
  assert.deepEqual(herdrLaunchArgv({ cmd: [], path: "/a", platform: "darwin" }), []);
  assert.deepEqual(herdrLaunchArgv({ cmd: ["C:\\bin\\x.exe"], path: "C:\\p", platform: "win32" }), ["C:\\bin\\x.exe"]);
});

test("launch: sin hc → not-installed; sin core → no-core; NADA se ejecuta", async () => {
  const app = fakeApp({ status: { out: "{}" } });
  assert.deepEqual(await mk({ hc: null, app }).launch(INPUT), { ok: false, reason: "not-installed" });
  const hc = fakeHc({ up: false });
  assert.deepEqual(await mk({ hc, app }).launch(INPUT), { ok: false, reason: "no-core" });
  assert.equal(hc.calls.length, 0);
  assert.equal(app.calls.length, 0);
});

test("launch sin ventana (herdr-app status falla): hc run con el argv EXACTO y nombre mt3k-<agente>-<hash>-<sufijo>", async () => {
  const hc = fakeHc();
  const app = fakeApp({ status: { err: 2, out: "" } });
  const r = await mk({ hc, app }).launch(INPUT);
  assert.deepEqual(r, { ok: true, paneId: "hc:t7", address: "t7", via: "core", name: launchName("claude", INPUT.cwd, "abc") });
  const run = hc.calls.find((c) => c[0] === "run")[1];
  assert.deepEqual(run, { argv: INPUT.argv, cwd: INPUT.cwd, name: launchName("claude", INPUT.cwd, "abc") });
  assert.deepEqual(app.calls.map((c) => c.argv), [["status"]]); // no ls, no do
  assert.equal(hc.calls.some((c) => c[0] === "mark"), false); // hc run ya etiqueta (--label)
  assert.equal(hc.calls.at(-1)[0], "invalidate");
});

test("launch sin ventana: nombre ocupado → reintenta con otro sufijo, una sola vez", async () => {
  const hc = fakeHc({ runs: [{ ok: false, err: "x", nameTaken: true }] });
  const r = await mk({ hc, app: fakeApp({}) }).launch(INPUT);
  assert.equal(r.ok, true);
  const names = hc.calls.filter((c) => c[0] === "run").map((c) => c[1].name);
  assert.equal(names.length, 2);
  assert.notEqual(names[0], names[1]);
  const hc2 = fakeHc({ runs: [{ ok: false, err: "x", nameTaken: true }, { ok: false, err: "x", nameTaken: true }] });
  assert.deepEqual(await mk({ hc: hc2, app: fakeApp({}) }).launch(INPUT), { ok: false, reason: "error", err: "nombre de terminal ocupado" });
});

test("launch sin ventana: hc run falla con core vivo → error (500, sin tmux); con core muerto → no-core", async () => {
  const hc = fakeHc({ runs: [{ ok: false, err: "no se pudo crear el terminal", nameTaken: false }] });
  assert.deepEqual(await mk({ hc, app: fakeApp({}) }).launch(INPUT), { ok: false, reason: "error", err: "no se pudo crear el terminal" });
  let up = true;
  const dying = { ...fakeHc(), coreUp: async () => { const v = up; up = false; return v; }, run: async () => ({ ok: false, err: "hc no disponible", code: "NOCORE" }) };
  assert.equal((await mk({ hc: dying, app: fakeApp({}) }).launch(INPUT)).reason, "no-core");
});

test("launch con ventana y espacio de esa carpeta: tab.new en ese espacio, terminal del JSON, luego hc label", async () => {
  const hc = fakeHc();
  const app = fakeApp({ status: { out: "{}" }, ls: { out: LS }, do: { out: '{"pane":"p9","terminal":"t21"}' } });
  const r = await mk({ hc, app }).launch(INPUT);
  assert.deepEqual(r, { ok: true, paneId: "hc:t21", address: "t21", via: "app" });
  assert.deepEqual(app.calls.map((c) => c.argv.slice(0, 2)), [["status"], ["ls"], ["do", "tab.new"]]);
  const payload = JSON.parse(app.calls[2].argv[2]);
  assert.deepEqual(payload, { space: "sp1", name: "claude", folder: INPUT.cwd, argv: INPUT.argv });
  assert.deepEqual(hc.calls.filter((c) => c[0] !== "invalidate"), [["mark", "hc:t21"]]);
  assert.equal(hc.calls.some((c) => c[0] === "run"), false);
});

test("launch con ventana y SIN espacio de esa carpeta: space.new con el nombre de la carpeta", async () => {
  const app = fakeApp({ status: { out: "{}" }, ls: { out: LS }, do: { out: '{"terminal":"t3"}' } });
  const r = await mk({ hc: fakeHc(), app }).launch({ agentId: "shell", cwd: "/Users/x/nuevo", argv: [] });
  assert.equal(r.paneId, "hc:t3");
  assert.deepEqual(app.calls[2].argv.slice(0, 2), ["do", "space.new"]);
  assert.deepEqual(JSON.parse(app.calls[2].argv[2]), { name: "nuevo", folder: "/Users/x/nuevo" });
});

test("launch con ventana: no se pudo etiquetar → éxito con warning (no se cierra nada)", async () => {
  const hc = fakeHc({ mark: { ok: false, err: "etiquetar falló" } });
  const app = fakeApp({ status: { out: "{}" }, ls: { out: LS }, do: { out: '{"terminal":"t21"}' } });
  const r = await mk({ hc, app }).launch(INPUT);
  assert.equal(r.ok, true);
  assert.match(r.warning, /no se pudo marcar/);
});

test("launch con ventana: ls falla o do rechaza (error JSON) → cae a hc run; timeout/ilegible → NO duplica", async () => {
  // ls falla
  let hc = fakeHc();
  let app = fakeApp({ status: { out: "{}" }, ls: { err: 1, out: "" } });
  assert.equal((await mk({ hc, app }).launch(INPUT)).via, "core");
  // do rechazado por la app (exit≠0 con {"error"}): nada se creó → hc run
  hc = fakeHc();
  app = fakeApp({ status: { out: "{}" }, ls: { out: LS }, do: { err: 1, out: '{"error":"bad"}' } });
  const r = await mk({ hc, app }).launch(INPUT);
  assert.equal(r.via, "core");
  assert.equal(hc.calls.filter((c) => c[0] === "run").length, 1);
  // timeout de do: puede haber creado el terminal → error, sin hc run
  hc = fakeHc();
  app = fakeApp({ status: { out: "{}" }, ls: { out: LS }, do: { err: "TIMEOUT", out: '{"error":"x"}' } });
  assert.deepEqual(await mk({ hc, app }).launch(INPUT), { ok: false, reason: "error", err: "herdr-app do falló" });
  assert.equal(hc.calls.some((c) => c[0] === "run"), false);
  // do OK pero sin terminal en la respuesta
  hc = fakeHc();
  app = fakeApp({ status: { out: "{}" }, ls: { out: LS }, do: { out: '{"pane":"p1"}' } });
  assert.deepEqual(await mk({ hc, app }).launch(INPUT), { ok: false, reason: "error", err: "herdr-app no devolvió el terminal" });
  assert.equal(hc.calls.some((c) => c[0] === "run"), false);
});

test("launch sin binario herdr-app: va directo a hc run sin ejecutar nada de la app", async () => {
  const app = fakeApp({});
  const r = await mk({ hc: fakeHc(), app, appPath: null }).launch(INPUT);
  assert.equal(r.via, "core");
  assert.equal(app.calls.length, 0);
});

test("status: installed/running/app sin arrancar nada", async () => {
  assert.deepEqual(await mk({ hc: null }).status(), { installed: false, running: false, app: false });
  const noCoreApp = fakeApp({ status: { out: "{}" } });
  assert.deepEqual(await mk({ hc: fakeHc({ up: false }), app: noCoreApp }).status(), { installed: true, running: false, app: false });
  assert.equal(noCoreApp.calls.length, 0); // sin core: ninguna invocación de herdr-app
  assert.deepEqual(await mk({ hc: fakeHc(), app: fakeApp({ status: { err: 2 } }) }).status(), { installed: true, running: true, app: false });
  assert.deepEqual(await mk({ hc: fakeHc(), app: fakeApp({ status: { out: "{}" } }) }).status(), { installed: true, running: true, app: true });
  const app = fakeApp({});
  assert.deepEqual(await mk({ hc: fakeHc(), app, appPath: null }).status(), { installed: true, running: true, app: false });
  assert.equal(app.calls.length, 0);
});

test("fallo tras despachar hc run (timeout / respuesta ilegible / core muerto después) → error, NUNCA no-core", async () => {
  for (const failure of [
    { ok: false, err: "no se pudo crear el terminal", nameTaken: false },
    { ok: false, err: "hc no devolvió el terminal" },
  ]) {
    let up = true;
    const hc = { ...fakeHc({ runs: [failure] }), coreUp: async () => { const v = up; up = false; return v; } }; // el core "muere" tras el despacho
    const r = await mk({ hc, app: fakeApp({}) }).launch(INPUT);
    assert.deepEqual([r.ok, r.reason], [false, "error"]);
  }
  // solo cuando hc ni se ejecutó (sondeo previo falló) es seguro caer a tmux
  const safe = fakeHc({ runs: [{ ok: false, err: "hc no disponible", code: "NOCORE" }] });
  assert.equal((await mk({ hc: safe, app: fakeApp({}) }).launch(INPUT)).reason, "no-core");
});

test("herdr-app corre con el mismo entorno que hc hacia el core (Linux: XDG_RUNTIME_DIR de /run/user)", async () => {
  const seen = [];
  const exec = (_file, argv, opts, cb) => {
    seen.push({ cmd: argv[0], env: opts.env });
    cb(null, argv[0] === "ls" ? LS : argv[0] === "do" ? '{"terminal":"t9"}' : "ok");
  };
  const hc = { ...fakeHc(), hcEnv: async () => ({ XDG_RUNTIME_DIR: "/run/user/0" }) };
  const l = createHerdrLauncher({ getHerdr: () => hc, findApp: () => APP, exec, nameSuffix: "abc", env: { A: "1" } });
  const r = await l.launch(INPUT);
  assert.equal(r.ok, true);
  assert.deepEqual(seen.map((c) => c.cmd), ["status", "ls", "do"]);
  for (const c of seen) assert.deepEqual({ A: c.env.A, X: c.env.XDG_RUNTIME_DIR }, { A: "1", X: "/run/user/0" }, c.cmd);
  assert.equal((await l.status()).app, true);
});

test("herdr-app: sin overlay (hcEnv {}) el entorno es el original", async () => {
  const envs = [];
  const exec = (_f, argv, opts, cb) => { envs.push(opts.env); cb(null, "ok"); };
  const l = createHerdrLauncher({ getHerdr: () => fakeHc(), findApp: () => APP, exec, env: { A: "1" } });
  assert.equal((await l.status()).app, true);
  assert.equal(envs.length, 1);
  assert.equal(envs[0].A, "1");
  assert.equal(envs[0].XDG_RUNTIME_DIR, process.env.XDG_RUNTIME_DIR);
});

test("herdr-app falla CERRADO: hcEnv null, error o ausente → cero llamadas a herdr-app (status y launch)", async () => {
  const variants = {
    null: { ...fakeHc(), hcEnv: async () => null },
    throw: { ...fakeHc(), hcEnv: async () => { throw new Error("boom"); } },
    missing: (() => { const h = fakeHc(); delete h.hcEnv; return h; })(),
  };
  for (const [name, hc] of Object.entries(variants)) {
    const app = fakeApp({ status: { out: "ok" }, ls: { out: LS }, do: { out: '{"terminal":"t9"}' } });
    const l = createHerdrLauncher({ getHerdr: () => hc, findApp: () => APP, exec: app.exec, nameSuffix: "abc" });
    assert.deepEqual(await l.status(), { installed: true, running: true, app: false }, name);
    assert.deepEqual(await l.launch(INPUT), { ok: false, reason: "no-core" }, name);
    assert.equal(app.calls.length, 0, name);
    assert.equal(hc.calls.filter(([k]) => k === "run").length, 0, name);
  }
});

test("herdr-app: el core muere tras coreUp → launch devuelve no-core sin herdr-app ni hc run", async () => {
  let envCalls = 0;
  const hc = { ...fakeHc(), hcEnv: async () => (envCalls++ === 0 ? null : {}) };
  const app = fakeApp({ status: { out: "ok" } });
  const l = createHerdrLauncher({ getHerdr: () => hc, findApp: () => APP, exec: app.exec, nameSuffix: "abc" });
  assert.deepEqual(await l.launch(INPUT), { ok: false, reason: "no-core" });
  assert.equal(app.calls.length, 0);
  assert.equal(hc.calls.filter(([k]) => k === "run").length, 0);
});

test("herdr-app: el entorno se resuelve una vez por lanzamiento y se reutiliza en status, ls y do", async () => {
  let envCalls = 0;
  const hc = { ...fakeHc(), hcEnv: async () => { envCalls++; return { XDG_RUNTIME_DIR: "/run/user/0" }; } };
  const app = fakeApp({ status: { out: "ok" }, ls: { out: LS }, do: { out: '{"terminal":"t9"}' } });
  const l = createHerdrLauncher({ getHerdr: () => hc, findApp: () => APP, exec: app.exec, nameSuffix: "abc" });
  assert.equal((await l.launch(INPUT)).ok, true);
  assert.equal(envCalls, 1);
  assert.deepEqual(app.calls.map((c) => c.argv[0]), ["status", "ls", "do"]);
});
