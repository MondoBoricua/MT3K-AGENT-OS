import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { createHerdrConn, encodeObserverWrite } from './herdr-conn.mjs';
// Las pruebas no dependen del entorno de quien las corre (sesión de Herdr o directorios XDG heredados).
for (const k of ["HC_SESSION", "XDG_RUNTIME_DIR", "XDG_STATE_HOME"]) delete process.env[k];


function frame(channel, kind, payload = Buffer.alloc(0)) {
  if (!Buffer.isBuffer(payload)) payload = Buffer.from(JSON.stringify(payload));
  const out = Buffer.alloc(9 + payload.length);
  out.writeUInt32LE(channel); out[4] = kind; out.writeUInt32LE(payload.length, 5); payload.copy(out, 9);
  return out;
}
function harness(options = {}) {
  const children = [], calls = [], writes = [];
  let live = 0, peak = 0;
  function spawn(path, argv, opts) {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.channels = new Set(); child.killCount = 0; child.framed = false; child.nextChannel = 1;
    const timed = new Set();
    child.kill = () => {
      if (child.killCount++) return;
      live -= child.channels.size; child.channels.clear();
      for (const timer of timed) clearTimeout(timer);
      child.emit('exit', 0, 'SIGTERM');
    };
    function send(bytes) {
      const size = options.fragment ?? bytes.length;
      for (let i = 0; i < bytes.length; i += size) child.stdout.write(bytes.subarray(i, i + size));
    }
    child.send = send;
    child.stdin = new Writable({ write(bytes, _, callback) {
      writes.push(Buffer.from(bytes));
      if (!child.framed) {
        const request = JSON.parse(bytes.toString()); calls.push(request);
        assert.equal(request.method, 'hello');
        child.framed = true;
        if (!options.noHello) send(Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { framed: true } }) + '\n'));
      } else {
        const channel = bytes.readUInt32LE(), kind = bytes[4], payload = bytes.subarray(9);
        if (channel === 0) {
          const request = JSON.parse(payload.toString()); calls.push(request);
          assert.equal(request.method, 'terminal.attach');
          assert.equal(request.params.observe, true);
          if (options.attachError) send(frame(0, 0, { id: request.id, error: { code: 'not_found', message: 'missing terminal' } }));
          else if (options.exitFirst && children.length === 1) child.kill();
          else {
            const channel = child.nextChannel++; child.channels.add(channel); live++; peak = Math.max(peak, live);
            const reply = frame(0, 0, { id: request.id, result: { channel, terminal: { cols: 96, rows: 43 } } });
            const size = Buffer.alloc(4); size.writeUInt16LE(80); size.writeUInt16LE(24, 2);
            const data = options.data ?? Buffer.from('\x1b[31mhello\x1b[0m');
            const initial = Buffer.concat([reply, frame(channel, 3, size), ...(options.noData ? [] : [frame(channel, 0, data)])]);
            send(initial); // reply, RESIZE and DATA can share one incoming chunk
            if (options.afterAttach) options.afterAttach({ child, channel, send, frame });
            if (options.continuous) {
              const timer = setInterval(() => send(frame(channel, 0, Buffer.from('x'))), 10); timed.add(timer);
            }
          }
        } else {
          assert.ok([1, 2].includes(kind), 'only CREDIT and CLOSE');
          if (kind === 2 && child.channels.delete(channel)) live--;
        }
      }
      callback();
    } });
    children.push(child); Object.assign(child, { path, argv, options: opts }); return child;
  }
  return { spawn, children, calls, writes, get peak() { return peak; }, get live() { return live; } };
}
function setup(t, options = {}, config = {}) {
  const fake = harness(options), conn = createHerdrConn({ hcPath: '/fake/hc', spawn: fake.spawn, locateCore: async () => ({}), ...config });
  t.after(() => conn.close()); return { fake, conn };
}

test('lazy child, fixed connect argv, hello, observer attach, CREDIT/CLOSE and reuse', async t => {
  const env = { EXAMPLE: 'yes' }; const { fake, conn } = setup(t, {}, { env });
  assert.equal(fake.children.length, 0);
  const a = conn.snapshot('t9', { cols: 96, rows: 43, history: 60 });
  assert.equal(conn.snapshot('t9', { cols: 100, rows: 50 }), a, 'per-address promise dedup');
  const result = await a;
  assert.deepEqual(result, { ok: true, bytes: Buffer.from('\x1b[31mhello\x1b[0m'), cols: 80, rows: 24 });
  assert.equal(fake.live, 0);
  assert.equal(fake.children[0].path, '/fake/hc');
  assert.deepEqual(fake.children[0].argv, ['connect']);
  assert.equal(fake.children[0].options.windowsHide, true); assert.equal(fake.children[0].options.env, env);
  assert.deepEqual(fake.calls.map(c => c.method), ['hello', 'terminal.attach']);
  assert.deepEqual(fake.calls[1].params, { terminal: 't9', observe: true, resize_notifications: true, cols: 96, rows: 43, history: 60 });
  assert.ok(fake.writes.some(w => w[4] === 1 && w.readUInt32LE(9) === result.bytes.length));
  assert.ok(fake.writes.some(w => w[4] === 2 && w.length === 9));
  await conn.snapshot('t10'); assert.equal(fake.children.length, 1);
});
test('byte-fragmented hello, frame headers and payloads', async t => {
  const { conn } = setup(t, { fragment: 1 });
  assert.equal((await conn.snapshot('t9')).bytes.toString(), '\x1b[31mhello\x1b[0m');
});
test('validation never spawns, dimensions are clamped, history defaults to 1000', async t => {
  const { fake, conn } = setup(t);
  for (const invalid of ['t', 't1234567', 't9AA', '../t9', 't9\n', null, 9]) assert.equal((await conn.snapshot(invalid)).ok, false);
  assert.equal(fake.children.length, 0);
  await conn.snapshot('t123456a', { cols: 2, rows: 999, history: 9999 });
  assert.deepEqual(fake.calls[1].params, { terminal: 't123456a', observe: true, resize_notifications: true, cols: 20, rows: 300, history: 2000 });
  await conn.snapshot('t3', { cols: 999, rows: -1, history: -2 });
  assert.deepEqual([fake.calls[2].params.cols, fake.calls[2].params.rows, fake.calls[2].params.history], [500, 5, 0]);
  await conn.snapshot('t4'); assert.equal(fake.calls[3].params.history, 1000);
});
test('attach error returns bounded error without stream or rejection', async t => {
  const { conn, fake } = setup(t, { attachError: true });
  assert.deepEqual(await conn.snapshot('t9'), { ok: false, err: 'missing terminal' });
  assert.equal(fake.live, 0); assert.equal(conn.stats().channels, 0);
});
test('child exit during attach fails request, then lazy respawn respects backoff', async t => {
  let time = 10000;
  const { conn, fake } = setup(t, { exitFirst: true }, { now: () => time });
  assert.equal((await conn.snapshot('t9')).ok, false);
  assert.equal(conn.stats().retryAt, 11000); assert.equal(conn.stats().failures, 1);
  await delay(10); assert.equal(fake.children.length, 1, 'no eager reconnect');
  time = 11000;
  assert.equal((await conn.snapshot('t9')).ok, true); assert.equal(fake.children.length, 2);
  fake.children[1].kill(); assert.equal(conn.stats().retryAt, 12000, 'a good hello reset the backoff');
});
test('close interrupts a pending reconnect delay and clears every timer', async t => {
  const { conn } = setup(t, { exitFirst: true });
  await conn.snapshot('t9'); const pending = conn.snapshot('t9');
  await delay(10); assert.ok(conn.stats().timers > 0);
  conn.close(); assert.equal((await pending).ok, false);
  assert.equal(conn.stats().timers, 0); assert.equal(conn.stats().active, 0);
});
test('idle shutdown, later request restarts; close is final and idempotent', async t => {
  const { conn, fake } = setup(t, {}, { idleMs: 15 });
  await conn.snapshot('t9'); await delay(35);
  assert.equal(fake.children[0].killCount, 1); assert.equal(conn.stats().connected, false);
  await conn.snapshot('t9'); assert.equal(fake.children.length, 2);
  conn.close(); conn.close();
  assert.equal(fake.children[1].killCount, 1); assert.equal(conn.stats().timers, 0);
  assert.equal((await conn.snapshot('t9')).ok, false);
});
test('at most four simultaneous attaches; queued work drains', async t => {
  const { conn, fake } = setup(t);
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => conn.snapshot(`t${i}`)));
  assert.equal(results.every(r => r.ok), true); assert.equal(fake.peak, 4); assert.equal(fake.live, 0);
  assert.equal(fake.children.length, 1); assert.equal(conn.stats().inflight, 0);
});
test('bounded waiting queue and close settle queued/active requests', async t => {
  const { conn, fake } = setup(t, { noData: true });
  const promises = Array.from({ length: 68 }, (_, i) => conn.snapshot(`t${i}`));
  assert.equal((await conn.snapshot('t100')).err, 'snapshot queue full');
  await delay(10); assert.equal(fake.peak, 4);
  conn.close(); assert.ok((await Promise.all(promises)).every(r => !r.ok));
  assert.equal(conn.stats().inflight, 0); assert.equal(conn.stats().timers, 0);
});
test('allowlist rejects every writer RPC/frame and nonobserver attach', () => {
  for (const method of ['terminal.send', 'terminal.keys', 'terminal.run', 'terminal.resize', 'events.subscribe', 'server.stop']) {
    assert.throws(() => encodeObserverWrite({ rpc: { method, params: {} } }, true), /not allowed/);
  }
  for (const kind of [0, 3, 4, 5, 6, 7]) assert.throws(() => encodeObserverWrite({ channel: 1, kind }, true), /not allowed/);
  assert.throws(() => encodeObserverWrite({ rpc: { method: 'terminal.attach', params: { terminal: 't9', observe: false } } }, true));
  assert.throws(() => encodeObserverWrite({ channel: 0, kind: 1, payload: Buffer.alloc(4) }, true));
  assert.throws(() => encodeObserverWrite({ channel: 1, kind: 2, payload: Buffer.from('x') }, true));
  assert.throws(() => encodeObserverWrite({ rpc: { method: 'hello', params: { framed: true } } }, true));
});
test('large repaint returns credits beyond initial 256KiB window', async t => {
  const { conn, fake } = setup(t, { data: Buffer.alloc(300000, 65), fragment: 8192 });
  const result = await conn.snapshot('t9'); assert.equal(result.bytes.length, 300000);
  assert.ok(fake.writes.some(w => w[4] === 1 && w.readUInt32LE(9) === 300000));
});
test('repaint byte cap, oversized frame header and malformed JSON fail safely', async t => {
  for (const variant of ['bytes', 'header', 'json']) {
    const { conn } = setup(t, { afterAttach({ send, channel, frame }) {
      if (variant === 'bytes') send(frame(channel, 0, Buffer.alloc(2 * 1024 * 1024, 65)));
      else if (variant === 'header') { const h = Buffer.alloc(9); h.writeUInt32LE(channel); h.writeUInt32LE(2 * 1024 * 1024 + 1, 5); send(h); }
      else send(frame(0, 0, Buffer.from('{invalid')));
    } });
    assert.equal((await conn.snapshot('t9')).ok, false); conn.close(); assert.equal(conn.stats().timers, 0);
  }
});
test('stderr drained and capped at 4096 bytes', async t => {
  const { conn, fake } = setup(t);
  await conn.snapshot('t9'); fake.children[0].stderr.write(Buffer.alloc(100000, 65));
  assert.equal(conn.stats().stderrBytes, 4096);
});
test('continuous output is bounded to 400ms from first DATA', async t => {
  const { conn } = setup(t, { continuous: true });
  const start = performance.now(); const result = await conn.snapshot('t9');
  const elapsed = performance.now() - start;
  t.diagnostic(`continuous capture ${elapsed.toFixed(2)}ms`);
  assert.ok(result.ok); assert.ok(elapsed >= 380 && elapsed < 800);
});
test('resize before replacement repaint discards the old paint', async t => {
  const { conn } = setup(t, { afterAttach({ channel, send, frame }) {
    const size = Buffer.alloc(4); size.writeUInt16LE(100); size.writeUInt16LE(30, 2);
    send(Buffer.concat([frame(channel, 3, size), frame(channel, 0, Buffer.from('replacement'))]));
  } });
  const result = await conn.snapshot('t9');
  assert.deepEqual([result.cols, result.rows, result.bytes.toString()], [100, 30, 'replacement']);
});
test('exit after first DATA does not return a partial successful snapshot', async t => {
  const { conn } = setup(t, { afterAttach({ child }) { child.kill(); } });
  assert.equal((await conn.snapshot('t9')).ok, false);
  assert.equal(conn.stats().channels, 0);
});
test('no DATA and no hello have bounded deadlines and clean shutdown', async t => {
  const a = setup(t, { noData: true }), b = setup(t, { noHello: true });
  const results = await Promise.all([a.conn.snapshot('t9'), b.conn.snapshot('t9')]);
  assert.ok(results.every(r => !r.ok));
  a.conn.close(); b.conn.close();
  assert.equal(a.conn.stats().timers, 0); assert.equal(b.conn.stats().timers, 0);
});
test('spawn exceptions return failures; exponential backoff is capped at 30s', async t => {
  let time = 0, attempts = 0;
  const conn = createHerdrConn({ spawn() { attempts++; throw new Error('missing hc'); }, now: () => time, locateCore: async () => ({}) });
  t.after(() => conn.close());
  for (const wait of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    assert.equal((await conn.snapshot('t9')).ok, false);
    assert.equal(conn.stats().retryAt - time, wait); time += wait;
  }
  assert.equal(attempts, 7);
});
test('empty DATA does not start a capture or retain chunks', async t => {
  const { conn } = setup(t, { data: Buffer.alloc(0), afterAttach({ channel, send, frame }) {
    send(frame(channel, 0, Buffer.from('nonempty')));
  } });
  assert.equal((await conn.snapshot('t9')).bytes.toString(), 'nonempty');
});

test('S4: while a retry is pending snapshot() returns at once (no sleeping) and failures reset after hello', async t => {
  let time = 10000;
  const { conn, fake } = setup(t, { exitFirst: true }, { now: () => time });
  assert.equal((await conn.snapshot('t9')).ok, false);
  const t0 = performance.now();
  const r = await conn.snapshot('t9');
  assert.equal(r.ok, false);
  assert.ok(performance.now() - t0 < 50, 'must not wait for the 1 s backoff');
  assert.equal(fake.children.length, 1);
  time = 11000;
  assert.equal((await conn.snapshot('t9')).ok, true);
  assert.equal(conn.stats().failures, 0);
});

test('B2: canSpawn is checked before every spawn; false never spawns and closes a live child', async t => {
  let allowed = false, checks = 0;
  const { conn, fake } = setup(t, {}, { canSpawn: async () => { checks++; return allowed; } });
  assert.equal((await conn.snapshot('t9')).ok, false);
  assert.equal(fake.children.length, 0);
  allowed = true;
  assert.equal((await conn.snapshot('t9')).ok, true);
  assert.equal(fake.children.length, 1);
  allowed = false; // el core murió con el hijo vivo
  assert.equal((await conn.snapshot('t9')).ok, false);
  assert.equal(fake.children[0].killCount, 1);
  assert.equal(fake.children.length, 1);
  assert.equal(conn.stats().connected, false);
  assert.ok(checks >= 3);
});

test('N8: cols/rows from attach reply and resize frames are clamped to 20..500 / 5..300', async t => {
  const { conn } = setup(t, { afterAttach({ channel, send, frame }) {
    const size = Buffer.alloc(4); size.writeUInt16LE(9000); size.writeUInt16LE(9000, 2);
    send(frame(channel, 3, size)); send(frame(channel, 0, Buffer.from('z')));
  } });
  const r = await conn.snapshot('t9');
  assert.equal(r.ok, true);
  assert.deepEqual([r.cols, r.rows], [500, 300]);
});

test('R4-1: a fresh connection still in hello is never returned by a canSpawn that resolved late', async t => {
  const answers = [[true, 50], [false, 5], [true, 0]];
  let i = 0;
  const { conn, fake } = setup(t, {}, { canSpawn: () => { const [v, ms] = answers[Math.min(i++, 2)]; return delay(ms).then(() => v); } });
  assert.equal((await conn.snapshot('t9')).ok, true); // conexión inicial (respuestas ajenas al reproductor)
  i = 0;
  const a = conn.snapshot('t1'), b = conn.snapshot('t2'), c = conn.snapshot('t3');
  const results = await Promise.all([a, b, c]);
  assert.equal(results[0].ok, true, results[0].err); // la que esperó el canSpawn lento NO recibe la conexión nueva sin hello
  assert.equal(results[1].ok, false); // su canSpawn dijo false
  assert.ok(!/observer attach required/.test(results[2].err ?? ''));
  assert.equal(conn.stats().failures, 0);
  assert.ok(fake.children.length >= 1);
});

test('spawn env: the resolved runtime dir reaches hc connect; nothing resolved keeps the same env object', async t => {
  const env = { EXAMPLE: 'yes' };
  const withRuntime = setup(t, {}, { env, locateCore: async () => ({ XDG_RUNTIME_DIR: '/run/user/0' }) });
  assert.equal((await withRuntime.conn.snapshot('t9')).ok, true);
  assert.deepEqual(withRuntime.fake.children[0].options.env, { EXAMPLE: 'yes', XDG_RUNTIME_DIR: '/run/user/0' });
  assert.deepEqual(env, { EXAMPLE: 'yes' }, 'input env is not mutated');
  const plain = setup(t, {}, { env, locateCore: async () => ({}) });
  assert.equal((await plain.conn.snapshot('t9')).ok, true);
  assert.equal(plain.fake.children[0].options.env, env);
});

test('spawn fails CLOSED: no live core (null) or a throwing locator means zero spawns', async t => {
  const env = { EXAMPLE: 'yes' };
  for (const [name, locateCore] of [['null', async () => null], ['undefined', async () => undefined], ['throw', async () => { throw new Error('boom'); }]]) {
    const { fake, conn } = setup(t, {}, { env, locateCore });
    assert.equal((await conn.snapshot('t9')).ok, false, name);
    assert.equal((await conn.snapshot('t9')).ok, false, name + ' (again)');
    assert.equal(fake.children.length, 0, name);
    assert.equal(conn.stats().spawns, 0, name);
  }
});

test('spawn env: the core disappears between connections → the respawn does not happen', async t => {
  let alive = true;
  const { fake, conn } = setup(t, {}, { env: {}, locateCore: async () => (alive ? {} : null) });
  assert.equal((await conn.snapshot('t9')).ok, true);
  assert.equal(fake.children.length, 1);
  alive = false;
  fake.children[0].kill();
  await delay(20);
  assert.equal((await conn.snapshot('t10')).ok, false);
  assert.equal(fake.children.length, 1, 'no second hc connect once the core is gone');
});

test('canSpawn=false never locates nor spawns', async t => {
  let located = 0;
  const { fake, conn } = setup(t, {}, { env: {}, canSpawn: async () => false, locateCore: async () => { located++; return {}; } });
  assert.equal((await conn.snapshot('t9')).ok, false);
  assert.equal(fake.children.length, 0);
  assert.equal(located, 0);
});
