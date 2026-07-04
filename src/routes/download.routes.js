const express = require("express");
const router = express.Router();
const controller = require("../controllers/download.controller");
const history = require("../controllers/history.controller");
const feedController = require("../controllers/feed.controller");
const deviceController = require("../controllers/device.controller");

router.post("/download", controller.downloadVideo);
router.get("/history/:deviceId", history.getHistory);
router.get("/feed", feedController.getGlobalFeed);
router.post("/device/register", deviceController.registerDevice);


module.exports = router;

