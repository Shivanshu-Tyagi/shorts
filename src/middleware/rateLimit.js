/**
 * Small fixed-window in-memory rate limiter (no dependency).
 * Per-process by design. Behind a reverse proxy set TRUST_PROXY so req.ip is the
 * real client; otherwise every user shares the proxy's IP bucket.
 */
const { AppError, sendError } = require("../utils/errors");

function createRateLimiter({ windowMs, max, keyFn, now = Date.now }) {
  const buckets = new Map();
  const sweep = setInterval(() => {
    const t = now();
    for (const [k, b] of buckets) if (b.reset <= t) buckets.delete(k);
  }, Math.max(windowMs, 1000));
  if (sweep.unref) sweep.unref();

  const mw = (req, res, next) => {
    const key = keyFn(req);
    if (!key) return next();
    const t = now();
    let b = buckets.get(key);
    if (!b || b.reset <= t) { b = { count: 0, reset: t + windowMs }; buckets.set(key, b); }
    b.count += 1;
    if (b.count > max) {
      sendError(res, new AppError("RATE_LIMITED", undefined, { retryAfterSec: Math.max(1, Math.ceil((b.reset - t) / 1000)) }));
      return;
    }
    next();
  };
  mw.__buckets = buckets;
  mw.__stop = () => clearInterval(sweep);
  return mw;
}

const deviceKey = (req) => {
  const id = (req.body && req.body.deviceId) || (req.query && req.query.deviceId);
  return typeof id === "string" && id ? `dev:${id.slice(0, 128)}` : null;
};

function downloadLimiters(config) {
  const { windowMs, perDevice, perIp } = config.rateLimit;
  return [
    createRateLimiter({ windowMs, max: perIp, keyFn: (req) => (req.ip ? `ip:${req.ip}` : null) }),
    createRateLimiter({
      windowMs, max: perDevice,
      keyFn: deviceKey,
    }),
  ];
}

/** Quota/reward endpoints are polled by the apps (status after an ad), so they get their own, larger buckets. */
function quotaLimiters(config) {
  const { windowMs, perDevice, perIp } = config.rateLimit;
  return [
    createRateLimiter({ windowMs, max: perIp * 2, keyFn: (req) => (req.ip ? `qip:${req.ip}` : null) }),
    createRateLimiter({ windowMs, max: perDevice * 4, keyFn: (req) => { const k = deviceKey(req); return k ? `q${k}` : null; } }),
  ];
}

module.exports = { createRateLimiter, downloadLimiters, quotaLimiters };
