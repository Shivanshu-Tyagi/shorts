const rateLimit = {};

const LIMIT = 10; // requests
const WINDOW = 60 * 1000; // 1 minute

module.exports = (req, res, next) => {
  const ip = req.ip;
  const now = Date.now();

  if (!rateLimit[ip]) {
    rateLimit[ip] = { count: 1, time: now };
    return next();
  }

  const diff = now - rateLimit[ip].time;

  if (diff > WINDOW) {
    rateLimit[ip] = { count: 1, time: now };
    return next();
  }

  if (rateLimit[ip].count >= LIMIT) {
    return res.status(429).json({
      success: false,
      message: "Too many requests. Please wait.",
    });
  }

  rateLimit[ip].count++;
  next();
};
