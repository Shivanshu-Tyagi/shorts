const express = require("express");
const mongoose = require("mongoose");
require("dotenv").config();

const mediaRoutes = require("./routes/media.routes");
const downloadRoutes = require("./routes/download.routes");
const deviceRoutes = require("./routes/device.routes");
const statsRoutes = require("./routes/stats.routes");

// start cron jobs
require("./jobs/notification.cron");

const app = express();

app.use(express.json());

// routes
app.use("/api", mediaRoutes);
app.use("/api", downloadRoutes);
app.use("/api", deviceRoutes);
app.use("/api", statsRoutes);

// health check
app.get("/health", (req, res) => {
  res.json({
    success: true,
    message: "Server running"
  });
});

const connectDB = async () => {
  try {

    await mongoose.connect(process.env.MONGO_URL, {
      maxPoolSize: 10
    });

    console.log("✅ MongoDB Connected");

  } catch (error) {

    console.error("❌ MongoDB Connection Failed:", error.message);
    process.exit(1);

  }
};

module.exports = { app, connectDB };