const Download = require("../models/download.model");

exports.getGlobalFeed = async (req, res) => {
  try {
    let page = parseInt(req.query.page) || 1;
    let limit = parseInt(req.query.limit) || 10;

    if (page < 1) page = 1;
    if (limit < 1 || limit > 20) limit = 20;

    const skip = (page - 1) * limit;

    const matchQuery = {
      fileKey: { $exists: true, $ne: "" }
    };

    const videos = await Download.find(matchQuery)
      .sort({ createdAt: -1 })   // newest first
      .skip(skip)
      .limit(limit);

    const totalCount = await Download.countDocuments(matchQuery);
    const totalPages = Math.ceil(totalCount / limit);

    const feedData = videos.map(item => ({
      id: item._id,
      title: item.title || "Untitled",
      thumbnail: item.thumbnail || "",
      platform: item.platform || "unknown",
      duration: item.duration || 0,
      playUrl: item.downloadUrl,
      downloadUrl: item.downloadUrl,
      createdAt: item.createdAt
    }));

    res.json({
      success: true,
      page,
      limit,
      total: totalCount,
      totalPages,
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


//
//const Download = require("../models/download.model");
//
//// CloudFront base URL
//const CDN_BASE_URL = process.env.CDN_DOMAIN || "d2sb6k9ai6oc0m.cloudfront.net";
//
//exports.getGlobalFeed = async (req, res) => {
//  try {
//    // Pagination params
//    let page = parseInt(req.query.page) || 1;
//    let limit = parseInt(req.query.limit) || 10;
//
//    if (page < 1) page = 1;
//    if (limit < 1 || limit > 20) limit = 10;
//
//    const skip = (page - 1) * limit;
//
//    // ✅ Mongo aggregation for random shorts
//    // Only fetch videos with fileKey (uploaded to S3/CloudFront) and duration <= 120s
//    const videos = await Download.aggregate([
//      {
//        $match: {
//          fileKey: { $ne: null },
//          duration: { $lte: 120 }
//        }
//      },
//      { $sample: { size: limit } } // random videos
//    ]);
//
//    const feedData = videos.map((item) => ({
//      id: item._id,
//      title: item.title || "Untitled",
//      thumbnail: item.thumbnail || "",
//      duration: item.duration || 0,
//      platform: item.platform || "unknown",
//      playUrl: `https://${CDN_BASE_URL}/${item.fileKey}`,
//      downloadUrl: `https://${CDN_BASE_URL}/${item.fileKey}`,
//      createdAt: item.createdAt
//    }));
//
//    res.status(200).json({
//      success: true,
//      code: "SHORTS_FEED_RANDOM",
//      message: "Random shorts feed fetched successfully",
//      page,
//      limit,
//      count: feedData.length,
//      data: feedData
//    });
//
//  } catch (err) {
//    console.error("Random Shorts Feed Error:", err);
//    res.status(500).json({
//      success: false,
//      code: "SERVER_ERROR",
//      message: "Failed to fetch random shorts feed"
//    });
//  }
//};