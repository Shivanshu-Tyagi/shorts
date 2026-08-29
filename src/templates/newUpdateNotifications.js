const Device = require("../models/device.model");
const {
  sendMulticastNotification,
} = require("../services/multi_notification.service");

const BATCH_SIZE = 500;

const shortsUpdateNotificationJob = async () => {
  const totalDevices = await Device.countDocuments({});
  const devicesWithToken =
    await Device.countDocuments({
      fcmToken: {
        $type: "string",
        $ne: "",
      },
    });

  console.log(
    "Total Devices:",
    totalDevices
  );

  console.log(
    "Devices With FCM Token:",
    devicesWithToken
  );

  let lastId = null;

  let processedDevices = 0;
  let totalSuccess = 0;
  let totalFailed = 0;

  while (true) {
    const query = {
      fcmToken: {
        $type: "string",
        $ne: "",
      },
    };

    if (lastId) {
      query._id = {
        $gt: lastId,
      };
    }

    const devices = await Device.find(query)
      .select("_id fcmToken")
      .sort({ _id: 1 })
      .limit(BATCH_SIZE)
      .lean();

    if (!devices.length) {
      break;
    }

    const tokens = [
      ...new Set(
        devices
          .map((device) => device.fcmToken)
          .filter(
            (token) =>
              typeof token === "string" &&
              token.trim().length > 0
          )
      ),
    ];

    console.log(
      `Batch Devices: ${devices.length}, Tokens: ${tokens.length}`
    );

    if (tokens.length) {
      const result =
        await sendMulticastNotification({
          tokens,

          title:
            "🚀 Shorts Downloader का नया Update!",

          body:
            "अब किसी भी platform से Shorts सिर्फ 1 सेकंड में डाउनलोड करें ⚡ अभी Try करें!",

          data: {
            type: "update",
            screen: "home",
            update_url:
              "https://play.google.com/store/apps/details?id=com.stackearn.shorts_downloader",
          },
        });

      totalSuccess +=
        result.successCount || 0;

      totalFailed +=
        result.failureCount || 0;

      console.log(
        "Batch Result:",
        {
          success: result.successCount,
          failed: result.failureCount,
          errors: result.errorCounts,
        }
      );
    }

    processedDevices += devices.length;

    lastId =
      devices[devices.length - 1]._id;

    console.log(
      `Processed: ${processedDevices}, Success: ${totalSuccess}, Failed: ${totalFailed}`
    );

    if (devices.length < BATCH_SIZE) {
      break;
    }
  }

  const finalResult = {
    totalDevices,
    devicesWithToken,
    processedDevices,
    totalSuccess,
    totalFailed,
  };

  console.log(
    "========== SHORTS UPDATE JOB COMPLETED =========="
  );

  console.log(
    finalResult
  );

  console.log(
    "No FCM tokens were deleted or modified."
  );

  return finalResult;
};

module.exports =
  shortsUpdateNotificationJob;