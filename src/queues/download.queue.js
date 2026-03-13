const { Queue } = require("bullmq");
const IORedis = require("ioredis");

const connection = new IORedis(process.env.REDIS_URL);

const downloadQueue = new Queue("video-download", {
  connection
});

module.exports = downloadQueue;