const axios = require("axios");

exports.getVideoInfo = async (url) => {

  const response = await axios.post(
    process.env.RAPID_API_HOST,
    { url },
    {
      headers: {
        "x-rapidapi-key": process.env.RAPID_API_KEY,
        "x-rapidapi-host": "social-download-all-in-one.p.rapidapi.com",
        "Content-Type": "application/json"
      }
    }
  );

  return response.data;
};