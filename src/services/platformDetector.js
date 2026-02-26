exports.detectPlatform = (url) => {
  if (url.includes("instagram.com")) return "instagram";
  if (url.includes("facebook.com")) return "facebook";
  if (url.includes("short")) return "short-video";

  return "unsupported";
};
