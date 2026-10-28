/**
 * Central, validated configuration for the downloader pipeline.
 * Every value has a safe default; env vars only override.
 * Secrets (RAPID_API_KEY, AWS_*, MONGO_URL) are read here but are NEVER
 * exposed to clients or logs (see services/downloaderSettings.js, utils/logger.js).
 */
const int = (v, d, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return d;
  return Math.min(max, Math.max(min, n));
};
const num = (v, d) => {
  if (v === undefined || v === null || v === "") return d;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
};
const bool = (v, d) => {
  if (v === undefined || v === "") return d;
  return !["0", "false", "no", "off"].includes(String(v).toLowerCase());
};
const list = (v) =>
  String(v || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

function loadConfig(env = process.env) {
  const timeoutMs = int(env.PROVIDER_TIMEOUT_MS, 15000, { min: 1000, max: 120000 });
  const maxAttempts = int(env.PROVIDER_MAX_ATTEMPTS, 2, { min: 1, max: 5 });
  const retryBaseMs = int(env.PROVIDER_RETRY_BASE_MS, 500, { min: 0, max: 10000 });
  // Worst case wall-clock of ONE provider "operation" (all attempts + backoff).
  const totalBudgetMs =
    timeoutMs * maxAttempts + retryBaseMs * (2 ** maxAttempts) + 1000;

  return Object.freeze({
    env: env.NODE_ENV || "development",
    trustProxy: env.TRUST_PROXY || null,

    provider: Object.freeze({
      endpoint: env.RAPID_API_HOST || "", // legacy name: this holds the FULL endpoint URL
      hostHeader:
        env.RAPID_API_HOST_HEADER || "social-download-all-in-one.p.rapidapi.com",
      apiKey: env.RAPID_API_KEY || "",
      timeoutMs,
      maxAttempts, // total HTTP attempts per operation (1 = no retry)
      retryBaseMs,
      totalBudgetMs,
      breakerThreshold: int(env.PROVIDER_BREAKER_THRESHOLD, 5, { min: 1 }),
      breakerCooldownMs: int(env.PROVIDER_BREAKER_COOLDOWN_MS, 30000, { min: 1000 }),
      costPerCallUsd: env.PROVIDER_COST_PER_CALL_USD
        ? num(env.PROVIDER_COST_PER_CALL_USD, null)
        : null,
    }),

    reuse: Object.freeze({
      mediaUrlTtlMs: int(env.MEDIA_URL_TTL_SECONDS, 600, { min: 30 }) * 1000,
      negativeTtlMs: int(env.NEGATIVE_CACHE_TTL_SECONDS, 300, { min: 1 }) * 1000,
      transientCooldownMs: int(env.TRANSIENT_COOLDOWN_MS, 5000, { min: 0, max: 60000 }),
      assetCacheTtlMs: int(env.ASSET_CACHE_TTL_MS, 300000, { min: 0 }),
      assetCacheMax: int(env.ASSET_CACHE_MAX, 5000, { min: 10 }),
      processingStaleMs: int(env.PROCESSING_STALE_MS, 900000, { min: 60000 }),
      lockPollMs: int(env.LOCK_POLL_MS, 150, { min: 20, max: 2000 }),
      followerMaxWaitMs: int(env.FOLLOWER_MAX_WAIT_MS, totalBudgetMs + 5000, { min: 1000 }),
      lockTtlMs: totalBudgetMs + 5000,
    }),

    queue: Object.freeze({
      attempts: int(env.JOB_ATTEMPTS, 3, { min: 1, max: 10 }),
      backoffMs: int(env.JOB_BACKOFF_MS, 5000, { min: 0 }),
      concurrency: int(env.WORKER_CONCURRENCY, 1, { min: 1, max: 16 }),
      enqueueTimeoutMs: int(env.ENQUEUE_TIMEOUT_MS, 5000, { min: 500 }),
    }),

    media: Object.freeze({
      maxBytes: int(env.MAX_MEDIA_BYTES, 200 * 1024 * 1024, { min: 1024 }),
      timeoutMs: int(env.MEDIA_DOWNLOAD_TIMEOUT_MS, 30000, { min: 1000 }),
      maxRedirects: int(env.MEDIA_MAX_REDIRECTS, 3, { min: 0, max: 10 }),
      refreshMax: int(env.MEDIA_REFRESH_MAX, 1, { min: 0, max: 3 }),
    }),

    downloader: Object.freeze({
      enabled: bool(env.DOWNLOADER_ENABLED, true),
      // Old app builds do not send `appId`; they are not quota-limited. Flip to true after forcing an update.
      requireAppId: bool(env.REQUIRE_APP_ID, false),
      // YouTube was enabled in the shipped code (the block was commented out) -> default true.
      disabledPlatforms: Object.freeze(list(env.DISABLED_PLATFORMS)),
      extraHosts: Object.freeze(list(env.EXTRA_ALLOWED_HOSTS)),
      maxUrlLength: int(env.MAX_URL_LENGTH, 2048, { min: 64, max: 8192 }),
      requestDeadlineMs: int(env.REQUEST_DEADLINE_MS, totalBudgetMs + 10000, { min: 2000 }),
      qualityPreference: Object.freeze([
        "hd_no_watermark",
        "no_watermark",
        "watermark",
      ]),
    }),

    rateLimit: Object.freeze({
      windowMs: int(env.RATE_LIMIT_WINDOW_MS, 60000, { min: 1000 }),
      perDevice: int(env.RATE_LIMIT_PER_DEVICE, 20, { min: 1 }),
      perIp: int(env.RATE_LIMIT_PER_IP, 120, { min: 1 }),
    }),

    metricsToken: env.METRICS_TOKEN || "",
    adminToken: env.ADMIN_TOKEN || "",

    // Built-in DEFAULTS only. Resolution order at runtime: DB override > env > these (see services/appSettings.js).
    quotaEnv: Object.freeze({
      enabled: env.DL_QUOTA_ENABLED,
      freeDownloads: env.DL_FREE_DOWNLOADS,
      rewardedDownloads: env.DL_REWARDED_DOWNLOADS,
      rewardedAdsEnabled: env.DL_REWARDED_ADS_ENABLED,
      maxRewardedAdsPerDay: env.DL_MAX_REWARDED_ADS_PER_DAY,
      maxRewardedAdsTotal: env.DL_MAX_REWARDED_ADS_TOTAL,
      rewardCooldownSeconds: env.DL_REWARD_COOLDOWN_SECONDS,
      rewardShowWhenRemainingAtMost: env.DL_REWARD_SHOW_WHEN_REMAINING_AT_MOST,
      rewardSessionTtlSeconds: env.DL_REWARD_SESSION_TTL_SECONDS,
      reservationTtlSeconds: env.DL_RESERVATION_TTL_SECONDS,
      enforceWithoutRewardedAd: env.DL_ENFORCE_WITHOUT_REWARDED_AD,
      minAdWatchSeconds: env.DL_MIN_AD_WATCH_SECONDS,
      statusPollIntervalMs: env.DL_STATUS_POLL_INTERVAL_MS,
      statusPollTimeoutMs: env.DL_STATUS_POLL_TIMEOUT_MS,
    }),
    // Insecure client-confirmed rewards can only be switched on by an operator via env (never via the admin API).
    allowClientRewardVerification: bool(env.ALLOW_CLIENT_REWARD_VERIFICATION, false),
    settingsCacheTtlMs: int(env.SETTINGS_CACHE_TTL_MS, 30000, { min: 0 }),
    ssv: Object.freeze({
      keysUrl: env.ADMOB_SSV_KEYS_URL || "https://www.gstatic.com/admob/reward/verifier-keys.json",
      maxAgeMs: int(env.ADMOB_SSV_MAX_AGE_SECONDS, 3600, { min: 60 }) * 1000,
      keyCacheMs: int(env.ADMOB_SSV_KEY_CACHE_SECONDS, 86400, { min: 60 }) * 1000,
    }),
  });
}

module.exports = { loadConfig, config: loadConfig() };
