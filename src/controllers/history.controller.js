const Download = require("../models/download.model");

/**
 * GET /history/:deviceId?limit=20&page=1
 */
exports.getHistory = async (req, res) => {
  try {
    const { deviceId } = req.params;

    if (!deviceId) {
      return res.status(400).json({
        success: false,
        code: "VALIDATION_ERROR",
        message: "deviceId is required",
      });
    }

    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const skip = (page - 1) * limit;

    const query = {
      deviceId,
      status: "ready"
    };

    const [history, totalCount] = await Promise.all([
      Download.find(
        query,
        {
          originalUrl: 1,
          platform: 1,
          title: 1,
          duration: 1,
          cdnUrl: 1,
          thumbnailCdn: 1,
          thumbnail: 1,
          createdAt: 1
        }
      )
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),

      Download.countDocuments(query)
    ]);

    const formattedHistory = history.map((item) => ({
      id: item._id,
      platform: item.platform,
      title: item.title,
      duration: item.duration,
      videoUrl: item.cdnUrl,
      thumbnail: item.thumbnailCdn || item.thumbnail,
      createdAt: item.createdAt
    }));

    const totalPages = Math.ceil(totalCount / limit);

    return res.status(200).json({
      success: true,
      code: "HISTORY_FETCHED",
      message: "Download history fetched successfully",
      count: formattedHistory.length,
      total: totalCount,
      page,
      limit,
      totalPages,
      data: formattedHistory   // empty [] allowed
    });

  } catch (err) {
    console.error("History Error:", err);

    return res.status(500).json({
      success: false,
      code: "SERVER_ERROR",
      message: "Failed to fetch history",
    });
  }
};