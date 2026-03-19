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
    const videoId = req.params.id;  
    const { deviceId } = req.body; 

    if (!videoId || !deviceId) {
      return res.status(400).json({
        success: false,
        message: "videoId or deviceId missing"
      });
    }

    // check already saved
    const exists = await VideoSave.findOne({ videoId, deviceId });

    if (exists) {
      await VideoSave.deleteOne({ videoId, deviceId });

      await Download.updateOne(
        { videoId: videoId },   
        { $inc: { saves: -1 } }
      );

      return res.json({
        success: true,
        saved: false
      });

    } else {
      await VideoSave.create({ videoId, deviceId });

      await Download.updateOne(
        { videoId: videoId }, 
        { $inc: { saves: 1 } }
      );

      return res.json({
        success: true,
        saved: true
      });
    }

  } catch (error) {
    console.error("Toggle Save Error:", error);
    res.status(500).json({ success: false });
  }
};
/// INCREMENT VIEWS
exports.incrementViews = async (req, res) => {
  try {
    const videoId = req.params.id;
    const { deviceId } = req.body;

    const existing = await VideoView.findOne({ videoId, deviceId });

    if (!existing) {
      await VideoView.create({ videoId, deviceId });

      const update = await Download.updateOne(
        { videoId },
        {
          $inc: { views: 1 },
          $setOnInsert: {
            videoId,
            playUrl: `https://cdn.stackearn.com/videos/${videoId}.mp4`
          }
        },
        { upsert: true }   // ✅ FIX
      );

      console.log("update result:", update);
    }

    const video = await Download.findOne({ videoId });

    return res.json({
      success: true,
      views: video?.views || 0
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
};


/// LIKES OR UN LIKES SHORTS
exports.toggleLike = async (req, res) => {
  try {
    const videoId = req.params.id;   // ✅ UUID
    const { deviceId } = req.body;

    if (!videoId || !deviceId) {
      return res.status(400).json({ success: false });
    }

    const existing = await VideoLike.findOne({
      videoId,
      deviceId
    });

    if (existing) {
      await VideoLike.deleteOne({ videoId, deviceId });

    await Download.updateOne(
  { videoId },
  {
    $inc: { likes: existing ? -1 : 1 },
    $setOnInsert: {
      videoId,
      playUrl: `https://cdn.stackearn.com/videos/${videoId}.mp4`
    }
  },
  { upsert: true }
);

      return res.json({ liked: false });
    }

    // ✅ like
    await VideoLike.create({ videoId, deviceId });

    await Download.updateOne(
      { videoId },  
      { $inc: { likes: 1 } }
    );

    return res.json({
      success: true,
      liked: true
    });

  } catch (err) {
    console.error("Like Error:", err);

    res.status(500).json({
      success: false
    });
  }
};