/**
 * Download orchestration: database-first reuse + minimum paid provider calls.
 *
 *   normalize -> asset lookup (cache/DB, legacy promotion) -> classify
 *     READY        -> reuse stored file         (0 provider calls)
 *     NEGATIVE     -> short-lived cached failure (0 provider calls)
 *     IN_PROGRESS  -> join the running job       (0 provider calls)
 *     REQUEUE      -> job lost, URL still fresh  (0 provider calls, re-enqueue)
 *     NEEDS_PROVIDER -> single-flight + lease lock -> ONE provider operation
 *
 * Everything infrastructure-specific is injected (stores, provider, queue), so the
 * decision logic is testable without Mongo/Redis/network.
 */
const crypto = require("crypto");
const { AppError, PERMANENT_CODES, toAppError } = require("../utils/errors");
const { normalizeVideoUrl } = require("../utils/videoUrl");
const { TTLCache } = require("../utils/ttlCache");
const { createSingleFlight } = require("../utils/singleFlight");

const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, mk) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(mk()), ms);
    p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
  });

/**
 * Best-effort expiry of a provider media URL. Uses explicit hints in the URL when
 * present (expires/exp/oe/X-Amz-Expires), never trusts more than the configured TTL.
 */
function estimateMediaExpiry(url, fetchedAt, ttlMs) {
  let exp = fetchedAt + ttlMs;
  try {
    const q = new URL(url).searchParams;
    const cands = [];
    for (const k of ["expires", "Expires", "exp", "e"]) {
      const v = Number(q.get(k)); if (v > 1e9 && v < 4e9) cands.push(v * 1000);
    }
    const oe = q.get("oe");
    if (oe && /^[0-9a-f]{6,8}$/i.test(oe)) cands.push(parseInt(oe, 16) * 1000);
    const amzD = q.get("X-Amz-Date"), amzE = Number(q.get("X-Amz-Expires"));
    if (amzD && amzE > 0 && /^\d{8}T\d{6}Z$/.test(amzD)) {
      const t = Date.parse(`${amzD.slice(0, 4)}-${amzD.slice(4, 6)}-${amzD.slice(6, 8)}T${amzD.slice(9, 11)}:${amzD.slice(11, 13)}:${amzD.slice(13, 15)}Z`);
      if (Number.isFinite(t)) cands.push(t + amzE * 1000);
    }
    for (const c of cands) exp = Math.min(exp, c);
  } catch { /* keep default */ }
  return Math.max(exp, fetchedAt + 30000); // never hand out an already-dead URL as "fresh"
}

function createDownloadService(deps) {
  const { assets, rows, provider, queue, config, metrics, logger } = deps;
  const quota = deps.quota || null; // optional: quota/reward feature
  const now = deps.now || Date.now;
  const sleep = deps.sleep || defaultSleep;
  const R = config.reuse;
  const cache = deps.cache || new TTLCache({ ttlMs: R.assetCacheTtlMs, max: R.assetCacheMax, now });
  const flights = deps.flights || createSingleFlight();
  const normOpts = {
    extraHosts: config.downloader.extraHosts,
    disabledPlatforms: config.downloader.disabledPlatforms,
    maxUrlLength: config.downloader.maxUrlLength,
  };

  // ---------------------------------------------------------------- asset state
  function classify(a, t = now()) {
    if (!a) return "NEEDS_PROVIDER";
    if (a.storage && a.storage.cdnUrl) return "READY";
    if (a.failure && a.failure.expiresAt > t) return "NEGATIVE";
    const lastActive = a.processingAt || a.queuedAt || 0;
    const active = (a.status === "queued" || a.status === "processing") && t - lastActive < R.processingStaleMs;
    if (active) return "IN_PROGRESS";
    if (a.sourceMedia && a.sourceMedia.url && a.sourceMedia.expiresAt > t) return "REQUEUE";
    return "NEEDS_PROVIDER";
  }

  function remember(a) {
    if (!a) return;
    if (a.storage && a.storage.cdnUrl) cache.set(a.key, a);
    else if (a.failure && a.failure.expiresAt > now()) cache.set(a.key, a, Math.min(a.failure.expiresAt - now(), R.negativeTtlMs));
    else cache.delete(a.key);
  }
  async function readAsset(key, { fresh = false } = {}) {
    if (!fresh) { const c = cache.get(key); if (c) return c; }
    const a = await assets.getByKey(key);
    remember(a);
    return a;
  }
  const errorFromFailure = (f) =>
    new AppError(f.code, undefined, { retryAfterSec: f.retryAfterSec || Math.max(1, Math.ceil((f.expiresAt - now()) / 1000)) });

  // ------------------------------------------------- coordination (lease + wait)
  /**
   * check(asset) -> {value} when the goal is already satisfied (or throws);
   * work(asset)  -> performed by exactly one leader at a time.
   * Followers poll the DB (cheap) -- never the provider -- and get the leader's result.
   * A crashed leader's lease expires by TTL, so nothing can block forever.
   */
  async function coordinate(key, check, work) {
    const owner = crypto.randomUUID();
    const deadline = now() + R.followerMaxWaitMs;
    for (;;) {
      let a = await readAsset(key, { fresh: true });
      let hit = check(a);
      if (hit) return { ...hit, leader: false };
      if (await assets.tryAcquireLock(key, owner, R.lockTtlMs)) {
        try {
          a = await readAsset(key, { fresh: true }); // double-checked: someone may have finished
          hit = check(a);
          if (hit) return { ...hit, leader: false };
          return { ...(await work(a)), leader: true };
        } finally {
          await assets.releaseLock(key, owner).catch(() => {});
        }
      }
      if (now() >= deadline) throw new AppError("SERVICE_BUSY");
      metrics.inc("lock_wait_poll");
      await sleep(R.lockPollMs);
    }
  }

  function checkForDownload(a) {
    const st = classify(a);
    if (st === "READY" || st === "IN_PROGRESS") return { asset: a };
    if (st === "NEGATIVE") throw errorFromFailure(a.failure);
    return null; // NEEDS_PROVIDER / REQUEUE -> a leader must act
  }

  // ----------------------------------------------------------------- job queue
  async function enqueue(asset) {
    const jobId = `v_${sha1(asset.key).slice(0, 24)}_${asset.generation}`;
    try {
      await withTimeout(
        queue.enqueue(
          "process-video",
          { assetKey: asset.key, generation: asset.generation, fileKey: asset.fileKey },
          {
            jobId,
            attempts: config.queue.attempts,
            backoff: { type: "exponential", delay: config.queue.backoffMs },
            removeOnComplete: true,
            removeOnFail: { age: 86400, count: 1000 },
          }
        ),
        config.queue.enqueueTimeoutMs,
        () => new Error("enqueue timeout")
      );
    } catch (e) {
      throw new AppError("QUEUE_UNAVAILABLE", undefined, { cause: e });
    }
  }

  async function recordFailure(meta, existing, err) {
    try {
      const e = toAppError(err);
      // Infra/breaker conditions are not a property of THIS video -> do not cache per video.
      if (["PROVIDER_UNAVAILABLE", "PROVIDER_AUTH", "QUEUE_UNAVAILABLE", "DB_ERROR"].includes(e.code)) return;
      const permanent = PERMANENT_CODES.has(e.code);
      const ttl = permanent ? R.negativeTtlMs : Math.max(R.transientCooldownMs, Math.min((e.retryAfterSec || 0) * 1000, 60000));
      if (!(ttl > 0)) return;
      const failure = { code: e.code, permanent, at: now(), expiresAt: now() + ttl, retryAfterSec: e.retryAfterSec || null };
      if (existing) await assets.update(meta.key, { failure, status: "failed" });
      else await assets.create({ key: meta.key, platform: meta.platform, videoId: meta.videoId, canonicalUrl: meta.canonicalUrl, providerUrl: meta.providerUrl, status: "failed", failure });
      cache.delete(meta.key);
    } catch { /* never mask the original error */ }
  }

  // ------------------------------------------------ leader work: provider + save
  async function leaderWork(meta, existing) {
    const st = classify(existing);
    if (st === "REQUEUE") {
      const asset = await assets.update(meta.key, {
        status: "queued", queuedAt: now(), processingAt: null,
        generation: (existing.generation || 0) + 1, failure: null,
      });
      cache.delete(meta.key);
      await enqueue(asset);
      metrics.inc("job_requeued_without_provider");
      return { asset, providerCalled: false };
    }

    // Fail BEFORE spending money if we could not process the result anyway.
    if (!queue.isReady()) throw new AppError("QUEUE_UNAVAILABLE");

    let parsed;
    try {
      parsed = await provider.fetchVideo(meta.providerUrl);
    } catch (err) {
      await recordFailure(meta, existing, err);
      throw err;
    }
    metrics.inc("provider_operation_ok");

    const t = now();
    const patch = {
      platform: meta.platform, videoId: meta.videoId,
      canonicalUrl: meta.canonicalUrl, providerUrl: meta.providerUrl,
      title: parsed.title, thumbnail: parsed.thumbnail, duration: parsed.duration, formats: parsed.formats,
      status: "queued", queuedAt: t, processingAt: null,
      generation: ((existing && existing.generation) || 0) + 1,
      fileKey: (existing && existing.fileKey) || `videos/${crypto.randomUUID()}.mp4`,
      sourceMedia: { url: parsed.selected.url, quality: parsed.selected.quality, fetchedAt: t, expiresAt: estimateMediaExpiry(parsed.selected.url, t, R.mediaUrlTtlMs) },
      failure: null, lastValidatedAt: t,
      providerCalls: ((existing && existing.providerCalls) || 0) + 1,
    };
    let asset = existing ? await assets.update(meta.key, patch) : null;
    if (!asset) asset = (await assets.create({ key: meta.key, ...patch })).asset;
    cache.delete(meta.key);
    // Asset (with the paid-for URL) is persisted BEFORE enqueue: if the queue is down
    // the result is not lost and a later request re-enqueues without another provider call.
    await enqueue(asset);
    return { asset, providerCalled: true };
  }

  // -------------------------------------------------- legacy production data reuse
  async function promoteLegacy(meta) {
    if (!meta.legacySafe) return null;
    const row = await rows.findLegacyReady({ hosts: meta.legacyHosts, sourceId: meta.legacySourceId });
    if (!row || !row.cdnUrl) return null;
    const { asset } = await assets.create({
      key: meta.key, platform: meta.platform, videoId: meta.videoId,
      canonicalUrl: meta.canonicalUrl, providerUrl: meta.providerUrl,
      title: row.title || "Untitled", thumbnail: row.thumbnail || "", duration: row.duration || 0,
      status: "ready", fileKey: row.fileKey || null, legacy: true, lastValidatedAt: now(),
      storage: { fileKey: row.fileKey || null, cdnUrl: row.cdnUrl, thumbnailKey: null, thumbnailCdn: row.thumbnailCdn || null, storedAt: now() },
    });
    remember(asset);
    metrics.inc("legacy_promoted");
    return asset;
  }

  // ---------------------------------------------------------- per-device history
  const bestRow = (found) => {
    const rank = { ready: 0, pending: 1, processing: 1, failed: 2 };
    return [...found].sort((a, b) => rank[a.status] - rank[b.status])[0];
  };

  async function attachRow({ asset, meta, deviceId, originalUrl, isLeader, found, appId }) {
    const ready = !!(asset.storage && asset.storage.cdnUrl);
    const rank = { ready: 0, pending: 1, processing: 1, failed: 2 };
    const existing = bestRow(found);

    const state = ready
      ? { status: "ready", downloadUrl: asset.storage.cdnUrl, cdnUrl: asset.storage.cdnUrl, thumbnailCdn: asset.storage.thumbnailCdn || null }
      : { status: "pending", downloadUrl: (asset.sourceMedia && asset.sourceMedia.url) || null, fileKey: asset.fileKey || null };
    if (appId) state.appId = appId; // lets the worker settle this row's quota reservation

    if (existing && existing.status !== "failed") return { row: existing, kind: "existing" };
    if (existing) return { row: await rows.update(existing._id, state), kind: "retried" };

    const base = {
      deviceId, originalUrl, platform: meta.host, sourceId: meta.videoId, assetKey: meta.key,
      title: asset.title || "Untitled", thumbnail: asset.thumbnail || "", duration: asset.duration || 0,
      isDuplicate: !isLeader, ...state,
    };
    let { row } = await rows.insert(base);

    if (!ready) {
      // Close the race with a worker finishing between our read and our insert.
      const fresh = await readAsset(meta.key, { fresh: true });
      if (fresh && fresh.storage && fresh.storage.cdnUrl)
        row = await rows.update(row._id, { status: "ready", downloadUrl: fresh.storage.cdnUrl, cdnUrl: fresh.storage.cdnUrl, thumbnailCdn: fresh.storage.thumbnailCdn || null });
      else if (fresh && fresh.status === "failed" && fresh.failure)
        row = await rows.update(row._id, { status: "failed" });
    }
    return { row, kind: "created" };
  }

  // ------------------------------------------------------------------ public API
  async function requestDownload({ url, deviceId, appId = null }) {
    const t0 = process.hrtime.bigint();
    metrics.inc("download_request_received");
    let reservation = null; // { deviceId, appId, key } while a quota unit is held
    try {
      if (!config.downloader.enabled) throw new AppError("DOWNLOADS_DISABLED");
      if (config.downloader.requireAppId && (appId === null || appId === undefined)) throw new AppError("INVALID_REQUEST", "appId required");
      const meta = normalizeVideoUrl(url, normOpts);
      logger.event("download_request_received", { platform: meta.platform, key: meta.key, device: logger.hashId(deviceId) });

      // ---- quota gate (BEFORE any paid work). Same video for the same device is never charged twice.
      const found = await rows.findForDevice({
        deviceId, assetKey: meta.key, hosts: meta.legacyHosts,
        legacySourceId: meta.legacySafe ? meta.legacySourceId : null,
      });
      const prior = bestRow(found);
      const enforce = quota ? await quota.shouldEnforce(appId) : false;
      if (enforce && !(prior && prior.status !== "failed")) {
        await quota.reserve({ deviceId, appId, key: meta.key });
        reservation = { deviceId, appId, key: meta.key };
      }

      let asset = await readAsset(meta.key);
      if (!asset) asset = await promoteLegacy(meta);

      let outcome, isLeader = false;
      let st = classify(asset);

      if (st === "NEGATIVE") { metrics.inc("negative_cache_hit"); throw errorFromFailure(asset.failure); }

      if (st === "READY") { outcome = "database_cache_hit"; }
      else if (st === "IN_PROGRESS") { outcome = "duplicate_request_joined"; }
      else {
        const flight = await flights.run(meta.key, () =>
          coordinate(meta.key, checkForDownload, (cur) => leaderWork(meta, cur)));
        const r = flight.result;
        asset = r.asset;
        if (r.leader && r.providerCalled && !flight.shared) { outcome = "provider_call"; isLeader = true; }
        else if (r.leader && !r.providerCalled && !flight.shared) { outcome = "requeued"; isLeader = true; }
        else outcome = classify(asset) === "READY" ? "database_cache_hit" : "duplicate_request_joined";
      }

      if (outcome === "database_cache_hit") { metrics.inc("database_cache_hit"); logger.event("database_cache_hit", { key: meta.key }); }
      if (outcome === "duplicate_request_joined") { metrics.inc("duplicate_request_joined"); logger.event("duplicate_request_joined", { key: meta.key }); }

      const { row, kind } = await attachRow({
        asset, meta, deviceId, originalUrl: url, isLeader, found, appId: reservation ? appId : undefined,
      });
      const ready = row.status === "ready";

      // Already delivered => settle now. Otherwise the worker commits when the file is really stored.
      if (reservation && ready) { await quota.commit(reservation); reservation = null; }
      else if (reservation) { reservation = null; /* ownership passes to the worker (commit/release by row.appId) */ }

      const message = kind === "existing" && ready ? "Already saved in your history"
        : ready ? "Video already processed" : "Video processing started";

      const quotaState = quota && appId ? await quota.getState({ deviceId, appId }).catch(() => null) : null;

      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      metrics.observe(`request_ms:${outcome}`, ms);
      metrics.observe("request_ms:all", ms);
      return { row, message, outcome, ms, quota: quotaState };
    } catch (err) {
      if (reservation) await quota.release(reservation).catch(() => {}); // failure => no quota consumed
      const e = toAppError(err);
      metrics.inc("download_failed");
      logger.event("download_failed", { code: e.code, status: e.status });
      throw err;
    }
  }

  /**
   * Used by the worker when the stored media URL is expired/rejected. Only ONE provider
   * operation happens even if several workers ask at once; callers that already used a
   * URL fetched at `usedFetchedAt` get any newer URL instead of triggering another call.
   */
  async function ensureFreshSource(assetKey, { usedFetchedAt = null } = {}) {
    const needsRefresh = (a) =>
      !a.sourceMedia || !a.sourceMedia.url || a.sourceMedia.expiresAt <= now() ||
      (usedFetchedAt != null && a.sourceMedia.fetchedAt <= usedFetchedAt);
    const check = (a) => (a && ((a.storage && a.storage.cdnUrl) || !needsRefresh(a)) ? { asset: a } : null);

    const r = await coordinate(assetKey, check, async (a) => {
      if (!a) throw new AppError("INTERNAL");
      const meta = normalizeVideoUrl(a.providerUrl, normOpts);
      const parsed = await provider.fetchVideo(meta.providerUrl);
      const t = now();
      const updated = await assets.update(assetKey, {
        title: parsed.title || a.title, thumbnail: parsed.thumbnail || a.thumbnail, duration: parsed.duration || a.duration,
        sourceMedia: { url: parsed.selected.url, quality: parsed.selected.quality, fetchedAt: t, expiresAt: estimateMediaExpiry(parsed.selected.url, t, R.mediaUrlTtlMs) },
        lastValidatedAt: t, providerCalls: (a.providerCalls || 0) + 1,
      });
      metrics.inc("media_refresh_provider_call");
      return { asset: updated };
    });
    return r.asset;
  }

  return { requestDownload, ensureFreshSource, classify, readAsset, __cache: cache, __flights: flights };
}

module.exports = { createDownloadService, estimateMediaExpiry };
