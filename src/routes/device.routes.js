const express = require("express");
const router = express.Router();

const deviceController = require("../controllers/device.controller");
const settingController = require("../controllers/setting.controller");

router.post("/device/register", deviceController.registerDevice);

router.get("/ads-config", settingController.getAdsConfig);

module.exports = router;