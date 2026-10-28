const mongoose = require("mongoose");

/** Lease locks. TTL index removes expired docs; acquisition logic never relies on it. */
const LockSchema = new mongoose.Schema(
  {
    _id: { type: String },
    owner: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { collection: "download_locks", versionKey: false }
);
LockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 60 });

module.exports = mongoose.model("DownloadLock", LockSchema);
