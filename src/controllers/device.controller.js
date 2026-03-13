const admin = require("../config/firebase");
const Device = require("../models/device.model");

exports.registerDevice = async (req, res) => {

  try {

    const { deviceId, fcmToken } = req.body;

    if (!deviceId || !fcmToken) {
      return res.status(400).json({
        success:false,
        message:"deviceId and fcmToken required"
      });
    }

    let device = await Device.findOne({ deviceId });

    if (!device) {

      device = await Device.create({
        deviceId,
        fcmToken
      });

      // subscribe to topic
      try {

        await admin.messaging().subscribeToTopic(
          [fcmToken],
          "all_users"
        );

        console.log("Device subscribed to topic");

      } catch (err) {

        console.error("Topic subscribe error:", err.message);

      }

      // send welcome notification
      try {

        await admin.messaging().send({
          token: fcmToken,
          notification: {
            title: "🎉 Welcome to StackEarn",
            body: "Download HD Shorts instantly 🚀"
          },
          data:{
            type:"welcome"
          }
        });

        console.log("Welcome notification sent");

      } catch (err) {

        console.error("Welcome notification error:", err.message);

      }

    } else {

      device.fcmToken = fcmToken;
      await device.save();

    }

    return res.json({
      success:true,
      message:"Device registered",
      data:fcmToken
    });

  } catch (err) {

    console.error("Device register error:", err);

    return res.status(500).json({
      success:false,
      message:"Device registration failed"
    });

  }

};