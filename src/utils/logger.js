/**
 * Structured JSON event logger with secret redaction.
 * - Never pass headers/bodies here. Redaction is a safety net, not a licence.
 * - Silent when NODE_ENV=test unless LOG_LEVEL=debug.
 */
const crypto = require("crypto");

const SENSITIVE = /(key|token|secret|authorization|password|cookie|credential|signature)/i;
let sink = (line) => console.log(line);

const silent = () =>
  process.env.NODE_ENV === "test" && process.env.LOG_LEVEL !== "debug";

function redact(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === "string") return value.length > 300 ? value.slice(0, 300) + "…" : value;
  if (typeof value !== "object") return value;
  if (depth > 2) return "[depth]";
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE.test(k) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

function write(level, event, fields) {
  if (silent()) return;
  sink(JSON.stringify({ ts: new Date().toISOString(), level, event, ...redact(fields || {}) }));
}

module.exports = {
  event: (event, fields) => write("info", event, fields),
  warn: (event, fields) => write("warn", event, fields),
  error: (event, fields) => write("error", event, fields),
  /** Stable, non-reversible short id so logs never carry the raw deviceId. */
  hashId: (id) => crypto.createHash("sha1").update(String(id)).digest("hex").slice(0, 10),
  redact,
  __setSink: (fn) => { sink = fn; },
  __resetSink: () => { sink = (line) => console.log(line); },
};
