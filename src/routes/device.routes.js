const express = require("express");
const router = express.Router();

const deviceController = require("../controllers/device.controller");
const settingController = require("../controllers/setting.controller");
const vydoSettingController = require("../controllers/vydoSetting.controller");

console.log(typeof deviceController.registerDevice);
console.log(typeof settingController.getAdsConfig);

router.post("/device/register", deviceController.registerDevice);

router.get("/ads-config", settingController.getAdsConfig);
router.get("/vydo-ads-config", vydoSettingController.getVydoAdsConfig);
module.exports = router;