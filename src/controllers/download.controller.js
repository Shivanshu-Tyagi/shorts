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

//     console.log("🔗 API URL:", url);

//     // 1️⃣ Call Apify
//     const apifyResponse = await axios.post(
//       `https://api.apify.com/v2/acts/wilcode~all-social-media-video-downloader/run-sync-get-dataset-items?token=${process.env.APIFY_TOKEN}`,
//       {
//         url: url,
//         proxySettings: {
//           useApifyProxy: true,
//           apifyProxyGroups: ["RESIDENTIAL"],
//           apifyProxyCountry: "US",
//         },
//       }
//     );

//     const result = apifyResponse.data?.[0];

//     if (!result || !result.formats) {
//       return res.status(400).json({
//         success: false,
//         message: "Video data not found",
//       });
//     }

//     // 2️⃣ Select best video-only format, prefer 608x1080
//     const videoFormats = result.formats
//       .filter(f =>
//         f.url &&
//         f.resolution &&
//         f.resolution.includes("x") &&
//         f.resolution !== "audio only"
//       )
//       .map(f => ({ ...f, height: parseInt(f.resolution.split("x")[1]) || 0 }))
//       .sort((a, b) => b.height - a.height);

//     if (!videoFormats.length) {
//       return res.status(400).json({
//         success: false,
//         message: "No suitable video format found",
//       });
//     }

//     // Prefer 608x1080 if exists
//     let selectedFormat = videoFormats.find(f => f.resolution === "608x1080");
//     if (!selectedFormat) selectedFormat = videoFormats[0];

//     const apiDownloadUrl = selectedFormat.url;
//     const thumbnail = result.thumbnailUrl || "";

//     console.log("🎥 Selected:", selectedFormat.resolution);
// //
// //    // 3️⃣ Fetch video as stream
// //    const videoResponse = await axios({
// //      url: apiDownloadUrl,
// //      method: "GET",
// //      responseType: "stream",
// //    });

//     // 4️⃣ Create S3 key (device-based folder)
//     const fileName = `${uuidv4()}.mp4`;
//     const fileKey = `videos/${deviceId}/${fileName}`;

//     // 5️⃣ Upload to S3
// //    await uploadToS3(videoResponse.data, fileKey);
// //    console.log("☁ Video uploaded to S3 with key:", fileKey);

//     // 6️⃣ Save in Mongo
//     const savedData = await Download.create({
//       deviceId,
//       originalUrl: url,          // API signed URL
//       downloadUrl: apiDownloadUrl, // API signed URL (response me bhi)
//       fileKey: fileKey,          // S3 key for internal storage
//       platform: result.source || "unknown",
//       title: result.title || "Untitled",
//       thumbnail: thumbnail,
//       duration: result.duration || 0,
//     });

//     // 7️⃣ Response (Apify URL + thumbnail)
//     return res.status(200).json({
//       success: true,
//       message: "Video uploaded to S3 successfully",
// //      downloadUrl: apiDownloadUrl,
//       thumbnail: thumbnail,
//       data: savedData,
//     });

//   } catch (error) {
//     console.error("❌ Download Error:", error.message);
//     return res.status(500).json({
//       success: false,
//       message: "Download failed",
//       error: error.message,
//     });
//   }
// };


const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const Download = require("../models/download.model");
const { uploadToS3 } = require("../utils/s3Client");

exports.downloadVideo = async (req, res) => {
  try {
    const { url, deviceId } = req.body;

    if (!url || !deviceId) {
      return res.status(400).json({
        success: false,
        message: "url and deviceId required",
      });
    }

    console.log("🔗 API URL:", url);

    // 1️⃣ Call RapidAPI
    const rapidResponse = await axios.post(
      `${process.env.RAPID_API_HOST}`,
      { url },
      {
        headers: {
          "x-rapidapi-key": process.env.RAPID_API_KEY,
          "x-rapidapi-host": "social-download-all-in-one.p.rapidapi.com",
          "Content-Type": "application/json",
        },
      }
    );

    const result = rapidResponse.data;

    if (!result || !result.medias || !result.medias.length) {
      return res.status(400).json({
        success: false,
        message: "Video data not found",
      });
    }

    // 2️⃣ Filter only video files
    const videos = result.medias.filter(
      media => media.type === "video" && media.url
    );

    if (!videos.length) {
      return res.status(400).json({
        success: false,
        message: "No video format available",
      });
    }

    // 3️⃣ Prefer best quality
    let selectedFormat =
      videos.find(v => v.quality === "hd_no_watermark") ||
      videos.find(v => v.quality === "no_watermark") ||
      videos.find(v => v.quality === "watermark") ||
      videos[0];

    const apiDownloadUrl = selectedFormat.url;

    console.log("🎥 Selected quality:", selectedFormat.quality);

    // 4️⃣ Create S3 key
    const fileName = `${uuidv4()}.mp4`;
    const fileKey = `videos/${deviceId}/${fileName}`;

    // OPTIONAL S3 Upload (uncomment if needed)
    
    // const videoResponse = await axios({
    //   url: apiDownloadUrl,
    //   method: "GET",
    //   responseType: "stream",
    // });

    // await uploadToS3(videoResponse.data, fileKey);
    

    // 5️⃣ Save in Mongo
    const savedData = await Download.create({
      deviceId,
      originalUrl: url,
      downloadUrl: apiDownloadUrl,
      fileKey,
      platform: result.source || "unknown",
      title: result.title || "Untitled",
      thumbnail: result.thumbnail || "",
      duration: result.duration || 0,
    });

    return res.status(200).json({
      success: true,
      message: "Video fetched successfully",
      // downloadUrl: apiDownloadUrl,
      // thumbnail: result.thumbnail,
      data: savedData,
    });

  } catch (error) {
    console.error("❌ Download Error:", error.response?.data || error.message);

    return res.status(500).json({
      success: false,
      message: "Download failed",
      error: error.response?.data || error.message,
    });
  }
};