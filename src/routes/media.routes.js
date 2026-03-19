const express = require("express");
const router = express.Router();

const mediaController = require("../controllers/media.controller");

// Get single short by id
router.get("/shorts/:id", mediaController.getShortById);

module.exports = router;