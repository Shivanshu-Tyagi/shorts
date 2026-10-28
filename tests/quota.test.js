const { test, describe, afterEach, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { Readable } = require("stream");
const { buildHarness, sleep, REWARDED_UNIT } = require("./helpers");
const logger = require("../src/utils/logger");
const { createVideoProcessor } = require("../src/services/videoProcessor");
const { MediaFetchError } = require("../src/utils/netGuard");
const { createAppSettings } = require("../src/services/appSettings");
const { createQuotaService } = require("../src/services/quota.service");
const { createMemoryStores } = require("../src/repositories/memory");
const { loadConfig } = require("../src/config");

class Unrecoverable extends Error {}
const IG = (n) => `https://www.instagram.com/reel/QUOTA${String(n).padStart(5, "0")}/`;
const KEY = (n) => `instagram:QUOTA${String(n).padStart(5, "0")}`;
let H, tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "q-")); });
afterEach(async () => { if (H) { await H.close(); H = null; } fs.rmSync(tmp, { recursive: true, force: true }); });

const dl = (n, deviceId = "dev-1", appId = "shorts", h = H) => h.service.requestDownload({ url: IG(n), deviceId, appId });
const state = (deviceId = "dev-1", appId = "shorts") => H.quota.getState({ deviceId, appId });

/** Runs the REAL worker processor for one asset (success or failure) so quota settlement is exercised end-to-end. */
async function runJob(key, { fail = null } = {}) {
  const proc = createVideoProcessor({
    assets: H.stores.assets, rows: H.stores.rows, service: H.service, provider: H.provider, quota: H.quota, config: H.config, metrics: H.metrics, logger, fs,
    openStream: async () => { if (fail) throw new MediaFetchError(fail, "x"); return { res: Readable.from([Buffer.alloc(512, 7)]) }; },
    generateThumbnail: async (_v, t) => fs.writeFileSync(t, "j"), uploadToS3: async () => {}, cdnDomain: "cdn.test", tmpDir: tmp, UnrecoverableError: Unrecoverable,
  });
  return proc.process({ data: { assetKey: key }, attemptsMade: 0, opts: { attempts: 3 } });
}

describe("settings are dynamic (nothing hardcoded) and safe", () => {
  test("defaults are 3 free / 3 per ad; env overrides defaults; DB overrides env", async () => {
    const mk = (env, store) => createAppSettings({ store, config: loadConfig({ ...env }) });
    const stores = createMemoryStores();
    let r = await mk({}, stores.settings).resolve("shorts");
    assert.equal(r.limits.freeDownloads, 3); assert.equal(r.limits.rewardedDownloads, 3);
    r = await mk({ DL_FREE_DOWNLOADS: "5", DL_REWARDED_DOWNLOADS: "2" }, stores.settings).resolve("vydo");
    assert.equal(r.limits.freeDownloads, 5); assert.equal(r.limits.rewardedDownloads, 2);
    const s = mk({ DL_FREE_DOWNLOADS: "5" }, stores.settings);
    await s.update("shorts", { downloadLimits: { freeDownloads: 7 } });
    assert.equal((await s.resolve("shorts")).limits.freeDownloads, 7, "DB > env");
    assert.equal((await s.resolve("vydo")).limits.freeDownloads, 5, "other app unaffected");
    await s.update("shorts", { downloadLimits: { freeDownloads: null } });
    assert.equal((await s.resolve("shorts")).limits.freeDownloads, 5, "null removes the override -> env");
  });
  test("garbage env values are ignored, never break anything", async () => {
    const r = await createAppSettings({ store: createMemoryStores().settings, config: loadConfig({ DL_FREE_DOWNLOADS: "abc", DL_REWARDED_DOWNLOADS: "-4", DL_REWARD_SESSION_TTL_SECONDS: "1" }) }).resolve("shorts");
    assert.equal(r.limits.freeDownloads, 3); assert.equal(r.limits.rewardedDownloads, 3); assert.equal(r.limits.rewardSessionTtlSeconds, 600);
  });
  test("admin validation: wrong types, ranges, unknown keys, bad ad unit are rejected and nothing is stored", async () => {
    const stores = createMemoryStores(); const s = createAppSettings({ store: stores.settings, config: loadConfig({}) });
    for (const bad of [{ freeDownloads: "3" }, { freeDownloads: -1 }, { freeDownloads: 1.5 }, { freeDownloads: 99999 }, { enabled: "yes" }, { nope: 1 }, { rewardVerification: "magic" }])
      await assert.rejects(s.update("shorts", { downloadLimits: bad }), (e) => e.status === 400 && !!e.extra.errors, JSON.stringify(bad));
    await assert.rejects(s.update("shorts", { rewarded: { unitId: "ca-app-pub-1/2" } }), (e) => !!e.extra.errors["rewarded.unitId"]);
    await assert.rejects(s.update("nope", {}), { status: 404 });
    assert.equal(await stores.settings.get("shorts"), null);
  });
  test("insecure client verification can NOT be switched on through the API (env-gated)", async () => {
    const s = createAppSettings({ store: createMemoryStores().settings, config: loadConfig({}) });
    await assert.rejects(s.update("shorts", { downloadLimits: { rewardVerification: "client" } }), (e) => !!e.extra.errors.rewardVerification);
    const s2 = createAppSettings({ store: createMemoryStores().settings, config: loadConfig({ ALLOW_CLIENT_REWARD_VERIFICATION: "true" }) });
    assert.equal((await s2.update("shorts", { downloadLimits: { rewardVerification: "client" } })).limits.rewardVerification, "client");
  });
  test("settings DB outage never breaks downloads: last known values (stale-while-error) or defaults are served", async () => {
    let down = false;
    const store = { get: async () => { if (down) throw new Error("mongo down"); return { downloadLimits: { freeDownloads: 9 }, version: 1 }; } };
    const s = createAppSettings({ store, config: loadConfig({ SETTINGS_CACHE_TTL_MS: "1" }) });
    assert.equal((await s.resolve("shorts")).limits.freeDownloads, 9);
    down = true; await sleep(5);                                   // cache expired AND db down
    assert.equal((await s.resolve("shorts")).limits.freeDownloads, 9, "stale value kept");
    const cold = createAppSettings({ store, config: loadConfig({}) });
    assert.equal((await cold.resolve("vydo")).limits.freeDownloads, 3, "no cache at all -> built-in defaults, still no throw");
  });
  test("admin update takes effect immediately in this process (cache invalidated)", async () => {
    const s = createAppSettings({ store: createMemoryStores().settings, config: loadConfig({ SETTINGS_CACHE_TTL_MS: "600000" }) });
    assert.equal((await s.resolve("shorts")).limits.freeDownloads, 3);
    await s.update("shorts", { downloadLimits: { freeDownloads: 4 } });
    assert.equal((await s.resolve("shorts")).limits.freeDownloads, 4);
  });
  test("SAFETY: quota is inert until a rewarded ad unit is configured (no lock-out without a way to unlock)", async () => {
    H = await buildHarness();
    for (let i = 0; i < 6; i++) await dl(i);                         // far beyond 3, nothing blocks
    assert.equal((await H.appSettings.resolve("shorts")).limits.enabled, true);
    assert.equal(H.appSettings.isEnforced(await H.appSettings.resolve("shorts")), false);
    await H.appSettings.update("shorts", { downloadLimits: { enforceWithoutRewardedAd: true } });
    assert.equal(H.appSettings.isEnforced(await H.appSettings.resolve("shorts")), true);
  });
});

describe("free downloads (limits come from settings)", () => {
  test("exactly 3 free downloads, the 4th is refused with 403 + quota payload, and costs ZERO provider calls", async () => {
    H = await buildHarness(); await H.enableQuota();
    const results = [];
    for (let i = 1; i <= 3; i++) results.push(await dl(i));
    assert.equal(H.fake.calls, 3);
    assert.equal(results[2].quota.remaining, 0, "reservations count immediately (no burst past the limit)");
    await assert.rejects(dl(4), (e) => {
      assert.equal(e.code, "DOWNLOAD_LIMIT_REACHED"); assert.equal(e.status, 403);
      assert.equal(e.extra.quota.remaining, 0); assert.equal(e.extra.quota.nextReward.unlocksDownloads, 3);
      return true;
    });
    assert.equal(H.fake.calls, 3, "denied request never reached the paid provider");
  });
  test("changing the free limit in settings changes behaviour immediately (5, then 0)", async () => {
    H = await buildHarness(); await H.enableQuota("shorts", { freeDownloads: 5 });
    for (let i = 1; i <= 5; i++) await dl(i);
    await assert.rejects(dl(6), { code: "DOWNLOAD_LIMIT_REACHED" });
    await H.appSettings.update("shorts", { downloadLimits: { freeDownloads: 0 } });
    await assert.rejects(dl(7, "brand-new-device"), { code: "DOWNLOAD_LIMIT_REACHED" });
  });
  test("used/remaining/free counters are exact after real worker completion", async () => {
    H = await buildHarness(); await H.enableQuota();
    await dl(1); await dl(2);
    let s = await state(); assert.deepEqual([s.used, s.inProgress, s.remaining], [0, 2, 1]);
    await runJob(KEY(1)); await runJob(KEY(2));
    s = await state();
    assert.deepEqual([s.used, s.inProgress, s.remaining, s.totalAllowed], [2, 0, 1, 3]);
    assert.deepEqual(s.freeDownloads, { total: 3, used: 2, remaining: 1 });
    assert.equal(s.rewarded.adCompleted, false); assert.equal(s.rewarded.unlockedDownloads, 0);
    assert.equal(s.nextReward.eligible, false); assert.equal(s.nextReward.reason, "LIMIT_NOT_REACHED");
  });
  test("the rewarded ad is offered only AFTER the downloads complete (not while they are merely in progress)", async () => {
    H = await buildHarness(); await H.enableQuota();
    for (let i = 1; i <= 3; i++) await dl(i);
    let s = await state(); assert.deepEqual([s.remaining, s.nextReward.eligible, s.nextReward.reason], [0, false, "DOWNLOADS_IN_PROGRESS"]);
    await assert.rejects(H.quota.startReward({ deviceId: "dev-1", appId: "shorts" }), (e) => e.code === "REWARD_NOT_ELIGIBLE" && e.extra.quota.nextReward.reason === "DOWNLOADS_IN_PROGRESS");
    await runJob(KEY(1)); await runJob(KEY(2));
    assert.equal((await state()).nextReward.eligible, false);
    await runJob(KEY(3));
    assert.equal((await state()).nextReward.eligible, true);
  });
  test("a download that FAILS while the user waits frees the quota instead of showing an ad", async () => {
    H = await buildHarness(); await H.enableQuota();
    for (let i = 1; i <= 3; i++) await dl(i);
    await runJob(KEY(1)); await runJob(KEY(2)); await assert.rejects(runJob(KEY(3), { fail: "permanent" }), Unrecoverable);
    const s = await state(); assert.deepEqual([s.used, s.remaining, s.nextReward.eligible, s.nextReward.reason], [2, 1, false, "LIMIT_NOT_REACHED"]);
  });
  test("exhausted -> next reward eligible", async () => {
    H = await buildHarness(); await H.enableQuota();
    for (let i = 1; i <= 3; i++) { await dl(i); await runJob(KEY(i)); }
    const s = await state(); assert.equal(s.used, 3); assert.equal(s.remaining, 0); assert.equal(s.nextReward.eligible, true);
  });
});

describe("duplicate requests / retries / restarts never double charge", () => {
  test("same video, same device, repeated and concurrent -> ONE unit", async () => {
    H = await buildHarness(); await H.enableQuota();
    await Promise.all(Array.from({ length: 12 }, () => dl(1)));
    await dl(1); await dl(1);
    assert.deepEqual([(await state()).inProgress, H.fake.calls, H.stores.rows.__all().length], [1, 1, 1]);
    await runJob(KEY(1)); await dl(1);
    assert.equal((await state()).used, 1, "re-requesting a finished video is free");
  });
  test("re-downloading a video you already own works even at 0 remaining", async () => {
    H = await buildHarness(); await H.enableQuota();
    for (let i = 1; i <= 3; i++) { await dl(i); await runJob(KEY(i)); }
    const again = await dl(2);
    assert.equal(again.message, "Already saved in your history"); assert.equal(again.quota.used, 3);
  });
  test("10 parallel requests for 10 DIFFERENT videos with 3 allowed -> exactly 3 succeed, 7 refused, only 3 provider calls", async () => {
    H = await buildHarness(); await H.enableQuota();
    const r = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => dl(100 + i)));
    assert.equal(r.filter((x) => x.status === "fulfilled").length, 3);
    assert.equal(r.filter((x) => x.status === "rejected" && x.reason.code === "DOWNLOAD_LIMIT_REACHED").length, 7);
    assert.equal(H.fake.calls, 3);
  });
  test("app restart / new server instance: state is server-side, nothing resets", async () => {
    H = await buildHarness(); await H.enableQuota();
    await dl(1); await runJob(KEY(1)); await dl(2);
    const fresh = H.newService();                                          // "restarted" API process, same database
    const freshQuota = createQuotaService({ quotas: H.stores.quotas, settings: H.appSettings });
    assert.deepEqual([(await freshQuota.getState({ deviceId: "dev-1", appId: "shorts" })).used, (await freshQuota.getState({ deviceId: "dev-1", appId: "shorts" })).inProgress], [1, 1]);
    await assert.doesNotReject(fresh.requestDownload({ url: IG(3), deviceId: "dev-1", appId: "shorts" }));
    await assert.rejects(fresh.requestDownload({ url: IG(4), deviceId: "dev-1", appId: "shorts" }), { code: "DOWNLOAD_LIMIT_REACHED" });
  });
  test("a lost device-id does not matter for repeated worker runs: commit is idempotent", async () => {
    H = await buildHarness(); await H.enableQuota();
    await dl(1); await runJob(KEY(1)); await runJob(KEY(1)); await runJob(KEY(1));
    assert.equal((await state()).used, 1);
  });
});

describe("failed downloads do not cost quota", () => {
  test("provider failure (5xx) -> reservation released, nothing consumed", async () => {
    H = await buildHarness({ behavior: () => ({ status: 500, json: {} }) }); await H.enableQuota();
    for (let i = 1; i <= 5; i++) await assert.rejects(dl(i));
    const s = await state(); assert.deepEqual([s.used, s.inProgress, s.remaining], [0, 0, 3]);
  });
  test("private/deleted video (404) -> released", async () => {
    H = await buildHarness({ behavior: () => ({ status: 404, json: {} }) }); await H.enableQuota();
    await assert.rejects(dl(1), { code: "VIDEO_UNAVAILABLE" }); assert.equal((await state()).remaining, 3);
  });
  test("queue down BEFORE the provider -> refused, released, zero provider calls", async () => {
    H = await buildHarness({ queueReady: false }); await H.enableQuota();
    await assert.rejects(dl(1), { code: "QUEUE_UNAVAILABLE" }); assert.equal((await state()).remaining, 3); assert.equal(H.fake.calls, 0);
  });
  test("worker fails permanently (CDN rejects) -> row failed AND reservation released", async () => {
    H = await buildHarness(); await H.enableQuota();
    await dl(1); assert.equal((await state()).remaining, 2);
    await assert.rejects(runJob(KEY(1), { fail: "permanent" }), Unrecoverable);
    const s = await state(); assert.deepEqual([s.used, s.inProgress, s.remaining], [0, 0, 3]);
    assert.equal(H.stores.rows.__all()[0].status, "failed");
  });
  test("after a failure the same video can be retried and is charged once", async () => {
    H = await buildHarness(); await H.enableQuota();
    await dl(1); await assert.rejects(runJob(KEY(1), { fail: "permanent" }), Unrecoverable);
    await sleep(5); await H.stores.assets.update(KEY(1), { failure: null });      // cooldown elapsed
    await dl(1); await runJob(KEY(1));
    const s = await state(); assert.deepEqual([s.used, s.remaining], [1, 2]);
    assert.equal(H.stores.rows.__all().length, 1, "failed row was revived, not duplicated");
  });
  test("a reservation whose job vanished expires by TTL instead of leaking quota forever", async () => {
    let t = Date.now(); const clock = () => t;
    H = await buildHarness({ now: clock }); await H.enableQuota("shorts", { reservationTtlSeconds: 60 });
    await dl(1); await dl(2); await dl(3);
    await assert.rejects(dl(4), { code: "DOWNLOAD_LIMIT_REACHED" });
    t += 61000;
    assert.equal((await state()).remaining, 3);
  });
});

describe("DB hits are charged too (a stored video is still a download for the user)", () => {
  test("second device gets the stored file instantly: used +1, ready, zero provider calls", async () => {
    H = await buildHarness(); await H.enableQuota();
    await dl(1, "dev-A"); await runJob(KEY(1));
    const calls = H.fake.calls;
    const r = await dl(1, "dev-B");
    assert.equal(r.row.status, "ready"); assert.equal(H.fake.calls, calls);
    assert.deepEqual([r.quota.used, r.quota.remaining], [1, 2]);
  });
  test("device at 0 remaining is refused even when the file is already stored", async () => {
    H = await buildHarness(); await H.enableQuota("shorts", { freeDownloads: 1 });
    await dl(1, "dev-A"); await runJob(KEY(1)); await dl(2, "dev-B"); await runJob(KEY(2));
    await assert.rejects(dl(1, "dev-B"), { code: "DOWNLOAD_LIMIT_REACHED" });
  });
});

describe("compatibility + both apps", () => {
  test("old app builds (no appId) are not limited and create no quota data", async () => {
    H = await buildHarness(); await H.enableQuota();
    for (let i = 1; i <= 6; i++) { const r = await H.service.requestDownload({ url: IG(i), deviceId: "old-app" }); assert.equal(r.quota, null); assert.equal(r.row.appId, undefined); }
    assert.equal(await H.stores.quotas.get("old-app", "shorts"), null);
  });
  test("REQUIRE_APP_ID=true rejects builds that do not identify themselves", async () => {
    H = await buildHarness({ env: { REQUIRE_APP_ID: "true" } });
    await assert.rejects(H.service.requestDownload({ url: IG(1), deviceId: "d" }), { status: 400, message: "appId required" });
  });
  test("unknown appId is rejected (cannot mint new free quota by inventing app names)", async () => {
    H = await buildHarness(); await H.enableQuota();
    for (const a of ["evil", "", "SHORTS", "__proto__", "constructor"]) await assert.rejects(dl(1, "d", a), { status: 400 }, a);
    assert.equal(H.fake.calls, 0);
  });
  for (const app of ["shorts", "vydo"]) {
    test(`[${app}] identical behaviour: 3 free -> blocked -> own quota per app for the same device`, async () => {
      H = await buildHarness(); await H.enableQuota("shorts"); await H.enableQuota("vydo");
      for (let i = 1; i <= 3; i++) { await dl(i, "same-device", app); await runJob(KEY(i)); }
      await assert.rejects(dl(4, "same-device", app), { code: "DOWNLOAD_LIMIT_REACHED" });
      const other = app === "shorts" ? "vydo" : "shorts";
      assert.equal((await state("same-device", other)).remaining, 3, "other app's quota untouched");
    });
  }
  test("per-app settings are independent (vydo can have different limits)", async () => {
    H = await buildHarness(); await H.enableQuota("shorts"); await H.enableQuota("vydo", { freeDownloads: 1, rewardedDownloads: 10 });
    assert.equal((await state("d", "shorts")).totalAllowed, 3); assert.equal((await state("d", "vydo")).totalAllowed, 1);
  });
  test("quota disabled by settings -> nothing enforced even with a rewarded unit", async () => {
    H = await buildHarness(); await H.enableQuota("shorts", { enabled: false });
    for (let i = 1; i <= 5; i++) await dl(i);
  });
  test("response when not exhausted contains full state for the UI", async () => {
    H = await buildHarness(); await H.enableQuota();
    const q = (await dl(1)).quota;
    for (const k of ["enforced", "limits", "totalAllowed", "used", "inProgress", "remaining", "freeDownloads", "rewarded", "nextReward", "session", "serverTime"]) assert.ok(k in q, k);
    for (const k of ["adCompleted", "completedAds", "unlockedDownloads", "usedFromRewards", "remainingFromRewards", "lastUnlockedDownloads", "lastCompletedAt"]) assert.ok(k in q.rewarded, k);
    for (const k of ["eligible", "reason", "retryAfterSeconds", "unlocksDownloads", "adsRemainingToday", "pollIntervalMs", "pollTimeoutMs"]) assert.ok(k in q.nextReward, k);
  });
});
