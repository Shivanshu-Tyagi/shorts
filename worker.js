require("dotenv").config();

const mongoose = require("mongoose");

async function startWorker() {
  try {

    // MongoDB connect
    await mongoose.connect(process.env.MONGO_URL, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000
    });

    console.log("✅ MongoDB connected (worker)");

    // start worker
    require("./src/worker/download.worker");

    console.log("🚀 Worker started...");

  } catch (err) {
    console.error("❌ Worker DB connection error:", err);
    process.exit(1);
  }
}

// global error handlers
process.on("unhandledRejection", (err) => {
  console.error("Unhandled Rejection:", err);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
  process.exit(1);
});

// graceful shutdown
process.on("SIGINT", async () => {
  console.log("Worker shutting down...");
  await mongoose.connection.close();
  process.exit(0);
});

startWorker();