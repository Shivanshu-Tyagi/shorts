const express = require("express");
const router = express.Router();

const controller = require("../controllers/stats.controller");
router.post("/shorts/:id/share", controller.incrementShare);
router.post("/shorts/:id/download", controller.incrementDownload);
router.post("/shorts/:id/save", controller.toggleSave);
router.post("/shorts/:id/view", controller.incrementViews);
router.post("/shorts/:id/like", controller.toggleLike);

module.exports = router;



