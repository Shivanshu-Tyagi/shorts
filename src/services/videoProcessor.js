/**
 * Worker core. Pure-ish: every side effect is injected so it is testable without
 * Redis/S3/ffmpeg. The BullMQ wiring lives in src/worker/download.worker.js.
 *
 * BILLING: this code NEVER calls the provider just because it is "a new attempt".
 * It uses the media URL the API process already paid for, and asks for a fresh one
 * (via service.ensureFreshSource, single-flight) only when that URL is expired or
 * the CDN rejects it - at most `media.refreshMax` times per job run.
 */
const path = require("path");
const crypto = require("crypto");
const { Transform } = require("stream");
const { pipeline } = require("stream/promises");
const { MediaFetchError } = require("../utils/netGuard");
const { AppError, PERMANENT_CODES, toAppError } = require("../utils/errors");

const readyPatch = (s) => ({
  status: "ready", downloadUrl: s.cdnUrl, cdnUrl: s.cdnUrl, thumbnailCdn: s.thumbnailCdn || null,
});

const isFinalAttempt = (job) => (job.attemptsMade || 0) + 1 >= ((job.opts && job.opts.attempts) || 1);

/** -> { code, permanent } */
function classifyJobError(err) {
  if (err instanceof MediaFetchError) {
    return { code: "DOWNLOAD_UNAVAILABLE", permanent: err.kind !== "transient" };
  }
  const e = toAppError(err);
  if (err instanceof AppError) return { code: e.code, permanent: PERMANENT_CODES.has(e.code) };
  return { code: "DOWNLOAD_UNAVAILABLE", permanent: false }; // S3 / ffmpeg / fs: retryable
}

async function downloadToFile(openStream, fs, url, filePath, { maxBytes, timeoutMs, maxRedirects }) {
  const { res } = await openStream(url, {
    maxBytes, timeoutMs, maxRedirects,
    headers: { "User-Agent": "Mozilla/5.0", Referer: "https://www.instagram.com/" },
  });
  let n = 0;
  const limiter = new Transform({
    transform(chunk, _e, cb) {
      n += chunk.length;
      if (n > maxBytes) return cb(new MediaFetchError("too_large", "download exceeds size limit"));
      cb(null, chunk);
    },
  });
  try {
    await pipeline(res, limiter, fs.createWriteStream(filePath));
  } catch (e) {
    throw e instanceof MediaFetchError ? e : new MediaFetchError("transient", `stream: ${e.code || e.message}`);
  }
  if (n === 0) throw new MediaFetchError("transient", "empty body");
  return n;
}

function createVideoProcessor(d) {
  const { assets, rows, service, config, metrics, logger, fs, openStream, generateThumbnail, uploadToS3, cdnDomain, tmpDir, UnrecoverableError = Error } = d;
  const quota = d.quota || null;
  const now = d.now || Date.now;
  const M = config.media;
  const dl = (url, file) => downloadToFile(openStream, fs, url, file, M);

  async function markFailed(key, { code, permanent }) {
    const ttl = permanent ? config.reuse.negativeTtlMs : config.reuse.transientCooldownMs;
    await assets.update(key, { status: "failed", failure: { code, permanent, at: now(), expiresAt: now() + ttl, retryAfterSec: null } });
    await rows.failByAsset(key);
    await settleQuota(key);
  }

  /**
   * Settle download-quota reservations of every quota-aware row of this asset:
   * ready => commit (counts as a used download), failed => release (costs nothing). Both are idempotent,
   * so job retries / duplicate runs can never double count.
   */
  async function settleQuota(key) {
    if (!quota) return;
    for (const r of await rows.findByAsset(key)) {
      if (!r.appId) continue;
      const ref = { deviceId: r.deviceId, appId: r.appId, key };
      if (r.status === "ready") await quota.commit(ref);
      else if (r.status === "failed") await quota.release(ref);
    }
  }

  async function finalize(asset) {
    await rows.completeByAsset(asset.key, readyPatch(asset.storage));
    await settleQuota(asset.key);
  }

  async function storeFiles({ fileKey, videoPath, thumbPath, thumbKey }) {
    let thumbOk = true;
    try { await generateThumbnail(videoPath, thumbPath); }
    catch (e) { thumbOk = false; logger.warn("thumbnail_failed", { reason: String(e && e.message).slice(0, 120) }); }
    await uploadToS3(fs.createReadStream(videoPath), fileKey, "video/mp4");
    if (thumbOk) await uploadToS3(fs.createReadStream(thumbPath), thumbKey, "image/jpeg");
    return {
      cdnUrl: `https://${cdnDomain}/${fileKey}`,
      thumbnailCdn: thumbOk ? `https://${cdnDomain}/${thumbKey}` : null,
      thumbnailKey: thumbOk ? thumbKey : null,
    };
  }

  async function processAssetJob(job) {
    const key = job.data.assetKey;
    let asset = await assets.getByKey(key);
    if (!asset) throw new UnrecoverableError("asset missing");
    if (asset.storage && asset.storage.cdnUrl) { await finalize(asset); return { skipped: "already_ready" }; }

    await assets.update(key, { status: "processing", processingAt: now() });
    const id = path.basename(asset.fileKey, path.extname(asset.fileKey));
    const stamp = `${id}_${crypto.randomUUID()}`; // unique per run: two workers may process the same asset concurrently
    const videoPath = path.join(tmpDir, `${stamp}.mp4`);
    const thumbPath = path.join(tmpDir, `${stamp}.jpg`);

    try {
      let refreshes = 0;
      const refresh = async (used) => {
        refreshes++;
        asset = await service.ensureFreshSource(key, { usedFetchedAt: used });
        return asset;
      };

      let src = asset.sourceMedia;
      if (!src || !src.url || src.expiresAt <= now()) {
        if (refreshes >= M.refreshMax) throw new MediaFetchError("expired", "media url expired");
        await refresh(src ? src.fetchedAt : null);
        if (asset.storage && asset.storage.cdnUrl) { await finalize(asset); return { skipped: "ready_by_other" }; }
        src = asset.sourceMedia;
      }

      for (;;) {
        try { await dl(src.url, videoPath); break; }
        catch (e) {
          if (e instanceof MediaFetchError && e.kind === "expired" && refreshes < M.refreshMax) {
            metrics.inc("media_url_rejected_refresh");
            await refresh(src.fetchedAt);
            if (asset.storage && asset.storage.cdnUrl) { await finalize(asset); return { skipped: "ready_by_other" }; }
            src = asset.sourceMedia;
            continue;
          }
          throw e;
        }
      }

      const stored = await storeFiles({ fileKey: asset.fileKey, videoPath, thumbPath, thumbKey: `thumbnails/${id}.jpg` });
      const storage = { fileKey: asset.fileKey, cdnUrl: stored.cdnUrl, thumbnailKey: stored.thumbnailKey, thumbnailCdn: stored.thumbnailCdn, storedAt: now() };
      // Order matters: asset first, then rows (see attachRow's race handling).
      await assets.update(key, { status: "ready", storage, sourceMedia: null, failure: null, lastValidatedAt: now() });
      await rows.completeByAsset(key, readyPatch(storage));
      await settleQuota(key); // a throw here fails the attempt; the retry hits finalize() and settles idempotently
      metrics.inc("job_completed");
      return { ok: true };
    } catch (err) {
      const verdict = classifyJobError(err);
      logger.error("job_failed", { key, code: verdict.code, permanent: verdict.permanent, attempt: (job.attemptsMade || 0) + 1 });
      if (verdict.permanent || isFinalAttempt(job)) await markFailed(key, verdict).catch(() => {});
      if (verdict.permanent) throw new UnrecoverableError(verdict.code);
      throw err;
    } finally {
      await fs.promises.rm(videoPath, { force: true }).catch(() => {});
      await fs.promises.rm(thumbPath, { force: true }).catch(() => {});
    }
  }

  /** Jobs enqueued by the OLD controller before this deploy: {videoId,originalUrl,fileKey}. */
  async function processLegacyJob(job) {
    const { videoId, fileKey } = job.data;
    const row = await rows.getById(videoId);
    if (!row) throw new UnrecoverableError("row missing");
    if (row.status === "ready") return { skipped: "already_ready" };
    await rows.update(videoId, { status: "processing" });
    const stamp = `legacy_${videoId}_${crypto.randomUUID()}`;
    const videoPath = path.join(tmpDir, `${stamp}.mp4`);
    const thumbPath = path.join(tmpDir, `${stamp}.jpg`);
    try {
      let url = row.downloadUrl;
      let refreshed = false;
      const refresh = async () => {
        const { normalizeVideoUrl } = require("../utils/videoUrl");
        const meta = normalizeVideoUrl(job.data.originalUrl, { extraHosts: config.downloader.extraHosts });
        refreshed = true;
        url = (await d.provider.fetchVideo(meta.providerUrl)).selected.url;
      };
      if (!url) await refresh();
      for (;;) {
        try { await dl(url, videoPath); break; }
        catch (e) {
          if (e instanceof MediaFetchError && e.kind === "expired" && !refreshed && M.refreshMax > 0) { await refresh(); continue; }
          throw e;
        }
      }
      const id = path.basename(fileKey, path.extname(fileKey));
      const stored = await storeFiles({ fileKey, videoPath, thumbPath, thumbKey: `thumbnails/${id}.jpg` });
      await rows.update(videoId, { status: "ready", cdnUrl: stored.cdnUrl, downloadUrl: stored.cdnUrl, thumbnailCdn: stored.thumbnailCdn });
      return { ok: true, legacy: true };
    } catch (err) {
      const verdict = classifyJobError(err);
      if (verdict.permanent || isFinalAttempt(job)) await rows.update(videoId, { status: "failed" }).catch(() => {});
      if (verdict.permanent) throw new UnrecoverableError(verdict.code);
      throw err;
    } finally {
      await fs.promises.rm(videoPath, { force: true }).catch(() => {});
      await fs.promises.rm(thumbPath, { force: true }).catch(() => {});
    }
  }

  return {
    process: (job) => (job.data && job.data.assetKey ? processAssetJob(job) : processLegacyJob(job)),
  };
}

module.exports = { createVideoProcessor, downloadToFile, classifyJobError, isFinalAttempt };
