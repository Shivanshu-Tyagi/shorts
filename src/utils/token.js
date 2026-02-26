const crypto = require("crypto");

const SECRET = process.env.STREAM_SECRET || "stream_secret";

exports.generateToken = (payload, ttlMs = 5 * 60 * 1000) => {
  const expiresAt = Date.now() + ttlMs;
  const data = JSON.stringify({ payload, expiresAt });

  const hash = crypto
    .createHmac("sha256", SECRET)
    .update(data)
    .digest("hex");

  return Buffer.from(`${hash}.${data}`).toString("base64");
};

exports.verifyToken = (token) => {
  const decoded = Buffer.from(token, "base64").toString();
  const [hash, data] = decoded.split(".");

  const expectedHash = crypto
    .createHmac("sha256", SECRET)
    .update(data)
    .digest("hex");

  if (hash !== expectedHash) return null;

  const parsed = JSON.parse(data);
  if (Date.now() > parsed.expiresAt) return null;

  return parsed.payload;
};
