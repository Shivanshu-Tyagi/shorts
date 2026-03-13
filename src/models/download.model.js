const mongoose = require("mongoose");

const DownloadSchema = new mongoose.Schema({

  deviceId: {
    type: String,
    required: true
  },

  originalUrl: {
    type: String,
    required: true
  },

  downloadUrl: {
    type: String,
    required: true
  },

  fileKey: {
    type: String,
    default: null
  },

  cdnUrl: {
    type: String,
    default: null
  },

  thumbnail: {
    type: String,
    default: ""
  },

  thumbnailCdn: {
    type: String,
    default: null
  },

  title: {
    type: String,
    default: "Untitled"
  },

  duration: {
    type: Number,
    default: 0
  },

  platform: {
    type: String,
    default: "unknown"
  },

  sourceId: {
    type: String
  },

  isDuplicate: {
    type: Boolean,
    default: false
  },

  status: {
    type: String,
    enum: ["pending", "processing", "ready", "failed"],
    default: "pending"
  },

  views: {
    type: Number,
    default: 0
  },

  likes: {
    type: Number,
    default: 0
  },

  shares: {
    type: Number,
    default: 0
  },

  downloads: {
    type: Number,
    default: 0
  },

  createdAt: {
    type: Date,
    default: Date.now
  }

});

// indexes
DownloadSchema.index({ deviceId: 1 });
DownloadSchema.index({ createdAt: -1 });
DownloadSchema.index({ platform: 1, sourceId: 1 });
DownloadSchema.index({ status: 1 });

module.exports = mongoose.model("Download", DownloadSchema);