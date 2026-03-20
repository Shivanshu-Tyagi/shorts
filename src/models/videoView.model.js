const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  videoId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Download",
    required: true,
    index: true
  },
  deviceId: {
    type: String,
    required: true,
    index: true
  }
}, { timestamps: true });

schema.index({ videoId: 1, deviceId: 1 }, { unique: true });

module.exports = mongoose.models.VideoView || mongoose.model("VideoView", schema);