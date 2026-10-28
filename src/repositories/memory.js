/**
 * In-memory store with the SAME semantics as repositories/mongo.js
 * (unique keys, lease locks, partial-unique (deviceId, assetKey)).
 * Used by the unit/concurrency tests and the performance harness.
 */
const clone = (o) => (o == null ? o : structuredClone(o));

function createMemoryStores({ now = Date.now, latencyMs = 0 } = {}) {
  const A = new Map();
  const L = new Map();
  let R = [];
  let seq = 0;
  const calls = { assets: 0, rows: 0 };
  const lag = () => (latencyMs ? new Promise((r) => setTimeout(r, latencyMs)) : Promise.resolve());

  const assets = {
    async getByKey(key) { calls.assets++; await lag(); return clone(A.get(key) || null); },
    async create(doc) {
      calls.assets++; await lag();
      if (A.has(doc.key)) return { asset: clone(A.get(doc.key)), created: false };
      const d = { ...clone(doc), createdAt: new Date(now()), updatedAt: new Date(now()) };
      A.set(doc.key, d);
      return { asset: clone(d), created: true };
    },
    async update(key, patch) {
      calls.assets++; await lag();
      const d = A.get(key);
      if (!d) return null;
      Object.assign(d, clone(patch), { updatedAt: new Date(now()) });
      return clone(d);
    },
    async tryAcquireLock(key, owner, ttlMs) {
      await lag();
      const cur = L.get(key);
      if (cur && cur.expiresAt > now()) return false;
      L.set(key, { owner, expiresAt: now() + ttlMs });
      return true;
    },
    async releaseLock(key, owner) {
      await lag();
      const cur = L.get(key);
      if (cur && cur.owner === owner) L.delete(key);
    },
  };

  const rows = {
    async getById(id) { calls.rows++; await lag(); return clone(R.find((r) => String(r._id) === String(id)) || null); },
    async findForDevice({ deviceId, assetKey, hosts, legacySourceId }) {
      calls.rows++; await lag();
      return clone(R.filter((r) => r.deviceId === deviceId &&
        (r.assetKey === assetKey || (legacySourceId && hosts.includes(r.platform) && r.sourceId === legacySourceId))).slice(0, 10));
    },
    async insert(fields) {
      calls.rows++; await lag();
      if (fields.assetKey) {
        const dup = R.find((r) => r.deviceId === fields.deviceId && r.assetKey === fields.assetKey);
        if (dup) return { row: clone(dup), created: false };
      }
      const r = { ...clone(fields), _id: `row${++seq}`, createdAt: new Date(now()), updatedAt: new Date(now()) };
      R.push(r);
      return { row: clone(r), created: true };
    },
    async update(id, patch) {
      calls.rows++; await lag();
      const r = R.find((x) => String(x._id) === String(id));
      if (!r) return null;
      Object.assign(r, clone(patch), { updatedAt: new Date(now()) });
      return clone(r);
    },
    async completeByAsset(assetKey, patch) {
      await lag(); let n = 0;
      for (const r of R) if (r.assetKey === assetKey && ["pending", "processing"].includes(r.status)) { Object.assign(r, clone(patch)); n++; }
      return n;
    },
    async failByAsset(assetKey) {
      await lag(); let n = 0;
      for (const r of R) if (r.assetKey === assetKey && ["pending", "processing"].includes(r.status)) { r.status = "failed"; n++; }
      return n;
    },
    async findByAsset(assetKey) { await lag(); return clone(R.filter((r) => r.assetKey === assetKey)); },
    async findLegacyReady({ hosts, sourceId }) {
      await lag();
      return clone(R.filter((r) => hosts.includes(r.platform) && r.sourceId === sourceId && r.status === "ready" && r.cdnUrl)
        .sort((a, b) => String(a._id).localeCompare(String(b._id), undefined, { numeric: true }))[0] || null);
    },
    /** test helper: seed a pre-optimisation row */
    __seed(row) { const r = { _id: `row${++seq}`, createdAt: new Date(now()), ...clone(row) }; R.push(r); return clone(r); },
    __all: () => clone(R),
  };

  // ---- quotas (same semantics as repositories/mongo.js; JS is single-threaded so each method is atomic)
  const Q = new Map();
  const qk = (d, a) => `${d}\u0000${a}`;
  const fresh = (deviceId, appId) => ({ deviceId, appId, used: 0, reservations: [], rewardedGranted: 0, rewardsCompleted: 0, lastRewardAt: null, lastRewardUnits: 0, lastDownloadAt: null, grants: [], sessions: [] });
  const quotas = {
    async ensure(deviceId, appId) { await lag(); if (!Q.has(qk(deviceId, appId))) Q.set(qk(deviceId, appId), fresh(deviceId, appId)); return clone(Q.get(qk(deviceId, appId))); },
    async get(deviceId, appId) { await lag(); return clone(Q.get(qk(deviceId, appId)) || null); },
    async reserve({ deviceId, appId, key, free, ttlMs, now: t }) {
      await lag();
      const d = Q.get(qk(deviceId, appId));
      if (!d) return { ok: false, doc: null };
      d.reservations = d.reservations.filter((r) => r.exp > t);
      if (d.reservations.some((r) => r.key === key)) return { ok: true, already: true, doc: clone(d) };
      if (d.used + d.reservations.length < free + d.rewardedGranted) { d.reservations.push({ key, exp: t + ttlMs }); return { ok: true, already: false, doc: clone(d) }; }
      return { ok: false, doc: clone(d) };
    },
    async commit({ deviceId, appId, key, now: t }) {
      await lag(); const d = Q.get(qk(deviceId, appId));
      if (!d || !d.reservations.some((r) => r.key === key)) return false;
      d.reservations = d.reservations.filter((r) => r.key !== key); d.used += 1; d.lastDownloadAt = t; return true;
    },
    async release({ deviceId, appId, key }) {
      await lag(); const d = Q.get(qk(deviceId, appId));
      if (!d || !d.reservations.some((r) => r.key === key)) return false;
      d.reservations = d.reservations.filter((r) => r.key !== key); return true;
    },
    async addSession({ deviceId, appId, session, now: t }) {
      await lag(); const d = Q.get(qk(deviceId, appId)); if (!d) return null;
      d.sessions = d.sessions.filter((x) => !(x.expiresAt < t - 86400000));
      if (d.sessions.some((x) => x.state === "issued" && x.expiresAt > t)) return null;
      d.sessions.push(clone(session)); return clone(d);
    },
    async findBySession(deviceId, nonce) {
      await lag();
      for (const d of Q.values()) if (d.deviceId === deviceId && d.sessions.some((x) => x.nonce === nonce)) return clone(d);
      return null;
    },
    async grantSession({ deviceId, appId, nonce, units, txId, adUnit, now: t }) {
      await lag(); const d = Q.get(qk(deviceId, appId)); if (!d) return null;
      const s = d.sessions.find((x) => x.nonce === nonce && x.state === "issued" && x.expiresAt > t && x.units === units);
      if (!s) return null;
      s.state = "granted"; s.grantedAt = t; s.transactionId = txId; s.adUnit = adUnit;
      d.lastRewardAt = t; d.lastRewardUnits = units; d.rewardedGranted += units; d.rewardsCompleted += 1;
      d.grants.push(t); d.grants = d.grants.slice(-50);
      return clone(d);
    },
    /** test helper */ __put(doc) { Q.set(qk(doc.deviceId, doc.appId), { ...fresh(doc.deviceId, doc.appId), ...clone(doc) }); },
  };

  const S = new Map();
  const settings = {
    async get(appId) { await lag(); return clone(S.get(appId) || null); },
    async update(appId, { downloadLimits, rewarded }) {
      await lag();
      const cur = S.get(appId) || { appId, downloadLimits: {}, rewarded: null, version: 0 };
      for (const [k, v] of Object.entries(downloadLimits || {})) { if (v === null) delete cur.downloadLimits[k]; else cur.downloadLimits[k] = v; }
      if (rewarded === null) cur.rewarded = null; else if (rewarded) cur.rewarded = clone(rewarded);
      cur.version += 1; S.set(appId, cur); return clone(cur);
    },
  };

  return { assets, rows, quotas, settings, calls, __locks: L, __assets: A };
}
module.exports = { createMemoryStores };
