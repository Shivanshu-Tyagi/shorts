// PM2 process file: API + queue worker. Start with: pm2 start ecosystem.config.js
module.exports = {
  apps: [
    {
      name: "shorts-api",
      script: "src/server.js",
      instances: 1, // cron jobs (notifications) run inside the API; keep 1 to avoid duplicate runs
      max_memory_restart: "500M",
      env: { NODE_ENV: "production" },
    },
    {
      name: "shorts-worker",
      script: "worker.js",
      instances: 1, // scale concurrency with WORKER_CONCURRENCY in .env first
      max_memory_restart: "800M",
      kill_timeout: 20000,
      env: { NODE_ENV: "production" },
    },
  ],
};
