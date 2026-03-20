const mongoose = require("mongoose");
const Download = require("../models/download.model");
const VideoLike = require("../models/videoLike.model");
const VideoView = require("../models/videoView.model");
const VideoSave = require("../models/videoSave.model");

/// INCREMENT DOWNLOADS SHORTS

exports.incrementDownload = async (req, res) => {
  try {

    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid video id"
      });
    }

    const short = await Download.findByIdAndUpdate(
      id,
      { $inc: { downloads: 1 } },
      { new: true }
    );

    if (!short) {
      return res.status(404).json({
        success: false,
        message: "Short not found"
      });
    }

    return res.json({
      success: true,
      downloads: short.downloads
    });

  } catch (err) {

    console.error("Download increment error:", err);

    return res.status(500).json({
      success: false
    });

  }
};//======== SHARE COUNTS API I++ ==================///
exports.incrementShare = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await Download.updateOne(
      { _id: id },
      { $inc: { shares: 1 } }
    );
    const short = await Download.findById(id);

    return res.json({
      success: true,
      playUrl: short.cdnUrl
    });

  } catch (err) {
    console.error("Share update error:", err);
    return res.status(500).json({
      success: false
    });
  }
};


/// INCREMENT SHAVES SHORTS
exports.toggleSave = async (req, res) => {

  try {

    const { id } = req.params;
    const { deviceId } = req.body;

    const existing = await VideoSave.findOne({
      videoId: id,
      deviceId
    });

    if (existing) {

      await existing.deleteOne();

      await Download.updateOne(
        { _id: id },
        { $inc: { saves: -1 } }
      );

      return res.json({
        success: true,
        saved: false
      });

    }

    await VideoSave.create({
      videoId: id,
      deviceId
    });

    await Download.updateOne(
      { _id: id },
      { $inc: { saves: 1 } }
    );

    return res.json({
      success: true,
      saved: true
    });

  } catch (err) {

    console.error("Toggle Save Error:", err);

    res.status(500).json({
      success: false
    });

  }

};
/// INCREMENT VIEWS
exports.incrementViews = async (req, res) => {

  try {

    const { id } = req.params;
    const { deviceId } = req.body;

    const existing = await VideoView.findOne({
      videoId: id,
      deviceId
    });

    if (!existing) {

      await VideoView.create({
        videoId: id,
        deviceId
      });

      await Download.updateOne(
        { _id: id },
        { $inc: { views: 1 } }
      );

    }

    const video = await Download.findById(id);

    return res.json({
      success: true,
      views: video.views
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      success: false
    });

  }

};
/// LIKES OR UN LIKES SHORTS
exports.toggleLike = async (req, res) => {
  try {
    const { id } = req.params;
    const { deviceId } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false });
    }

    const existing = await VideoLike.findOne({ videoId: id, deviceId });

    if (existing) {
      await existing.deleteOne();
      await Download.updateOne({ _id: id }, { $inc: { likes: -1 } });
      return res.json({ success: true, liked: false });
    }

    await VideoLike.create({ videoId: id, deviceId });
    await Download.updateOne({ _id: id }, { $inc: { likes: 1 } });

    return res.json({ success: true, liked: true });

  } catch (err) {
    res.status(500).json({ success: false });
  }
};