const { generateToken } = require("../utils/token");

/*
  IMPORTANT:
  yahan assume kiya gaya hai ki metadata.service
  hume ek PUBLIC MP4 URL deta hai
*/

exports.createStreamingLink = (videoUrl) => {
  const token = generateToken({ videoUrl });

  return {
    streamUrl: `/api/v1/download/stream/${token}`,
    expiresIn: "5 minutes",
  };
};
