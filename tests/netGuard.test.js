const { test, describe, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { isPrivateIp, createGuardedLookup, assertSafeUrlShape, openGuardedStream, MediaFetchError } = require("../src/utils/netGuard");

describe("isPrivateIp", () => {
  const blocked = ["127.0.0.1", "10.0.0.1", "172.16.5.5", "172.31.255.255", "192.168.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255",
    "::1", "::", "fe80::1", "fc00::1", "fd12::1", "::ffff:127.0.0.1", "::ffff:10.1.1.1", "2001:db8::1", "ff02::1", "garbage"];
  const allowed = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "172.15.0.1", "::ffff:8.8.8.8", "2606:4700:4700::1111"];
  for (const ip of blocked) test(`blocks ${ip}`, () => assert.equal(isPrivateIp(ip), true));
  for (const ip of allowed) test(`allows ${ip}`, () => assert.equal(isPrivateIp(ip), false));
});

describe("assertSafeUrlShape", () => {
  for (const u of ["file:///etc/passwd", "ftp://x.com/a", "http://user:pw@cdn.example.com/a", "http://cdn.example.com:8080/a", "http://127.0.0.1/a",
    "http://[::1]/a", "http://169.254.169.254/latest", "http://localhost/a", "http://svc.internal/a", "not a url"])
    test(`rejects ${u}`, () => assert.throws(() => assertSafeUrlShape(u), (e) => e instanceof MediaFetchError && e.kind === "blocked"));
  test("accepts public https", () => assert.equal(assertSafeUrlShape("https://cdn.example.com/v.mp4").hostname, "cdn.example.com"));
});

describe("guarded DNS lookup (the address validated IS the address connected to)", () => {
  const fake = (addrs) => (host, opts, cb) => cb(null, addrs);
  const run = (g, host, opts = {}) => new Promise((res) => g(host, opts, (err, a, f) => res({ err, a, f })));
  test("rejects hostnames resolving to private IPs (DNS rebinding / internal names)", async () => {
    const r = await run(createGuardedLookup({ lookup: fake([{ address: "10.0.0.5", family: 4 }]) }), "evil.example.com");
    assert.equal(r.err.kind, "blocked");
  });
  test("rejects if ANY returned address is private", async () => {
    const r = await run(createGuardedLookup({ lookup: fake([{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }]) }), "mixed.example.com");
    assert.equal(r.err.kind, "blocked");
  });
  test("passes public addresses (single + all modes)", async () => {
    const g = createGuardedLookup({ lookup: fake([{ address: "93.184.216.34", family: 4 }]) });
    assert.deepEqual(await run(g, "ok.example.com"), { err: null, a: "93.184.216.34", f: 4 });
    const all = await run(g, "ok.example.com", { all: true });
    assert.deepEqual(all.a, [{ address: "93.184.216.34", family: 4 }]);
  });
});

describe("openGuardedStream against a local server (policy relaxed ONLY for loopback in this test)", () => {
  let server, port;
  const relaxed = (extra = {}) => ({ isBlocked: (ip) => ip !== "127.0.0.1" && isPrivateIp(ip), lookup: createGuardedLookup({ isBlocked: (ip) => ip !== "127.0.0.1" && isPrivateIp(ip) }), allowedPorts: null, ...extra });
  const start = async () => {
    server = http.createServer((req, res) => {
      const u = req.url;
      if (u === "/ok") { res.writeHead(200, { "content-type": "video/mp4", "content-length": "5" }); return res.end("hello"); }
      if (u === "/redir-ok") { res.writeHead(302, { location: "/ok" }); return res.end(); }
      if (u === "/redir-meta") { res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }); return res.end(); }
      if (u === "/redir-file") { res.writeHead(302, { location: "file:///etc/passwd" }); return res.end(); }
      if (u === "/loop") { res.writeHead(302, { location: "/loop" }); return res.end(); }
      if (u === "/html") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<html>"); }
      if (u === "/big") { res.writeHead(200, { "content-type": "video/mp4", "content-length": "999999" }); return res.end("x"); }
      const m = /^\/s(\d+)$/.exec(u); if (m) { res.writeHead(Number(m[1])); return res.end(); }
      res.writeHead(404); res.end();
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r)); port = server.address().port;
  };
  after(() => server && server.close());
  const get = async (p, o) => { if (!server) await start(); return openGuardedStream(`http://127.0.0.1:${port}${p}`, { ...relaxed(), ...o }); };
  const rej = async (p, kind, o) => assert.rejects(get(p, o), (e) => e instanceof MediaFetchError && e.kind === kind, `${p} -> ${kind}`);

  test("streams a normal video", async () => { const { res } = await get("/ok"); let b = ""; for await (const c of res) b += c; assert.equal(b, "hello"); });
  test("follows a safe redirect", async () => { const { res, finalUrl } = await get("/redir-ok"); res.resume(); assert.match(finalUrl, /\/ok$/); });
  test("REDIRECT to cloud metadata IP is blocked", async () => rej("/redir-meta", "blocked"));
  test("redirect to file:// is blocked", async () => rej("/redir-file", "blocked"));
  test("redirect loop is bounded", async () => rej("/loop", "permanent", { maxRedirects: 3 }));
  test("non-media content-type rejected", async () => rej("/html", "bad_type"));
  test("declared size over the limit rejected before download", async () => rej("/big", "too_large", { maxBytes: 1000 }));
  test("status classification: 403/404/410 -> expired, 429/503 -> transient, 400 -> permanent", async () => {
    for (const [s, k] of [[403, "expired"], [404, "expired"], [410, "expired"], [429, "transient"], [503, "transient"], [400, "permanent"]]) await rej(`/s${s}`, k);
  });
  test("with the DEFAULT policy, loopback is refused", async () => {
    if (!server) await start();
    await assert.rejects(openGuardedStream(`http://127.0.0.1:${port}/ok`), (e) => e.kind === "blocked");
  });
});
