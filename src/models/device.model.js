const mongoose = require("mongoose");

const DeviceSchema = new mongoose.Schema({

  deviceId: {
    type: String,
    required: true,
    unique: true
  },

  fcmToken: {
    type: String,
    required: true
  },

  createdAt: {
    type: Date,
    default: Date.now
  }

});

module.exports = mongoose.model("Device", DeviceSchema);