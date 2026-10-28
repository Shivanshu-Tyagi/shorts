const crypto = require("crypto");
const { config } = require("../config");
const { metrics } = require("../services/metrics.service");
const { getProvider } = require("../services/rapidapi.service");

const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** GET /api/internal/download-metrics  (header: x-metrics-token). 404 unless METRICS_TOKEN is set. */
exports.getMetrics = (req, res) => {
  if (!config.metricsToken) return res.status(404).json({ success: false, message: "Not found" });
  if (!safeEq(req.get("x-metrics-token") || "", config.metricsToken))
    return res.status(401).json({ success: false, message: "Unauthorized" });
  return res.json({ success: true, data: { ...metrics.snapshot(), providerCircuit: getProvider().status() } });
};
