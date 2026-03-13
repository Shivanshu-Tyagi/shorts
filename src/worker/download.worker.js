const { Worker } = require("bullmq");
const axios = require("axios");
const Download = require("../models/download.model");
const { uploadToS3 } = require("../services/s3.service");
const { connection } = require("../config/radis");

const worker = new Worker(
  "video-download",
  async (job) => {

    console.log("Processing job:", job.data);

    const { videoId, videoUrl, thumbnail, fileKey } = job.data;

    try {

      console.log("Updating status to processing");

      await Download.updateOne(
        { _id: videoId },
        { status: "processing" }
      );

      console.log("Downloading video...");

      const videoStream = await axios({
        url: videoUrl,
        method: "GET",
        responseType: "stream"
      });

      console.log("Uploading video to S3...");

      await uploadToS3(videoStream.data, fileKey);

      const cdnUrl = `https://${process.env.CDN_URL}/${fileKey}`;

      console.log("Video uploaded:", cdnUrl);

      const thumbKey = `thumbnails/${videoId}.jpg`;

      const thumbStream = await axios({
        url: thumbnail,
        method: "GET",
        responseType: "stream"
      });

      await uploadToS3(thumbStream.data, thumbKey, "image/jpeg");

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

      console.log("Job completed");

    } catch (err) {

      console.error("Worker error:", err);

      await Download.updateOne(
        { _id: videoId },
        { status: "failed" }
      );

    }

  },
  { connection }
);