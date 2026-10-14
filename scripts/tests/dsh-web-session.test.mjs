import test from "node:test";
import assert from "node:assert/strict";
import { lastWebToken, sessionCookie } from "../lib/web-session.mjs";

test("parses a token from a startup log line", () => {
  const token = "aB_9-".repeat(9);
  assert.equal(lastWebToken(`dsh web: /?token=${token} (LAN URL follows)`), token);
  assert.equal(lastWebToken("token=short"), null);
  assert.equal(lastWebToken("starting web server"), null);
});

test("selects the last token in log file contents", () => {
  const first = "a".repeat(43), last = "b_".repeat(22);
  assert.equal(lastWebToken(`/?token=${first}\r\nready\r\n/?token=${last}\r\nready\n`), last);
  assert.equal(lastWebToken(""), null);
});

test("extracts name=value without cookie attributes", () => {
  assert.equal(sessionCookie("dsh-auth-test=payload==; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400"), "dsh-auth-test=payload==");
  assert.equal(sessionCookie("dsh-auth-test=value; Expires=Wed, 21 Oct 2037 07:28:00 GMT"), "dsh-auth-test=value");
  assert.equal(sessionCookie(null), null);
  assert.equal(sessionCookie("invalid"), null);
  assert.equal(sessionCookie("bad=value\r\ninjected=x"), null);
});

// Exercise the actual proxy section on ephemeral ports without starting the panel API.
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import { once } from "node:events";
import vm from "node:vm";

test("proxy renews sessions, preserves other cookies and never replays a streamed body", async (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), "web-session-test-"));
  const file = join(dir, "web.log");
  let generation = 1, requests = 0, exchanges = 0, rejectSession = false;
  let seenHeaders;
  const token = () => String(generation).repeat(43);
  const logToken = () => fs.appendFileSync(file, `/?token=${token()}\n`);
  logToken();
  const upstream = createServer((req, res) => {
    const u = new URL(req.url, "http://localhost");
    if (u.searchParams.has("token")) {
      exchanges++;
      assert.equal(req.headers.host, `127.0.0.1:${upstream.address().port}`);
      if (u.searchParams.get("token") !== token()) { res.writeHead(401); return res.end(); }
      res.writeHead(303, { location: "./", "set-cookie": `dsh-auth-test=${generation}; Path=/; HttpOnly` });
      return res.end();
    }
    requests++;
    seenHeaders = req.headers;
    req.resume();
    if (rejectSession || !req.headers.cookie?.includes(`dsh-auth-test=${generation}`)) {
      res.writeHead(401); return res.end("authentication required");
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.write("<html><head></head>"); res.end("</html>");
  });
  let proxy;
  t.after(async () => {
    for (const server of [proxy, upstream].filter(Boolean)) {
      server.closeAllConnections(); await new Promise((r) => server.close(r));
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const def = { id: "test", name: "Test", web: upstream.address().port, webProxy: 1, webLog: file };
  const context = vm.createContext({ ...fs, lastWebToken, sessionCookie, fetch, AbortSignal, URL, Buffer,
    setTimeout, clearTimeout, httpRequest, netConnect, process: { env: {} }, console: { log() {} },
    TOKEN: null, AGENT_DEFS: [def], def, expand: (p) => p, authorized: () => true, logEvent() {},
    createServer(handler) {
      proxy = createServer(handler);
      const listen = proxy.listen.bind(proxy);
      proxy.listen = () => listen(0, "127.0.0.1");
      return proxy;
    },
  });
  const source = fs.readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  vm.runInContext(source.slice(source.indexOf("const webTokens ="), source.indexOf("async function startWebTool")), context);
  assert.equal(await vm.runInContext("webProbe(def)", context), true);
  vm.runInContext(source.slice(source.indexOf("let PROXY_HTTPS =")), context);
  await once(proxy, "listening");
  const url = `http://127.0.0.1:${proxy.address().port}/`;
  let r = await fetch(url, { headers: { cookie: "mt3k_t=private; theme=dark", accept: "text/html" } });
  assert.equal(r.status, 200);
  assert.match(await r.text(), /crypto.randomUUID/);
  assert.equal(seenHeaders.cookie, "dsh-auth-test=1; theme=dark");
  assert.equal(r.headers.get("set-cookie"), null);

  generation++; logToken(); requests = 0; exchanges = 0;
  r = await fetch(url); assert.equal(r.status, 200); await r.text();
  assert.equal(requests, 2); assert.equal(exchanges, 2);

  generation++; logToken(); requests = 0;
  r = await fetch(url, { method: "POST", body: "payload" });
  assert.equal(r.status, 401); await r.text(); assert.equal(requests, 1);

  rejectSession = true; requests = 0; exchanges = 0;
  r = await fetch(url); assert.equal(r.status, 401); await r.text();
  assert.equal(requests, 2); assert.equal(exchanges, 1);

  rejectSession = false; generation++; logToken(); exchanges = 0;
  const statuses = await Promise.all(Array.from({ length: 6 }, async () => {
    const r = await fetch(url); await r.text(); return r.status;
  }));
  assert.deepEqual(statuses, Array(6).fill(200)); assert.equal(exchanges, 2);

  delete def.webLog; requests = 0; exchanges = 0;
  r = await fetch(url, { headers: { cookie: "mt3k_t=private; theme=dark" } });
  assert.equal(r.status, 401); await r.text();
  assert.equal(seenHeaders.cookie, undefined); assert.equal(exchanges, 0);
});
