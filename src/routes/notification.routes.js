const express = require("express");
const router = express.Router();

const {
  sendMulticastNotification,
} = require("../services/notification.service");

router.post("/test-notification", async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({
        success: false,
        message: "FCM token is required",
      });
    }

    const result =
      await sendMulticastNotification({
        tokens: [token],
        title: "🚀 Shorts Downloader का नया Update!",
        body: "अब किसी भी प्लेटफॉर्म से Shorts डाउनलोड करें सिर्फ 1 सेकंड में! ⚡ नया अपडेट अभी इस्तेमाल करें और फास्ट डाउनलोडिंग का मज़ा लें। 🔥",
        data: {
          type: "SHORTS_UPDATE",
          screen: "home",
        },
      });

    return res.status(200).json({
      success: true,
      message: "Notification request completed",
      result,
    });
  } catch (error) {
    console.error(
      "Manual notification error:",
      error
    );

    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

module.exports = router;