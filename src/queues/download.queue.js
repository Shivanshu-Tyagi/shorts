const { Queue } = require("bullmq");
const IORedis = require("ioredis");

const connection = new IORedis(process.env.REDIS_URL);

const downloadQueue = new Queue("video-download", {
  connection
});

// Named exports (the only importer was the download controller, rewritten alongside).
// `connection` is exposed so callers can cheaply check readiness BEFORE spending
// provider money on a request that could not be queued anyway.
module.exports = { downloadQueue, connection };
