const express = require("express");
const router = express.Router();

const quotaController = require("../controllers/quota.controller");
const ssvController = require("../controllers/ssv.controller");
const adminController = require("../controllers/adminSettings.controller");
const { config } = require("../config");
const { quotaLimiters } = require("../middleware/rateLimit");

const limiters = quotaLimiters(config);

router.get("/quota", ...limiters, quotaController.getQuota);
router.post("/quota/reward/start", ...limiters, quotaController.startReward);
router.post("/quota/reward/claim", ...limiters, quotaController.claimReward);
router.get("/ads/ssv", ssvController.handleSsv);
router.get("/internal/settings/:appId", adminController.getSettings);
router.put("/internal/settings/:appId", adminController.putSettings);

module.exports = router;
