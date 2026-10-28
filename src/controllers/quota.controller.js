/**
 * Download quota + rewarded-ad endpoints.
 *   GET  /api/quota?deviceId=&appId=          current state + configuration
 *   POST /api/quota/reward/start  {deviceId, appId}          issue a one-time ad session (nonce)
 *   POST /api/quota/reward/claim  {deviceId, appId, nonce}   report/confirm the session outcome
 */
const container = require("../services/container");
const { AppError, sendError } = require("../utils/errors");

const str = (v) => (typeof v === "string" ? v : undefined);

async function withConfig(appId, quotaState) {
  const settings = container.getAppSettings();
  return settings.publicView(await settings.resolve(appId));
} 

exports.getQuota = async (req, res) => {
  try {
    const { deviceId, appId } = { deviceId: str(req.query.deviceId), appId: str(req.query.appId) };
    const state = await container.getQuotaService().getState({ deviceId, appId });
    return res.status(200).json({ success: true, message: "Quota fetched successfully.", data: state, config: await withConfig(appId) });
  } catch (err) { return sendError(res, err); }
};

exports.startReward = async (req, res) => {
  try {
    const b = req.body && typeof req.body === "object" ? req.body : {};
    const quota = container.getQuotaService();
    const session = await quota.startReward({ deviceId: str(b.deviceId), appId: str(b.appId) });
    return res.status(200).json({ success: true, message: "Reward session started.", data: session, quota: await quota.getState({ deviceId: b.deviceId, appId: b.appId }) });
  } catch (err) { return sendError(res, err); }
};

exports.claimReward = async (req, res) => {
  try {
    const b = req.body && typeof req.body === "object" ? req.body : {};
    if (typeof b.nonce !== "string" || b.nonce.length < 16 || b.nonce.length > 128) throw new AppError("INVALID_REQUEST", "nonce required");
    const { quota, ...data } = await container.getQuotaService().claim({ deviceId: str(b.deviceId), appId: str(b.appId), nonce: b.nonce });
    const message = data.sessionState === "granted" ? "Reward unlocked." : data.sessionState === "expired" ? "Reward session expired." : "Reward pending verification.";
    return res.status(200).json({ success: true, message, data, quota });
  } catch (err) { return sendError(res, err); }
};
