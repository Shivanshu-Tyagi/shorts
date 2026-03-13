const { S3Client } = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_KEY,
    secretAccessKey: process.env.AWS_SECRET
  }
});

exports.uploadToS3 = async (stream, fileKey, contentType = "video/mp4") => {

  console.log("Uploading to S3 with key:", process.env.BUCKET);

  const upload = new Upload({
    client: s3,
    params: {
      Bucket: process.env.BUCKET,
      Key: fileKey,
      Body: stream,
      ContentType: contentType
    },
    queueSize: 4,
    partSize: 5 * 1024 * 1024
  });

  await upload.done();

  return fileKey;
};