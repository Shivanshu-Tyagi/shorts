const mongoose = require("mongoose");

/**
 * One document per (deviceId, appId). Every state transition is a SINGLE-DOCUMENT atomic update
 * (conditional $inc/$push/$pull), so concurrent/duplicate requests cannot over-grant.
 *   used          committed (successful) downloads
 *   reservations  in-flight downloads [{key, exp}]  (released on failure, expire by TTL)
 *   rewardedGranted  total extra downloads unlocked by verified ads
 *   sessions      rewarded-ad sessions [{nonce,state,units,createdAt,expiresAt,grantedAt,transactionId,adUnit}]
 *   grants        last N grant timestamps (rolling daily cap)
 * Limits themselves (free/reward sizes) are NOT stored here: they come from settings at check time.
 */
// Typed sub-documents (no _id): conditional $pull / $elemMatch / positional updates cast reliably.
const ReservationSchema = new mongoose.Schema({ key: { type: String, required: true }, exp: { type: Number, required: true } }, { _id: false });
const SessionSchema = new mongoose.Schema(
  {
    nonce: { type: String, required: true },
    state: { type: String, enum: ["issued", "granted"], default: "issued" },
    units: { type: Number, required: true },
    createdAt: { type: Number, required: true },
    expiresAt: { type: Number, required: true },
    grantedAt: { type: Number },
    transactionId: { type: String },
    adUnit: { type: String },
  },
  { _id: false }
);

const DownloadQuotaSchema = new mongoose.Schema(
  {
    deviceId: { type: String, required: true },
    appId: { type: String, required: true },
    used: { type: Number, default: 0 },
    reservations: { type: [ReservationSchema], default: [] },
    rewardedGranted: { type: Number, default: 0 },
    rewardsCompleted: { type: Number, default: 0 },
    lastRewardAt: { type: Number, default: null },
    lastRewardUnits: { type: Number, default: 0 },
    lastDownloadAt: { type: Number, default: null },
    grants: { type: [Number], default: [] },
    sessions: { type: [SessionSchema], default: [] },
  },
  { timestamps: true, collection: "download_quotas", minimize: false }
);

DownloadQuotaSchema.index({ deviceId: 1, appId: 1 }, { unique: true });

module.exports = mongoose.model("DownloadQuota", DownloadQuotaSchema);
