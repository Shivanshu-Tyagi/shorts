process.env.NODE_ENV = "test";
process.env.ADMIN_TOKEN = "admin-secret-token-123";
process.env.RAPID_API_KEY = "PROVIDER-SECRET-XYZ";
process.env.RAPID_API_HOST = "https://secret-provider.example.com/x";
const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { buildHarness, REWARDED_UNIT } = require("./helpers");
const container = require("../src/services/container");
const quotaC = require("../src/controllers/quota.controller");
const adminC = require("../src/controllers/adminSettings.controller");
const { handleDownload } = require("../src/controllers/download.controller");
const { getAdsConfig } = require("../src/controllers/setting.controller");
const { getVydoAdsConfig } = require("../src/controllers/vydoSetting.controller");
const { quotaLimiters } = require("../src/middleware/rateLimit");
const { loadConfig } = require("../src/config");

const mockRes = () => { const r = { statusCode: 200, body: undefined, headers: {}, headersSent: false, writableEnded: false, destroyed: false }; r.status = (c) => { r.statusCode = c; return r; }; r.set = (k, v) => { r.headers[k] = v; return r; }; r.json = (b) => { r.body = JSON.parse(JSON.stringify(b)); /* wire-accurate: undefined keys vanish */ r.headersSent = true; return r; }; return r; };
const req = (o = {}) => ({ query: {}, body: {}, params: {}, ...o, get: (h) => (o.headers || {})[h.toLowerCase()] });
const call = async (fn, o) => { const res = mockRes(); await fn(req(o), res); return res; };
const IG = (n) => `https://www.instagram.com/reel/HTTP${String(n).padStart(6, "0")}/`;
let H;
beforeEach(async () => {
  H = await buildHarness();
  container.setAppSettings(H.appSettings); container.setQuotaService(H.quota); container.setDownloadService(H.service);
});
afterEach(async () => { await H.close(); });
const exhaust = async (d = "dev-1", a = "shorts") => { await H.stores.quotas.ensure(d, a); H.stores.quotas.__put({ deviceId: d, appId: a, used: 3 }); };

describe("GET /api/quota", () => {
  test("validation: missing/invalid deviceId, unknown app", async () => {
    for (const q of [{}, { deviceId: "d" }, { appId: "shorts" }, { deviceId: "bad id!", appId: "shorts" }, { deviceId: "d", appId: "nope" }, { deviceId: "x".repeat(200), appId: "shorts" }]) {
      const r = await call(quotaC.getQuota, { query: q }); assert.equal(r.statusCode, 400, JSON.stringify(q)); assert.equal(r.body.success, false);
    }
  });
  test("returns state + current configuration; creates nothing; no secrets", async () => {
    await H.enableQuota();
    const r = await call(quotaC.getQuota, { query: { deviceId: "dev-9", appId: "shorts" } });
    assert.equal(r.statusCode, 200); assert.equal(r.body.data.remaining, 3); assert.equal(r.body.data.limits.freeDownloads, 3);
    assert.equal(r.body.config.freeDownloads, 3); assert.equal(r.body.config.enforced, true); assert.equal(r.body.config.rewardedAdUnitConfigured, true);
    assert.equal(await H.stores.quotas.get("dev-9", "shorts"), null, "read-only");
    const json = JSON.stringify(r.body); assert.ok(!json.includes("PROVIDER-SECRET") && !json.includes("admin-secret"));
  });
});

describe("POST /api/quota/reward/start + /claim", () => {
  test("start: 403 + full quota payload while downloads remain; 200 + nonce when exhausted", async () => {
    await H.enableQuota();
    let r = await call(quotaC.startReward, { body: { deviceId: "dev-1", appId: "shorts" } });
    assert.equal(r.statusCode, 403); assert.equal(r.body.code, "REWARD_NOT_ELIGIBLE"); assert.equal(r.body.quota.nextReward.reason, "LIMIT_NOT_REACHED");
    await exhaust();
    r = await call(quotaC.startReward, { body: { deviceId: "dev-1", appId: "shorts" } });
    assert.equal(r.statusCode, 200); assert.ok(r.body.data.nonce.length >= 32); assert.equal(r.body.data.userId, "dev-1"); assert.equal(r.body.data.adUnitId, REWARDED_UNIT);
    assert.equal(r.body.quota.session.state, "issued");
  });
  test("start: junk bodies -> 400", async () => {
    for (const body of [undefined, {}, { deviceId: 5, appId: "shorts" }, { deviceId: "d", appId: {} }]) assert.equal((await call(quotaC.startReward, { body })).statusCode, 400);
  });
  test("claim: validation, 404, pending (never grants in secure mode)", async () => {
    await H.enableQuota(); await exhaust();
    const s = (await call(quotaC.startReward, { body: { deviceId: "dev-1", appId: "shorts" } })).body.data;
    assert.equal((await call(quotaC.claimReward, { body: { deviceId: "dev-1", appId: "shorts" } })).statusCode, 400);
    assert.equal((await call(quotaC.claimReward, { body: { deviceId: "dev-1", appId: "shorts", nonce: "short" } })).statusCode, 400);
    assert.equal((await call(quotaC.claimReward, { body: { deviceId: "dev-1", appId: "shorts", nonce: "n".repeat(40) } })).statusCode, 404);
    const r = await call(quotaC.claimReward, { body: { deviceId: "dev-1", appId: "shorts", nonce: s.nonce } });
    assert.equal(r.statusCode, 200); assert.equal(r.body.data.sessionState, "pending"); assert.equal(r.body.data.unlockedDownloads, 0); assert.equal(r.body.quota.remaining, 0);
  });
});

describe("download endpoint with quota", () => {
  test("success carries quota; the 4th download is 403 DOWNLOAD_LIMIT_REACHED with quota for the UI", async () => {
    await H.enableQuota();
    for (let i = 1; i <= 3; i++) {
      const r = await call(handleDownload, { body: { url: IG(i), deviceId: "dev-1", appId: "shorts" } });
      assert.equal(r.statusCode, 200); assert.equal(r.body.success, true); assert.equal(r.body.quota.remaining, 3 - i);
      assert.ok(r.body.data && r.body.message, "legacy contract intact");
    }
    const r = await call(handleDownload, { body: { url: IG(4), deviceId: "dev-1", appId: "shorts" } });
    assert.equal(r.statusCode, 403); assert.equal(r.body.code, "DOWNLOAD_LIMIT_REACHED"); assert.equal(r.body.success, false);
    assert.equal(r.body.quota.remaining, 0);
    assert.deepEqual([r.body.quota.nextReward.eligible, r.body.quota.nextReward.reason], [false, "DOWNLOADS_IN_PROGRESS"], "ad is offered only once the 3 downloads have completed");
  });
  test("old clients: identical response shape as before (no quota key)", async () => {
    await H.enableQuota();
    const r = await call(handleDownload, { body: { url: IG(1), deviceId: "old" } });
    assert.deepEqual(Object.keys(r.body).sort(), ["data", "message", "success"]);
  });
  test("appId of the wrong type -> 400", async () => {
    assert.equal((await call(handleDownload, { body: { url: IG(1), deviceId: "d", appId: 7 } })).statusCode, 400);
  });
});

describe("admin settings API", () => {
  const put = (body, token = "admin-secret-token-123", appId = "shorts") => call(adminC.putSettings, { params: { appId }, body, headers: token ? { "x-admin-token": token } : {} });
  test("401 without / with wrong token (constant-time compare)", async () => {
    for (const t of [null, "", "wrong", "admin-secret-token-12"]) { const r = await put({}, t); assert.equal(r.statusCode, 401); }
    assert.equal((await call(adminC.getSettings, { params: { appId: "shorts" }, headers: {} })).statusCode, 401);
  });
  test("404 for everyone when ADMIN_TOKEN is not configured (endpoint effectively off)", async () => {
    const { config } = require("../src/config"); const keep = config.adminToken;
    try { Object.defineProperty(config, "adminToken", { value: "", configurable: true }); } catch { return; }
    const r = await put({}); assert.equal(r.statusCode, 404);
    Object.defineProperty(config, "adminToken", { value: keep, configurable: true });
  });
  test("PUT changes limits that the very next download/quota call uses (no redeploy)", async () => {
    let r = await put({ downloadLimits: { freeDownloads: 1, rewardedDownloads: 2 }, rewarded: { enabled: true, unitId: REWARDED_UNIT } });
    assert.equal(r.statusCode, 200); assert.equal(r.body.data.downloadLimits.freeDownloads, 1); assert.equal(r.body.data.enforced, true);
    assert.equal((await call(handleDownload, { body: { url: IG(1), deviceId: "d1", appId: "shorts" } })).statusCode, 200);
    assert.equal((await call(handleDownload, { body: { url: IG(2), deviceId: "d1", appId: "shorts" } })).statusCode, 403);
    r = await put({ downloadLimits: { freeDownloads: null } });                       // back to default 3
    assert.equal(r.body.data.downloadLimits.freeDownloads, 3);
    assert.equal((await call(handleDownload, { body: { url: IG(2), deviceId: "d1", appId: "shorts" } })).statusCode, 200);
  });
  test("PUT validation errors are reported per field and change nothing", async () => {
    const r = await put({ downloadLimits: { freeDownloads: "lots", rewardVerification: "client" }, rewarded: { unitId: "bad" } });
    assert.equal(r.statusCode, 400); assert.ok(r.body.errors.freeDownloads && r.body.errors.rewardVerification && r.body.errors["rewarded.unitId"]);
    assert.equal(await H.stores.settings.get("shorts"), null);
    assert.equal((await put({}, undefined, "unknown-app")).statusCode, 404);
  });
});

describe("settings endpoints (both apps) - additive, backward compatible", () => {
  const EXISTING = ["appName", "appId", "platform", "isAdsEnabled", "forceUpdate", "latestVersion", "minimumVersion", "maintenance", "ads", "support", "settings", "downloader"];
  for (const [name, fn, app] of [["shorts", getAdsConfig, "shorts"], ["vydo", getVydoAdsConfig, "vydo"]]) {
    test(`[${name}] unconfigured: response identical to before + downloadLimits; ads.rewarded unchanged`, async () => {
      const r = await call(fn, {}); const d = r.body.data;
      assert.equal(r.statusCode, 200); for (const k of EXISTING) assert.ok(k in d, k);
      assert.deepEqual(d.ads.rewarded, { enabled: false, unitId: "" });
      assert.equal(d.downloadLimits.freeDownloads, 3); assert.equal(d.downloadLimits.rewardedDownloads, 3); assert.equal(d.downloadLimits.enforced, false);
      assert.equal("downloadQuota" in d, false, "no deviceId => no per-device state");
    });
    test(`[${name}] configured: rewarded ad unit + limits come from the settings DB; ?deviceId= adds that device's quota`, async () => {
      await H.enableQuota(app, { freeDownloads: 5, rewardedDownloads: 4 });
      const d = (await call(fn, { query: { deviceId: "dev-1" } })).body.data;
      assert.deepEqual(d.ads.rewarded, { enabled: true, unitId: REWARDED_UNIT });
      assert.equal(d.downloadLimits.freeDownloads, 5); assert.equal(d.downloadLimits.enforced, true);
      assert.equal(d.downloadQuota.remaining, 5); assert.equal(d.downloadQuota.appId, app);
      assert.equal((await call(fn, { headers: { "x-device-id": "dev-1" } })).body.data.downloadQuota.totalAllowed, 5);
      assert.equal("downloadQuota" in (await call(fn, { query: { deviceId: "bad id" } })).body.data, false);
    });
    test(`[${name}] if the settings layer is completely broken the endpoint still answers exactly as before`, async () => {
      container.setAppSettings({ resolve: async () => { throw new Error("boom"); }, publicView: () => { throw new Error("boom"); } });
      const r = await call(fn, { query: { deviceId: "dev-1" } });
      assert.equal(r.statusCode, 200); assert.deepEqual(r.body.data.ads.rewarded, { enabled: false, unitId: "" }); assert.equal(r.body.data.downloadLimits, undefined);
      for (const k of EXISTING) assert.ok(k in r.body.data, k);
    });
  }
  test("quota state differs per app for the same device", async () => {
    await H.enableQuota("shorts"); await H.enableQuota("vydo", { freeDownloads: 1 }); await exhaust("dev-1", "shorts");
    assert.equal((await call(getAdsConfig, { query: { deviceId: "dev-1" } })).body.data.downloadQuota.remaining, 0);
    assert.equal((await call(getVydoAdsConfig, { query: { deviceId: "dev-1" } })).body.data.downloadQuota.remaining, 1);
  });
});

describe("rate limiting of quota endpoints", () => {
  test("status polling (every 2s for 30s) is not throttled by the download limiter; abuse still is", () => {
    const cfg = loadConfig({ RATE_LIMIT_PER_DEVICE: "20" }); const [ip, dev] = quotaLimiters(cfg);
    let blocked = 0;
    for (let i = 0; i < 100; i++) { const res = mockRes(); dev({ ip: "1.1.1.1", query: { deviceId: "d1" }, body: {} }, res, () => {}); if (res.statusCode === 429) blocked++; }
    assert.equal(blocked, 100 - 80, "80/min allowed for polling, the rest refused");
    ip.__stop(); dev.__stop();
  });
});
