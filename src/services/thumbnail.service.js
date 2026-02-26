const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const path = require("path");
const fs = require("fs-extra");

ffmpeg.setFfmpegPath(ffmpegPath);

exports.generateThumbnail = async (videoUrl) => {
  const id = Date.now();

  const publicDir = path.join(__dirname, "../../src/public/thumbnails");
  await fs.ensureDir(publicDir);

  const thumbPath = path.join(publicDir, `thumb-${id}.jpg`);

  return new Promise((resolve, reject) => {
    ffmpeg(videoUrl) // ✅ STREAM DIRECTLY FROM URL
      .inputOptions([
        "-headers",
        "User-Agent: Mozilla/5.0",
      ])
      .on("error", (err) => {
        console.error("FFmpeg error:", err.message);
        reject(err);
      })
      .on("end", () => {
        resolve(`/public/thumbnails/${path.basename(thumbPath)}`);
      })
      .screenshots({
        timestamps: ["2"],
        filename: path.basename(thumbPath),
        folder: path.dirname(thumbPath),
        size: "480x?",
      });
  });
};
