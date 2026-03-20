const mongoose = require("mongoose");
const Download = require("../models/download.model");
const VideoSave = require("../models/videoSave.model");

exports.getHistory = async (req, res) => {

  try {

    const { deviceId } = req.params;

    if (!deviceId) {
      return res.status(400).json({
        success: false,
        code: "VALIDATION_ERROR",
        message: "deviceId is required"
      });
    }

    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const skip = (page - 1) * limit;

    // 🔥 STEP 1: Parallel fetch
    const [downloads, saves] = await Promise.all([
      Download.find({ deviceId, status: "ready" }).lean(),
      VideoSave.find({ deviceId }).lean()
    ]);

    // 🔥 STEP 2: Valid ObjectIds only
    const savedIds = saves
      .map(v => v.videoId)
      .filter(id => mongoose.Types.ObjectId.isValid(id));

    // 🔥 STEP 3: Fetch saved videos
    const savedVideos = await Download.find({
      _id: { $in: savedIds }
    }).lean();

    // 🔥 STEP 4: Map for activity time
    const savedMap = {};
    saves.forEach(s => {
      if (mongoose.Types.ObjectId.isValid(s.videoId)) {
        savedMap[s.videoId.toString()] = s.createdAt;
      }
    });

    // 🔥 STEP 5: Merge + remove duplicates
    const map = new Map();

    // downloads
    downloads.forEach(v => {
      map.set(v._id.toString(), {
        id: v._id,
        platform: v.platform,
        title: v.title,
        videoUrl: v.cdnUrl,
        thumbnail: v.thumbnailCdn || v.thumbnail,
        createdAt: v.createdAt,
        activityTime: v.createdAt
      });
    });

    // saved (overwrite if exists → latest activity)
    savedVideos.forEach(v => {
      map.set(v._id.toString(), {
        id: v._id,
        platform: v.platform,
        title: v.title,
        videoUrl: v.cdnUrl,
        thumbnail: v.thumbnailCdn || v.thumbnail,
        createdAt: v.createdAt,
        activityTime: savedMap[v._id.toString()]
      });
    });

    const merged = Array.from(map.values());

    // 🔥 STEP 6: Latest first
    merged.sort((a, b) => new Date(b.activityTime) - new Date(a.activityTime));

    // 🔥 STEP 7: Pagination
    const paginated = merged.slice(skip, skip + limit);

    return res.json({
      success: true,
      code: "HISTORY_FETCHED",
      message: "Download history fetched successfully",
      count: paginated.length,
      total: merged.length,
      page,
      limit,
      totalPages: Math.ceil(merged.length / limit),
      data: paginated
    });

  } catch (err) {

    console.error("History Error:", err);

    return res.status(500).json({
      success: false,
      code: "SERVER_ERROR",
      message: "Failed to fetch history"
    });

  }

};