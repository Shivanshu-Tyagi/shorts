const cron = require("node-cron");
const { sendTopicNotification } = require("../services/notification.service");
const templates = require("../templates/notification.templates");

// Morning notification
cron.schedule(
  "0 10 * * *",
  async () => {
    try {
      console.log("Sending morning promo");

      await sendTopicNotification(
        "all_users",
        templates.trendingPromo.title,
        templates.trendingPromo.body
      );

      console.log("Morning notification sent");
    } catch (err) {
      console.error("Morning cron error:", err.message);
    }
  },
  {
    timezone: "Asia/Kolkata"
  }
);

// Evening notification
cron.schedule(
  "0 20 * * *",
  async () => {
    try {
      console.log("Sending evening promo");

      await sendTopicNotification(
        "all_users",
        templates.eveningPromo.title,
        templates.eveningPromo.body
      );

      console.log("Evening notification sent");
    } catch (err) {
      console.error("Evening cron error:", err.message);
    }
  },
  {
    timezone: "Asia/Kolkata"
  }
);