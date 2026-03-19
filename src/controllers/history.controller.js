const Download = require("../models/download.model");
const VideoSave = require("../models/videoSave.model");

exports.getHistory = async (req, res) => {

  try {

    const { deviceId } = req.params;

    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const skip = (page - 1) * limit;

    // download history
    const downloads = await Download.find(
      { deviceId, status: "ready" }
    ).lean();

    // saved videos
    const saves = await VideoSave.find({ deviceId }).lean();

    const savedIds = saves.map(v => v.videoId);

    const savedVideos = await Download.find({
      _id: { $in: savedIds }
    }).lean();

    const savedMap = {};
    saves.forEach(s => {
      savedMap[s.videoId.toString()] = s.createdAt;
    });

    const merged = [

      ...downloads.map(v => ({
        id: v._id,
        platform: v.platform,
        title: v.title,
        videoUrl: v.cdnUrl,
        thumbnail: v.thumbnailCdn || v.thumbnail,
        createdAt: v.createdAt,
        activityTime: v.createdAt
      })),

      ...savedVideos.map(v => ({
        id: v._id,
        platform: v.platform,
        title: v.title,
        videoUrl: v.cdnUrl,
        thumbnail: v.thumbnailCdn || v.thumbnail,
        createdAt: v.createdAt,
        activityTime: savedMap[v._id.toString()]
      }))

    ];

    // latest first
    merged.sort((a, b) => new Date(b.activityTime) - new Date(a.activityTime));

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

    res.status(500).json({
      success: false,
      code: "SERVER_ERROR",
      message: "Failed to fetch history"
    });

  }

};