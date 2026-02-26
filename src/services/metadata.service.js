const { generateThumbnail } = require("./thumbnail.service");

exports.fetchMetadataService = async (videoUrl, platform) => {
  const thumbnailUrl = await generateThumbnail(videoUrl);

  return {
    title: "Public Short Video",
    thumbnail: thumbnailUrl, 
    duration: 15, 
    platform,
    directVideoUrl: videoUrl,
  };
};
