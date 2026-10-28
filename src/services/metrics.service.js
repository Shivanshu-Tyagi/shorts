/**
 * In-process counters + latency histograms. Cheap, no deps.
 * Per-process by design; in a multi-instance deployment sum the counters
 * across instances (or scrape each instance).
 */
const MAX_SAMPLES = 2000;

function createMetrics(costPerCallUsd = null) {
  const counters = new Map();
  const samples = new Map();

  const inc = (name, n = 1) => counters.set(name, (counters.get(name) || 0) + n);
  const get = (name) => counters.get(name) || 0;
  const observe = (name, ms) => {
    let arr = samples.get(name);
    if (!arr) samples.set(name, (arr = []));
    arr.push(ms);
    if (arr.length > MAX_SAMPLES) arr.shift();
  };
  const pct = (sorted, p) =>
    sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : null;
  const summarize = (arr) => {
    const s = [...arr].sort((a, b) => a - b);
    const sum = s.reduce((a, b) => a + b, 0);
    const r = (x) => (x == null ? null : Math.round(x * 100) / 100);
    return { count: s.length, avgMs: r(s.length ? sum / s.length : null), p50Ms: r(pct(s, 50)), p95Ms: r(pct(s, 95)), maxMs: r(s[s.length - 1] ?? null) };
  };

  function snapshot() {
    const received = get("download_request_received");
    const hits = get("database_cache_hit");
    const calls = get("external_api_call_started");
    const latency = {};
    for (const [k, v] of samples) latency[k] = summarize(v);
    return {
      counters: Object.fromEntries(counters),
      latency,
      derived: {
        cacheHitPercent: received ? Math.round((hits / received) * 10000) / 100 : null,
        externalCallsPerRequest: received ? Math.round((calls / received) * 1000) / 1000 : null,
        estimatedProviderCostUsd:
          costPerCallUsd == null ? null : Math.round(calls * costPerCallUsd * 1e6) / 1e6,
      },
    };
  }
  const reset = () => { counters.clear(); samples.clear(); };
  return { inc, get, observe, snapshot, reset };
}

module.exports = { createMetrics, metrics: createMetrics(require("../config").config.provider.costPerCallUsd) };
