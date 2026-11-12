import { spawn as nodeSpawn } from 'node:child_process';

const MAX_BYTES = 2 * 1024 * 1024;
const CONTROL_MAX = 64 * 1024;
const ADDRESS = /^t[0-9]{1,6}[a-z]?$/;
const clamp = (v, lo, hi, fallback) => Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.trunc(v))) : fallback;

/** @internal Single outbound encoder. No generic raw-write escape hatch. */
export function encodeObserverWrite(message, framed) {
  let channel = 0, kind = 0, payload;
  if (message.rpc) {
    const rpc = message.rpc;
    if (!['hello', 'terminal.attach'].includes(rpc.method)) throw new Error('RPC not allowed');
    if (rpc.method === 'hello' && (framed || rpc.params?.framed !== true)) throw new Error('invalid hello');
    if (rpc.method === 'terminal.attach' && (!framed || rpc.params?.observe !== true || !ADDRESS.test(rpc.params?.terminal))) throw new Error('observer attach required');
    payload = Buffer.from(JSON.stringify(rpc));
    if (payload.length > CONTROL_MAX) throw new Error('control limit');
    if (!framed) return Buffer.concat([payload, Buffer.from('\n')]);
  } else {
    ({ channel, kind, payload = Buffer.alloc(0) } = message);
    if (!framed || !Number.isInteger(channel) || channel < 1 || channel > 0xffffffff || ![1, 2].includes(kind)) throw new Error('stream frame not allowed');
    if (!Buffer.isBuffer(payload) || (kind === 1 ? payload.length !== 4 : payload.length !== 0)) throw new Error('invalid stream payload');
  }
  const out = Buffer.alloc(9 + payload.length);
  out.writeUInt32LE(channel); out[4] = kind; out.writeUInt32LE(payload.length, 5); payload.copy(out, 9);
  return out;
}

/** One lazy, read-only hc connect transport. No other hc command is invoked. */
export function createHerdrConn({ hcPath = 'hc', spawn = nodeSpawn, env = process.env, now = Date.now, idleMs = 30000 } = {}) {
  let closed = false, conn = null, connecting = null, active = 0, nextId = 1;
  let failures = 0, retryAt = 0, spawns = 0, idle = null;
  const timers = new Map(), inflight = new Map(), queue = [];
  const later = (fn, ms, cancel = () => {}) => {
    const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
    timers.set(t, cancel); return t;
  };
  const clear = t => { if (t) { clearTimeout(t); timers.delete(t); } };
  const sleep = ms => new Promise(resolve => later(() => resolve(true), ms, () => resolve(false)));
  const error = err => ({ ok: false, err: String(err?.message ?? err).slice(0, 300) });
  function write(c, message) {
    const bytes = encodeObserverWrite(message, c.framed);
    if (c.dead || closed) throw new Error('connection closed');
    // Bound Node's pending stdin queue too; never retain unbounded CREDIT writes.
    if ((c.child.stdin.writableLength ?? 0) + bytes.length > CONTROL_MAX) throw new Error('hc write backlog');
    c.child.stdin.write(bytes);
  }
  function fail(c, reason, intentional = false) {
    if (c.dead) return;
    c.dead = true;
    if (conn === c) conn = null;
    if (!intentional && !closed) { retryAt = now() + Math.min(30000, 1000 * 2 ** Math.min(failures++, 5)); }
    c.ready?.(null); c.ready = null;
    for (const p of [...c.pending.values()]) p.finish(error(reason));
    for (const p of [...c.channels.values()]) p.finish(error(reason));
    c.pending.clear(); c.channels.clear();
    clear(c.helloTimer);
    c.payload = null; c.stderr = Buffer.alloc(0);
    try { c.child.kill(); } catch { /* already gone */ }
  }
  function rpc(c, method, params, onResult) {
    return new Promise(resolve => {
      const id = nextId++;
      const timer = later(() => fail(c, 'hc RPC timeout'), 2000);
      const finish = value => { clear(timer); c.pending.delete(id); resolve(value); };
      c.pending.set(id, { finish, onResult });
      try { write(c, { rpc: { jsonrpc: '2.0', id, method, params } }); }
      catch (e) { fail(c, e); }
    });
  }
  function dispatch(c, message) {
    const p = c.pending.get(message.id);
    if (!p) return; // notifications are deliberately not forwarded
    if (message.error) { p.finish(error(message.error.message ?? message.error.code ?? 'attach error')); return; }
    p.onResult?.(message.result);
    p.finish({ ok: true, result: message.result });
  }
  function frame(c, channel, kind, payload) {
    if (channel === 0) { if (kind === 0) dispatch(c, JSON.parse(payload.toString('utf8'))); return; }
    const p = c.channels.get(channel);
    if (!p) return;
    if (kind === 3) {
      if (payload.length !== 4) throw new Error('invalid resize');
      const cols = payload.readUInt16LE(0), rows = payload.readUInt16LE(2);
      if (!cols || !rows) throw new Error('invalid size');
      // A resize followed by replacement paint invalidates previous collected bytes.
      p.cols = cols; p.rows = rows; p.chunks = []; p.length = 0;
      clear(p.quiet); p.quiet = null;
    } else if (kind === 0) {
      if (!payload.length) return; // Empty DATA must not grow the chunk list.
      if (p.length + payload.length > MAX_BYTES) { p.finish(error('repaint exceeds 2 MiB')); return; }
      p.chunks.push(payload); p.length += payload.length;
      const credit = Buffer.alloc(4); credit.writeUInt32LE(payload.length);
      write(c, { channel, kind: 1, payload: credit });
      clear(p.first);
      if (!p.cap) p.cap = later(() => p.finish(p.length ? p.result() : error('empty repaint')), 400);
      clear(p.quiet);
      p.quiet = later(() => p.finish(p.result()), 40);
    } else if (kind === 2) p.finish(p.length ? p.result() : error('stream closed before repaint'));
  }
  function ingest(c, chunk) {
    let offset = 0;
    while (offset < chunk.length && !c.dead) {
      if (!c.framed) {
        const newline = chunk.indexOf(10, offset), end = newline < 0 ? chunk.length : newline;
        if (c.helloLength + end - offset > CONTROL_MAX) throw new Error('hello limit');
        chunk.copy(c.hello, c.helloLength, offset, end); c.helloLength += end - offset;
        offset = end;
        if (newline < 0) return;
        offset++;
        const reply = JSON.parse(c.hello.subarray(0, c.helloLength).toString('utf8'));
        if (reply.id !== c.helloId || reply.result?.framed !== true) throw new Error('framed hello refused');
        c.framed = true; c.hello = null; clear(c.helloTimer);
        c.ready(c); c.ready = null;
        continue;
      }
      if (!c.payload) {
        const n = Math.min(9 - c.headerLength, chunk.length - offset);
        chunk.copy(c.header, c.headerLength, offset, offset + n); offset += n; c.headerLength += n;
        if (c.headerLength < 9) return;
        c.channel = c.header.readUInt32LE(0); c.kind = c.header[4];
        const length = c.header.readUInt32LE(5);
        if (length > (c.channel === 0 ? CONTROL_MAX : MAX_BYTES)) throw new Error('frame limit');
        c.payload = Buffer.alloc(length); c.payloadLength = 0;
      }
      const n = Math.min(c.payload.length - c.payloadLength, chunk.length - offset);
      chunk.copy(c.payload, c.payloadLength, offset, offset + n); offset += n; c.payloadLength += n;
      if (c.payloadLength === c.payload.length) {
        const payload = c.payload; c.payload = null; c.headerLength = 0;
        frame(c, c.channel, c.kind, payload);
      }
    }
  }
  async function ensure() {
    if (closed) return null;
    if (conn && !conn.dead && conn.framed) return conn;
    if (connecting) return connecting;
    connecting = (async () => {
      if (retryAt > now() && !await sleep(retryAt - now())) return null;
      if (closed) return null;
      let child;
      try { child = spawn(hcPath, ['connect'], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
      catch { retryAt = now() + Math.min(30000, 1000 * 2 ** Math.min(failures++, 5)); return null; }
      spawns++;
      const c = { child, framed: false, dead: false, pending: new Map(), channels: new Map(), stderr: Buffer.alloc(0), hello: Buffer.alloc(CONTROL_MAX), helloLength: 0, header: Buffer.alloc(9), headerLength: 0, payload: null, helloId: nextId++ };
      conn = c;
      const ready = new Promise(resolve => { c.ready = resolve; });
      child.stdout.on('data', b => { try { ingest(c, b); } catch (e) { fail(c, e); } });
      child.stderr.on('data', b => { if (!c.dead) c.stderr = Buffer.concat([c.stderr, b.subarray(Math.max(0, b.length - 4096))]).subarray(-4096); });
      child.on('error', e => fail(c, e));
      child.on('exit', () => fail(c, 'hc connect exited'));
      child.stdin.on('error', e => fail(c, e));
      child.stdout.on('error', e => fail(c, e));
      child.stderr.on('error', e => fail(c, e));
      c.helloTimer = later(() => fail(c, 'hello timeout'), 2000);
      try { write(c, { rpc: { jsonrpc: '2.0', id: c.helloId, method: 'hello', params: { framed: true } } }); }
      catch (e) { fail(c, e); }
      return ready;
    })();
    try { return await connecting; } finally { connecting = null; }
  }
  async function capture(address, size) {
    const c = await ensure();
    if (!c || c.dead || closed) return error('connection unavailable');
    let p;
    const result = new Promise(resolve => {
      p = { ...size, chunks: [], length: 0, channel: null, done: false,
        result() { return { ok: true, bytes: Buffer.concat(p.chunks, p.length), cols: p.cols, rows: p.rows }; },
        finish(value) {
          if (p.done) return;
          p.done = true;
          for (const t of [p.first, p.cap, p.quiet]) clear(t);
          if (p.channel !== null) {
            c.channels.delete(p.channel);
            if (!c.dead && !closed) { try { write(c, { channel: p.channel, kind: 2 }); } catch (e) { fail(c, e); } }
          }
          p.chunks = []; resolve(value);
        },
      };
    });
    const attached = await rpc(c, 'terminal.attach', { terminal: address, observe: true, resize_notifications: true, ...size }, reply => {
      const channel = reply?.channel;
      if (!Number.isInteger(channel) || channel < 1 || channel > 0xffffffff || c.channels.has(channel)) throw new Error('invalid attach channel');
      p.channel = channel;
      if (Number.isInteger(reply?.terminal?.cols) && reply.terminal.cols > 0) p.cols = reply.terminal.cols;
      if (Number.isInteger(reply?.terminal?.rows) && reply.terminal.rows > 0) p.rows = reply.terminal.rows;
      c.channels.set(channel, p);
      p.first = later(() => p.finish(error('no repaint received')), 2000);
    });
    if (!attached.ok) p.finish(attached);
    return result;
  }
  function scheduleIdle() {
    clear(idle);
    if (!closed && active === 0 && queue.length === 0) idle = later(() => { if (conn) fail(conn, 'idle', true); }, clamp(idleMs, 1, 2147483647, 30000));
  }
  function pump() {
    while (!closed && active < 4 && queue.length) {
      const job = queue.shift(); active++;
      // Both branches terminate in resolve; no detached rejected promises.
      Promise.resolve().then(() => capture(job.address, job.size)).catch(error).then(value => {
        active--; inflight.delete(job.address); job.resolve(value); pump(); scheduleIdle();
      });
    }
  }
  return {
    snapshot(address, { cols, rows, history = 1000 } = {}) {
      if (typeof address !== 'string' || !ADDRESS.test(address)) return Promise.resolve(error('invalid address'));
      if (closed) return Promise.resolve(error('connection closed'));
      if (inflight.has(address)) return inflight.get(address);
      if (inflight.size >= 68) return Promise.resolve(error('snapshot queue full'));
      clear(idle);
      const size = { cols: clamp(cols, 20, 500, 200), rows: clamp(rows, 5, 300, 120), history: clamp(history, 0, 2000, 1000) };
      let resolve;
      const promise = new Promise(r => { resolve = r; });
      inflight.set(address, promise); queue.push({ address, size, resolve }); pump();
      return promise;
    },
    close() {
      if (closed) return;
      closed = true;
      if (conn) fail(conn, 'connection closed', true);
      for (const job of queue.splice(0)) { inflight.delete(job.address); job.resolve(error('connection closed')); }
      for (const [timer, cancel] of timers) { clearTimeout(timer); cancel(); }
      timers.clear();
    },
    stats() { return { connected: !!conn?.framed && !conn?.dead, closed, spawns, active, queued: queue.length, inflight: inflight.size, channels: conn?.channels.size ?? 0, timers: timers.size, stderrBytes: conn?.stderr.length ?? 0, failures, retryAt }; },
  };
}

// End condition: upstream viewers.rs attach() queues first_paint before output(),
// wire.rs splits pending bytes into 16 KiB frames with credit, and there is no
// end-of-repaint marker. Forty milliseconds without DATA is therefore a heuristic,
// not a proof of completeness. Continuous output is sampled for at most 400 ms
// from first DATA; captures and individual incoming frames are capped at 2 MiB.
