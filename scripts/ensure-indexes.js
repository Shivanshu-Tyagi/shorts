/**
 * Creates the indexes required by the optimisation. ADDITIVE ONLY (createIndexes);
 * it never drops or rebuilds existing indexes (do NOT use syncIndexes on `downloads`).
 *
 *   node scripts/ensure-indexes.js
 *
 * Mongoose also builds these automatically at boot unless MONGO_AUTO_INDEX=false.
 * On a large `downloads` collection prefer running this script once, off-peak, then
 * deploying with MONGO_AUTO_INDEX=false.
 */
require("dotenv").config();
const mongoose = require("mongoose");
const VideoAsset = require("../src/models/videoAsset.model");
const DownloadLock = require("../src/models/lock.model");
const Download = require("../src/models/download.model");
const DownloadQuota = require("../src/models/downloadQuota.model");
const AppSetting = require("../src/models/appSetting.model");

(async () => {
  if (!process.env.MONGO_URL) throw new Error("MONGO_URL is not defined");
  await mongoose.connect(process.env.MONGO_URL, { autoIndex: false, serverSelectionTimeoutMS: 10000 });
  for (const [name, model] of [["video_assets", VideoAsset], ["download_locks", DownloadLock], ["downloads", Download], ["download_quotas", DownloadQuota], ["app_settings", AppSetting]]) {
    await model.createIndexes();
    const idx = await model.collection.indexes();
    console.log(`${name}:`, idx.map((i) => i.name).join(", "));
  }
  await mongoose.disconnect();
})().catch((e) => { console.error("ensure-indexes failed:", e.message); process.exit(1); });
