/**
 * Download-limit settings: built-in defaults, validation, env parsing.
 * NOTHING in the quota/reward logic reads a literal limit; everything goes through resolved settings.
 */
const DEFAULT_LIMITS = Object.freeze({
  enabled: true,                       // master switch for quota enforcement
  freeDownloads: 3,                    // initial free downloads per device per app
  rewardedDownloads: 3,                // downloads unlocked by ONE completed rewarded ad (0 disables rewards)
  rewardedAdsEnabled: true,
  maxRewardedAdsPerDay: 10,            // rolling 24h cap per device (0 = unlimited)
  maxRewardedAdsTotal: 0,              // lifetime cap per device (0 = unlimited)
  rewardCooldownSeconds: 0,            // min gap between two rewards
  rewardShowWhenRemainingAtMost: 0,    // offer an ad when remaining <= this (0 = only when exhausted)
  rewardSessionTtlSeconds: 600,        // how long an issued ad session stays valid
  reservationTtlSeconds: 1800,         // in-flight download reservation lifetime (>= worker job time)
  enforceWithoutRewardedAd: false,     // SAFETY: do not lock users out while no rewarded ad unit is configured
  rewardVerification: "ssv",           // "ssv" (secure, default) | "client" (insecure, env-gated)
  minAdWatchSeconds: 5,                // only used by rewardVerification="client"
  statusPollIntervalMs: 2000,          // hints for the apps while waiting for the SSV callback
  statusPollTimeoutMs: 30000,
});

// [type, min, max]
const SCHEMA = {
  enabled: ["bool"], rewardedAdsEnabled: ["bool"], enforceWithoutRewardedAd: ["bool"],
  freeDownloads: ["int", 0, 1000], rewardedDownloads: ["int", 0, 1000],
  maxRewardedAdsPerDay: ["int", 0, 100], maxRewardedAdsTotal: ["int", 0, 100000],
  rewardCooldownSeconds: ["int", 0, 86400], rewardShowWhenRemainingAtMost: ["int", 0, 1000],
  rewardSessionTtlSeconds: ["int", 30, 3600], reservationTtlSeconds: ["int", 60, 86400],
  minAdWatchSeconds: ["int", 0, 120], statusPollIntervalMs: ["int", 500, 10000], statusPollTimeoutMs: ["int", 5000, 120000],
  rewardVerification: ["enum", ["ssv", "client"]],
};

/** Returns { value } or { error } for one field. Strings from env are coerced; wrong types from the API are rejected. */
function coerce(key, raw, { strict = false } = {}) {
  const spec = SCHEMA[key];
  if (!spec) return { error: "unknown setting" };
  const [type, a, b] = spec;
  if (type === "bool") {
    if (typeof raw === "boolean") return { value: raw };
    if (!strict && typeof raw === "string" && /^(true|false|1|0|yes|no|on|off)$/i.test(raw)) return { value: /^(true|1|yes|on)$/i.test(raw) };
    return { error: "must be boolean" };
  }
  if (type === "int") {
    const n = typeof raw === "number" ? raw : (!strict && typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN);
    if (!Number.isInteger(n)) return { error: "must be an integer" };
    if (n < a || n > b) return { error: `must be between ${a} and ${b}` };
    return { value: n };
  }
  if (type === "enum") return a.includes(raw) ? { value: raw } : { error: `must be one of ${a.join(", ")}` };
  return { error: "bad schema" };
}

/** Lenient (env / stored docs): invalid entries are ignored so a typo can never break downloads. */
function parseLenient(obj) {
  const out = {};
  for (const k of Object.keys(SCHEMA)) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== "") {
      const r = coerce(k, obj[k]);
      if (r.error === undefined) out[k] = r.value;
    }
  }
  return out;
}

/** Strict (admin API input): returns { patch, errors }. `null` means "remove override". */
function parseStrict(obj) {
  const patch = {}, errors = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === null) { if (SCHEMA[k]) patch[k] = null; else errors[k] = "unknown setting"; continue; }
    const r = coerce(k, v, { strict: true });
    if (r.error) errors[k] = r.error; else patch[k] = r.value;
  }
  return { patch, errors };
}

module.exports = { DEFAULT_LIMITS, SCHEMA, parseLenient, parseStrict };
