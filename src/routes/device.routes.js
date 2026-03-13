const express = require("express");
const router = express.Router();

const deviceController = require("../controllers/device.controller");

router.post("/device/register", (req,res,next)=>{

  console.log("🔥 DEVICE REGISTER ROUTE HIT");

  next();

}, deviceController.registerDevice);

module.exports = router;