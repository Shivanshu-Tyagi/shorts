/**
 * External downloader provider client (RapidAPI "social-download-all-in-one").
 *
 * BILLING RULES ENFORCED HERE (this is the only place that talks to the provider):
 *  - bounded attempts (PROVIDER_MAX_ATTEMPTS, default 2; the old code did 3 here
 *    and the worker repeated the whole thing again),
 *  - retry ONLY on network error / timeout / 5xx; never on 4xx or 429,
 *  - hard total budget per operation, circuit breaker on repeated failures,
 *  - every HTTP attempt is counted + timed (metrics + structured events),
 *  - API key lives only in a request header; never logged.
 *
 * Uses Node's built-in fetch (undici) -> keep-alive connection reuse by default
 * and native AbortSignal timeouts.
 */
const { AppError } = require("../utils/errors");
const { createBreaker } = require("../utils/circuitBreaker");
const logger = require("../utils/logger");
const { config: defaultConfig } = require("../config");
const { metrics: defaultMetrics } = require("./metrics.service");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UNAVAILABLE_RE = /(private|not found|unavailable|deleted|removed|no longer|does not exist|login required|age[- ]restrict|copyright)/i;

/** Pure: validate + normalise a provider payload. Throws AppError. */
function parseProviderResponse(data, qualityPreference) {
  if (!data || typeof data !== "object") throw new AppError("PROVIDER_INVALID_RESPONSE");
  if (data.error === true) {
    const msg = String(data.message || data.error_message || "");
    throw new AppError(UNAVAILABLE_RE.test(msg) ? "VIDEO_UNAVAILABLE" : "PROVIDER_ERROR");
  }
  if (!Array.isArray(data.medias)) {
    if (data.medias === undefined || data.medias === null) throw new AppError("NO_MEDIA");
    throw new AppError("PROVIDER_INVALID_RESPONSE");
  }
  const videos = data.medias.filter((m) => m && m.type === "video" && typeof m.url === "string" && m.url);
  if (!videos.length) throw new AppError("NO_MEDIA");

  // Same preference order as the original controller.
  let selected = null;
  for (const q of qualityPreference) { selected = videos.find((v) => v.quality === q); if (selected) break; }
  selected = selected || videos[0];

  let u;
  try { u = new URL(selected.url); } catch { throw new AppError("PROVIDER_INVALID_RESPONSE"); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new AppError("PROVIDER_INVALID_RESPONSE");

  const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const dur = Number(data.duration);
  return {
    title: str(data.title, 500) || "Untitled",
    thumbnail: str(data.thumbnail, 2048),
    duration: Number.isFinite(dur) && dur > 0 ? dur : 0,
    selected: { url: selected.url, quality: str(selected.quality, 40) || null, extension: str(selected.extension, 10) || null },
    formats: data.medias.slice(0, 20).filter(Boolean).map((m) => ({
      type: str(m.type, 20) || null, quality: str(m.quality, 40) || null, extension: str(m.extension, 10) || null,
    })),
  };
}

function createProviderClient({
  config = defaultConfig, metrics = defaultMetrics, fetchImpl = globalThis.fetch,
  now = Date.now, sleepFn = sleep, random = Math.random,
} = {}) {
  const p = config.provider;
  const breaker = createBreaker({ threshold: p.breakerThreshold, cooldownMs: p.breakerCooldownMs, now });

  async function attempt(url, signal, attemptNo) {
    metrics.inc("external_api_call_started");
    if (attemptNo > 1) metrics.inc("external_api_retry");
    logger.event("external_api_call_started", { attempt: attemptNo });
    const t0 = process.hrtime.bigint();
    const ms = () => Number(process.hrtime.bigint() - t0) / 1e6;
    try {
      const res = await fetchImpl(p.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-rapidapi-key": p.apiKey, "x-rapidapi-host": p.hostHeader },
        body: JSON.stringify({ url }),
        signal: AbortSignal.any([AbortSignal.timeout(p.timeoutMs), signal].filter(Boolean)),
      });
      const latency = ms();
      metrics.observe("provider_latency", latency);
      logger.event("external_api_call_completed", { attempt: attemptNo, status: res.status, ms: Math.round(latency) });
      return res;
    } catch (err) {
      metrics.observe("provider_latency", ms());
      const timedOut = err && (err.name === "TimeoutError" || err.name === "AbortError");
      const e = new AppError(timedOut ? "PROVIDER_TIMEOUT" : "PROVIDER_ERROR", undefined, { cause: err });
      e.retryable = true;
      logger.warn("external_api_call_failed", { attempt: attemptNo, reason: timedOut ? "timeout" : (err && err.code) || "network" });
      throw e;
    }
  }

  /** One billed "operation": up to maxAttempts HTTP calls. */
  async function fetchVideo(providerUrl, { signal } = {}) {
    if (!p.endpoint || !p.apiKey) throw new AppError("PROVIDER_AUTH");
    if (!breaker.allow()) {
      metrics.inc("provider_breaker_rejected");
      throw new AppError("PROVIDER_UNAVAILABLE", undefined, { retryAfterSec: breaker.retryAfterSec() });
    }
    const deadline = now() + p.totalBudgetMs;
    let lastErr;
    for (let i = 1; i <= p.maxAttempts; i++) {
      try {
        const res = await attempt(providerUrl, signal, i);
        if (res.status === 429) {
          const ra = parseInt(res.headers.get("retry-after"), 10);
          breaker.failure(); metrics.inc("external_api_failed");
          throw new AppError("PROVIDER_RATE_LIMITED", undefined, { retryAfterSec: Number.isFinite(ra) ? Math.min(ra, 120) : 30 });
        }
        if (res.status === 401 || res.status === 403) {
          breaker.failure(); metrics.inc("external_api_failed");
          logger.error("provider_auth_failed", { status: res.status });
          throw new AppError("PROVIDER_AUTH");
        }
        if (res.status >= 500) {
          const e = new AppError("PROVIDER_ERROR"); e.retryable = res.status !== 501; throw e;
        }
        if ([400, 404, 410, 422].includes(res.status)) {
          breaker.success(); // provider is healthy; this video is the problem
          metrics.inc("external_api_video_unavailable");
          throw new AppError("VIDEO_UNAVAILABLE");
        }
        if (!res.ok) throw new AppError("PROVIDER_ERROR");
        let data;
        try { data = await res.json(); } catch { throw new AppError("PROVIDER_INVALID_RESPONSE"); }
        const parsed = parseProviderResponse(data, config.downloader.qualityPreference);
        breaker.success();
        return parsed;
      } catch (err) {
        lastErr = err instanceof AppError ? err : new AppError("PROVIDER_ERROR", undefined, { cause: err });
        const out = lastErr.code;
        if (["NO_MEDIA", "VIDEO_UNAVAILABLE"].includes(out)) { breaker.success(); throw lastErr; }
        if (["PROVIDER_INVALID_RESPONSE"].includes(out)) { metrics.inc("external_api_failed"); throw lastErr; }
        if (!lastErr.retryable || i === p.maxAttempts) break;
        const backoff = p.retryBaseMs * 2 ** (i - 1) * (0.75 + random() * 0.5);
        if (now() + backoff >= deadline) break;
        await sleepFn(backoff);
      }
    }
    breaker.failure();
    metrics.inc("external_api_failed");
    throw lastErr;
  }

  return { fetchVideo, breaker, status: () => breaker.state() };
}

// ---- backwards-compatible default instance + legacy export ----------------------------------
let _default;
const getProvider = () => (_default ||= createProviderClient());
/** @deprecated legacy raw-response helper kept for compatibility; prefer download.service. */
exports.getVideoInfo = async (url) => {
  const raw = await getProvider().fetchVideo(url);
  return { title: raw.title, thumbnail: raw.thumbnail, duration: raw.duration,
    medias: [{ type: "video", url: raw.selected.url, quality: raw.selected.quality }] };
};
exports.createProviderClient = createProviderClient;
exports.parseProviderResponse = parseProviderResponse;
exports.getProvider = getProvider;
