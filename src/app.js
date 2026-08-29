const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");

require("dotenv").config();

const mediaRoutes = require("./routes/media.routes");
const downloadRoutes = require("./routes/download.routes");
const deviceRoutes = require("./routes/device.routes");
const statsRoutes = require("./routes/stats.routes");
const notificationRoutes = require("./routes/notification.routes");


const app = express();

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
app.use("/api", deviceRoutes);
app.use("/api", statsRoutes);
app.use("/api", notificationRoutes);
app.get("/health", (req, res) => {
  res.status(200).json({
    success: true,
    message: "Server running",
  });
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

startServer();


module.exports = {
  app,
  connectDB,
};