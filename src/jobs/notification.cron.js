const cron = require("node-cron");

const {
  sendTopicNotification,
} = require("../services/notification.service");

const templates = require("../templates/notification.templates");
const shortsUpdateNotificationJob = require("../templates/newUpdateNotifications");


const initCronJobs = () => {

  ///  SEND MORNING JOB 
  cron.schedule(
    "0 0 9 * * *",
    async () => {
      try {
        console.log(
          "Sending morning trending notification"
        );

        const response =
          await sendTopicNotification(
            "all_users",
            templates.trendingPromo.title,
            templates.trendingPromo.body
          );

        console.log(
          "Morning notification sent:",
          response
        );
      } catch (error) {
        console.error(
          "Morning notification error:",
          error.message
        );
      }
    },
    {
      timezone: "Asia/Kolkata",
    }
  );

  /// AFTNOON WATERMARK JOB
  cron.schedule(
    "0 0 12 * * *",
    async () => {
      try {


        const response =
          await sendTopicNotification(
            "all_users",
            templates.watermarkFree.title,
            templates.watermarkFree.body
          );


      } catch (error) {
        console.error(
          "Morning notification error:",
          error.message
        );
      }
    },
    {
      timezone: "Asia/Kolkata",
    }
  );

  /// AFTNERNOON TRENDING JOB
  cron.schedule(
    "0 30 13 * * *",
    async () => {
      try {
        console.log(
          "Sending afternoon download notification"
        );

        const response =
          await sendTopicNotification(
            "all_users",
            templates.fastDownload.title,
            templates.fastDownload.body
          );

        console.log(
          "Afternoon notification sent:",
          response
        );
      } catch (error) {
        console.error(
          "Afternoon notification error:",
          error.message
        );
      }
    },
    {
      timezone: "Asia/Kolkata",
    }
  );


  /// EVENING NOTIFCIACTUONS JOB 
  cron.schedule(
    "0 30 18 * * *",
    async () => {
      try {
        console.log(
          "Sending evening shorts notification"
        );

        const response =
          await sendTopicNotification(
            "all_users",
            templates.eveningPromo.title,
            templates.eveningPromo.body
          );

        console.log(
          "Evening notification sent:",
          response
        );
      } catch (error) {
        console.error(
          "Evening notification error:",
          error.message
        );
      }
    },
    {
      timezone: "Asia/Kolkata",
    }
  );

  /// NIGHT NOTIFCIACTUONS JOB 
  cron.schedule(
    "0 30 21 * * *",
    async () => {
      try {
        console.log(
          "Sending night shorts notification"
        );

        const response =
          await sendTopicNotification(
            "all_users",
            templates.dailyReminder.title,
            templates.dailyReminder.body
          );

        console.log(
          "night notification sent:",
          response
        );
      } catch (error) {
        console.error(
          "Evening notification error:",
          error.message
        );
      }
    },
    {
      timezone: "Asia/Kolkata",
    }
  );


   /// MID - NIGHT NOTIFCIACTUONS JOB 
    cron.schedule(
    "0 59 23 * * *",
    async () => {
      try {

        const response =
          await sendTopicNotification(
            "all_users",
            templates.youtubeDownload.title,
            templates.youtubeDownload.body
          );
      } catch (error) {
        console.error(
          "Evening notification error:",
          error.message
        );
      }
    },
    {
      timezone: "Asia/Kolkata",
    }
  );


// /// NEW RELASE UPDATE JOB 
// cron.schedule(
//   "30 24 13 * * *",
//   async () => {
//     try {
//       console.log(
//         "Starting Shorts Update Notification"
//       );

//       const result =
//         await shortsUpdateNotificationJob();

//       console.log(
//         "SHORTS NOTIFICATION RESULT:",
//         result
//       );
//     } catch (error) {
//       console.error(
//         "SHORTS NOTIFICATION ERROR:",
//         error
//       );
//     }
//   },
//   {
//     timezone: "Asia/Kolkata",
//   }
// );

  console.log(
    "Notification cron jobs initialized"
  );
};


module.exports = initCronJobs;



