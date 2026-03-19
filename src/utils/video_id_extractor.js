const extractVideoIdFromUrl = (url) => {
  if (!url) return null;

  try {
    const parts = url.split("/");
    const fileName = parts[parts.length - 1]; 
    return fileName.split(".")[0]; 
  } catch (err) {
    return null;
  }
};