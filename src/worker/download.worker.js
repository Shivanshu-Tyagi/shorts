const { Worker, UnrecoverableError } = require("bullmq");
const fs = require("fs");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");

const { config } = require("../config");
const { metrics } = require("../services/metrics.service");
const logger = require("../utils/logger");
const { uploadToS3 } = require("../services/s3.service");
const { connection } = require("../config/redis");
const { openGuardedStream } = require("../utils/netGuard");
const { createDownloadService } = require("../services/download.service");
const { createVideoProcessor } = require("../services/videoProcessor");
const { getProvider } = require("../services/rapidapi.service");
const { assets, rows, quotas, settings } = require("../repositories/mongo");
const { createAppSettings } = require("../services/appSettings");
const { createQuotaService } = require("../services/quota.service");

ffmpeg.setFfmpegPath(ffmpegPath);

const TMP_DIR = path.join(__dirname, "../../tmp");
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

function generateThumbnail(videoPath, thumbnailPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .screenshots({
        timestamps: ["2"],
        filename: path.basename(thumbnailPath),
        folder: TMP_DIR,
        size: "1080x1920",
      })
      .on("end", resolve)
      .on("error", reject);
  });
}

const provider = getProvider();
const quota = createQuotaService({ quotas, settings: createAppSettings({ store: settings, config }), metrics });
// The worker only needs ensureFreshSource(); it never enqueues, so no queue port is passed.
const service = createDownloadService({ assets, rows, provider, queue: { isReady: () => true, enqueue: async () => {} }, config, metrics, logger });

const processor = createVideoProcessor({
  assets, rows, service, provider, quota, config, metrics, logger, fs,
  openStream: openGuardedStream, generateThumbnail, uploadToS3,
  cdnDomain: process.env.CDN_DOMAIN, tmpDir: TMP_DIR, UnrecoverableError,
});

const downloadWorker = new Worker(
  "video-download",
  (job) => processor.process(job),
  { connection, concurrency: config.queue.concurrency }
);

downloadWorker.on("failed", (job, err) => {
  logger.error("worker_job_failed", { jobId: job && job.id, attemptsMade: job && job.attemptsMade, reason: String(err && err.message).slice(0, 120) });
});

module.exports = downloadWorker;
