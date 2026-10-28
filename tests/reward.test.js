const { test, describe, afterEach, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { Readable } = require("stream");
const crypto = require("crypto");
const { buildHarness, REWARDED_UNIT } = require("./helpers");
const { createSigner } = require("./ssvHelper");
const logger = require("../src/utils/logger");
const container = require("../src/services/container");
const { createSsvVerifier, createKeyProvider, adUnitMatches } = require("../src/services/adSsv");
const { createVideoProcessor } = require("../src/services/videoProcessor");
const { handleSsv } = require("../src/controllers/ssv.controller");

const UNIT_NUM = REWARDED_UNIT.split("/")[1];
const IG = (n) => `https://www.instagram.com/reel/RWD${String(n).padStart(7, "0")}/`;
let H, S, tmp, clock;
const mockRes = () => { const r = { statusCode: 200, body: undefined, headers: {}, headersSent: false }; r.status = (c) => { r.statusCode = c; return r; }; r.set = (k, v) => { r.headers[k] = v; return r; }; r.json = (b) => { r.body = b; r.headersSent = true; return r; }; return r; };

async function setup({ env = {}, limits = {}, virtualClock = false, apps = ["shorts"] } = {}) {
  S = createSigner();
  clock = { t: Date.now() };
  H = await buildHarness({ env, ...(virtualClock ? { now: () => clock.t } : {}) });
  for (const a of apps) await H.enableQuota(a, limits);
  container.setQuotaService(H.quota);
  container.setSsvVerifier(createSsvVerifier({ keyProvider: S.keyProvider, now: virtualClock ? () => clock.t : Date.now }));
}
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "r-")); });
afterEach(async () => { if (H) { await H.close(); H = null; } fs.rmSync(tmp, { recursive: true, force: true }); });

const exhaust = (deviceId = "dev-1", appId = "shorts", used = 3) => H.stores.quotas.ensure(deviceId, appId).then(() => H.stores.quotas.__put({ deviceId, appId, used }));
const state = (deviceId = "dev-1", appId = "shorts") => H.quota.getState({ deviceId, appId });
const start = (deviceId = "dev-1", appId = "shorts") => H.quota.startReward({ deviceId, appId });
const callSsv = async (query) => { const res = mockRes(); await handleSsv({ originalUrl: `/api/ads/ssv?${query}` }, res); return res; };
const signedFor = (session, over = {}, opts) => S.build({ custom_data: session.nonce, user_id: "dev-1", ad_unit: UNIT_NUM, ...over }, opts);
const grantedTotal = async (d = "dev-1", a = "shorts") => (await H.stores.quotas.get(d, a)).rewardedGranted;

describe("starting a reward", () => {
  test("not offered while downloads remain (LIMIT_NOT_REACHED) and no session is created", async () => {
    await setup();
    await assert.rejects(start(), (e) => e.code === "REWARD_NOT_ELIGIBLE" && e.status === 403 && e.extra.quota.nextReward.reason === "LIMIT_NOT_REACHED");
    assert.equal((await H.stores.quotas.get("dev-1", "shorts")).sessions.length, 0);
  });
  test("offered when exhausted: unpredictable nonce, TTL from settings, idempotent; 20 concurrent starts -> ONE session", async () => {
    await setup(); await exhaust();
    const sessions = await Promise.all(Array.from({ length: 20 }, () => start()));
    assert.equal(new Set(sessions.map((s) => s.nonce)).size, 1);
    const s = sessions[0];
    assert.ok(s.nonce.length >= 32); assert.equal(s.unlocksDownloads, 3); assert.equal(s.userId, "dev-1"); assert.equal(s.verification, "ssv"); assert.equal(s.adUnitId, REWARDED_UNIT);
    assert.equal(s.expiresAt - (await state()).serverTime <= 600000, true);
    assert.equal((await H.stores.quotas.get("dev-1", "shorts")).sessions.length, 1);
  });
  test("no rewarded ad unit configured -> DISABLED", async () => {
    await setup({ apps: [] }); await H.appSettings.update("shorts", { downloadLimits: { enforceWithoutRewardedAd: true } }); await exhaust();
    await assert.rejects(start(), (e) => e.extra.quota.nextReward.reason === "DISABLED");
  });
  test("rewards switched off in settings (rewardedDownloads=0 / rewardedAdsEnabled=false) -> DISABLED", async () => {
    await setup(); await exhaust();
    await H.appSettings.update("shorts", { downloadLimits: { rewardedAdsEnabled: false } });
    await assert.rejects(start(), (e) => e.extra.quota.nextReward.reason === "DISABLED");
    await H.appSettings.update("shorts", { downloadLimits: { rewardedAdsEnabled: true, rewardedDownloads: 0 } });
    await assert.rejects(start(), (e) => e.extra.quota.nextReward.reason === "DISABLED");
  });
  test("unlock size is snapshotted at start; later settings changes do not alter an issued session", async () => {
    await setup({ limits: { rewardedDownloads: 5 } }); await exhaust(); const s = await start();
    await H.appSettings.update("shorts", { downloadLimits: { rewardedDownloads: 1 } });
    assert.equal((await callSsv(signedFor(s).query)).body.status, "granted");
    assert.equal(await grantedTotal(), 5);
  });
});

describe("verified grant (AdMob SSV)", () => {
  test("valid signed callback unlocks exactly the configured amount, and the app can display it", async () => {
    await setup(); await exhaust();
    const s = await start();
    const res = await callSsv(signedFor(s).query);
    assert.equal(res.statusCode, 200); assert.deepEqual(res.body, { success: true, status: "granted" });
    const q = await state();
    assert.deepEqual([q.remaining, q.totalAllowed, q.used], [3, 6, 3]);
    assert.deepEqual([q.rewarded.adCompleted, q.rewarded.completedAds, q.rewarded.unlockedDownloads, q.rewarded.lastUnlockedDownloads, q.rewarded.remainingFromRewards], [true, 1, 3, 3, 3]);
    assert.equal(q.session.state, "granted"); assert.equal(q.nextReward.reason, "LIMIT_NOT_REACHED");
  });
  test("end to end: 3 free -> blocked -> ad -> 3 more -> blocked again -> next ad -> 3 more (rewards accumulate)", async () => {
    await setup();
    const url = (n) => ({ url: IG(n), deviceId: "dev-1", appId: "shorts" });
    const run = async (key) => createVideoProcessor({ assets: H.stores.assets, rows: H.stores.rows, service: H.service, provider: H.provider, quota: H.quota, config: H.config, metrics: H.metrics, logger, fs,
      openStream: async () => ({ res: Readable.from([Buffer.alloc(300, 1)]) }), generateThumbnail: async (_v, t) => fs.writeFileSync(t, "j"), uploadToS3: async () => {}, cdnDomain: "c", tmpDir: tmp }).process({ data: { assetKey: key }, attemptsMade: 0, opts: { attempts: 3 } });
    let n = 0;
    const burn = async (count) => { for (let i = 0; i < count; i++) { n++; await H.service.requestDownload(url(n)); await run(`instagram:RWD${String(n).padStart(7, "0")}`); } };
    await burn(3);
    await assert.rejects(H.service.requestDownload(url(99)), { code: "DOWNLOAD_LIMIT_REACHED" });
    for (let round = 1; round <= 2; round++) {
      const s = await start(); assert.equal((await callSsv(signedFor(s).query)).body.status, "granted");
      assert.equal((await state()).remaining, 3);
      await burn(3);
      await assert.rejects(H.service.requestDownload(url(100 + round)), { code: "DOWNLOAD_LIMIT_REACHED" });
      const q = await state(); assert.deepEqual([q.used, q.rewarded.completedAds, q.rewarded.usedFromRewards, q.nextReward.eligible], [3 + 3 * round, round, 3 * round, true]);
    }
  });
  test("REPLAY: the same signed callback delivered 5x credits once", async () => {
    await setup(); await exhaust(); const s = await start(); const q = signedFor(s).query;
    const statuses = []; for (let i = 0; i < 5; i++) statuses.push((await callSsv(q)).body.status);
    assert.deepEqual(statuses, ["granted", "already_granted", "already_granted", "already_granted", "already_granted"]);
    assert.equal(await grantedTotal(), 3);
  });
  test("20 CONCURRENT duplicate callbacks (Google retries / races) credit once", async () => {
    await setup({ env: {} }); await H.close(); H = null; // fresh harness with 4ms store latency to force interleaving
    S = createSigner(); H = await buildHarness({ storeLatencyMs: 4 }); await H.enableQuota();
    container.setQuotaService(H.quota); container.setSsvVerifier(createSsvVerifier({ keyProvider: S.keyProvider }));
    await exhaust(); const s = await start(); const q = signedFor(s).query;
    const rs = await Promise.all(Array.from({ length: 20 }, () => callSsv(q)));
    assert.equal(rs.filter((r) => r.body.status === "granted").length, 1);
    assert.equal(await grantedTotal(), 3);
  });
  test("a captured URL cannot be replayed against a NEW session (nonce is inside the signed data)", async () => {
    await setup(); await exhaust(); const s1 = await start(); const old = signedFor(s1);
    await callSsv(old.query);
    await H.stores.quotas.__put({ ...(await H.stores.quotas.get("dev-1", "shorts")), used: 6 });   // exhausted again
    const s2 = await start(); assert.notEqual(s2.nonce, s1.nonce);
    assert.equal((await callSsv(old.query)).body.status, "already_granted");
    assert.equal(await grantedTotal(), 3, "second session still unpaid");
  });
  for (const [name, mutate] of [
    ["changed user_id", (q) => q.replace("user_id=dev-1", "user_id=dev-2")],
    ["changed custom_data", (q, s) => q.replace(s.nonce, "A".repeat(32))],
    ["changed reward_amount", (q) => q.replace("reward_amount=1", "reward_amount=999")],
    ["changed ad_unit", (q) => q.replace(`ad_unit=${UNIT_NUM}`, "ad_unit=9999999999")],
    ["changed transaction_id", (q) => q.replace(/transaction_id=[0-9a-f]+/, "transaction_id=deadbeef")],
    ["signature removed", (q) => q.replace(/&signature=[^&]+/, "")],
    ["garbage signature", (q) => q.replace(/&signature=[^&]+/, "&signature=AAAA")],
    ["unknown key_id", (q) => q.replace(/key_id=\d+/, "key_id=1")],
    ["params re-ordered", (q) => q.split("&").reverse().join("&")],
  ]) {
    test(`TAMPERED (${name}) -> 400, nothing granted`, async () => {
      await setup(); await exhaust(); const s = await start();
      const res = await callSsv(mutate(signedFor(s).query, s));
      assert.equal(res.statusCode, 400); assert.equal(res.body.code, "SSV_INVALID"); assert.equal(await grantedTotal(), 0);
    });
  }
  test("signed by a DIFFERENT key (forged callback from the app/attacker) -> 400", async () => {
    await setup(); await exhaust(); const s = await start();
    const attacker = createSigner(S.keyId);                       // same key id, attacker's private key
    assert.equal((await callSsv(attacker.build({ custom_data: s.nonce, user_id: "dev-1", ad_unit: UNIT_NUM }).query)).statusCode, 400);
    assert.equal(await grantedTotal(), 0);
  });
  test("stale (>maxAge) or future timestamp -> 400", async () => {
    await setup(); await exhaust(); const s = await start();
    for (const ts of [Date.now() - 2 * 3600e3, Date.now() + 3600e3]) assert.equal((await callSsv(signedFor(s, { timestamp: String(ts) }).query)).statusCode, 400);
    assert.equal(await grantedTotal(), 0);
  });
  test("missing/empty required params, junk and oversized queries -> 400", async () => {
    await setup(); await exhaust(); const s = await start();
    for (const over of [{ custom_data: undefined }, { user_id: undefined }, { transaction_id: undefined }, { timestamp: undefined }, { ad_unit: undefined }])
      assert.equal((await callSsv(signedFor(s, over).query)).statusCode, 400);
    for (const q of ["", "a=b", "signature=x&key_id=1", "x".repeat(5000)]) assert.equal((await callSsv(q)).statusCode, 400);
  });
  test("correctly signed but for a DIFFERENT ad unit -> no grant (status ad_unit_mismatch)", async () => {
    await setup(); await exhaust(); const s = await start();
    const r = await callSsv(signedFor(s, { ad_unit: "7777777777" }).query);
    assert.equal(r.statusCode, 200); assert.equal(r.body.status, "ad_unit_mismatch"); assert.equal(r.body.success, false); assert.equal(await grantedTotal(), 0);
  });
  test("correctly signed but the nonce belongs to another device -> unknown_session", async () => {
    await setup(); await exhaust("dev-1"); const s = await start("dev-1");
    const r = await callSsv(signedFor(s, { user_id: "dev-2" }).query);
    assert.equal(r.body.status, "unknown_session"); assert.equal(await grantedTotal(), 0);
  });
  test("session expired before the callback arrived -> no grant", async () => {
    await setup({ virtualClock: true, limits: { rewardSessionTtlSeconds: 60 } }); await exhaust(); const s = await start();
    clock.t += 61000;
    const r = await callSsv(signedFor(s, { timestamp: String(clock.t) }).query);
    assert.equal(r.body.status, "expired"); assert.equal(await grantedTotal(), 0);
  });
  test("SSV key server unreachable -> 503 so Google retries (and nothing is granted)", async () => {
    await setup(); await exhaust(); const s = await start();
    container.setSsvVerifier(createSsvVerifier({ keyProvider: async () => { throw new Error("gstatic down"); } }));
    const r = await callSsv(signedFor(s).query);
    assert.equal(r.statusCode, 503); assert.equal(await grantedTotal(), 0);
  });
  test("signature algorithm is verified for real (message = raw query before &signature=)", async () => {
    await setup(); const ok = S.build({}); const v = createSsvVerifier({ keyProvider: S.keyProvider });
    assert.equal((await v(ok.query)).user_id, "device-1");
    const spaced = S.build({ reward_item: "gold coins", custom_data: "a b&c" });   // values that need URL-encoding
    assert.equal((await v(spaced.query)).reward_item, "gold coins");
  });
});

describe("incomplete / failed ads and client-side claims never grant", () => {
  test("ad load failure / user closes early: no callback -> nothing unlocked, session stays pending, app may retry later", async () => {
    await setup(); await exhaust(); const s = await start();
    for (let i = 0; i < 25; i++) {
      const r = await H.quota.claim({ deviceId: "dev-1", appId: "shorts", nonce: s.nonce });
      assert.equal(r.sessionState, "pending"); assert.equal(r.unlockedDownloads, 0);
    }
    assert.deepEqual([await grantedTotal(), (await state()).remaining], [0, 0]);
  });
  test("claim reports the real outcome once Google's callback arrives", async () => {
    await setup(); await exhaust(); const s = await start();
    await callSsv(signedFor(s).query);
    const r = await H.quota.claim({ deviceId: "dev-1", appId: "shorts", nonce: s.nonce });
    assert.deepEqual([r.sessionState, r.unlockedDownloads, r.quota.remaining], ["granted", 3, 3]);
  });
  test("claim with unknown nonce or another device's nonce -> 404", async () => {
    await setup(); await exhaust(); const s = await start();
    await assert.rejects(H.quota.claim({ deviceId: "dev-1", appId: "shorts", nonce: "x".repeat(32) }), { status: 404 });
    await assert.rejects(H.quota.claim({ deviceId: "dev-2", appId: "shorts", nonce: s.nonce }), { status: 404 });
  });
  test("a request that merely says 'reward earned' to the download/quota APIs credits nothing", async () => {
    await setup(); await exhaust(); await start();
    await assert.rejects(H.service.requestDownload({ url: IG(1), deviceId: "dev-1", appId: "shorts", rewardEarned: true }), { code: "DOWNLOAD_LIMIT_REACHED" });
  });
  test("client-confirm mode is OFF unless the operator enables it by env: settings cannot turn it on, claims still don't grant", async () => {
    await setup(); await exhaust(); const s = await start();
    await assert.rejects(H.appSettings.update("shorts", { downloadLimits: { rewardVerification: "client" } }), { status: 400 });
    assert.equal((await H.quota.claim({ deviceId: "dev-1", appId: "shorts", nonce: s.nonce })).sessionState, "pending");
  });
  test("client-confirm mode (explicit env opt-in): needs min watch time, grants once", async () => {
    await setup({ env: { ALLOW_CLIENT_REWARD_VERIFICATION: "true" }, virtualClock: true, limits: { rewardVerification: "client", minAdWatchSeconds: 10 } });
    await exhaust(); const s = await start(); assert.equal(s.verification, "client");
    await assert.rejects(H.quota.claim({ deviceId: "dev-1", appId: "shorts", nonce: s.nonce }), { code: "REWARD_NOT_ELIGIBLE" });
    clock.t += 11000;
    for (let i = 0; i < 4; i++) assert.equal((await H.quota.claim({ deviceId: "dev-1", appId: "shorts", nonce: s.nonce })).sessionState, "granted");
    assert.equal(await grantedTotal(), 3);
  });
});

describe("caps and cooldown (all from settings)", () => {
  const grantOnce = async () => { const s = await start(); const r = await callSsv(signedFor(s, { timestamp: String(clock.t) }).query); assert.equal(r.body.status, "granted"); H.stores.quotas.__put({ ...(await H.stores.quotas.get("dev-1", "shorts")), used: (await H.stores.quotas.get("dev-1", "shorts")).rewardedGranted + 3 }); };
  test("daily cap: after N ads in 24h the next is refused with retry-after, then allowed after the window", async () => {
    await setup({ virtualClock: true, limits: { maxRewardedAdsPerDay: 2 } }); await exhaust();
    await grantOnce(); clock.t += 3600e3; await grantOnce();
    await assert.rejects(start(), (e) => e.extra.quota.nextReward.reason === "DAILY_CAP" && e.extra.quota.nextReward.retryAfterSeconds > 0 && e.status === 403);
    clock.t += 24 * 3600e3; assert.equal((await state()).nextReward.eligible, true);
  });
  test("lifetime cap", async () => {
    await setup({ virtualClock: true, limits: { maxRewardedAdsTotal: 1, maxRewardedAdsPerDay: 0 } }); await exhaust(); await grantOnce();
    await assert.rejects(start(), (e) => e.extra.quota.nextReward.reason === "TOTAL_CAP");
  });
  test("cooldown between rewards", async () => {
    await setup({ virtualClock: true, limits: { rewardCooldownSeconds: 300 } }); await exhaust(); await grantOnce();
    await assert.rejects(start(), (e) => e.extra.quota.nextReward.reason === "COOLDOWN" && e.extra.quota.nextReward.retryAfterSeconds <= 300);
    clock.t += 301000; assert.equal((await state()).nextReward.eligible, true);
  });
  test("rewardShowWhenRemainingAtMost lets an ad be offered before the quota is empty", async () => {
    await setup({ limits: { rewardShowWhenRemainingAtMost: 1 } }); await exhaust("dev-1", "shorts", 2);
    assert.equal((await state()).nextReward.eligible, true);
  });
});

describe("both apps behave identically", () => {
  for (const app of ["shorts", "vydo"]) {
    test(`[${app}] exhaust -> start -> verified callback -> +3, independent of the other app`, async () => {
      await setup({ apps: ["shorts", "vydo"] }); await exhaust("dev-1", app); await exhaust("dev-1", app === "shorts" ? "vydo" : "shorts", 0);
      const s = await start("dev-1", app);
      assert.equal((await callSsv(signedFor(s).query)).body.status, "granted");
      assert.equal((await state("dev-1", app)).remaining, 3);
      assert.equal((await H.stores.quotas.get("dev-1", app === "shorts" ? "vydo" : "shorts")).rewardedGranted, 0);
    });
  }
  test("a session issued by one app cannot be redeemed by the other app's ad unit", async () => {
    await setup({ apps: ["shorts", "vydo"] });
    await H.appSettings.update("vydo", { rewarded: { enabled: true, unitId: "ca-app-pub-3333333333333333/4444444444" } });
    await exhaust("dev-1", "vydo"); const s = await start("dev-1", "vydo");
    assert.equal((await callSsv(signedFor(s, { ad_unit: UNIT_NUM }).query)).body.status, "ad_unit_mismatch");
    assert.equal((await callSsv(signedFor(s, { ad_unit: "4444444444" }).query)).body.status, "granted");
  });
});

describe("SSV key provider", () => {
  test("caches keys, refreshes an unknown key_id at most once per minute, survives fetch failure with cached keys", async () => {
    let calls = 0, fail = false; const now = { t: 1e12 };
    const fetchImpl = async () => { calls++; if (fail) throw new Error("net"); return { ok: true, json: async () => ({ keys: [{ keyId: 1, pem: "PEM1" }] }) }; };
    const kp = createKeyProvider({ url: "u", cacheMs: 3600e3, fetchImpl, now: () => now.t });
    assert.equal(await kp(1), "PEM1"); assert.equal(await kp(1), "PEM1"); assert.equal(calls, 1);
    assert.equal(await kp(999), null); assert.equal(await kp(998), null); assert.equal(calls, 1, "unknown ids cannot be used to hammer Google");
    now.t += 61000; fail = true; assert.equal(await kp(999), null); assert.equal(await kp(1), "PEM1", "cached key still served when refresh fails");
  });
  test("adUnitMatches accepts full or numeric ids, rejects blanks", () => {
    assert.equal(adUnitMatches("ca-app-pub-1/222", "222"), true); assert.equal(adUnitMatches("ca-app-pub-1/222", "ca-app-pub-9/222"), true);
    assert.equal(adUnitMatches("ca-app-pub-1/222", "333"), false); assert.equal(adUnitMatches("", "222"), false); assert.equal(adUnitMatches("ca-app-pub-1/222", ""), false);
  });
});
