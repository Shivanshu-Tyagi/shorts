const admin = require("../config/firebase");
const Device = require("../models/device.model");
const templates = require("../templates/notification.templates");

exports.registerDevice = async (req, res) => {

  try {

    const { deviceId, fcmToken } = req.body;

    if (!deviceId || !fcmToken) {
      return res.status(400).json({
        success: false,
        message: "deviceId and fcmToken required"
      });
    }

    let device = await Device.findOne({ deviceId });

    if (device) {

      console.log("Existing device found");

      if (device.fcmToken !== fcmToken) {
        device.fcmToken = fcmToken;
        await device.save();
        console.log("FCM token updated");
      }

    } else {

      console.log("New device detected");

      device = await Device.create({
        deviceId,
        fcmToken
      });

      console.log("Device saved in DB");

      try {
        await admin.messaging().subscribeToTopic([fcmToken], "all_users");
      } catch (e) {
        console.log("Topic subscribe error:", e.message);
      }
    }

    // ✅ Send notification safely
    try {

      const message = {
        token: fcmToken,
        notification: {
          title: templates.welcome.title,
          body: templates.welcome.body
        },
        data: {
          type: "welcome"
        }
      };

      const response = await admin.messaging().send(message);

      console.log("Notification sent:", response);

    } catch (err) {

      console.error("Notification error:", err.code);

      // 🔥 IMPORTANT FIX
      if (err.code === "messaging/registration-token-not-registered") {

        console.log("Invalid token → removing from DB");

        await Device.deleteOne({ deviceId });

      }

    }

    return res.json({
      success: true,
      message: "Device registered successfully"
    });

  } catch (err) {

    console.error("Register error:", err);

    return res.status(500).json({
      success: false,
      message: "Server error"
    });

  }

};