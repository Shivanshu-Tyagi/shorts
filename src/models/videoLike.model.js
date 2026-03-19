const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  videoId: {
    type: String,   
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

module.exports = mongoose.model("VideoLike", schema);