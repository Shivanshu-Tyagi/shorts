const mongoose = require("mongoose");

const Download = new mongoose.Schema({
  deviceId: { type: String, required: true },
  originalUrl: { type: String, required: true },
  downloadUrl: { type: String, required: true },
  fileKey: { type: String, default: null },

  platform: String,
  title: String,
  thumbnail: String,
  duration: Number,

  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("Download", Download);