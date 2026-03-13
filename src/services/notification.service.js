const admin = require("../config/firebase");

const sendTopicNotification = async (topic, title, body, data = {}) => {

  const message = {

    topic,

    notification: {
      title,
      body
    },

    data

  };

  try {

    await admin.messaging().send(message);

    console.log("Topic notification sent");

  } catch (err) {

    console.error("Topic notification error:", err);

  }

};

module.exports = { sendTopicNotification };