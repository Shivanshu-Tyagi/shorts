exports.extractSourceId = (url) => {

  try {

    const parsed = new URL(url);

    const parts = parsed.pathname.split("/").filter(Boolean);

    return parts[parts.length - 1];

  } catch (e) {

    return null;

  }

};