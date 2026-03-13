const cron = require("node-cron");

const { sendTopicNotification } = require("../services/notification.service");
const templates = require("../templates/notification.templates");

// Morning notification
cron.schedule("0 10 * * *", async () => {

  console.log("Sending morning promo");

  await sendTopicNotification(
    "all_users",
    templates.trendingPromo.title,
    templates.trendingPromo.body
  );

});

// Evening notification
cron.schedule("0 20 * * *", async () => {

  console.log("Sending evening promo");

  await sendTopicNotification(
    "all_users",
    templates.eveningPromo.title,
    templates.eveningPromo.body
  );

});