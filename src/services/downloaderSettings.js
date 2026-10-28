/**
 * Client-facing downloader settings. ONLY real, enforced values are exposed.
 * Never include: API keys, provider endpoint/host, tokens, AWS/Mongo details.
 */
const { config: defaultConfig } = require("../config");
const { PLATFORMS } = require("../utils/videoUrl");

function providerStatus(provider, config) {
  if (!config.provider.endpoint || !config.provider.apiKey) return "unavailable";
  const s = provider ? provider.status() : "closed";
  return s === "open" ? "unavailable" : s === "half-open" ? "degraded" : "available";
}

function buildDownloaderSettings({ config = defaultConfig, provider = null } = {}) {
  const d = config.downloader;
  return {
    enabled: d.enabled,
    supportedPlatforms: Object.entries(PLATFORMS).map(([id, p]) => ({
      id, name: p.name, domains: p.domains, enabled: d.enabled && !d.disabledPlatforms.includes(id),
    })),
    requireAppId: d.requireAppId,
    maxUrlLength: d.maxUrlLength,
    qualityPreference: [...d.qualityPreference],
    rateLimit: { windowSeconds: Math.round(config.rateLimit.windowMs / 1000), maxRequestsPerDevice: config.rateLimit.perDevice },
    provider: { status: providerStatus(provider, config) },
  };
}

/** Never let a settings-build problem break the existing ads/app-config response. */
function safeDownloaderSettings() {
  try {
    let provider = null;
    try { provider = require("./rapidapi.service").getProvider(); } catch { /* status falls back */ }
    return buildDownloaderSettings({ provider });
  } catch {
    return { enabled: true };
  }
}

module.exports = { buildDownloaderSettings, safeDownloaderSettings };
