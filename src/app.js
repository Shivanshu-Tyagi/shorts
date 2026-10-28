const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");

require("dotenv").config();

const { config } = require("./config");
const { sendError, AppError } = require("./utils/errors");
const mediaRoutes = require("./routes/media.routes");
const downloadRoutes = require("./routes/download.routes");
const quotaRoutes = require("./routes/quota.routes");
const deviceRoutes = require("./routes/device.routes");
const statsRoutes = require("./routes/stats.routes");
const notificationRoutes = require("./routes/notification.routes");


const app = express();

if (config.trustProxy) {
  app.set("trust proxy", /^\d+$/.test(config.trustProxy) ? Number(config.trustProxy) : config.trustProxy);
}

app.use(
  cors({
    origin: [
      "http://192.168.1.44:8080",
      "http://localhost:8080",
      "http://localhost:5173",
      "https://shorts.stackearn.com",
      "https://stackearn.com",
      "https://www.stackearn.com",
      "https://e2d5942a-b0d1-4b6f-a3d9-2b630cd20b9a.lovableproject.com",
    ],
    methods: [
      "GET",
      "POST",
      "PUT",
      "DELETE",
      "OPTIONS",
    ],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
    ],
  })
);

// Download endpoints only ever need a tiny JSON body: reject anything bigger early.
app.use(["/api/download", "/api/download-all", "/api/quota", "/api/internal"], express.json({ limit: "16kb" }));

app.use(
  express.json({
    limit: "50mb",
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "50mb",
  })
);

app.use("/api", mediaRoutes);
app.use("/api", downloadRoutes);
app.use("/api", quotaRoutes);
app.use("/api", deviceRoutes);
app.use("/api", statsRoutes);
app.use("/api", notificationRoutes);
app.get("/health", (req, res) => {
  res.status(200).json({
    success: true,
    message: "Server running",
  });
});

// Consistent JSON errors (bad JSON, oversize body, anything uncaught).
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && (err.status === 413 || err.type === "entity.too.large"))
    return res.status(413).json({ success: false, code: "PAYLOAD_TOO_LARGE", message: "Request body too large" });
  if (err && err.type === "entity.parse.failed")
    return sendError(res, new AppError("INVALID_REQUEST", "Invalid JSON body"));
  return sendError(res, err);
});

const connectDB = async () => {
  try {
    if (!process.env.MONGO_URL) {
      throw new Error(
        "MONGO_URL is not defined in .env"
      );
    }

    await mongoose.connect(
      process.env.MONGO_URL,
      {
        maxPoolSize: 10,
        serverSelectionTimeoutMS: 10000,
        socketTimeoutMS: 45000,
        autoIndex: process.env.MONGO_AUTO_INDEX !== "false",
      }
    );


    mongoose.connection.on(
      "error",
      (error) => {
        console.error(
          "MongoDB Error:",
          error.message
        );
      }
    );

    mongoose.connection.on(
      "disconnected",
      () => {
        console.error(
          "MongoDB Disconnected"
        );
      }
    );
  } catch (error) {
    console.error(
      "MongoDB Connection Failed:",
      error.message
    );

    process.exit(1);
  }
};

const startServer = async () => {
  try {
    await connectDB();

    // Warm the queue connection at boot (as the old controller import did).
    require("./services/container").getDownloadService();

    const initCronJobs =
      require("./jobs/notification.cron");

    initCronJobs();

    console.log(
      "Notification cron initialized"
    );

    const PORT =
      process.env.PORT || 5000;

    app.listen(PORT, () => {
      console.log(
        `Server running on port: ${PORT}`
      );
    });
  } catch (error) {
    console.error(
      "Server startup failed:",
      error
    );

    process.exit(1);
  }
};

// Previously this ran on require() AND server.js started a second listener.
// Now it only auto-starts when this file is executed directly.
if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  connectDB,
  startServer,
};