const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_KEY,
    secretAccessKey: process.env.AWS_SECRET,
  },
});

exports.uploadToS3 = async (stream, fileKey) => {
  const chunks = [];

  for await (let chunk of stream) {
    chunks.push(chunk);
  }

  const buffer = Buffer.concat(chunks);

  const uploadParams = {
    Bucket: process.env.BUCKET,
    Key: fileKey,
    Body: buffer,
    ContentType: "video/mp4",
    ContentLength: buffer.length,
  };

  await s3.send(new PutObjectCommand(uploadParams));

  return fileKey;
};