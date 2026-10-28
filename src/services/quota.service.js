/**
 * Download quota + rewarded-ad unlocks.
 *
 *  allowed   = limits.freeDownloads + rewardedGranted          (limits come from settings, never literals)
 *  remaining = max(0, allowed - used - inProgress)
 *
 *  A download is RESERVED before any paid work, COMMITTED when it really succeeded, RELEASED when it
 *  failed. Re-asking for the same video while it is reserved/committed never charges twice.
 *  Rewards: start (issues a one-time nonce) -> ad -> AdMob server-side callback (signed) -> grant.
 *  The client's own "I watched it" signal never grants anything (unless the operator explicitly enables
 *  the insecure "client" mode through env).
 */
const crypto = require("crypto");
const { AppError } = require("../utils/errors");
const { isKnownApp } = require("../config/apps");
const logger = require("../utils/logger");

const DAY = 86400000;
const DEVICE_ID_RE = /^[\w.:@-]{1,128}$/;

function createQuotaService({ quotas, settings, now = Date.now, metrics = null }) {
  const inc = (n) => metrics && metrics.inc(n);

  function assertIdentity(deviceId, appId) {
    if (typeof deviceId !== "string" || !DEVICE_ID_RE.test(deviceId)) throw new AppError("INVALID_REQUEST", "Invalid deviceId");
    if (!isKnownApp(appId)) throw new AppError("INVALID_REQUEST", "Unknown appId");
  }

  /** Pure view of a quota doc under the given settings. */
  function computeState(doc, resolved, t = now()) {
    const L = resolved.limits;
    const d = { used: 0, reservations: [], rewardedGranted: 0, rewardsCompleted: 0, lastRewardAt: null, lastRewardUnits: 0, grants: [], sessions: [], ...(doc || {}) };
    const inProgress = (d.reservations || []).filter((r) => r.exp > t).length;
    const allowed = L.freeDownloads + d.rewardedGranted;
    const remaining = Math.max(0, allowed - d.used - inProgress);
    const rewardedUsed = Math.min(d.rewardedGranted, Math.max(0, d.used - L.freeDownloads));
    const enforced = settings.isEnforced(resolved);

    // ---- next reward eligibility
    const recent = (d.grants || []).filter((g) => g > t - DAY).sort((a, b) => a - b);
    let reason = null, retryAfterSeconds = 0;
    if (!L.enabled || !L.rewardedAdsEnabled || L.rewardedDownloads <= 0 || !resolved.rewarded.enabled || !resolved.rewarded.unitId) reason = "DISABLED";
    else if (remaining > L.rewardShowWhenRemainingAtMost) reason = "LIMIT_NOT_REACHED";
    else if (inProgress > 0) reason = "DOWNLOADS_IN_PROGRESS"; // the ad is offered only after the downloads actually COMPLETE (a failure would free the quota again)
    else if (L.maxRewardedAdsTotal > 0 && d.rewardsCompleted >= L.maxRewardedAdsTotal) reason = "TOTAL_CAP";
    else if (L.maxRewardedAdsPerDay > 0 && recent.length >= L.maxRewardedAdsPerDay) { reason = "DAILY_CAP"; retryAfterSeconds = Math.ceil((recent[0] + DAY - t) / 1000); }
    else if (L.rewardCooldownSeconds > 0 && d.lastRewardAt && d.lastRewardAt + L.rewardCooldownSeconds * 1000 > t) { reason = "COOLDOWN"; retryAfterSeconds = Math.ceil((d.lastRewardAt + L.rewardCooldownSeconds * 1000 - t) / 1000); }

    const live = (d.sessions || []).filter((s) => s.state === "issued" && s.expiresAt > t).sort((a, b) => b.createdAt - a.createdAt)[0];
    const lastGranted = (d.sessions || []).filter((s) => s.state === "granted").sort((a, b) => b.grantedAt - a.grantedAt)[0];

    return {
      appId: d.appId || undefined,
      enforced,
      limits: { freeDownloads: L.freeDownloads, rewardedDownloadsPerAd: L.rewardedDownloads },
      totalAllowed: allowed,
      used: d.used,
      inProgress,
      remaining,
      freeDownloads: { total: L.freeDownloads, used: Math.min(d.used, L.freeDownloads), remaining: Math.max(0, L.freeDownloads - d.used) },
      rewarded: {
        adCompleted: d.rewardsCompleted > 0,
        completedAds: d.rewardsCompleted,
        unlockedDownloads: d.rewardedGranted,
        usedFromRewards: rewardedUsed,
        remainingFromRewards: Math.max(0, d.rewardedGranted - rewardedUsed),
        lastUnlockedDownloads: d.lastRewardUnits || 0,
        lastCompletedAt: d.lastRewardAt || null,
      },
      nextReward: {
        eligible: reason === null,
        reason,
        retryAfterSeconds,
        unlocksDownloads: L.rewardedDownloads,
        adsRemainingToday: L.maxRewardedAdsPerDay > 0 ? Math.max(0, L.maxRewardedAdsPerDay - recent.length) : null,
        pollIntervalMs: L.statusPollIntervalMs,
        pollTimeoutMs: L.statusPollTimeoutMs,
      },
      session: live ? { state: "issued", nonce: live.nonce, expiresAt: live.expiresAt, unlocksDownloads: live.units }
        : lastGranted ? { state: "granted", unlockedDownloads: lastGranted.units, grantedAt: lastGranted.grantedAt } : { state: "none" },
      serverTime: t,
    };
  }

  async function getState({ deviceId, appId }) {
    assertIdentity(deviceId, appId);
    const [resolved, doc] = await Promise.all([settings.resolve(appId), quotas.get(deviceId, appId)]);
    return computeState({ ...(doc || {}), appId }, resolved);
  }

  async function shouldEnforce(appId) {
    if (appId === null || appId === undefined) return false;
    return settings.isEnforced(await settings.resolve(appId));
  }

  // ------------------------------------------------------------------- downloads
  async function reserve({ deviceId, appId, key }) {
    assertIdentity(deviceId, appId);
    const resolved = await settings.resolve(appId);
    const L = resolved.limits;
    await quotas.ensure(deviceId, appId);
    const r = await quotas.reserve({ deviceId, appId, key, free: L.freeDownloads, ttlMs: L.reservationTtlSeconds * 1000, now: now() });
    if (!r.ok) {
      inc("quota_denied");
      throw new AppError("DOWNLOAD_LIMIT_REACHED", undefined, { extra: { quota: computeState({ ...r.doc, appId }, resolved) } });
    }
    inc(r.already ? "quota_reserve_duplicate" : "quota_reserved");
    return { already: r.already };
  }
  const commit = async ({ deviceId, appId, key }) => { const ok = await quotas.commit({ deviceId, appId, key, now: now() }); if (ok) inc("quota_committed"); return ok; };
  const release = async ({ deviceId, appId, key }) => { const ok = await quotas.release({ deviceId, appId, key }); if (ok) inc("quota_released"); return ok; };

  // --------------------------------------------------------------------- rewards
  async function startReward({ deviceId, appId }) {
    assertIdentity(deviceId, appId);
    const resolved = await settings.resolve(appId);
    const L = resolved.limits;
    const doc = await quotas.ensure(deviceId, appId);
    const t = now();
    const state = computeState({ ...doc, appId }, resolved, t);
    const live = (doc.sessions || []).find((s) => s.state === "issued" && s.expiresAt > t);
    if (!state.nextReward.eligible) {
      throw new AppError("REWARD_NOT_ELIGIBLE", undefined, { retryAfterSec: state.nextReward.retryAfterSeconds || undefined, extra: { quota: state } });
    }
    const out = (s) => ({ nonce: s.nonce, expiresAt: s.expiresAt, unlocksDownloads: s.units, userId: deviceId, verification: L.rewardVerification, adUnitId: resolved.rewarded.unitId });
    if (live) return out(live);                      // idempotent: repeated start returns the same session
    const session = { nonce: crypto.randomBytes(24).toString("base64url"), state: "issued", units: L.rewardedDownloads, createdAt: t, expiresAt: t + L.rewardSessionTtlSeconds * 1000 };
    const added = await quotas.addSession({ deviceId, appId, session, now: t });
    if (!added) {                                    // lost a race with a concurrent start: reuse theirs
      const again = await quotas.get(deviceId, appId);
      const s = (again.sessions || []).find((x) => x.state === "issued" && x.expiresAt > t);
      if (s) return out(s);
      throw new AppError("SERVICE_BUSY");
    }
    inc("reward_session_started");
    return out(session);
  }

  /**
   * Credit a reward for a session. Called ONLY by (a) the verified AdMob SSV callback or
   * (b) claimClient() when the operator enabled the insecure client mode.
   * Idempotent: replays / duplicates / late callbacks return {status:"already_granted"} and credit nothing.
   */
  async function grantByNonce({ deviceId, nonce, txId, adUnit, expectedAdUnitCheck }) {
    if (typeof deviceId !== "string" || !DEVICE_ID_RE.test(deviceId) || typeof nonce !== "string" || nonce.length < 16 || nonce.length > 128)
      return { status: "invalid" };
    const doc = await quotas.findBySession(deviceId, nonce);
    if (!doc) return { status: "unknown_session" };
    const t = now();
    const session = doc.sessions.find((s) => s.nonce === nonce);
    if (session.state === "granted") { inc("reward_replay_ignored"); return { status: "already_granted", appId: doc.appId }; }
    if (session.expiresAt <= t) { inc("reward_expired"); return { status: "expired", appId: doc.appId }; }
    const resolved = await settings.resolve(doc.appId);
    if (expectedAdUnitCheck && !expectedAdUnitCheck(resolved.rewarded)) { inc("reward_ad_unit_mismatch"); return { status: "ad_unit_mismatch", appId: doc.appId }; }
    const granted = await quotas.grantSession({ deviceId, appId: doc.appId, nonce, units: session.units, txId, adUnit, now: t });
    if (!granted) {                                  // lost a race: someone else granted/expired it between read and write
      const again = await quotas.findBySession(deviceId, nonce);
      const s = again && again.sessions.find((x) => x.nonce === nonce);
      if (s && s.state === "granted") { inc("reward_replay_ignored"); return { status: "already_granted", appId: doc.appId }; }
      return { status: "expired", appId: doc.appId };
    }
    inc("reward_granted");
    logger.event("reward_granted", { appId: doc.appId, device: logger.hashId(deviceId), units: session.units });
    return { status: "granted", appId: doc.appId, units: session.units };
  }

  /** What the app calls after the ad's own "earned reward" callback. In secure mode it only REPORTS. */
  async function claim({ deviceId, appId, nonce }) {
    assertIdentity(deviceId, appId);
    const resolved = await settings.resolve(appId);
    const L = resolved.limits;
    const doc = await quotas.get(deviceId, appId);
    const s = doc && (doc.sessions || []).find((x) => x.nonce === nonce);
    if (!s) throw new AppError("REWARD_SESSION_NOT_FOUND");
    const t = now();
    if (s.state === "issued" && L.rewardVerification === "client") {
      if (s.expiresAt <= t) throw new AppError("REWARD_SESSION_EXPIRED");
      if (t - s.createdAt < L.minAdWatchSeconds * 1000) throw new AppError("REWARD_NOT_ELIGIBLE", "Ad was not watched long enough");
      await grantByNonce({ deviceId, nonce, txId: `client:${nonce}`, adUnit: "client" });
    }
    const state = await getState({ deviceId, appId });
    const fresh = (await quotas.get(deviceId, appId)).sessions.find((x) => x.nonce === nonce);
    const sessionState = fresh.state === "granted" ? "granted" : fresh.expiresAt <= t ? "expired" : "pending";
    return { sessionState, verification: L.rewardVerification, unlockedDownloads: sessionState === "granted" ? fresh.units : 0, quota: state };
  }

  return { getState, computeState, shouldEnforce, reserve, commit, release, startReward, grantByNonce, claim };
}

module.exports = { createQuotaService, DEVICE_ID_RE };
