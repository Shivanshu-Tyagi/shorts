/**
 * Test I (performance) + before/after provider-call comparison.
 *
 * WHAT IS MEASURED vs MODELLED (be careful when quoting these numbers):
 *  - "after" numbers: MEASURED by running the real service/provider-client code against a real
 *    local HTTP fake provider (artificial 120 ms latency) and in-memory stores.
 *  - Store latency is 0 ms here, so hit/miss latencies are the pure application overhead. Real
 *    MongoDB round-trips are NOT included; instead we report DB operations per request, which is
 *    hardware independent.
 *  - "before" numbers: a MODEL of the original code's call pattern (legacySim below), derived by
 *    reading download.controller.js / download.worker.js / rapidapi.service.js. The original code
 *    could not be executed in this sandbox (npm registry unreachable => express/mongoose/axios/
 *    bullmq not installable).
 */
const { test, describe, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
const { buildHarness, okProvider } = require("./helpers");

const PROVIDER_MS = 120;
const results = {};
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };
const stats = (a) => ({ n: a.length, avgMs: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(3), p50Ms: +pct(a, 50).toFixed(3), p95Ms: +pct(a, 95).toFixed(3), maxMs: +Math.max(...a).toFixed(3) });
const timed = async (fn) => { const t = process.hrtime.bigint(); const r = await fn(); return [Number(process.hrtime.bigint() - t) / 1e6, r]; };
const IG = (i) => `https://www.instagram.com/reel/PERF${String(i).padStart(6, "0")}/`;

/** Model of the ORIGINAL flow. Counts billed provider HTTP requests. */
function legacySim() {
  const db = []; // {deviceId, platform(host), sourceId(last seg), status}
  let calls = 0;
  const rapid = (ok = true, retries = 3) => { // old getVideoInfo: up to 3 tries, only the failing ones all count
    for (let i = 0; i < retries; i++) { calls++; if (ok) return true; } return false;
  };
  const lastSeg = (u) => new URL(u).pathname.split("/").filter(Boolean).pop();
  return {
    get calls() { return calls; },
    /** one request; the worker "fresh URL" call happens when the job runs (modelled immediately) */
    request(deviceId, url, { providerOk = true, workerOk = true } = {}) {
      const platform = new URL(url).hostname, sourceId = lastSeg(url);
      const existing = db.find((r) => r.platform === platform && r.sourceId === sourceId && r.status === "ready");
      if (existing) { if (!db.find((r) => r.deviceId === deviceId && r.platform === platform && r.sourceId === sourceId)) db.push({ deviceId, platform, sourceId, status: "ready" }); return; }
      if (!rapid(providerOk)) return;                       // controller call
      const row = { deviceId, platform, sourceId, status: "pending" }; db.push(row);
      // worker: BullMQ attempts:3, each attempt calls getVideoInfo again (3 internal tries when failing)
      for (let attempt = 0; attempt < 3; attempt++) { if (rapid(workerOk)) { row.status = "ready"; return; } }
      row.status = "failed";
    },
    /** N requests that all arrive before the first job finished: none sees a 'ready' row yet */
    burst(devices, url) { for (const d of devices) { const platform = new URL(url).hostname, sourceId = lastSeg(url); if (!rapid(true)) continue; db.push({ deviceId: d, platform, sourceId, status: "pending" }); rapid(true); } },
  };
}

describe("Test I - measurements", () => {
  test("latency: cache-hit vs cache-miss vs provider (pure app overhead, 0 ms store latency)", async () => {
    const H = await buildHarness({ behavior: okProvider({ delayMs: PROVIDER_MS }), env: { PROVIDER_TIMEOUT_MS: "5000" } });
    const miss = [];
    for (let i = 0; i < 25; i++) { const [ms] = await timed(() => H.service.requestDownload({ url: IG(i), deviceId: "warm" })); miss.push(ms); await H.completeJob(`instagram:PERF${String(i).padStart(6, "0")}`); }
    const hitNewDevice = [];
    for (let i = 0; i < 1000; i++) { const [ms] = await timed(() => H.service.requestDownload({ url: IG(i % 25), deviceId: `hit-${i}` })); hitNewDevice.push(ms); }
    const hitSameDevice = [];
    for (let i = 0; i < 1000; i++) { const [ms] = await timed(() => H.service.requestDownload({ url: IG(i % 25), deviceId: "warm" })); hitSameDevice.push(ms); }
    const snap = H.metrics.snapshot();
    results.latency = { providerLatencyMs_fakeInjected: PROVIDER_MS, cacheMiss: stats(miss), cacheHit_newDevice: stats(hitNewDevice), cacheHit_sameDevice: stats(hitSameDevice), providerLatencyObserved: snap.latency.provider_latency, providerCallsTotal: H.fake.calls };
    assert.equal(H.fake.calls, 25, "1000+1000 hits cost zero provider calls");
    assert.ok(stats(miss).p50Ms >= PROVIDER_MS * 0.9, "miss is dominated by the provider");
    assert.ok(stats(hitNewDevice).p95Ms < 20, `hit p95 ${stats(hitNewDevice).p95Ms}ms should be tiny`);
    await H.close();
  });

  test("DB operations per request (hardware independent)", async () => {
    const H = await buildHarness();
    const snap = () => ({ a: H.stores.calls.assets, r: H.stores.calls.rows });
    let s = snap(); await H.service.requestDownload({ url: IG(900), deviceId: "x" }); let e = snap();
    const miss = { assetOps: e.a - s.a, rowOps: e.r - s.r };
    await H.completeJob("instagram:PERF000900");
    await H.service.requestDownload({ url: IG(900), deviceId: "y" }); // warm cache
    s = snap(); await H.service.requestDownload({ url: IG(900), deviceId: "z" }); e = snap();
    const hitNew = { assetOps: e.a - s.a, rowOps: e.r - s.r };
    s = snap(); await H.service.requestDownload({ url: IG(900), deviceId: "z" }); e = snap();
    const hitSame = { assetOps: e.a - s.a, rowOps: e.r - s.r };
    results.dbOpsPerRequest = { cacheMiss: miss, cacheHit_newDevice: hitNew, cacheHit_sameDevice: hitSame };
    assert.equal(hitSame.assetOps, 0); assert.equal(hitSame.rowOps, 1, "single indexed read");
    assert.equal(hitNew.assetOps, 0); assert.ok(hitNew.rowOps <= 2);
    await H.close();
  });

  test("concurrency: 100 simultaneous requests", async () => {
    let H = await buildHarness({ behavior: okProvider({ delayMs: PROVIDER_MS }), env: { PROVIDER_TIMEOUT_MS: "5000" }, storeLatencyMs: 1 });
    let [wall] = await timed(() => Promise.all(Array.from({ length: 100 }, (_, i) => H.service.requestDownload({ url: IG(950), deviceId: `c${i}` }))));
    const same = { requests: 100, wallMs: +wall.toFixed(1), providerCalls: H.fake.calls, jobsEnqueued: H.queue.jobs.length };
    assert.equal(H.fake.calls, 1); await H.close();

    H = await buildHarness({ behavior: okProvider({ delayMs: PROVIDER_MS }), env: { PROVIDER_TIMEOUT_MS: "5000" }, storeLatencyMs: 1 });
    [wall] = await timed(() => Promise.all(Array.from({ length: 100 }, (_, i) => H.service.requestDownload({ url: IG(960 + i), deviceId: "one" }))));
    const distinct = { requests: 100, wallMs: +wall.toFixed(1), providerCalls: H.fake.calls, jobsEnqueued: H.queue.jobs.length };
    assert.equal(H.fake.calls, 100); assert.equal(H.queue.jobs.length, 100); await H.close();

    H = await buildHarness({ behavior: okProvider({ delayMs: PROVIDER_MS }), env: { PROVIDER_TIMEOUT_MS: "5000" }, storeLatencyMs: 1 });
    const svcs = [H.newService(), H.newService(), H.newService(), H.newService()];
    [wall] = await timed(() => Promise.all(Array.from({ length: 100 }, (_, i) => svcs[i % 4].requestDownload({ url: IG(990), deviceId: `m${i}` }))));
    const multi = { requests: 100, instances: 4, wallMs: +wall.toFixed(1), providerCalls: H.fake.calls, lockPolls: H.metrics.get("lock_wait_poll") };
    assert.equal(H.fake.calls, 1); await H.close();
    results.concurrency = { sameVideo_oneProcess: same, sameVideo_fourInstancesSharedLease: multi, hundredDistinctVideos: distinct };
  });

  test("provider calls: BEFORE (modelled original) vs AFTER (measured)", async () => {
    const rows = [];
    const scenario = async (name, legacyFn, newFn) => {
      const L = legacySim(); legacyFn(L);
      const H = await buildHarness(); await newFn(H); const after = H.fake.calls; await H.close();
      rows.push({ scenario: name, before_modelled: L.calls, after_measured: after });
    };
    const ig = "https://www.instagram.com/reel/AAAAA11111/";
    await scenario("1 new video, success", (L) => L.request("d1", ig), (H) => H.service.requestDownload({ url: ig, deviceId: "d1" }));
    await scenario("same video again by 10 other devices after it finished (exact same URL)", (L) => { L.request("d1", ig); for (let i = 0; i < 10; i++) L.request(`o${i}`, ig); },
      async (H) => { await H.service.requestDownload({ url: ig, deviceId: "d1" }); await H.completeJob("instagram:AAAAA11111"); for (let i = 0; i < 10; i++) await H.service.requestDownload({ url: ig, deviceId: `o${i}` }); });
    await scenario("same video again, URL spelled differently (bare host / tracking / /p/ vs /reel/)", (L) => { L.request("d1", ig); ["https://instagram.com/reel/AAAAA11111/?igsh=1", "https://www.instagram.com/p/AAAAA11111/"].forEach((u, i) => L.request(`o${i}`, u)); },
      async (H) => { await H.service.requestDownload({ url: ig, deviceId: "d1" }); await H.completeJob("instagram:AAAAA11111"); for (const [i, u] of ["https://instagram.com/reel/AAAAA11111/?igsh=1", "https://www.instagram.com/p/AAAAA11111/"].entries()) await H.service.requestDownload({ url: u, deviceId: `o${i}` }); });
    await scenario("10 devices request the same NEW video at the same moment", (L) => L.burst(Array.from({ length: 10 }, (_, i) => `d${i}`), ig),
      (H) => Promise.all(Array.from({ length: 10 }, (_, i) => H.service.requestDownload({ url: ig, deviceId: `d${i}` }))));
    await scenario("same device taps download 3x while it is processing", (L) => L.burst(["d1", "d1", "d1"], ig),
      async (H) => { for (let i = 0; i < 3; i++) await H.service.requestDownload({ url: ig, deviceId: "d1" }); });
    await scenario("provider down, 1 request", (L) => L.request("d1", ig, { providerOk: false }),
      async (H) => { H.fake.behavior = () => ({ status: 500, json: {} }); await H.service.requestDownload({ url: ig, deviceId: "d1" }).catch(() => {}); });
    await scenario("provider OK for the API call but media fetch fails in worker (3 BullMQ attempts)", (L) => L.request("d1", ig, { workerOk: false }),
      async (H) => { await H.service.requestDownload({ url: ig, deviceId: "d1" }); /* worker retries reuse the stored URL: no provider calls */ });
    results.providerCalls = rows;
    console.log("\n  scenario".padEnd(100) + "before(model)  after(measured)");
    for (const r of rows) console.log("  " + r.scenario.padEnd(98) + String(r.before_modelled).padEnd(15) + r.after_measured);
    assert.ok(rows.every((r) => r.after_measured <= r.before_modelled));
  });

  after(() => {
    console.log("\n  MEASUREMENTS " + JSON.stringify(results, null, 1).replace(/\n\s*/g, " "));
    if (process.env.WRITE_MEASUREMENTS) fs.writeFileSync(path.join(__dirname, "../docs/measurements.json"), JSON.stringify({ node: process.version, generatedAt: new Date().toISOString(), note: "after = measured; before = modelled from the original source; store latency 0ms; fake provider latency 120ms", ...results }, null, 2));
  });
});
