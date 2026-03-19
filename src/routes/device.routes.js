const express = require("express");
const router = express.Router();

const deviceController = require("../controllers/device.controller");

router.post("/device/register", deviceController.registerDevice);

module.exports = router;