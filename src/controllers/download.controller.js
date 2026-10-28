/**
 * POST /api/download
 * Thin HTTP layer. ALL decision logic (DB-first reuse, dedupe, provider calls) lives in
 * services/download.service.js, so there is exactly one path to the paid provider.
 *
 * Response contract is unchanged:  { success, message, data: <download row> }
 * Errors:                          { success:false, code, message }  (code is additive)
 */
const container = require("../services/container");
const { config } = require("../config");
const logger = require("../utils/logger");
const { AppError, sendError, toAppError } = require("../utils/errors");

async function handleDownload(req, res) {
  const t0 = process.hrtime.bigint();
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const { url, deviceId } = body;
  const appId = body.appId === undefined ? null : body.appId;

  if (typeof url !== "string" || typeof deviceId !== "string" || !url || !deviceId || deviceId.length > 128 || (appId !== null && typeof appId !== "string")) {
    return sendError(res, new AppError("INVALID_REQUEST"));
  }

  let timer;
  try {
    const service = container.getDownloadService();
    const result = await Promise.race([
      service.requestDownload({ url, deviceId, appId }),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new AppError("REQUEST_TIMEOUT")), config.downloader.requestDeadlineMs); }),
    ]);
    clearTimeout(timer);
    if (res.writableEnded || res.destroyed) return; // client went away; shared work continues for others
    res.set("X-Response-Time-Ms", (Number(process.hrtime.bigint() - t0) / 1e6).toFixed(1));
    return res.status(200).json({ success: true, message: result.message, data: result.row, ...(result.quota ? { quota: result.quota } : {}) });
  } catch (err) {
    clearTimeout(timer);
    if (res.writableEnded || res.destroyed) return;
    const e = toAppError(err);
    if (e.code === "INTERNAL" || e.code === "DB_ERROR") {
      logger.error("download_internal_error", { code: e.code, message: String((err && err.message) || "").slice(0, 200) });
    }
    return sendError(res, e);
  }
}

exports.handleDownload = handleDownload;
exports.downloadVideo = handleDownload;
