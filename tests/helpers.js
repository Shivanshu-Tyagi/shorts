/** Shared test harness: fake paid provider (real local HTTP server) + memory stores. */
process.env.NODE_ENV = "test";
const http = require("http");
const { loadConfig } = require("../src/config");
const { createMetrics } = require("../src/services/metrics.service");
const logger = require("../src/utils/logger");
const { createMemoryStores } = require("../src/repositories/memory");
const { createProviderClient } = require("../src/services/rapidapi.service");
const { createDownloadService } = require("../src/services/download.service");
const { createAppSettings } = require("../src/services/appSettings");
const { createQuotaService } = require("../src/services/quota.service");

const REWARDED_UNIT = "ca-app-pub-1111111111111111/2222222222";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fake RapidAPI. behavior(req, body, callNo) -> {status?, json?, delayMs?, headers?} */
async function startFakeProvider(behavior) {
  const state = { calls: 0, bodies: [], headersSeen: [], behavior };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      state.calls += 1;
      const n = state.calls;
      let body = {}; try { body = JSON.parse(raw); } catch {}
      state.bodies.push(body);
      state.headersSeen.push(req.headers);
      const r = (await state.behavior(req, body, n)) || {};
      if (r.delayMs) await sleep(r.delayMs);
      res.writeHead(r.status || 200, { "Content-Type": "application/json", ...(r.headers || {}) });
      res.end(typeof r.json === "string" ? r.json : JSON.stringify(r.json ?? {}));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  state.url = `http://127.0.0.1:${server.address().port}/api`;
  state.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  return state;
}

/** Default happy provider: title/medias derived from the submitted URL. */
const okProvider = (extra = {}) => (req, body, n) => ({
  delayMs: extra.delayMs || 0,
  json: {
    error: false,
    title: `Title of ${body.url}`,
    thumbnail: "https://img.example.com/t.jpg",
    duration: 12,
    medias: [
      { type: "video", quality: "watermark", url: `https://cdn.example.com/wm/${n}.mp4`, extension: "mp4" },
      { type: "video", quality: "hd_no_watermark", url: `https://cdn.example.com/hd/${n}.mp4?x=1`, extension: "mp4" },
      { type: "audio", url: "https://cdn.example.com/a.mp3", extension: "mp3" },
    ],
  },
});

async function buildHarness({ behavior = okProvider(), env = {}, storeLatencyMs = 0, queueReady = true, now } = {}) {
  const fake = await startFakeProvider(behavior);
  const config = loadConfig({
    RAPID_API_HOST: fake.url, RAPID_API_KEY: "test-secret-key-123",
    PROVIDER_TIMEOUT_MS: "1000", PROVIDER_MAX_ATTEMPTS: "2", PROVIDER_RETRY_BASE_MS: "10",
    PROVIDER_BREAKER_THRESHOLD: "50", LOCK_POLL_MS: "20", TRANSIENT_COOLDOWN_MS: "250",
    NEGATIVE_CACHE_TTL_SECONDS: "300", ...env,
  });
  const metrics = createMetrics();
  const stores = createMemoryStores({ latencyMs: storeLatencyMs, ...(now ? { now } : {}) });
  const q = { ready: queueReady, jobs: [], seen: new Set() };
  const queue = {
    isReady: () => q.ready,
    enqueue: async (name, data, opts) => {
      if (q.failEnqueue) throw new Error("redis down");
      if (q.seen.has(opts.jobId)) return null; // BullMQ ignores duplicate custom jobIds
      q.seen.add(opts.jobId); q.jobs.push({ name, data, opts });
      return { id: opts.jobId };
    },
  };
  const provider = createProviderClient({ config, metrics });
  const appSettings = createAppSettings({ store: stores.settings, config: { ...config, settingsCacheTtlMs: 0 }, ...(now ? { now } : {}) });
  const quota = createQuotaService({ quotas: stores.quotas, settings: appSettings, metrics, ...(now ? { now } : {}) });
  const mk = () => createDownloadService({ assets: stores.assets, rows: stores.rows, provider, queue, config, metrics, logger, quota, ...(now ? { now } : {}) });
  const service = mk();
  return {
    fake, config, metrics, stores, queue: q, provider, service, newService: mk, appSettings, quota,
    close: () => fake.close(),
    /** Turn the quota feature on (a rewarded ad unit must exist, exactly like in production). */
    async enableQuota(appId = "shorts", limits = {}) {
      await appSettings.update(appId, { rewarded: { enabled: true, unitId: REWARDED_UNIT }, downloadLimits: limits });
    },
    /** Simulate the worker finishing a job (same ordering as videoProcessor). */
    async completeJob(key, cdn = `https://cdn.test/${key.replace(/\W/g, "_")}.mp4`) {
      const storage = { fileKey: "videos/x.mp4", cdnUrl: cdn, thumbnailKey: "t", thumbnailCdn: cdn + ".jpg", storedAt: Date.now() };
      await stores.assets.update(key, { status: "ready", storage, sourceMedia: null, failure: null });
      await stores.rows.completeByAsset(key, { status: "ready", downloadUrl: cdn, cdnUrl: cdn, thumbnailCdn: storage.thumbnailCdn });
    },
  };
}

module.exports = { buildHarness, startFakeProvider, okProvider, sleep, REWARDED_UNIT };
