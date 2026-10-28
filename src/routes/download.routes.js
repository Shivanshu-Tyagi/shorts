const express = require("express");
const router = express.Router();
const controller = require("../controllers/download.controller");
const downloadController = require("../controllers/downloadAll.controller");
const history = require("../controllers/history.controller");
const feedController = require("../controllers/feed.controller");
const deviceController = require("../controllers/device.controller");
const metricsController = require("../controllers/metrics.controller");
const { config } = require("../config");
const { downloadLimiters } = require("../middleware/rateLimit");

const limiters = downloadLimiters(config);

router.post("/download", ...limiters, controller.downloadVideo);
router.post("/download-all", ...limiters, downloadController.downloadAllVideo);
router.get("/internal/download-metrics", metricsController.getMetrics);
router.get("/history/:deviceId", history.getHistory);
router.get("/feed", feedController.getGlobalFeed);
router.post("/device/register", deviceController.registerDevice);


module.exports = router;

