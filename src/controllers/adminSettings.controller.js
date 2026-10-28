/**
 * GET/PUT /api/internal/settings/:appId   (header: x-admin-token = ADMIN_TOKEN; 404 if ADMIN_TOKEN is unset)
 * PUT body: { "downloadLimits": { "freeDownloads": 3, "rewardedDownloads": 3, "maxRewardedAdsPerDay": null }, "rewarded": { "enabled": true, "unitId": "ca-app-pub-.../..." } }
 * `null` removes an override (falls back to env/default).
 */
const crypto = require("crypto");
const container = require("../services/container");
const { config } = require("../config");
const { AppError, sendError } = require("../utils/errors");

const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const guard = (req) => {
  if (!config.adminToken) throw new AppError("NOT_FOUND");
  if (!eq(req.get("x-admin-token") || "", config.adminToken)) throw new AppError("UNAUTHORIZED");
};
const view = (appId, settings, r) => ({ appId, version: r.version, downloadLimits: r.limits, rewarded: r.rewarded, enforced: settings.isEnforced(r) });

exports.getSettings = async (req, res) => {
  try {
    guard(req);
    const s = container.getAppSettings();
    return res.json({ success: true, data: view(req.params.appId, s, await s.resolve(req.params.appId)) });
  } catch (err) { return sendError(res, err); }
};

exports.putSettings = async (req, res) => {
  try {
    guard(req);
    const s = container.getAppSettings();
    const b = req.body && typeof req.body === "object" ? req.body : {};
    const r = await s.update(req.params.appId, { downloadLimits: b.downloadLimits, rewarded: b.rewarded });
    return res.json({ success: true, message: "Settings updated.", data: view(req.params.appId, s, r) });
  } catch (err) { return sendError(res, err); }
};
