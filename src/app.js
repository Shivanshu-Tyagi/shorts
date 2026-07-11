const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors"); // <-- Add this

require("dotenv").config();

const mediaRoutes = require("./routes/media.routes");
const downloadRoutes = require("./routes/download.routes");
const deviceRoutes = require("./routes/device.routes");
const statsRoutes = require("./routes/stats.routes");

// start cron jobs
require("./jobs/notification.cron");

const app = express();

// CORS
app.use(cors({
  origin: [
    "https://shorts.stackearn.com",
    "https://stackearn.com",
    "https://www.stackearn.com",
    "https://e2d5942a-b0d1-4b6f-a3d9-2b630cd20b9a.lovableproject.com"
  ],
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.options("*", cors()); // Handle preflight requests

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
    console.error("MongoDB Connection Failed:", error.message);
    process.exit(1);
  }
};

module.exports = { app, connectDB };
