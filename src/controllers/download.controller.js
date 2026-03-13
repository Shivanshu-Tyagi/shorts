const { v4: uuidv4 } = require("uuid");
const Download = require("../models/download.model");
const downloadQueue = require("../queues/download.queue");
const { getVideoInfo } = require("../services/rapidapi.service");
const { extractSourceId } = require("../utils/sourceExtractor");

exports.downloadVideo = async (req, res) => {
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

    // check duplicate
    const existing = await Download.findOne({
      platform,
      sourceId,
      status: "ready",
    });

    if (existing) {
      // save user history
        const record=  await Download.create({
        deviceId,
        originalUrl: url,
        platform,
        sourceId,
        downloadUrl: existing.cdnUrl, // IMPORTANT
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
        message: "Video not found",
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
      thumbnail: result.thumbnail,
      duration: result.duration || 0,
      status: "pending",
    });

    // queue job
    await downloadQueue.add("process-video", {
      videoId: record._id,
      videoUrl: apiDownloadUrl,
      thumbnail: result.thumbnail,
      fileKey,
    });

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

// const axios = require("axios");
// const { v4: uuidv4 } = require("uuid");
// const Download = require("../models/download.model");
// const { uploadToS3 } = require("../utils/s3Client");

// exports.downloadVideo = async (req, res) => {
//   try {
//     const { url, deviceId } = req.body;

//     if (!url || !deviceId) {
//       return res.status(400).json({
//         success: false,
//         message: "url and deviceId required",
//       });
//     }

//     console.log("🔗 URL:", url);

//     // 1️⃣ RapidAPI call
//     const rapidResponse = await axios.post(
//       process.env.RAPID_API_HOST,
//       { url },
//       {
//         headers: {
//           "x-rapidapi-key": process.env.RAPID_API_KEY,
//           "x-rapidapi-host": "social-download-all-in-one.p.rapidapi.com",
//           "Content-Type": "application/json",
//         },
//       },
//     );

//     const result = rapidResponse.data;

//     if (!result?.medias?.length) {
//       return res.status(400).json({
//         success: false,
//         message: "Video data not found",
//       });
//     }

//     // 2️⃣ select best quality
//     const videos = result.medias.filter((m) => m.type === "video" && m.url);

//     if (!videos.length) {
//       return res.status(400).json({
//         success: false,
//         message: "No video format available",
//       });
//     }

//     let selectedFormat =
//       videos.find((v) => v.quality === "hd_no_watermark") ||
//       videos.find((v) => v.quality === "no_watermark") ||
//       videos.find((v) => v.quality === "watermark") ||
//       videos[0];

//     const apiDownloadUrl = selectedFormat.url;

//     console.log("🎥 Selected quality:", selectedFormat.quality);

//     // 3️⃣ duplicate detection
//     const existing = await Download.findOne({
//       originalUrl: url,
//       status: "ready",
//     });

//     if (existing) {
//       existing.downloads += 1;
//       await existing.save();

//       return res.status(200).json({
//         success: true,
//         message: "Video already processed",
//         data: existing,
//       });
//     }

//     // 4️⃣ create DB record
//     const videoId = uuidv4();

//     const fileKey = `videos/${videoId}.mp4`;

//     const record = await Download.create({
//       deviceId,
//       originalUrl: url,
//       downloadUrl: apiDownloadUrl,
//       fileKey,
//       platform: result.source || "unknown",
//       title: result.title || "Untitled",
//       thumbnail: result.thumbnail || "",
//       duration: result.duration || 0,
//       status: "pending",
//     });

//     // 5️⃣ respond immediately
//     res.status(200).json({
//       success: true,
//       message: "Video fetched successfully",
//       data: record,
//     });

//     // 6️⃣ background upload process
//     process.nextTick(async () => {
//       try {
//         await Download.updateOne({ _id: record._id }, { status: "processing" });

//         // VIDEO STREAM
//         const videoStream = await axios({
//           url: apiDownloadUrl,
//           method: "GET",
//           responseType: "stream",
//         });

//         await uploadToS3(videoStream.data, fileKey);

//         const cdnUrl = `https://${process.env.CDN_DOMAIN}/${fileKey}`;

//         // THUMBNAIL STREAM
//         const thumbStream = await axios({
//           url: result.thumbnail,
//           method: "GET",
//           responseType: "stream",
//         });

//         const thumbKey = `thumbnails/${videoId}.jpg`;

//         await uploadToS3(thumbStream.data, thumbKey, "image/jpeg");

//         const thumbnailCdn = `https://${process.env.CDN_DOMAIN}/${thumbKey}`;

//         await Download.updateOne(
//           { _id: record._id },
//           {
//             status: "ready",
//             cdnUrl,
//             thumbnailCdn,
//           },
//         );
//         console.log("✅ Upload completed:", cdnUrl);
//       } catch (err) {
//         console.error("Background upload error", err);

//         await Download.updateOne({ _id: record._id }, { status: "failed" });
//       }
//     });
//   } catch (error) {
//     console.error("❌ Download Error:", error.response?.data || error.message);

//     return res.status(500).json({
//       success: false,
//       message: "Download failed",
//       error: error.response?.data || error.message,
//     });
//   }
// };
