const { Worker } = require("bullmq");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");

const Download = require("../models/download.model");
// const Device = require("../models/device.model");

const { uploadToS3 } = require("../services/s3.service");
// const { sendNotification } = require("../services/notification.service");

// const templates = require("../templates/notification.templates");

const { connection } = require("../config/redis");

ffmpeg.setFfmpegPath(ffmpegPath);

const TMP_DIR = path.join(__dirname, "../../tmp");

if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

// generate thumbnail
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

const worker = new Worker(
  "video-download",
  async (job) => {

    console.log("Processing job:", job.data);

    const { videoId, videoUrl, fileKey, deviceId, title } = job.data;

    const videoPath = path.join(TMP_DIR, `${videoId}.mp4`);
    const thumbPath = path.join(TMP_DIR, `${videoId}.jpg`);

    try {

      console.log("Updating status → processing");

      await Download.updateOne(
        { _id: videoId },
        { status: "processing" }
      );

      // download video
      console.log("Downloading video...");

      const response = await axios({
        url: videoUrl,
        method: "GET",
        responseType: "stream"
      });

      const writer = fs.createWriteStream(videoPath);

      response.data.pipe(writer);

      await new Promise((resolve, reject) => {
        writer.on("finish", resolve);
        writer.on("error", reject);
      });

      console.log("Video downloaded");

      // generate thumbnail
      console.log("Generating thumbnail...");

      await generateThumbnail(videoPath, thumbPath);

      console.log("Thumbnail created");

      // upload video to S3
      console.log("Uploading video to S3...");

      await uploadToS3(
        fs.createReadStream(videoPath),
        fileKey,
        "video/mp4"
      );

      const cdnUrl = `https://${process.env.CDN_URL}/${fileKey}`;

      console.log("Video uploaded:", cdnUrl);

      // upload thumbnail
      const thumbKey = `thumbnails/${videoId}.jpg`;

      await uploadToS3(
        fs.createReadStream(thumbPath),
        thumbKey,
        "image/jpeg"
      );

      const thumbnailCdn = `https://${process.env.CDN_URL}/${thumbKey}`;

      console.log("Updating DB...");

      await Download.updateOne(
        { _id: videoId },
        {
          status: "ready",
          cdnUrl,
          thumbnailCdn
        }
      );

      console.log("DB Updated");

      // send notification
      // const device = await Device.findOne({ deviceId });

      // if (device?.fcmToken) {

      //   const template = templates.downloadSuccess(title || "Video");

      //   await sendNotification(
      //     device.fcmToken,
      //     template.title,
      //     template.body,
      //     {
      //       type: "video",
      //       videoUrl: cdnUrl,
      //       thumbnail: thumbnailCdn,
      //       title: title || "Video Ready"
      //     }
      //   );

      //   console.log("Notification sent");

      // }

      console.log("Job completed:", videoId);

    } catch (err) {

      console.error("Worker error:", err);

      await Download.updateOne(
        { _id: videoId },
        { status: "failed" }
      );

    } finally {

      // cleanup temp files
      if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
      if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);

    }

  },
  {
    connection,
    concurrency: 3
  }
);

module.exports = worker;