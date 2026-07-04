// const { Worker } = require("bullmq");
// const axios = require("axios");
// const fs = require("fs");
// const path = require("path");
// const ffmpeg = require("fluent-ffmpeg");
// const ffmpegPath = require("ffmpeg-static");

// const Download = require("../models/download.model");
// // const Device = require("../models/device.model");

// const { uploadToS3 } = require("../services/s3.service");
// // const { sendNotification } = require("../services/notification.service");

// // const templates = require("../templates/notification.templates");

// const { connection } = require("../config/redis");

// ffmpeg.setFfmpegPath(ffmpegPath);

// const TMP_DIR = path.join(__dirname, "../../tmp");

// if (!fs.existsSync(TMP_DIR)) {
//   fs.mkdirSync(TMP_DIR, { recursive: true });
// }

// // generate thumbnail
// function generateThumbnail(videoPath, thumbnailPath) {
//   return new Promise((resolve, reject) => {
//     ffmpeg(videoPath)
//       .screenshots({
//         timestamps: ["2"],
//         filename: path.basename(thumbnailPath),
//         folder: TMP_DIR,
//         size: "1080x1920"
//       })
//       .on("end", resolve)
//       .on("error", reject);
//   });
// }

// const worker = new Worker(
//   "video-download",
//   async (job) => {

//     console.log("Processing job:", job.data);

//     const { videoId, videoUrl, fileKey, deviceId, title } = job.data;

//     const videoPath = path.join(TMP_DIR, `${videoId}.mp4`);
//     const thumbPath = path.join(TMP_DIR, `${videoId}.jpg`);

//     try {

//       console.log("Updating status → processing");

//       await Download.updateOne(
//         { _id: videoId },
//         { status: "processing" }
//       );

//       // download video
//       console.log("Downloading video...");

//       const response = await axios({
//         url: videoUrl,
//         method: "GET",
//         responseType: "stream"
//       });

//       const writer = fs.createWriteStream(videoPath);

//       response.data.pipe(writer);

//       await new Promise((resolve, reject) => {
//         writer.on("finish", resolve);
//         writer.on("error", reject);
//       });

//       console.log("Video downloaded");

//       // generate thumbnail
//       console.log("Generating thumbnail...");

//       await generateThumbnail(videoPath, thumbPath);

//       console.log("Thumbnail created");

//       // upload video to S3
//       console.log("Uploading video to S3...");

//       await uploadToS3(
//         fs.createReadStream(videoPath),
//         fileKey,
//         "video/mp4"
//       );

//       const cdnUrl = `https://${process.env.CDN_DOMAIN}/${fileKey}`;

//       console.log("Video uploaded:", cdnUrl);

//       // upload thumbnail
//       const thumbKey = `thumbnails/${videoId}.jpg`;

//       await uploadToS3(
//         fs.createReadStream(thumbPath),
//         thumbKey,
//         "image/jpeg"
//       );

//       const thumbnailCdn = `https://${process.env.CDN_DOMAIN}/${thumbKey}`;

//       console.log("Updating DB...");

//       await Download.updateOne(
//         { _id: videoId },
//         {
//           status: "ready",
//           cdnUrl,
//           thumbnailCdn
//         }
//       );

//       console.log("DB Updated");

//       // send notification
//       // const device = await Device.findOne({ deviceId });

//       // if (device?.fcmToken) {

//       //   const template = templates.downloadSuccess(title || "Video");

//       //   await sendNotification(
//       //     device.fcmToken,
//       //     template.title,
//       //     template.body,
//       //     {
//       //       type: "video",
//       //       videoUrl: cdnUrl,
//       //       thumbnail: thumbnailCdn,
//       //       title: title || "Video Ready"
//       //     }
//       //   );

//       //   console.log("Notification sent");

//       // }

//       console.log("Job completed:", videoId);

//     } catch (err) {

//       console.error("Worker error:", err);

//       await Download.updateOne(
//         { _id: videoId },
//         { status: "failed" }
//       );

//     } finally {

//       // cleanup temp files
//       if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
//       if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);

//     }

//   },
//   {
//     connection,
//     concurrency: 3
//   }
// );

// module.exports = worker;


const { Worker } = require("bullmq");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");

const Download = require("../models/download.model");
const { uploadToS3 } = require("../services/s3.service");
const { getVideoInfo } = require("../services/rapidapi.service");
const { connection } = require("../config/redis");

ffmpeg.setFfmpegPath(ffmpegPath);

const TMP_DIR = path.join(__dirname, "../../tmp");

if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

// 🔥 Retry download
async function downloadWithRetry(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await axios({
        url,
        method: "GET",
        responseType: "stream",
        timeout: 30000,
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Referer": "https://www.instagram.com/"
        }
      });
    } catch (err) {
      console.log(`Download retry ${i + 1}`);

      if (i === retries - 1) throw err;

      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

// thumbnail
function generateThumbnail(videoPath, thumbnailPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .screenshots({
        timestamps: ["2"],
        filename: path.basename(thumbnailPath),
        folder: TMP_DIR,
        size: "1080x1920"
      })
      .on("end", resolve)
      .on("error", reject);
  });
}

// 🔥 Worker
const downloadWorker = new Worker(
  "video-download",
  async (job) => {

    console.log("Processing job:", job.data);

    const { videoId, originalUrl, fileKey } = job.data;

    const videoPath = path.join(TMP_DIR, `${videoId}.mp4`);
    const thumbPath = path.join(TMP_DIR, `${videoId}.jpg`);

    try {

      await Download.updateOne(
        { _id: videoId },
        { status: "processing" }
      );

      // 🔥 STEP 1: Fresh URL
      console.log("Fetching fresh URL...");
      const result = await getVideoInfo(originalUrl);

      if (!result?.medias?.length) {
        throw new Error("No media found from API");
      }

      const videos = result.medias.filter(
        (m) => m.type === "video" && m.url
      );

      const selected =
        videos.find((v) => v.quality === "hd_no_watermark") ||
        videos.find((v) => v.quality === "no_watermark") ||
        videos[0];

      if (!selected?.url) throw new Error("No valid video URL");

      console.log("Selected quality:", selected.quality);

      // 🔥 STEP 2: Download
      const response = await downloadWithRetry(selected.url);

      const writer = fs.createWriteStream(videoPath);

      response.data.pipe(writer);

      await new Promise((resolve, reject) => {
        response.data.on("error", reject);
        writer.on("finish", resolve);
        writer.on("error", reject);
      });

      console.log("Video downloaded");

      // thumbnail
      await generateThumbnail(videoPath, thumbPath);

      // upload video
      await uploadToS3(
        fs.createReadStream(videoPath),
        fileKey,
        "video/mp4"
      );

      const cdnUrl = `https://${process.env.CDN_DOMAIN}/${fileKey}`;

      // upload thumbnail
      const thumbKey = `thumbnails/${videoId}.jpg`;

      await uploadToS3(
        fs.createReadStream(thumbPath),
        thumbKey,
        "image/jpeg"
      );

      const thumbnailCdn = `https://${process.env.CDN_DOMAIN}/${thumbKey}`;

      // update DB
      await Download.updateOne(
        { _id: videoId },
        {
          status: "ready",
          cdnUrl,
          thumbnailCdn
        }
      );

      console.log("Job completed:", videoId);

    } catch (err) {

      console.error("Worker error:", err);

      await Download.updateOne(
        { _id: videoId },
        { status: "failed" }
      );

      throw err; // 🔥 retry trigger

    } finally {

      if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
      if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);

    }

  },
  {
    connection,
    concurrency: 1
  }
);

module.exports = downloadWorker;