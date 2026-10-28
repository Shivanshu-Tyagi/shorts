/**
 * Additive fields for the two settings endpoints (/api/ads-config, /api/vydo-ads-config).
 * Never throws: if anything fails the endpoints fall back to exactly their previous response.
 */
const { APPS } = require("../config/apps");
const { DEVICE_ID_RE } = require("./quota.service");
const logger = require("../utils/logger");

async function buildAppExtras(appId, req) {
  const fallback = { rewarded: { ...APPS[appId].rewarded }, downloadLimits: undefined, downloadQuota: undefined };
  try {
    const container = require("./container");
    const settings = container.getAppSettings();
    const resolved = await settings.resolve(appId);
    const extras = { rewarded: resolved.rewarded, downloadLimits: settings.publicView(resolved), downloadQuota: undefined };
    const deviceId = (req && req.query && req.query.deviceId) || (req && typeof req.get === "function" && req.get("x-device-id")) || null;
    if (typeof deviceId === "string" && DEVICE_ID_RE.test(deviceId)) {
      extras.downloadQuota = await container.getQuotaService().getState({ deviceId, appId }).catch(() => undefined);
    }
    return extras;
  } catch (e) {
    logger.error("settings_extras_failed", { appId, message: String(e && e.message).slice(0, 120) });
    return fallback;
  }
}
module.exports = { buildAppExtras };
