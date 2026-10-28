/**
 * MongoDB implementation of the stores used by download.service / videoProcessor.
 * Kept deliberately thin. Contract is exercised by tests/contract.stores.test.js
 * (runs against memory.js always, and against this file when TEST_MONGO_URL is set).
 */
const VideoAsset = require("../models/videoAsset.model");
const Lock = require("../models/lock.model");
const Download = require("../models/download.model");
const DownloadQuota = require("../models/downloadQuota.model");
const AppSetting = require("../models/appSetting.model");

const isDup = (e) => e && (e.code === 11000 || e.code === 11001);

const assets = {
  async getByKey(key) {
    return VideoAsset.findOne({ key }).lean();
  },
  /** Insert; if another writer won the unique-key race, return THEIR doc. */
  async create(doc) {
    try {
      const created = await VideoAsset.create(doc);
      return { asset: created.toObject(), created: true };
    } catch (e) {
      if (!isDup(e)) throw e;
      return { asset: await VideoAsset.findOne({ key: doc.key }).lean(), created: false };
    }
  },
  async update(key, patch) {
    return VideoAsset.findOneAndUpdate({ key }, { $set: patch }, { returnDocument: "after" }).lean();
  },
  /**
   * Lease lock. Filter matches only an EXPIRED lock; if a live lock exists the
   * upsert attempts an insert with the same _id and fails with E11000 => not acquired.
   */
  async tryAcquireLock(key, owner, ttlMs) {
    const now = Date.now();
    try {
      const doc = await Lock.findOneAndUpdate(
        { _id: key, expiresAt: { $lte: new Date(now) } },
        { $set: { owner, expiresAt: new Date(now + ttlMs) } },
        { upsert: true, returnDocument: "after" }
      ).lean();
      return !!doc && doc.owner === owner;
    } catch (e) {
      if (isDup(e)) return false;
      throw e;
    }
  },
  async releaseLock(key, owner) {
    await Lock.deleteOne({ _id: key, owner });
  },
};

const rows = {
  async getById(id) {
    return Download.findById(id).lean();
  },
  /** All of this device's rows for the video (new link, or legacy host+sourceId). */
  async findForDevice({ deviceId, assetKey, hosts, legacySourceId }) {
    const or = [{ assetKey }];
    if (legacySourceId) or.push({ platform: { $in: hosts }, sourceId: legacySourceId });
    return Download.find({ deviceId, $or: or }).limit(10).lean();
  },
  async insert(fields) {
    try {
      const doc = await Download.create(fields);
      return { row: doc.toObject(), created: true };
    } catch (e) {
      if (!isDup(e)) throw e;
      return { row: await Download.findOne({ deviceId: fields.deviceId, assetKey: fields.assetKey }).lean(), created: false };
    }
  },
  async update(id, patch) {
    return Download.findByIdAndUpdate(id, { $set: patch }, { returnDocument: "after" }).lean();
  },
  async completeByAsset(assetKey, patch) {
    const r = await Download.updateMany({ assetKey, status: { $in: ["pending", "processing"] } }, { $set: patch });
    return r.modifiedCount || 0;
  },
  async failByAsset(assetKey) {
    const r = await Download.updateMany({ assetKey, status: { $in: ["pending", "processing"] } }, { $set: { status: "failed" } });
    return r.modifiedCount || 0;
  },
  async findByAsset(assetKey) {
    return Download.find({ assetKey }).lean();
  },
  async findLegacyReady({ hosts, sourceId }) {
    return Download.findOne({ platform: { $in: hosts }, sourceId, status: "ready", cdnUrl: { $ne: null } })
      .sort({ _id: 1 })
      .lean();
  },
};

/**
 * Download quota. EVERY mutator is one atomic single-document update with its guard in the filter,
 * so duplicate / concurrent requests cannot over-spend or over-grant.
 */
const quotas = {
  async ensure(deviceId, appId) {
    try {
      return await DownloadQuota.findOneAndUpdate(
        { deviceId, appId }, { $setOnInsert: { used: 0 } },
        { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
      ).lean();
    } catch (e) {
      if (!isDup(e)) throw e;
      return DownloadQuota.findOne({ deviceId, appId }).lean();
    }
  },
  async get(deviceId, appId) {
    return DownloadQuota.findOne({ deviceId, appId }).lean();
  },
  /** -> {ok:true,already,doc} | {ok:false,doc}. Allowance = free + rewardedGranted (free comes from settings). */
  async reserve({ deviceId, appId, key, free, ttlMs, now }) {
    await DownloadQuota.updateOne({ deviceId, appId }, { $pull: { reservations: { exp: { $lte: now } } } });
    const doc = await DownloadQuota.findOneAndUpdate(
      {
        deviceId, appId, "reservations.key": { $ne: key },
        $expr: { $lt: [{ $add: ["$used", { $size: "$reservations" }] }, { $add: [free, "$rewardedGranted"] }] },
      },
      { $push: { reservations: { key, exp: now + ttlMs } } },
      { returnDocument: "after" }
    ).lean();
    if (doc) return { ok: true, already: false, doc };
    const cur = await DownloadQuota.findOne({ deviceId, appId }).lean();
    if (cur && (cur.reservations || []).some((r) => r.key === key && r.exp > now)) return { ok: true, already: true, doc: cur };
    return { ok: false, doc: cur };
  },
  async commit({ deviceId, appId, key, now }) {
    const doc = await DownloadQuota.findOneAndUpdate(
      { deviceId, appId, "reservations.key": key },
      { $pull: { reservations: { key } }, $inc: { used: 1 }, $set: { lastDownloadAt: now } },
      { returnDocument: "after" }
    ).lean();
    return !!doc;
  },
  async release({ deviceId, appId, key }) {
    const r = await DownloadQuota.updateOne({ deviceId, appId, "reservations.key": key }, { $pull: { reservations: { key } } });
    return (r.modifiedCount || 0) > 0;
  },
  /** Adds a session only if no live issued session exists. -> doc | null */
  async addSession({ deviceId, appId, session, now }) {
    await DownloadQuota.updateOne({ deviceId, appId }, { $pull: { sessions: { expiresAt: { $lt: now - 86400000 } } } });
    return DownloadQuota.findOneAndUpdate(
      { deviceId, appId, sessions: { $not: { $elemMatch: { state: "issued", expiresAt: { $gt: now } } } } },
      { $push: { sessions: session } },
      { returnDocument: "after" }
    ).lean();
  },
  async findBySession(deviceId, nonce) {
    return DownloadQuota.findOne({ deviceId, "sessions.nonce": nonce }).lean();
  },
  /** Atomically flips ONE issued, unexpired session to granted AND credits the downloads. -> doc | null */
  async grantSession({ deviceId, appId, nonce, units, txId, adUnit, now }) {
    return DownloadQuota.findOneAndUpdate(
      { deviceId, appId, sessions: { $elemMatch: { nonce, state: "issued", expiresAt: { $gt: now }, units } } },
      {
        $set: { "sessions.$.state": "granted", "sessions.$.grantedAt": now, "sessions.$.transactionId": txId, "sessions.$.adUnit": adUnit, lastRewardAt: now, lastRewardUnits: units },
        $inc: { rewardedGranted: units, rewardsCompleted: 1 },
        $push: { grants: { $each: [now], $slice: -50 } },
      },
      { returnDocument: "after" }
    ).lean();
  },
};

const settings = {
  async get(appId) {
    return AppSetting.findOne({ appId }).lean();
  },
  /** patch: { downloadLimits: {k: v|null}, rewarded: {..}|null|undefined } */
  async update(appId, { downloadLimits, rewarded }) {
    const $set = {}, $unset = {};
    for (const [k, v] of Object.entries(downloadLimits || {})) (v === null ? $unset : $set)[`downloadLimits.${k}`] = v === null ? 1 : v;
    if (rewarded === null) $unset.rewarded = 1; else if (rewarded) $set.rewarded = rewarded;
    const update = { $inc: { version: 1 } };                  // upsert takes appId from the filter
    if (Object.keys($set).length) update.$set = $set;
    if (Object.keys($unset).length) update.$unset = $unset;
    try {
      return await AppSetting.findOneAndUpdate({ appId }, update, { upsert: true, returnDocument: "after" }).lean();
    } catch (e) {
      if (!isDup(e)) throw e;
      return AppSetting.findOneAndUpdate({ appId }, update, { returnDocument: "after" }).lean(); // lost the upsert race: doc exists now
    }
  },
};

module.exports = { assets, rows, quotas, settings };
