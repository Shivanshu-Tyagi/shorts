const admin = require("../config/firebase");

const sendTopicNotification = async (topic, title, body, data = {}) => {

  const message = {
    topic: topic,

    notification: {
      title: title,
      body: body
    },

    data: data,

    android: {
      priority: "high",
      notification: {
        sound: "default",
        channelId: "default"
      }
    },

    apns: {
      payload: {
        aps: {
          sound: "default"
        }
      }
    }

  };

  try {

    const response = await admin.messaging().send(message);

    console.log("Topic notification sent:", response);

    return response;

  } catch (err) {

    console.error("Topic notification error:", err.message);

    throw err;

  }

};

module.exports = { sendTopicNotification };