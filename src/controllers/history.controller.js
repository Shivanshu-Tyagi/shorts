const Download = require("../models/download.model");

/**
 * GET /history/:deviceId?limit=20&page=1
 * Fetch user's download history
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

    // Pagination params
    const limit = Math.min(parseInt(req.query.limit) || 20, 50); // max 50
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const skip = (page - 1) * limit;

    // ✅ Fetch history sorted by latest first
    const [history, totalCount] = await Promise.all([
      Download.find(
        { deviceId },
        {
          deviceId: 1,
          originalUrl: 1,
          downloadUrl: 1, // direct S3 URL
          fileKey: 1,
          platform: 1,
          title: 1,
          thumbnail: 1,
          duration: 1,
          createdAt: 1
        }
      )
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),

      Download.countDocuments({ deviceId })
    ]);

    const totalPages = Math.ceil(totalCount / limit);

    return res.status(200).json({
      success: true,
      code: "HISTORY_FETCHED",
      message: "Download history fetched successfully",
      count: history.length,
      total: totalCount,
      page,
      limit,
      totalPages,
      data: history
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