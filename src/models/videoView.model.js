// src/models/videoView.model.js

const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  videoId: {
    type: String,   // ✅ FIX
    required: true,
    index: true
  },
  deviceId: {
    type: String,
    required: true,
    index: true
  }
}, { timestamps: true });

// ek device ek hi baar count hoga
schema.index({ videoId: 1, deviceId: 1 }, { unique: true });

module.exports = mongoose.model("VideoView", schema);