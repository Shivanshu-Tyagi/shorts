const admin = require("../config/firebase");

const sendTopicNotification = async (
  topic,
  title,
  body,
  data = {}
) => {
  const message = {
    topic,
    notification: {
      title,
      body,
    },
    data: Object.fromEntries(
      Object.entries(data).map(([key, value]) => [
        key,
        String(value),
      ])
    ),
    android: {
      priority: "high",
      notification: {
        sound: "default",
        channelId: "default",
      },
    },
    apns: {
      payload: {
        aps: {
          sound: "default",
        },
      },
    },
  };

  try {
    const response =
      await admin.messaging().send(message);

    console.log("Topic notification sent:", response);

    return {
      success: true,
      messageId: response,
    };
  } catch (err) {
    console.error(
      "Topic notification error:",
      err.message
    );

    throw err;
  }
};


module.exports = {
  sendTopicNotification
};