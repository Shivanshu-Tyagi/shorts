const { v4: uuidv4 } = require("uuid");
const Download = require("../models/download.model");
const downloadQueue = require("../queues/download.queue");
const { getVideoInfo } = require("../services/rapidapi.service");
const { extractSourceId } = require("../utils/sourceExtractor");

/// DOWNLOAD SHORTS VIDEO
exports.downloadAllVideo = async (req, res) => {
  const { url, deviceId } = req.body;

  if (!url || !deviceId) {
    return res.status(400).json({
      success: false,
      message: "url and deviceId required",
    });
  }



  try {
    // extract sourceId
    const sourceId = extractSourceId(url);

    // detect platform
    const platform = new URL(url).hostname;

  const hostname = new URL(url).hostname.toLowerCase();

// if (
//   hostname.includes("youtube.com") ||
//   hostname.includes("youtu.be") ||
//     hostname.includes("m.youtube.com") ||
//     hostname.includes("www.youtube.com")
// ) {
//   return res.status(400).json({
//     success: false,
//     message: "YouTube downloads are not supported.",
//   });
// }


    

    // check duplicate
    const existing = await Download.findOne({
      platform,
      sourceId,
      status: "ready",
    });

    if (existing) {
      // 🔥 check if already saved by this device
      const alreadySaved = await Download.findOne({
        deviceId,
        platform,
        sourceId,
      });

      if (alreadySaved) {
        return res.json({
          success: true,
          message: "Already saved in your history",
          data: alreadySaved,
        });
      }

      // ✅ create only if not exists
      const record = await Download.create({
        deviceId,
        originalUrl: url,
        platform,
        sourceId,
        downloadUrl: existing.cdnUrl,
        cdnUrl: existing.cdnUrl,
        thumbnail: existing.thumbnail,
        thumbnailCdn: existing.thumbnailCdn,
        title: existing.title,
        duration: existing.duration,
        status: "ready",
        isDuplicate: true,
      });

      return res.json({
        success: true,
        message: "Video already processed",
        data: record,
      });
    }

    // call RapidAPI
    const result = await getVideoInfo(url);

    if (!result?.medias?.length) {
      return res.status(400).json({
        success: false,
        message: "No media found from API",
      });
    }

    const videos = result.medias.filter((m) => m.type === "video" && m.url);

    const selectedFormat =
      videos.find((v) => v.quality === "hd_no_watermark") ||
      videos.find((v) => v.quality === "no_watermark") ||
      videos.find((v) => v.quality === "watermark") ||
      videos[0];

    const apiDownloadUrl = selectedFormat.url;

    const videoId = uuidv4();

    const fileKey = `videos/${videoId}.mp4`;

    const record = await Download.create({
      deviceId,
      originalUrl: url,
      platform,
      sourceId,
      downloadUrl: apiDownloadUrl,
      fileKey,
      title: result.title || "Untitled",
      thumbnail: result.thumbnail,
      duration: result.duration || 0,
      status: "pending",
    });

    // queue job
    await downloadQueue.add(
      "process-video",
      {
        videoId: record._id,
        originalUrl: url,
        fileKey,
        deviceId,
        title: result.title,
      },
      {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 5000,
        },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );

    return res.json({
      success: true,
      message: "Video processing started",
      data: record,
    });
  } catch (err) {
    console.error("Download Error", err);

    res.status(500).json({
      success: false,
      message: "Download failed",
    });
  }
};







