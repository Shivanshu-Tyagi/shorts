const axios = require("axios");

exports.downloadFromPython = async (url) => {
  const response = await axios.post("http://127.0.0.1:8000/download", {
    url
  });

  return response.data;
};
