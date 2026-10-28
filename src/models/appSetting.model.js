const mongoose = require("mongoose");

/** Per-app runtime overrides managed through PUT /api/internal/settings/:appId. */
const AppSettingSchema = new mongoose.Schema(
  {
    appId: { type: String, required: true },
    downloadLimits: { type: mongoose.Schema.Types.Mixed, default: {} },   // partial overrides of DEFAULT_LIMITS
    rewarded: { type: mongoose.Schema.Types.Mixed, default: null },        // { enabled, unitId } override for ads.rewarded
    version: { type: Number, default: 0 },
  },
  { timestamps: true, collection: "app_settings", minimize: false }
);
AppSettingSchema.index({ appId: 1 }, { unique: true });

module.exports = mongoose.model("AppSetting", AppSettingSchema);
