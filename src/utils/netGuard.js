/**
 * SSRF protection for every server-side fetch of an externally supplied URL
 * (the provider hands us media URLs; we must not be tricked into reaching
 * internal services, cloud metadata endpoints, or localhost).
 *
 * Defence in depth:
 *  1. scheme/credential/port checks on the URL,
 *  2. a guarded DNS `lookup` used BY THE SOCKET ITSELF, so the address we validate is
 *     the address we connect to (no DNS-rebinding TOCTOU gap),
 *  3. redirects are followed manually and each hop is re-validated,
 *  4. response size / content-type limits.
 */
const dns = require("dns");
const net = require("net");
const http = require("http");
const https = require("https");

class MediaFetchError extends Error {
  /** kind: expired | transient | permanent | blocked | too_large | bad_type */
  constructor(kind, message, status) {
    super(message);
    this.name = "MediaFetchError";
    this.kind = kind;
    this.status = status || null;
  }
}

// ---------- IP classification ----------------------------------------------------------
function ipv4ToInt(ip) {
  const p = ip.split(".").map(Number);
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}
const V4_BLOCKS = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
].map(([b, bits]) => [ipv4ToInt(b), bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0]);

function isPrivateV4(ip) {
  const n = ipv4ToInt(ip);
  return V4_BLOCKS.some(([base, mask]) => ((n & mask) >>> 0) === ((base & mask) >>> 0));
}

function parseV6(ip) {
  let s = ip.split("%")[0].toLowerCase();
  let tail = null;
  const m = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (m) {
    const o = m[1].split(".").map(Number);
    tail = [(o[0] << 8) | o[1], (o[2] << 8) | o[3]];
    s = s.slice(0, -m[1].length) + "0:0";
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 0) return null;
  const words = [...head, ...Array(halves.length === 2 ? fill : 0).fill("0"), ...rest].map((h) => parseInt(h || "0", 16));
  if (words.length !== 8 || words.some((w) => !(w >= 0 && w <= 0xffff))) return null;
  if (tail) { words[6] = tail[0]; words[7] = tail[1]; }
  return words;
}

function isPrivateIp(ip) {
  const fam = net.isIP(ip);
  if (fam === 4) return isPrivateV4(ip);
  if (fam === 6) {
    const w = parseV6(ip);
    if (!w) return true; // unparseable -> refuse
    if (w.every((x) => x === 0)) return true;                     // ::
    if (w.slice(0, 7).every((x) => x === 0) && w[7] === 1) return true; // ::1
    if (w.slice(0, 5).every((x) => x === 0) && w[5] === 0xffff)   // ::ffff:a.b.c.d (mapped)
      return isPrivateV4(`${w[6] >> 8}.${w[6] & 255}.${w[7] >> 8}.${w[7] & 255}`);
    if (w.slice(0, 6).every((x) => x === 0)) return true;         // ::a.b.c.d (compat)
    if ((w[0] & 0xfe00) === 0xfc00) return true;                  // fc00::/7 ULA
    if ((w[0] & 0xffc0) === 0xfe80) return true;                  // fe80::/10
    if ((w[0] & 0xffc0) === 0xfec0) return true;                  // fec0::/10
    if ((w[0] & 0xff00) === 0xff00) return true;                  // multicast
    if (w[0] === 0x2001 && w[1] === 0x0db8) return true;          // documentation
    if (w[0] === 0x0064 && w[1] === 0xff9b) return true;          // NAT64
    if (w[0] === 0x2002) return true;                             // 6to4
    return false;
  }
  return true; // not an IP -> caller must not treat as safe
}

// ---------- guarded DNS lookup ------------------------------------------------------------
function createGuardedLookup({ lookup = dns.lookup, isBlocked = isPrivateIp } = {}) {
  return function guardedLookup(hostname, options, callback) {
    if (typeof options === "function") { callback = options; options = {}; }
    lookup(hostname, { ...options, all: true }, (err, addrs) => {
      if (err) return callback(err);
      if (!addrs || !addrs.length) return callback(new MediaFetchError("transient", "dns: no addresses"));
      if (addrs.some((a) => isBlocked(a.address))) {
        return callback(new MediaFetchError("blocked", "destination address not allowed"));
      }
      if (options && options.all) return callback(null, addrs);
      return callback(null, addrs[0].address, addrs[0].family);
    });
  };
}

/** Static checks (no DNS). Throws MediaFetchError('blocked'). */
function assertSafeUrlShape(urlStr, { isBlocked = isPrivateIp, allowedPorts = ["80", "443"] } = {}) {
  let u;
  try { u = new URL(urlStr); } catch { throw new MediaFetchError("blocked", "invalid url"); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new MediaFetchError("blocked", "scheme not allowed");
  if (u.username || u.password) throw new MediaFetchError("blocked", "credentials in url");
  if (u.port && allowedPorts && !allowedPorts.includes(u.port)) throw new MediaFetchError("blocked", "port not allowed");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && isBlocked(host)) throw new MediaFetchError("blocked", "destination address not allowed");
  if (host.toLowerCase() === "localhost" || host.toLowerCase().endsWith(".localhost") || host.toLowerCase().endsWith(".internal"))
    throw new MediaFetchError("blocked", "destination host not allowed");
  return u;
}

const classifyStatus = (s) =>
  [401, 403, 404, 410].includes(s) ? "expired" : s === 429 || s >= 500 || s === 408 ? "transient" : "permanent";

/**
 * Open a guarded GET stream. Follows <= maxRedirects, re-validating every hop.
 * Resolves { res, finalUrl } where res is a 200/206 IncomingMessage (caller consumes it).
 */
function openGuardedStream(urlStr, opts = {}) {
  const {
    headers = {}, timeoutMs = 30000, maxRedirects = 3, maxBytes = Infinity,
    lookup = createGuardedLookup(), isBlocked = isPrivateIp, signal,
    modules = { "http:": http, "https:": https }, allowedPorts = ["80", "443"], // allowedPorts override exists for tests only
  } = opts;

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };

    const hop = (current, left) => {
      let u;
      try { u = assertSafeUrlShape(current, { isBlocked, allowedPorts }); } catch (e) { return done(reject, e); }
      const mod = modules[u.protocol];
      const req = mod.request(u, { method: "GET", headers, lookup, agent: false, timeout: timeoutMs }, (res) => {
        const status = res.statusCode;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (left <= 0) return done(reject, new MediaFetchError("permanent", "too many redirects"));
          let next;
          try { next = new URL(res.headers.location, u).toString(); } catch { return done(reject, new MediaFetchError("blocked", "bad redirect")); }
          return hop(next, left - 1);
        }
        if (status !== 200 && status !== 206) {
          res.resume();
          return done(reject, new MediaFetchError(classifyStatus(status), `upstream status ${status}`, status));
        }
        const ct = String(res.headers["content-type"] || "").toLowerCase();
        if (ct && !/^(video\/|application\/octet-stream|binary\/octet-stream|application\/mp4|application\/x-mpegurl|image\/)/.test(ct)) {
          res.resume();
          return done(reject, new MediaFetchError("bad_type", `unexpected content-type`));
        }
        const len = Number(res.headers["content-length"]);
        if (Number.isFinite(len) && len > maxBytes) {
          res.destroy();
          return done(reject, new MediaFetchError("too_large", "content-length exceeds limit"));
        }
        done(resolve, { res, finalUrl: u.toString() });
      });
      req.on("timeout", () => req.destroy(new MediaFetchError("transient", "upstream timeout")));
      req.on("error", (e) => done(reject, e instanceof MediaFetchError ? e : new MediaFetchError("transient", `network: ${e.code || e.message}`)));
      if (signal) {
        if (signal.aborted) req.destroy(new MediaFetchError("transient", "aborted"));
        else signal.addEventListener("abort", () => req.destroy(new MediaFetchError("transient", "aborted")), { once: true });
      }
      req.end();
    };
    hop(urlStr, maxRedirects);
  });
}

module.exports = {
  MediaFetchError, isPrivateIp, createGuardedLookup, assertSafeUrlShape,
  openGuardedStream, classifyStatus,
};
