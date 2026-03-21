exports.getVideoInfo = async (url, retries = 3) => {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await axios.post(
        process.env.RAPID_API_HOST,
        { url },
        {
          timeout: 15000,
          headers: {
            "x-rapidapi-key": process.env.RAPID_API_KEY,
            "x-rapidapi-host": "social-download-all-in-one.p.rapidapi.com",
            "Content-Type": "application/json"
          }
        }
      );

      return response.data;

    } catch (err) {
      console.log("RapidAPI retry:", i + 1);

      if (i === retries - 1) throw err;

      await new Promise(r => setTimeout(r, 2000));
    }
  }
};