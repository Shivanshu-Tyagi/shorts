const { GetObjectCommand, HeadObjectCommand } = require("@aws-sdk/client-s3");
const { s3 } = require("../services/s3.service");

exports.streamVideo = async (req, res) => {
  try {
    const { fileKey } = req.params;

    if (!fileKey) {
      return res.status(400).json({ message: "fileKey required" });
    }

    const bucket = process.env.BUCKET;

    // 🔹 Get file metadata
    const headCommand = new HeadObjectCommand({
      Bucket: bucket,
      Key: fileKey,
    });

    const headData = await s3.send(headCommand);
    const fileSize = headData.ContentLength;

    const range = req.headers.range;

    if (!range) {
      return res.status(416).send("Range header required");
    }

    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    const chunkSize = end - start + 1;

    const getCommand = new GetObjectCommand({
      Bucket: bucket,
      Key: fileKey,
      Range: `bytes=${start}-${end}`,
    });

    const data = await s3.send(getCommand);

    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunkSize,
      "Content-Type": "video/mp4",
    });

    data.Body.pipe(res);

  } catch (error) {
    console.error("Streaming error:", error);
    res.status(404).json({ message: "Video not found" });
  }
};