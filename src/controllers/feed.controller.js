const mongoose = require("mongoose");
const Download = require("../models/download.model");

exports.getGlobalFeed = async (req, res) => {
  try {

    const limit = Math.min(parseInt(req.query.limit) || 10, 20);
    const cursor = req.query.cursor;

    const query = {
      status: "ready",
      isDuplicate: false,
      cdnUrl: { $exists: true, $ne: null }
    };

    // cursor pagination
    if (cursor) {
      query._id = {
        $lt: new mongoose.Types.ObjectId(cursor)
      };
    }

    const videos = await Download.find(
      query,
      {
        title: 1,
        thumbnailCdn: 1,
        platform: 1,
        duration: 1,
        cdnUrl: 1,

        views: 1,
        likes: 1,
        comments: 1,
        shares: 1,
        saves: 1,
        downloads: 1,

        createdAt: 1
      }
    )
      .sort({ _id: -1 })
      .limit(limit)
      .lean();

    const nextCursor =
      videos.length === limit
        ? videos[videos.length - 1]._id
        : null;

    const feedData = videos.map(v => ({
      id: v._id,
      title: v.title || "Untitled",
      thumbnail: v.thumbnailCdn,
      platform: v.platform,
      playUrl: v.cdnUrl,
      stats: {
        views: v.views || 0,
        likes: v.likes || 0,
        comments: v.comments || 0,
        shares: v.shares || 0,
        saves: v.saves || 0,
        downloads: v.downloads || 0
      },

      createdAt: v.createdAt
    }));

    console.log(`Feed fetched: ${feedData.length} items`);

    res.json({
      success: true,
      count: feedData.length,
      nextCursor,
      data: feedData
    });

  } catch (err) {

    console.error("Feed Error:", err);

    res.status(500).json({
      success: false,
      message: "Failed to fetch shorts feed"
    });

  }
};