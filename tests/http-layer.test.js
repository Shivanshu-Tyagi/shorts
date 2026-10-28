const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
process.env.NODE_ENV = "test";
process.env.RAPID_API_KEY = "SUPER-SECRET-PROVIDER-KEY";
process.env.RAPID_API_HOST = "https://secret-provider.example.com/endpoint";
process.env.AWS_SECRET = "SUPER-SECRET-AWS";
process.env.MONGO_URL = "mongodb://user:SUPERSECRETPW@db/x";
process.env.REQUEST_DEADLINE_MS = "2000";

const container = require("../src/services/container");
const { handleDownload } = require("../src/controllers/download.controller");
const { downloadAllVideo } = require("../src/controllers/downloadAll.controller");
const { downloadVideo } = require("../src/controllers/download.controller");
const { AppError } = require("../src/utils/errors");
const { createRateLimiter } = require("../src/middleware/rateLimit");

function mockRes() {
  const res = { statusCode: 200, headers: {}, body: undefined, headersSent: false, writableEnded: false, destroyed: false };
  res.status = (c) => { res.statusCode = c; return res; };
  res.set = (k, v) => { res.headers[k] = v; return res; };
  res.json = (b) => { res.body = b; res.headersSent = true; return res; };
  return res;
}
const call = async (body) => { const res = mockRes(); await handleDownload({ body }, res); return res; };

describe("controller contract", () => {
  test("download and download-all are the SAME handler (one path to the paid provider)", () => {
    assert.equal(downloadAllVideo, downloadVideo);
  });
  test("missing fields -> legacy 400 + legacy message", async () => {
    for (const b of [undefined, {}, { url: "x" }, { deviceId: "d" }, { url: 5, deviceId: "d" }, { url: "x", deviceId: "d".repeat(200) }]) {
      const r = await call(b);
      assert.equal(r.statusCode, 400); assert.equal(r.body.success, false); assert.equal(r.body.message, "url and deviceId required");
    }
  });
  test("success keeps {success,message,data} and adds timing header", async () => {
    container.setDownloadService({ requestDownload: async () => ({ message: "Video processing started", row: { _id: "1", status: "pending" } }) });
    const r = await call({ url: "u", deviceId: "d" });
    assert.deepEqual(r.body, { success: true, message: "Video processing started", data: { _id: "1", status: "pending" } });
    assert.ok(r.headers["X-Response-Time-Ms"]);
  });
  test("AppError maps to its status + code + Retry-After; message is client-safe", async () => {
    container.setDownloadService({ requestDownload: async () => { throw new AppError("PROVIDER_RATE_LIMITED", undefined, { retryAfterSec: 9 }); } });
    const r = await call({ url: "u", deviceId: "d" });
    assert.equal(r.statusCode, 503); assert.equal(r.body.code, "PROVIDER_RATE_LIMITED"); assert.equal(r.headers["Retry-After"], "9");
  });
  test("unknown error -> 500 legacy 'Download failed', internals never leaked", async () => {
    container.setDownloadService({ requestDownload: async () => { throw new Error("connect ECONNREFUSED 10.0.0.5:27017 password=hunter2"); } });
    const r = await call({ url: "u", deviceId: "d" });
    assert.equal(r.statusCode, 500); assert.equal(r.body.message, "Download failed"); assert.ok(!JSON.stringify(r.body).includes("hunter2"));
  });
  test("Mongo errors -> 503 DB_ERROR (not 500, not leaked)", async () => {
    container.setDownloadService({ requestDownload: async () => { const e = new Error("topology closed uri=mongodb://u:pw@h"); e.name = "MongoServerSelectionError"; throw e; } });
    const r = await call({ url: "u", deviceId: "d" });
    assert.equal(r.statusCode, 503); assert.equal(r.body.code, "DB_ERROR"); assert.ok(!JSON.stringify(r.body).includes("pw@"));
  });
  test("request deadline -> 504 while shared work continues in the background", async () => {
    let finished = false;
    container.setDownloadService({ requestDownload: () => new Promise((r) => setTimeout(() => { finished = true; r({ message: "m", row: {} }); }, 2600)) });
    const r = await call({ url: "u", deviceId: "d" });
    assert.equal(r.statusCode, 504); assert.equal(r.body.code, "REQUEST_TIMEOUT"); assert.equal(finished, false);
    await new Promise((x) => setTimeout(x, 700)); assert.equal(finished, true);
  });
  test("client that already disconnected gets no write", async () => {
    container.setDownloadService({ requestDownload: async () => ({ message: "m", row: {} }) });
    const res = mockRes(); res.destroyed = true; await handleDownload({ body: { url: "u", deviceId: "d" } }, res);
    assert.equal(res.body, undefined);
  });
});

describe("rate limiter", () => {
  test("allows up to max per window then 429 + Retry-After, then resets", () => {
    let t = 1000; const rl = createRateLimiter({ windowMs: 60000, max: 3, keyFn: (r) => r.k, now: () => t });
    const hit = () => { const res = mockRes(); let nexted = false; rl({ k: "a" }, res, () => (nexted = true)); return { res, nexted }; };
    assert.ok([hit(), hit(), hit()].every((x) => x.nexted));
    const blocked = hit();
    assert.equal(blocked.nexted, false); assert.equal(blocked.res.statusCode, 429); assert.equal(blocked.res.body.code, "RATE_LIMITED"); assert.ok(Number(blocked.res.headers["Retry-After"]) >= 1);
    let other = false; rl({ k: "b" }, mockRes(), () => (other = true)); assert.ok(other, "other keys unaffected");
    t += 60001; assert.ok(hit().nexted, "window reset");
    rl.__stop();
  });
});

describe("Test G - Settings controllers", () => {
  const { getAdsConfig } = require("../src/controllers/setting.controller");
  const { getVydoAdsConfig } = require("../src/controllers/vydoSetting.controller");
  const run = async (fn) => { const res = mockRes(); await fn({}, res); return res; };

  for (const [name, fn, expect] of [["shorts", getAdsConfig, { appName: "Shorts Downloader", appId: "com.stackearn.shorts_downloader" }],
                                    ["vydo", getVydoAdsConfig, { appName: "VYDO - All Video Downloader", appId: "com.vydo_all_video_downloader" }]]) {
    test(`${name}: every pre-existing key is preserved with identical values`, async () => {
      const r = await run(fn); const d = r.body.data;
      assert.equal(r.statusCode, 200); assert.equal(r.body.success, true); assert.equal(r.body.message, "Configuration fetched successfully.");
      for (const [k, v] of Object.entries(expect)) assert.equal(d[k], v);
      for (const k of ["platform", "isAdsEnabled", "forceUpdate", "latestVersion", "minimumVersion", "maintenance", "ads", "support", "settings"]) assert.ok(k in d, k);
      for (const k of ["appId", "banner", "interstitial", "rewarded", "native", "appOpen"]) assert.ok(k in d.ads, `ads.${k}`);
      assert.deepEqual(Object.keys(d.ads.interstitial).sort(), ["afterClicks", "afterDownloads", "enabled", "unitId"]);
      assert.deepEqual(Object.keys(d.settings).sort(), ["playStoreLink", "privacy", "terms", "website", "whatsappNumber"]);
    });
    test(`${name}: new 'downloader' block has real, enforced settings`, async () => {
      const d = (await run(fn)).body.data.downloader;
      assert.equal(typeof d.enabled, "boolean");
      assert.deepEqual(d.supportedPlatforms.map((p) => p.id).sort(), ["facebook", "instagram", "linkedin", "pinterest", "reddit", "snapchat", "tiktok", "x", "youtube"]);
      assert.ok(d.supportedPlatforms.every((p) => typeof p.enabled === "boolean" && Array.isArray(p.domains) && p.name));
      assert.equal(d.maxUrlLength, 2048);
      assert.deepEqual(d.qualityPreference, ["hd_no_watermark", "no_watermark", "watermark"]);
      assert.ok(d.rateLimit.windowSeconds > 0 && d.rateLimit.maxRequestsPerDevice > 0);
      assert.ok(["available", "degraded", "unavailable"].includes(d.provider.status));
    });
    test(`${name}: NO secrets / provider details anywhere in the response`, async () => {
      const json = JSON.stringify((await run(fn)).body);
      for (const secret of ["SUPER-SECRET-PROVIDER-KEY", "secret-provider.example.com", "SUPER-SECRET-AWS", "SUPERSECRETPW", "mongodb://", "x-rapidapi", "apiKey", "rapidapi"])
        assert.ok(!json.toLowerCase().includes(secret.toLowerCase()), `leaked: ${secret}`);
    });
  }
  test("kill-switch and per-platform flags are reflected (safe defaults when unset)", () => {
    const { buildDownloaderSettings } = require("../src/services/downloaderSettings");
    const { loadConfig } = require("../src/config");
    const s = buildDownloaderSettings({ config: loadConfig({ DISABLED_PLATFORMS: "youtube,reddit", DOWNLOADER_ENABLED: "true", RAPID_API_HOST: "h", RAPID_API_KEY: "k" }) });
    assert.equal(s.supportedPlatforms.find((p) => p.id === "youtube").enabled, false);
    assert.equal(s.supportedPlatforms.find((p) => p.id === "instagram").enabled, true);
    const off = buildDownloaderSettings({ config: loadConfig({ DOWNLOADER_ENABLED: "false" }) });
    assert.equal(off.enabled, false); assert.ok(off.supportedPlatforms.every((p) => !p.enabled)); assert.equal(off.provider.status, "unavailable");
    const defaults = loadConfig({});
    assert.equal(defaults.provider.maxAttempts, 2); assert.equal(defaults.downloader.enabled, true); assert.equal(loadConfig({ PROVIDER_MAX_ATTEMPTS: "junk" }).provider.maxAttempts, 2);
  });
  test("provider circuit state is surfaced as availability", () => {
    const { buildDownloaderSettings } = require("../src/services/downloaderSettings");
    const { loadConfig } = require("../src/config");
    const cfg = loadConfig({ RAPID_API_HOST: "h", RAPID_API_KEY: "k" });
    assert.equal(buildDownloaderSettings({ config: cfg, provider: { status: () => "open" } }).provider.status, "unavailable");
    assert.equal(buildDownloaderSettings({ config: cfg, provider: { status: () => "half-open" } }).provider.status, "degraded");
    assert.equal(buildDownloaderSettings({ config: cfg, provider: { status: () => "closed" } }).provider.status, "available");
  });
});
