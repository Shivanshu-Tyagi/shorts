const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  videoId: {
    type: String,   // ✅ ObjectId → String
    required: true,
    index: true
  },
  deviceId: {
    type: String,
    required: true,
    index: true
  }
}, { timestamps: true });

// ✅ Unique combination (ek device ek video ko ek hi baar save kare)
schema.index({ videoId: 1, deviceId: 1 }, { unique: true });

module.exports = mongoose.model("VideoSave", schema);