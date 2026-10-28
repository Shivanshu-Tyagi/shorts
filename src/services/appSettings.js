/**
 * Dynamic per-app settings. Resolution order for download limits:
 *     DB override (app_settings)  >  environment (DL_*)  >  built-in defaults (config/quota.js)
 * Reads are cached briefly; an admin write invalidates the cache of THIS process immediately and other
 * processes converge within SETTINGS_CACHE_TTL_MS. A DB outage never breaks downloads: the last known
 * (or env/default) values are served.
 */
const { APPS, isKnownApp } = require("../config/apps");
const { DEFAULT_LIMITS, parseLenient, parseStrict } = require("../config/quota");
const { AppError } = require("../utils/errors");
const logger = require("../utils/logger");

function createAppSettings({ store, config, now = Date.now }) {
  const ttl = config.settingsCacheTtlMs;
  const envLimits = parseLenient(config.quotaEnv);
  const cache = new Map(); // appId -> { at, value }

  const finalize = (limits) => {
    const out = { ...limits };
    // The insecure mode can only be enabled by the operator through env, never via the DB/admin API.
    if (out.rewardVerification === "client" && !config.allowClientRewardVerification) out.rewardVerification = "ssv";
    return out;
  };

  async function load(appId) {
    const doc = store ? await store.get(appId) : null;
    const limits = finalize({ ...DEFAULT_LIMITS, ...envLimits, ...parseLenient(doc && doc.downloadLimits) });
    const ro = doc && doc.rewarded && typeof doc.rewarded === "object" ? doc.rewarded : null;
    const base = APPS[appId].rewarded;
    const rewarded = {
      enabled: ro && typeof ro.enabled === "boolean" ? ro.enabled : base.enabled,
      unitId: ro && typeof ro.unitId === "string" ? ro.unitId.trim() : base.unitId,
    };
    return { limits, rewarded, version: (doc && doc.version) || 0 };
  }

  async function resolve(appId) {
    if (!isKnownApp(appId)) throw new AppError("INVALID_REQUEST", "Unknown appId");
    const hit = cache.get(appId);
    if (hit && now() - hit.at < ttl) return hit.value;
    try {
      const value = await load(appId);
      cache.set(appId, { at: now(), value });
      return value;
    } catch (e) {
      logger.error("settings_load_failed", { appId, message: String(e && e.message).slice(0, 120) });
      if (hit) return hit.value; // stale beats broken
      return { limits: finalize({ ...DEFAULT_LIMITS, ...envLimits }), rewarded: { ...APPS[appId].rewarded }, version: 0 };
    }
  }

  /** Is quota actually enforced for this app right now? */
  const isEnforced = (r) =>
    r.limits.enabled && (r.limits.enforceWithoutRewardedAd || (r.limits.rewardedAdsEnabled && r.limits.rewardedDownloads > 0 && r.rewarded.enabled && !!r.rewarded.unitId));

  /** What the apps are allowed to see. */
  const publicView = (r) => ({ ...r.limits, enforced: isEnforced(r), rewardedAdUnitConfigured: !!(r.rewarded.enabled && r.rewarded.unitId) });

  async function update(appId, { downloadLimits, rewarded }) {
    if (!isKnownApp(appId)) throw new AppError("NOT_FOUND", "Unknown appId");
    const errors = {};
    let patch = {};
    if (downloadLimits !== undefined) {
      if (downloadLimits === null || typeof downloadLimits !== "object" || Array.isArray(downloadLimits)) errors.downloadLimits = "must be an object";
      else {
        const r = parseStrict(downloadLimits); patch = r.patch;
        Object.assign(errors, r.errors);
        if (patch.rewardVerification === "client" && !config.allowClientRewardVerification)
          errors.rewardVerification = "client verification is disabled on this server (ALLOW_CLIENT_REWARD_VERIFICATION)";
      }
    }
    let rw;
    if (rewarded !== undefined) {
      if (rewarded === null) rw = null;
      else if (typeof rewarded !== "object" || Array.isArray(rewarded)) errors.rewarded = "must be an object or null";
      else {
        rw = {};
        if (rewarded.enabled !== undefined) { if (typeof rewarded.enabled === "boolean") rw.enabled = rewarded.enabled; else errors["rewarded.enabled"] = "must be boolean"; }
        if (rewarded.unitId !== undefined) {
          if (typeof rewarded.unitId === "string" && (rewarded.unitId.trim() === "" || /^ca-app-pub-\d{10,}\/\d{6,}$/.test(rewarded.unitId.trim()))) rw.unitId = rewarded.unitId.trim();
          else errors["rewarded.unitId"] = "must look like ca-app-pub-XXXXXXXXXXXXXXXX/NNNNNNNNNN";
        }
      }
    }
    if (Object.keys(errors).length) throw new AppError("INVALID_REQUEST", "Invalid settings", { extra: { errors } });
    await store.update(appId, { downloadLimits: patch, rewarded: rw });
    cache.delete(appId);
    return resolve(appId);
  }

  return { resolve, isEnforced, publicView, update, invalidate: (id) => (id ? cache.delete(id) : cache.clear()) };
}

module.exports = { createAppSettings };
