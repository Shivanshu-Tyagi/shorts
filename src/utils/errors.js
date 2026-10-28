/**
 * One error type for the whole downloader pipeline.
 * `message` is ALWAYS client-safe; internal detail goes in `cause`/logs only.
 */
const CATALOG = {
  INVALID_REQUEST: [400, "url and deviceId required"], // legacy message preserved
  INVALID_URL: [400, "Invalid video URL"],
  UNSUPPORTED_PLATFORM: [400, "This platform is not supported"],
  NO_MEDIA: [400, "No media found from API"], // legacy status + message preserved
  VIDEO_UNAVAILABLE: [404, "This video is unavailable (it may be private or deleted)"],
  DOWNLOADS_DISABLED: [503, "Downloads are temporarily disabled"],
  RATE_LIMITED: [429, "Too many requests, please try again shortly"],
  REQUEST_TIMEOUT: [504, "The request took too long, please try again"],
  PROVIDER_RATE_LIMITED: [503, "Service is busy, please try again shortly"],
  PROVIDER_TIMEOUT: [504, "The download service timed out, please try again"],
  PROVIDER_ERROR: [502, "The download service failed, please try again"],
  PROVIDER_INVALID_RESPONSE: [502, "The download service returned an invalid response"],
  PROVIDER_UNAVAILABLE: [503, "The download service is temporarily unavailable"],
  PROVIDER_AUTH: [503, "The download service is temporarily unavailable"],
  QUEUE_UNAVAILABLE: [503, "Processing queue is unavailable, please try again"],
  SERVICE_BUSY: [503, "Service is busy, please try again shortly"],
  DB_ERROR: [503, "Service temporarily unavailable"],
  DOWNLOAD_UNAVAILABLE: [502, "The video file could not be downloaded"],
  DOWNLOAD_LIMIT_REACHED: [403, "Download limit reached. Watch a rewarded ad to unlock more downloads."],
  REWARD_NOT_ELIGIBLE: [403, "A reward is not available right now"],
  REWARD_SESSION_NOT_FOUND: [404, "Reward session not found"],
  REWARD_SESSION_EXPIRED: [410, "Reward session expired"],
  REWARD_CLIENT_CLAIM_DISABLED: [403, "Reward must be verified by the ad network"],
  SSV_INVALID: [400, "Invalid reward verification"],
  UNAUTHORIZED: [401, "Unauthorized"],
  NOT_FOUND: [404, "Not found"],
  INTERNAL: [500, "Download failed"], // legacy message preserved
};

class AppError extends Error {
  constructor(code, message, opts = {}) {
    const [status, safe] = CATALOG[code] || CATALOG.INTERNAL;
    super(message || safe);
    this.name = "AppError";
    this.code = CATALOG[code] ? code : "INTERNAL";
    this.status = opts.status || status;
    this.retryAfterSec = opts.retryAfterSec || null;
    this.extra = opts.extra || null; // additive, client-safe fields (e.g. { quota })
    if (opts.cause) this.cause = opts.cause;
  }
}

// Failures that will not change if we simply try again soon (cacheable "negatively").
const PERMANENT_CODES = new Set([
  "VIDEO_UNAVAILABLE",
  "NO_MEDIA",
  "DOWNLOAD_UNAVAILABLE",
]);

const isMongoError = (e) =>
  !!e && typeof e.name === "string" && /^Mongo|^MongoServer|MongooseError|CastError/.test(e.name);

/** Normalise any thrown value into an AppError (never leaks internals). */
function toAppError(err) {
  if (err instanceof AppError) return err;
  if (isMongoError(err)) return new AppError("DB_ERROR", undefined, { cause: err });
  return new AppError("INTERNAL", undefined, { cause: err });
}

function sendError(res, err) {
  const e = toAppError(err);
  if (res.headersSent) return e;
  if (e.retryAfterSec) res.set("Retry-After", String(e.retryAfterSec));
  res.status(e.status).json({ success: false, code: e.code, message: e.message, ...(e.extra || {}) });
  return e;
}

module.exports = { AppError, PERMANENT_CODES, toAppError, sendError, CATALOG };
