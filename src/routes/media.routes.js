const express = require("express");
const router = express.Router();
const mediaController = require("../controllers/media.controller");

router.get("/media/:fileKey", mediaController.streamVideo);

module.exports = router;