const { test, describe, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { buildHarness, okProvider, sleep } = require("./helpers");

const IG = (id) => `https://www.instagram.com/reel/${id}/`;
let H;
afterEach(async () => { if (H) { await H.close(); H = null; } });
const req = (url, deviceId = "dev-1") => H.service.requestDownload({ url, deviceId });

describe("Test A - first request (video not in DB)", () => {
  test("executes exactly one provider call, returns valid response, saves reusable record", async () => {
    H = await buildHarness();
    const r = await req(IG("AAAAA11111"));
    assert.equal(H.fake.calls, 1);
    assert.equal(r.outcome, "provider_call");
    assert.equal(r.row.status, "pending");
    assert.match(r.row.title, /Title of/);
    assert.equal(r.row.isDuplicate, false);
    assert.equal(r.row.platform, "www.instagram.com", "legacy hostname format preserved for clients");
    const a = await H.stores.assets.getByKey("instagram:AAAAA11111");
    assert.ok(a, "reusable record saved");
    assert.equal(a.providerCalls, 1);
    assert.match(a.sourceMedia.url, /\/hd\//, "hd_no_watermark preferred, same as the old controller");
    assert.deepEqual(a.formats.map((f) => f.type), ["video", "video", "audio"]);
    assert.equal(H.queue.jobs.length, 1);
    assert.equal(H.queue.jobs[0].data.assetKey, "instagram:AAAAA11111");
    assert.equal(H.metrics.get("external_api_call_started"), 1);
  });

  test("API key is sent to the provider only as a header, never in the body or logs", async () => {
    H = await buildHarness();
    const lines = []; const logger = require("../src/utils/logger");
    process.env.LOG_LEVEL = "debug"; logger.__setSink((l) => lines.push(l));
    try { await req(IG("AAAAA11111")); } finally { logger.__resetSink(); delete process.env.LOG_LEVEL; }
    assert.equal(H.fake.headersSeen[0]["x-rapidapi-key"], "test-secret-key-123");
    assert.ok(!JSON.stringify(H.fake.bodies[0]).includes("test-secret"));
    assert.ok(lines.length > 0, "events were logged");
    assert.ok(!lines.join("\n").includes("test-secret-key-123"), "secret must never appear in logs");
    assert.ok(!lines.join("\n").includes("dev-1"), "raw deviceId must not appear in logs");
    for (const ev of ["download_request_received", "external_api_call_started", "external_api_call_completed"])
      assert.ok(lines.some((l) => l.includes(`"event":"${ev}"`)), `event ${ev} logged`);
  });
});

describe("Test B - same video again", () => {
  test("after processing: DB hit, ZERO extra provider calls, even for another URL shape / device", async () => {
    H = await buildHarness();
    await H.service.requestDownload({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&si=trk", deviceId: "d1" });
    await H.completeJob("youtube:dQw4w9WgXcQ");
    assert.equal(H.fake.calls, 1);

    const again = await H.service.requestDownload({ url: "https://youtu.be/dQw4w9WgXcQ?si=other", deviceId: "d2" });
    assert.equal(again.outcome, "database_cache_hit");
    assert.equal(again.row.status, "ready");
    assert.match(again.row.cdnUrl, /^https:\/\/cdn\.test\//);
    assert.equal(again.row.isDuplicate, true);
    assert.equal(again.message, "Video already processed");

    const same = await H.service.requestDownload({ url: "https://www.youtube.com/shorts/dQw4w9WgXcQ", deviceId: "d1" });
    assert.equal(same.message, "Already saved in your history");
    assert.equal(H.fake.calls, 1, "still exactly one provider call in total");
  });

  test("while the first job is still running: joins it, zero extra provider calls", async () => {
    H = await buildHarness();
    await req(IG("BBBBB22222"), "d1");
    const second = await req(IG("BBBBB22222"), "d2");
    assert.equal(second.outcome, "duplicate_request_joined");
    assert.equal(H.fake.calls, 1);
    assert.equal(H.queue.jobs.length, 1, "no second job");
    await H.completeJob("instagram:BBBBB22222");
    const rows = H.stores.rows.__all();
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.status === "ready"), "joined rows are completed by the single job");
  });

  test("same device tapping download twice does not create a 2nd row or job", async () => {
    H = await buildHarness();
    const a = await req(IG("CCCCC33333"), "d1");
    const b = await req(IG("CCCCC33333"), "d1");
    assert.equal(String(a.row._id), String(b.row._id));
    assert.equal(H.stores.rows.__all().length, 1);
    assert.equal(H.fake.calls, 1);
  });

  test("row created in the race window right after the worker finished is not left pending", async () => {
    H = await buildHarness();
    await req(IG("DDDDD44444"), "d1");
    const realGet = H.stores.assets.getByKey; let n = 0;
    H.stores.assets.getByKey = async (k) => {                // worker completes between our read and insert
      const a = await realGet(k);
      if (++n === 1) await H.completeJob(k);
      return a;
    };
    H.service.__cache.clear();
    const r = await req(IG("DDDDD44444"), "d2");
    assert.equal(r.row.status, "ready");
  });

  test("legacy production rows are reused (no provider call) and promoted to an asset", async () => {
    H = await buildHarness();
    H.stores.rows.__seed({ deviceId: "old", platform: "www.instagram.com", sourceId: "EEEEE55555", status: "ready",
      cdnUrl: "https://cdn.old/videos/legacy.mp4", thumbnailCdn: "https://cdn.old/t.jpg", fileKey: "videos/legacy.mp4", title: "Legacy", duration: 7 });
    const r = await req("https://instagram.com/reel/EEEEE55555/?igsh=abc", "new-dev");
    assert.equal(H.fake.calls, 0);
    assert.equal(r.row.status, "ready");
    assert.equal(r.row.cdnUrl, "https://cdn.old/videos/legacy.mp4");
    assert.equal((await H.stores.assets.getByKey("instagram:EEEEE55555")).legacy, true);
  });

  test("legacy rows are NOT reused when the old sourceId was untrustworthy (youtube watch?v= -> 'watch')", async () => {
    H = await buildHarness();
    H.stores.rows.__seed({ deviceId: "old", platform: "www.youtube.com", sourceId: "watch", status: "ready", cdnUrl: "https://cdn.old/WRONG.mp4" });
    const r = await req("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    assert.equal(H.fake.calls, 1, "must call provider instead of serving some other video");
    assert.notEqual(r.row.cdnUrl, "https://cdn.old/WRONG.mp4");
  });
});

describe("Test C - concurrent requests for the same video", () => {
  test("30 simultaneous requests (one process) -> ONE provider call, all callers get the result", async () => {
    H = await buildHarness({ behavior: okProvider({ delayMs: 150 }), storeLatencyMs: 3 });
    const rs = await Promise.all(Array.from({ length: 30 }, (_, i) => req(IG("FFFFF66666"), `dev-${i}`)));
    assert.equal(H.fake.calls, 1);
    assert.equal(H.queue.jobs.length, 1);
    assert.equal(rs.filter((r) => r.outcome === "provider_call").length, 1);
    assert.ok(rs.every((r) => /Title of/.test(r.row.title) && r.row.status === "pending"));
    assert.equal(new Set(rs.map((r) => String(r.row._id))).size, 30, "each device gets its own history row");
    assert.equal(H.stores.rows.__all().filter((r) => r.isDuplicate === false).length, 1, "exactly one canonical (feed) row");
    assert.equal(H.metrics.get("lock_wait_poll"), 0, "same-process callers share one in-flight promise (no DB lease polling)");
    assert.equal(H.service.__flights.size(), 0, "in-flight entry cleaned up");
  });

  test("simultaneous requests landing on DIFFERENT app instances (shared DB lease) -> still ONE provider call", async () => {
    H = await buildHarness({ behavior: okProvider({ delayMs: 200 }), storeLatencyMs: 3 });
    const instances = [H.newService(), H.newService(), H.newService()]; // separate caches + single-flight maps
    const rs = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      instances[i % 3].requestDownload({ url: IG("GGGGG77777"), deviceId: `d${i}` })));
    assert.equal(H.fake.calls, 1);
    assert.equal(H.queue.jobs.length, 1);
    assert.ok(rs.every((r) => /Title of/.test(r.row.title)));
    assert.equal(H.metrics.get("lock_wait_poll") > 0, true, "followers waited on the lease instead of calling the provider");
  });

  test("dead leader (crashed holding the lock) cannot block forever: lease expires, next caller proceeds", async () => {
    H = await buildHarness();
    await H.stores.assets.tryAcquireLock("instagram:HHHHH88888", "crashed-process", 200);
    const t0 = Date.now();
    const r = await req(IG("HHHHH88888"));
    assert.equal(r.row.status, "pending");
    assert.equal(H.fake.calls, 1);
    assert.ok(Date.now() - t0 >= 150, "waited for lease expiry");
    assert.equal(H.stores.__locks.size, 0, "lock released after work");
  });
});

describe("Test D - different videos are never merged", () => {
  test("two different videos at once -> two provider calls, each gets its own correct result", async () => {
    H = await buildHarness({ behavior: okProvider({ delayMs: 80 }) });
    const [a, b] = await Promise.all([
      req("https://www.youtube.com/watch?v=aaaaaaaaaaa", "d1"),
      req("https://www.youtube.com/watch?v=bbbbbbbbbbb", "d1"),
    ]);
    assert.equal(H.fake.calls, 2);
    assert.notEqual(a.row.sourceId, b.row.sourceId);
    assert.ok(a.row.title.includes("aaaaaaaaaaa") && b.row.title.includes("bbbbbbbbbbb"));
    assert.equal(H.queue.jobs.length, 2);
  });
  test("two different videos with an IDENTICAL last path segment stay separate (old code merged these)", async () => {
    H = await buildHarness();
    await req("https://www.youtube.com/watch?v=aaaaaaaaaaa"); await H.completeJob("youtube:aaaaaaaaaaa");
    const b = await req("https://www.youtube.com/watch?v=bbbbbbbbbbb");
    assert.equal(b.row.status, "pending", "must NOT be served video A's file");
    assert.equal(H.fake.calls, 2);
  });
});

describe("Test E - expired media URL", () => {
  const seed = (H, over) => H.stores.assets.create({
    key: "instagram:IIIII99999", platform: "instagram", videoId: "IIIII99999", canonicalUrl: IG("IIIII99999"),
    providerUrl: IG("IIIII99999"), title: "Seeded", status: "queued", generation: 1, fileKey: "videos/s.mp4", ...over,
  });
  test("E1: metadata exists, media URL expired, nothing stored -> NOT a valid result; provider called once to refresh", async () => {
    H = await buildHarness();
    await seed(H, { queuedAt: Date.now() - 3600e3, sourceMedia: { url: "https://dead.example/x.mp4", fetchedAt: 0, expiresAt: Date.now() - 1000 } });
    const r = await req(IG("IIIII99999"));
    assert.equal(H.fake.calls, 1);
    assert.equal(r.row.status, "pending");
    assert.notEqual(r.row.downloadUrl, "https://dead.example/x.mp4");
    const a = await H.stores.assets.getByKey("instagram:IIIII99999");
    assert.ok(a.sourceMedia.expiresAt > Date.now(), "fresh URL stored");
    assert.equal(a.generation, 2, "new job generation");
  });
  test("E2: file already stored -> expired SOURCE url is irrelevant, zero provider calls", async () => {
    H = await buildHarness();
    await seed(H, { status: "ready", storage: { cdnUrl: "https://cdn.test/ok.mp4", thumbnailCdn: null }, sourceMedia: { url: "https://dead", fetchedAt: 0, expiresAt: 1 } });
    const r = await req(IG("IIIII99999"));
    assert.equal(r.row.status, "ready"); assert.equal(H.fake.calls, 0);
  });
  test("E3: job lost (stale) but URL still fresh -> re-enqueue WITHOUT a provider call", async () => {
    H = await buildHarness();
    await seed(H, { queuedAt: Date.now() - 3600e3, sourceMedia: { url: "https://still.fresh/x.mp4", fetchedAt: Date.now(), expiresAt: Date.now() + 300e3 } });
    await req(IG("IIIII99999"));
    assert.equal(H.fake.calls, 0); assert.equal(H.queue.jobs.length, 1);
  });
  test("E4: asset exists but queue/Redis is down -> fail fast BEFORE spending provider money", async () => {
    H = await buildHarness({ queueReady: false });
    await assert.rejects(req(IG("JJJJJ00000")), { code: "QUEUE_UNAVAILABLE", status: 503 });
    assert.equal(H.fake.calls, 0);
  });
  test("E5: queue fails AFTER the paid call -> result is kept; next request re-enqueues with no 2nd provider call", async () => {
    H = await buildHarness(); H.queue.failEnqueue = true;
    await assert.rejects(req(IG("KKKKK11111")), { code: "QUEUE_UNAVAILABLE" });
    assert.equal(H.fake.calls, 1);
    H.queue.failEnqueue = false;
    await sleep(5);
    const a = await H.stores.assets.getByKey("instagram:KKKKK11111");
    await H.stores.assets.update(a.key, { queuedAt: Date.now() - 3600e3 }); // simulate time passing: job never existed
    await req(IG("KKKKK11111"));
    assert.equal(H.fake.calls, 1, "paid result reused");
    assert.equal(H.queue.jobs.length, 1);
  });
});

describe("Test F - provider failure", () => {
  test("5xx: bounded retries (== PROVIDER_MAX_ATTEMPTS), correct error, no lock left", async () => {
    H = await buildHarness({ behavior: () => ({ status: 503, json: { message: "boom" } }) });
    await assert.rejects(req(IG("LLLLL22222")), (e) => e.code === "PROVIDER_ERROR" && e.status === 502);
    assert.equal(H.fake.calls, 2, "2 attempts total, not unlimited");
    assert.equal(H.stores.__locks.size, 0);
    assert.equal(H.metrics.get("external_api_retry"), 1);
  });
  test("failure is shared briefly (cooldown) then NOT permanent: later request retries the provider", async () => {
    let healthy = false;
    H = await buildHarness({ behavior: (r, b, n) => (healthy ? okProvider()(r, b, n) : { status: 500, json: {} }) });
    await assert.rejects(req(IG("MMMMM33333"), "d1"));
    const callsAfterFail = H.fake.calls;
    await assert.rejects(req(IG("MMMMM33333"), "d2"), { code: "PROVIDER_ERROR" });
    assert.equal(H.fake.calls, callsAfterFail, "another user within cooldown does not re-bill");
    healthy = true; await sleep(300);
    const ok = await req(IG("MMMMM33333"), "d3");
    assert.equal(ok.row.status, "pending", "one user's failure did not block others permanently");
  });
  test("429: NOT retried, 503 + Retry-After surfaced", async () => {
    H = await buildHarness({ behavior: () => ({ status: 429, headers: { "Retry-After": "7" }, json: {} }) });
    await assert.rejects(req(IG("NNNNN44444")), (e) => e.code === "PROVIDER_RATE_LIMITED" && e.status === 503 && e.retryAfterSec === 7);
    assert.equal(H.fake.calls, 1);
  });
  test("4xx 'not found/private': NOT retried, 404, negatively cached (no re-bill within TTL)", async () => {
    H = await buildHarness({ behavior: () => ({ status: 404, json: {} }) });
    await assert.rejects(req(IG("OOOOO55555")), { code: "VIDEO_UNAVAILABLE", status: 404 });
    await assert.rejects(req(IG("OOOOO55555"), "other-user"), { code: "VIDEO_UNAVAILABLE" });
    assert.equal(H.fake.calls, 1);
  });
  test("provider says error:true + 'private' in a 200 body -> VIDEO_UNAVAILABLE, no retry", async () => {
    H = await buildHarness({ behavior: () => ({ json: { error: true, message: "This video is private" } }) });
    await assert.rejects(req(IG("PPPPP66666")), { code: "VIDEO_UNAVAILABLE" });
    assert.equal(H.fake.calls, 1);
  });
  test("no medias -> legacy 400 'No media found from API' (not a 500)", async () => {
    H = await buildHarness({ behavior: () => ({ json: { title: "x", medias: [] } }) });
    await assert.rejects(req(IG("QQQQQ77777")), (e) => e.status === 400 && e.message === "No media found from API");
  });
  test("invalid JSON -> PROVIDER_INVALID_RESPONSE 502, not retried", async () => {
    H = await buildHarness({ behavior: () => ({ json: "<html>oops" }) });
    await assert.rejects(req(IG("RRRRR88888")), { code: "PROVIDER_INVALID_RESPONSE", status: 502 });
    assert.equal(H.fake.calls, 1);
  });
  test("timeout: aborted, bounded attempts, 504", async () => {
    H = await buildHarness({ behavior: () => ({ delayMs: 1400, json: {} }) });
    const t0 = Date.now();
    await assert.rejects(req(IG("SSSSS99999")), { code: "PROVIDER_TIMEOUT", status: 504 });
    assert.equal(H.fake.calls, 2);
    assert.ok(Date.now() - t0 < 3500, "bounded by timeout x attempts");
  });
  test("401/403 from provider -> safe 503 (credentials problem never leaks to client)", async () => {
    H = await buildHarness({ behavior: () => ({ status: 403, json: { message: "You are not subscribed to this API." } }) });
    await assert.rejects(req(IG("TTTTT00000")), (e) => e.code === "PROVIDER_AUTH" && e.status === 503 && !/subscribed/.test(e.message));
    assert.equal(H.fake.calls, 1);
  });
  test("circuit breaker opens after repeated failures: further requests cost ZERO provider calls", async () => {
    H = await buildHarness({ env: { PROVIDER_BREAKER_THRESHOLD: "3", PROVIDER_MAX_ATTEMPTS: "1", TRANSIENT_COOLDOWN_MS: "0" }, behavior: () => ({ status: 500, json: {} }) });
    for (let i = 0; i < 3; i++) await assert.rejects(req(IG(`UUUUU0000${i}`)));
    assert.equal(H.fake.calls, 3);
    await assert.rejects(req(IG("UUUUU00009")), { code: "PROVIDER_UNAVAILABLE", status: 503 });
    assert.equal(H.fake.calls, 3, "breaker short-circuited");
  });
  test("input validation + unsupported platform never reach the provider", async () => {
    H = await buildHarness();
    for (const bad of ["", "not a url", "ftp://www.instagram.com/p/abcde/", "http://127.0.0.1/x", "https://evil.example.com/a", "http://169.254.169.254/latest", "https://x.com:8080/u/status/1"])
      await assert.rejects(req(bad), (e) => ["INVALID_URL", "UNSUPPORTED_PLATFORM"].includes(e.code) && e.status === 400, bad);
    assert.equal(H.fake.calls, 0);
  });
  test("kill switch + per-platform disable", async () => {
    H = await buildHarness({ env: { DOWNLOADER_ENABLED: "false" } });
    await assert.rejects(req(IG("VVVVV11111")), { code: "DOWNLOADS_DISABLED", status: 503 });
    await H.close();
    H = await buildHarness({ env: { DISABLED_PLATFORMS: "youtube" } });
    await assert.rejects(req("https://youtu.be/dQw4w9WgXcQ"), { message: "YouTube downloads are not supported." });
    assert.equal(H.fake.calls, 0);
  });
});

describe("Test H - billing regression", () => {
  test("200 repeat requests (many devices) for one reusable video -> provider calls stay at exactly 1", async () => {
    H = await buildHarness();
    await req(IG("WWWWW22222"), "first"); await H.completeJob("instagram:WWWWW22222");
    for (let i = 0; i < 200; i++) await req(i % 2 ? IG("WWWWW22222") + "?igsh=" + i : "https://instagram.com/p/WWWWW22222/", `dev-${i}`);
    assert.equal(H.fake.calls, 1);
    assert.equal(H.metrics.get("external_api_call_started"), 1);
    const s = H.metrics.snapshot();
    assert.equal(s.counters.download_request_received, 201);
    assert.equal(s.counters.database_cache_hit, 200);
    assert.equal(s.derived.cacheHitPercent, 99.5);
  });
  test("100 requests after processing hit the in-memory cache, not the DB, for the asset lookup", async () => {
    H = await buildHarness();
    await req(IG("XXXXX33333"), "a"); await H.completeJob("instagram:XXXXX33333");
    await req(IG("XXXXX33333"), "b"); // warms cache
    const before = H.stores.calls.assets;
    for (let i = 0; i < 100; i++) await req(IG("XXXXX33333"), `c${i}`);
    assert.equal(H.stores.calls.assets - before, 0, "asset lookups served from cache");
  });
});
