/**
 * Store CONTRACT tests. Always run against the in-memory store.
 * Set TEST_MONGO_URL=mongodb://localhost:27017/shorts_test to run the SAME assertions against
 * the real Mongo implementation (unique index races, E11000 handling, lease lock, partial index).
 * (In the sandbox where this project was optimised no mongod was available, so the Mongo run
 *  could not be executed there - run it once in your environment before deploying.)
 */
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createMemoryStores } = require("../src/repositories/memory");

const impls = [["memory", async () => ({ stores: createMemoryStores(), done: async () => {} })]];
if (process.env.TEST_MONGO_URL) {
  impls.push(["mongo", async () => {
    const mongoose = require("mongoose");
    if (mongoose.connection.readyState === 0) await mongoose.connect(process.env.TEST_MONGO_URL);
    const models = ["videoAsset", "lock", "download", "downloadQuota", "appSetting"].map((n) => require(`../src/models/${n}.model`));
    await Promise.all(models.map((m) => m.init()));                                  // build indexes
    await Promise.all(models.map((m) => m.deleteMany({})));
    return { stores: require("../src/repositories/mongo"), done: async () => {} };
  }]);
}
after(async () => { if (process.env.TEST_MONGO_URL) await require("mongoose").disconnect(); });

for (const [name, make] of impls) {
  describe(`store contract [${name}]`, () => {
    let S;
    before(async () => { ({ stores: S } = await make()); });
    const A = (key, over = {}) => ({ key, platform: "instagram", videoId: key.split(":")[1], title: "t", status: "queued", ...over });

    test("assets.create is unique by key; the loser of a race gets the WINNER's document", async () => {
      const results = await Promise.all(Array.from({ length: 10 }, (_, i) => S.assets.create(A("instagram:RACE1", { title: `w${i}` }))));
      assert.equal(results.filter((r) => r.created).length, 1);
      assert.equal(new Set(results.map((r) => r.asset.title)).size, 1);
    });
    test("assets.update / getByKey / clearing nested fields with null", async () => {
      await S.assets.create(A("instagram:UPD1", { sourceMedia: { url: "u", expiresAt: 5 } }));
      const u = await S.assets.update("instagram:UPD1", { status: "ready", sourceMedia: null, storage: { cdnUrl: "c" } });
      assert.equal(u.status, "ready"); assert.equal(u.sourceMedia, null); assert.equal(u.storage.cdnUrl, "c");
      assert.equal((await S.assets.getByKey("instagram:UPD1")).storage.cdnUrl, "c");
      assert.equal(await S.assets.update("instagram:NOPE", { status: "x" }), null);
      assert.equal(await S.assets.getByKey("instagram:NOPE"), null);
    });
    test("lease lock: mutual exclusion, owner-only release, TTL expiry", async () => {
      assert.equal(await S.assets.tryAcquireLock("lk1", "A", 60000), true);
      assert.equal(await S.assets.tryAcquireLock("lk1", "B", 60000), false);
      await S.assets.releaseLock("lk1", "B");                                  // wrong owner: no effect
      assert.equal(await S.assets.tryAcquireLock("lk1", "C", 60000), false);
      await S.assets.releaseLock("lk1", "A");
      assert.equal(await S.assets.tryAcquireLock("lk1", "C", 80), true);
      assert.equal(await S.assets.tryAcquireLock("lk1", "D", 80), false);
      await new Promise((r) => setTimeout(r, 120));
      assert.equal(await S.assets.tryAcquireLock("lk1", "D", 60000), true, "expired lease is takeable (crashed owner)");
    });
    test("lease lock: 25 concurrent acquirers -> exactly one winner", async () => {
      const r = await Promise.all(Array.from({ length: 25 }, (_, i) => S.assets.tryAcquireLock("lk-race", `o${i}`, 60000)));
      assert.equal(r.filter(Boolean).length, 1);
    });
    test("rows.insert enforces one row per (deviceId, assetKey); loser gets the existing row", async () => {
      const rs = await Promise.all(Array.from({ length: 8 }, () => S.rows.insert({ deviceId: "dX", originalUrl: "u", assetKey: "instagram:ROW1", status: "pending", platform: "www.instagram.com", sourceId: "ROW1" })));
      assert.equal(rs.filter((r) => r.created).length, 1);
      assert.equal(new Set(rs.map((r) => String(r.row._id))).size, 1);
    });
    test("legacy rows (no assetKey) are unaffected by the partial unique index", async () => {
      for (let i = 0; i < 3; i++) await S.rows.insert({ deviceId: "dL", originalUrl: "u", status: "ready", platform: "www.instagram.com", sourceId: "LEG1", cdnUrl: "c" });
      const f = await S.rows.findForDevice({ deviceId: "dL", assetKey: "instagram:LEG1", hosts: ["www.instagram.com"], legacySourceId: "LEG1" });
      assert.equal(f.length, 3);
    });
    test("completeByAsset / failByAsset only touch pending|processing rows", async () => {
      const k = "instagram:CMP1";
      await S.rows.insert({ deviceId: "a", originalUrl: "u", assetKey: k, status: "pending" });
      await S.rows.insert({ deviceId: "b", originalUrl: "u", assetKey: k, status: "processing" });
      await S.rows.insert({ deviceId: "c", originalUrl: "u", assetKey: k, status: "failed" });
      await S.rows.insert({ deviceId: "d", originalUrl: "u", assetKey: k, status: "ready", cdnUrl: "keep" });
      assert.equal(await S.rows.completeByAsset(k, { status: "ready", cdnUrl: "new" }), 2);
      const all = await S.rows.findForDevice({ deviceId: "c", assetKey: k, hosts: [], legacySourceId: null });
      assert.equal(all[0].status, "failed");
      assert.equal((await S.rows.findForDevice({ deviceId: "d", assetKey: k, hosts: [], legacySourceId: null }))[0].cdnUrl, "keep");
      await S.rows.insert({ deviceId: "e", originalUrl: "u", assetKey: k, status: "pending" });
      assert.equal(await S.rows.failByAsset(k), 1);
    });
    test("findByAsset lists every row of an asset", async () => {
      await S.rows.insert({ deviceId: "fa1", originalUrl: "u", assetKey: "instagram:FA", status: "pending", appId: "shorts" });
      await S.rows.insert({ deviceId: "fa2", originalUrl: "u", assetKey: "instagram:FA", status: "ready" });
      assert.deepEqual((await S.rows.findByAsset("instagram:FA")).map((r) => r.deviceId).sort(), ["fa1", "fa2"]);
    });
    test("findLegacyReady: ready + cdnUrl only, host-matched, oldest first", async () => {
      await S.rows.insert({ deviceId: "p1", originalUrl: "u", status: "pending", platform: "www.instagram.com", sourceId: "LR1" });
      await S.rows.insert({ deviceId: "p2", originalUrl: "u", status: "ready", platform: "www.instagram.com", sourceId: "LR1", cdnUrl: "first" });
      await S.rows.insert({ deviceId: "p3", originalUrl: "u", status: "ready", platform: "www.instagram.com", sourceId: "LR1", cdnUrl: "second" });
      await S.rows.insert({ deviceId: "p4", originalUrl: "u", status: "ready", platform: "www.tiktok.com", sourceId: "LR1", cdnUrl: "other-host" });
      const r = await S.rows.findLegacyReady({ hosts: ["www.instagram.com", "instagram.com"], sourceId: "LR1" });
      assert.equal(r.cdnUrl, "first");
      assert.equal(await S.rows.findLegacyReady({ hosts: ["www.instagram.com"], sourceId: "NOPE" }), null);
    });

    // ------------------------------------------------------------------ quota
    describe("quotas", () => {
      const T = 1_700_000_000_000;
      const ref = (d) => ({ deviceId: d, appId: "shorts" });
      const reserve = (d, key, free = 3, now = T, ttlMs = 60000) => S.quotas.reserve({ ...ref(d), key, free, ttlMs, now });

      test("ensure is idempotent and race-safe (unique per device+app)", async () => {
        const docs = await Promise.all(Array.from({ length: 10 }, () => S.quotas.ensure("q-ens", "shorts")));
        assert.equal(new Set(docs.map((d) => String(d.deviceId + d.appId))).size, 1);
        assert.equal(docs[0].used, 0); assert.deepEqual(docs[0].reservations, []);
      });
      test("reserve: 25 concurrent reservations with allowance 5 -> EXACTLY 5 succeed", async () => {
        await S.quotas.ensure("q-race", "shorts");
        const r = await Promise.all(Array.from({ length: 25 }, (_, i) => reserve("q-race", `k${i}`, 5)));
        assert.equal(r.filter((x) => x.ok).length, 5);
        assert.equal((await S.quotas.get("q-race", "shorts")).reservations.length, 5);
      });
      test("reserve: same key twice is idempotent (never double counted)", async () => {
        await S.quotas.ensure("q-idem", "shorts");
        const a = await reserve("q-idem", "same", 3), b = await reserve("q-idem", "same", 3);
        assert.deepEqual([a.ok, a.already, b.ok, b.already], [true, false, true, true]);
        assert.equal((await S.quotas.get("q-idem", "shorts")).reservations.length, 1);
      });
      test("reserve: allowance = free + rewardedGranted; expired reservations free their slot", async () => {
        await S.quotas.ensure("q-ttl", "shorts");
        assert.equal((await reserve("q-ttl", "a", 1)).ok, true);
        assert.equal((await reserve("q-ttl", "b", 1)).ok, false);
        assert.equal((await reserve("q-ttl", "b", 1, T + 61000)).ok, true, "a expired by TTL");
      });
      test("commit / release are single-shot", async () => {
        await S.quotas.ensure("q-cr", "shorts"); await reserve("q-cr", "a"); await reserve("q-cr", "b");
        assert.equal(await S.quotas.commit({ ...ref("q-cr"), key: "a", now: T }), true);
        assert.equal(await S.quotas.commit({ ...ref("q-cr"), key: "a", now: T }), false);
        assert.equal(await S.quotas.release({ ...ref("q-cr"), key: "a" }), false, "cannot release a committed unit");
        assert.equal(await S.quotas.release({ ...ref("q-cr"), key: "b" }), true);
        assert.equal(await S.quotas.release({ ...ref("q-cr"), key: "b" }), false);
        assert.equal(await S.quotas.commit({ ...ref("q-cr"), key: "never" , now: T }), false);
        const d = await S.quotas.get("q-cr", "shorts"); assert.deepEqual([d.used, d.reservations.length], [1, 0]);
      });
      test("concurrent commit of one reservation counts once", async () => {
        await S.quotas.ensure("q-cc", "shorts"); await reserve("q-cc", "a");
        const r = await Promise.all(Array.from({ length: 10 }, () => S.quotas.commit({ ...ref("q-cc"), key: "a", now: T })));
        assert.equal(r.filter(Boolean).length, 1); assert.equal((await S.quotas.get("q-cc", "shorts")).used, 1);
      });
      const sess = (nonce, over = {}) => ({ nonce, state: "issued", units: 3, createdAt: T, expiresAt: T + 600000, ...over });
      test("addSession: only one live issued session; allowed again after it expires", async () => {
        await S.quotas.ensure("q-s1", "shorts");
        const r = await Promise.all(Array.from({ length: 10 }, (_, i) => S.quotas.addSession({ ...ref("q-s1"), session: sess(`n${i}`), now: T })));
        assert.equal(r.filter(Boolean).length, 1);
        assert.ok(await S.quotas.addSession({ ...ref("q-s1"), session: sess("later"), now: T + 700000 }));
      });
      test("grantSession: 20 concurrent grants of one nonce credit exactly once", async () => {
        await S.quotas.ensure("q-g1", "shorts"); await S.quotas.addSession({ ...ref("q-g1"), session: sess("nonce-1"), now: T });
        const r = await Promise.all(Array.from({ length: 20 }, (_, i) => S.quotas.grantSession({ ...ref("q-g1"), nonce: "nonce-1", units: 3, txId: `tx${i}`, adUnit: "u", now: T + 1000 })));
        assert.equal(r.filter(Boolean).length, 1);
        const d = await S.quotas.get("q-g1", "shorts"); assert.deepEqual([d.rewardedGranted, d.rewardsCompleted, d.grants.length, d.lastRewardUnits], [3, 1, 1, 3]);
        assert.equal(d.sessions[0].state, "granted");
      });
      test("grantSession refuses: expired session, wrong unit count, unknown nonce, already granted", async () => {
        await S.quotas.ensure("q-g2", "shorts"); await S.quotas.addSession({ ...ref("q-g2"), session: sess("n2"), now: T });
        const g = (nonce, units, now) => S.quotas.grantSession({ ...ref("q-g2"), nonce, units, txId: "t", adUnit: "u", now });
        assert.equal(await g("n2", 3, T + 600001), null, "expired (atomic guard, not just service-level)");
        assert.equal(await g("n2", 99, T + 1), null);
        assert.equal(await g("nope", 3, T + 1), null);
        assert.ok(await g("n2", 3, T + 1));
        assert.equal(await g("n2", 3, T + 2), null);
        assert.equal((await S.quotas.get("q-g2", "shorts")).rewardedGranted, 3);
      });
      test("findBySession is scoped to the device", async () => {
        await S.quotas.ensure("q-f1", "shorts"); await S.quotas.addSession({ ...ref("q-f1"), session: sess("zz-nonce"), now: T });
        assert.ok(await S.quotas.findBySession("q-f1", "zz-nonce"));
        assert.equal(await S.quotas.findBySession("someone-else", "zz-nonce"), null);
      });
      test("grants history keeps the last 50 only", async () => {
        await S.quotas.ensure("q-g3", "shorts");
        for (let i = 0; i < 55; i++) { await S.quotas.addSession({ ...ref("q-g3"), session: sess(`m${i}`, { createdAt: T + i, expiresAt: T + 1e9 }), now: T + i }); await S.quotas.grantSession({ ...ref("q-g3"), nonce: `m${i}`, units: 3, txId: "t", adUnit: "u", now: T + i }); }
        assert.equal((await S.quotas.get("q-g3", "shorts")).grants.length, 50);
      });
    });

    describe("settings store", () => {
      test("update merges per key, null unsets, rewarded replace/clear, version increments", async () => {
        const a = await S.settings.update("shorts", { downloadLimits: { freeDownloads: 4, rewardedDownloads: 2 }, rewarded: { enabled: true, unitId: "u1" } });
        assert.deepEqual([a.downloadLimits.freeDownloads, a.downloadLimits.rewardedDownloads, a.rewarded.unitId], [4, 2, "u1"]);
        const b = await S.settings.update("shorts", { downloadLimits: { freeDownloads: 5, rewardedDownloads: null } });
        assert.deepEqual([b.downloadLimits.freeDownloads, b.downloadLimits.rewardedDownloads], [5, undefined]);
        assert.equal(b.rewarded.unitId, "u1");
        const c = await S.settings.update("shorts", { rewarded: null });
        assert.ok(!c.rewarded); assert.ok(c.version > a.version);
        assert.equal(await S.settings.get("never-set"), null);
      });
      test("concurrent first-time updates do not crash (upsert race)", async () => {
        const r = await Promise.all(Array.from({ length: 6 }, (_, i) => S.settings.update("vydo", { downloadLimits: { freeDownloads: i + 1 } })));
        assert.equal(r.length, 6); assert.ok(await S.settings.get("vydo"));
      });
    });
  });
}
