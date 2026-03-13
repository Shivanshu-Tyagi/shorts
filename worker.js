require("dotenv").config();

const mongoose = require("mongoose");

async function startWorker() {

  try {

    await mongoose.connect(process.env.MONGO_URL);

    console.log("MongoDB connected (worker)");

    require("./src/worker/download.worker");

    console.log("Worker started...");

  } catch (err) {

    console.error("Worker DB connection error:", err);

  }

}

startWorker();