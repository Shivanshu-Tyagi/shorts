/**
 * GET /api/ads/ssv  - AdMob server-side verification callback (called by Google, not by the apps).
 *  400  signature/params invalid            -> nothing is granted
 *  503  keys/DB temporarily unavailable     -> Google retries
 *  200  verified; body.status tells what happened (granted | already_granted | expired | unknown_session | ad_unit_mismatch | invalid)
 */
const container = require("../services/container");
const { adUnitMatches } = require("../services/adSsv");
const { sendError } = require("../utils/errors");
const logger = require("../utils/logger");

exports.handleSsv = async (req, res) => {
  try {
    const raw = (req.originalUrl || "").split("?")[1] || "";   // must be the RAW query string (it is what Google signed)
    const p = await container.getSsvVerifier()(raw);
    const result = await container.getQuotaService().grantByNonce({
      deviceId: p.user_id, nonce: p.custom_data, txId: p.transaction_id, adUnit: p.ad_unit,
      expectedAdUnitCheck: (rewarded) => rewarded.enabled && adUnitMatches(rewarded.unitId, p.ad_unit),
    });
    logger.event("ssv_processed", { status: result.status, appId: result.appId });
    return res.status(200).json({ success: result.status === "granted" || result.status === "already_granted", status: result.status });
  } catch (err) { return sendError(res, err); }
};
