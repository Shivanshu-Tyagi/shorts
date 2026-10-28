const mongoose = require("mongoose");

/**
 * One canonical, reusable record per (platform, videoId).
 * The existing `downloads` collection stays the per-device history; this new
 * collection is the single source of truth for "have we already got this video?".
 *
 * Timestamps inside Mixed sub-objects are epoch milliseconds (numbers).
 */
const VideoAssetSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },          // `${platform}:${videoId}`
    platform: { type: String, required: true },
    videoId: { type: String, required: true },
    canonicalUrl: { type: String, default: "" },
    providerUrl: { type: String, default: "" },     // cleaned URL we send to the provider

    title: { type: String, default: "Untitled" },
    thumbnail: { type: String, default: "" },
    duration: { type: Number, default: 0 },
    formats: { type: [mongoose.Schema.Types.Mixed], default: [] }, // [{type,quality,extension}] (no URLs)

    status: {
      type: String,
      enum: ["queued", "processing", "ready", "failed"],
      default: "queued",
    },
    generation: { type: Number, default: 0 },       // bumps each time a new job is enqueued
    fileKey: { type: String, default: null },       // stable S3 key, reused across retries
    queuedAt: { type: Number, default: null },
    processingAt: { type: Number, default: null },  // worker heartbeat (stale-job detection)

    // SHORT-LIVED provider media URL: { url, quality, fetchedAt, expiresAt }
    sourceMedia: { type: mongoose.Schema.Types.Mixed, default: null },
    // PERMANENT storage reference: { fileKey, cdnUrl, thumbnailKey, thumbnailCdn, storedAt }
    storage: { type: mongoose.Schema.Types.Mixed, default: null },
    // Negative / cooldown cache: { code, permanent, at, expiresAt, retryAfterSec }
    failure: { type: mongoose.Schema.Types.Mixed, default: null },

    lastValidatedAt: { type: Number, default: null },
    providerCalls: { type: Number, default: 0 },    // lifetime billed operations for this video
    legacy: { type: Boolean, default: false },      // promoted from a pre-existing Download row
  },
  { timestamps: true, collection: "video_assets" }
);

VideoAssetSchema.index({ key: 1 }, { unique: true });
VideoAssetSchema.index({ status: 1, updatedAt: 1 }); // stale-job sweeps / ops queries

module.exports = mongoose.model("VideoAsset", VideoAssetSchema);
