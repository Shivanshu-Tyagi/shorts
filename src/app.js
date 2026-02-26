const express = require("express");
const mongoose = require("mongoose");
require("dotenv").config();

const mediaRoutes = require("./routes/media.routes");
const downloadRoutes = require("./routes/download.routes");

const app = express();

app.use(express.json());

app.use("/", mediaRoutes);
app.use("/api", downloadRoutes);

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URL);
    console.log("✅ MongoDB Connected");
  } catch (error) {
    console.error("❌ MongoDB Connection Failed:", error.message);
    process.exit(1);
  }
};

module.exports = { app, connectDB };