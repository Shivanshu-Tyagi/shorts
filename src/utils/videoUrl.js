/**
 * URL validation + canonical video identity.
 *
 * Why this exists: the old extractSourceId() used the LAST PATH SEGMENT as the
 * video id. For `youtube.com/watch?v=AAA` and `youtube.com/watch?v=BBB` that is
 * "watch" for BOTH -> different videos collapsed into one identity. And the
 * "platform" key was the raw hostname, so www.instagram.com vs instagram.com
 * never matched (=> needless paid provider calls).
 *
 * Rules here:
 *  - Prefer the platform's real video id.
 *  - Short links (vm.tiktok.com/XXXX, fb.watch/XXXX ...) get a separate "s:" namespace
 *    (they cannot be resolved without a network call, so they simply miss the cache
 *    rather than risk merging different videos).
 *  - Unknown path shapes fall back to a hash of host+path+remaining query, so two
 *    different URLs are NEVER merged unless we are certain they are the same video.
 *  - Only well-known tracking params are stripped.
 */
const crypto = require("crypto");
const { AppError } = require("./errors");

const PLATFORMS = {
  youtube: { name: "YouTube", domains: ["youtube.com", "youtu.be"] },
  instagram: { name: "Instagram", domains: ["instagram.com", "instagr.am"] },
  facebook: { name: "Facebook", domains: ["facebook.com", "fb.watch", "fb.com"] },
  tiktok: { name: "TikTok", domains: ["tiktok.com"] },
  x: { name: "X (Twitter)", domains: ["x.com", "twitter.com"] },
  snapchat: { name: "Snapchat", domains: ["snapchat.com"] },
  pinterest: { name: "Pinterest", domains: ["pinterest.com", "pin.it"] },
  reddit: { name: "Reddit", domains: ["reddit.com", "redd.it"] },
  linkedin: { name: "LinkedIn", domains: ["linkedin.com", "lnkd.in"] },
};

const TRACKING = new Set([
  "fbclid", "gclid", "igsh", "igshid", "si", "feature", "pp", "ref", "ref_src",
  "ref_url", "mibextid", "share_id", "is_from_webapp", "sender_device", "web_id",
]);
const TRACKING_BY_PLATFORM = { x: new Set(["s", "t"]), youtube: new Set(["t", "list", "index"]) };

const hostMatches = (host, domain) => host === domain || host.endsWith("." + domain);
const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

function detectPlatform(host, extraHosts = []) {
  for (const [id, p] of Object.entries(PLATFORMS)) {
    if (p.domains.some((d) => hostMatches(host, d))) return id;
  }
  if (extraHosts.some((h) => hostMatches(host, h))) return `ext_${host.replace(/^www\./, "")}`;
  return null;
}

function legacyHosts(host) {
  const bare = host.replace(/^www\./, "");
  return [...new Set([host, bare, "www." + bare])];
}

// ---- per-platform id extractors: return { id, raw } or null -------------------------
// `raw` is the literal path token the old code would have stored as sourceId (or null).
const E = {
  youtube(host, seg, q) {
    const ID = /^[A-Za-z0-9_-]{11}$/;
    if (hostMatches(host, "youtu.be")) return ID.test(seg[0] || "") ? { id: seg[0], raw: seg[0], canon: `https://www.youtube.com/watch?v=${seg[0]}` } : null;
    if (["shorts", "embed", "live", "v"].includes(seg[0]) && ID.test(seg[1] || ""))
      return { id: seg[1], raw: seg[1], canon: seg[0] === "shorts" ? `https://www.youtube.com/shorts/${seg[1]}` : `https://www.youtube.com/watch?v=${seg[1]}` };
    if (seg[0] === "watch" && ID.test(q.get("v") || "")) return { id: q.get("v"), raw: null, canon: `https://www.youtube.com/watch?v=${q.get("v")}` };
    return null;
  },
  instagram(host, seg) {
    const ID = /^[A-Za-z0-9_-]{5,}$/;
    const kinds = ["reel", "reels", "p", "tv"];
    if (seg[0] === "share" && kinds.includes(seg[1]) && ID.test(seg[2] || "")) return { id: `share:${seg[2]}`, raw: null };
    let i = kinds.includes(seg[0]) ? 0 : kinds.includes(seg[1]) ? 1 : -1;
    if (i >= 0 && ID.test(seg[i + 1] || "")) return { id: seg[i + 1], raw: seg[i + 1], canon: `https://www.instagram.com/p/${seg[i + 1]}/` };
    return null;
  },
  tiktok(host, seg) {
    const vi = seg.indexOf("video");
    if (vi >= 0 && /^\d{8,}$/.test(seg[vi + 1] || "")) return { id: seg[vi + 1], raw: seg[vi + 1], canon: `https://www.tiktok.com/video/${seg[vi + 1]}` };
    if (seg[0] === "t" && seg[1]) return { id: `s:${seg[1]}`, raw: seg[1] };
    if (/^(vm|vt)\./.test(host) && seg[0] && /^[A-Za-z0-9_-]{5,}$/.test(seg[0])) return { id: `s:${seg[0]}`, raw: seg[0] };
    return null;
  },
  facebook(host, seg, q) {
    if (hostMatches(host, "fb.watch") && seg[0]) return { id: `s:${seg[0]}`, raw: seg[0] };
    if (seg[0] === "share" && ["r", "v", "p"].includes(seg[1]) && seg[2]) return { id: `s:${seg[2]}`, raw: seg[2] };
    if (seg[0] === "reel" && /^\d+$/.test(seg[1] || "")) return { id: seg[1], raw: seg[1] };
    const vi = seg.indexOf("videos");
    if (vi >= 0) { const last = [...seg].reverse().find((s) => /^\d{6,}$/.test(s)); if (last) return { id: last, raw: last }; }
    if ((seg[0] === "watch" || seg[0] === "video.php") && /^\d+$/.test(q.get("v") || "")) return { id: q.get("v"), raw: null };
    return null;
  },
  x(host, seg) {
    const si = seg.findIndex((s) => s === "status" || s === "statuses");
    if (si >= 0 && /^\d+$/.test(seg[si + 1] || "")) return { id: seg[si + 1], raw: seg[si + 1] };
    return null;
  },
  snapchat(host, seg) {
    const si = seg.indexOf("spotlight");
    if (si >= 0 && seg[si + 1]) return { id: seg[si + 1], raw: seg[si + 1] };
    if (seg[0] === "t" && seg[1]) return { id: `s:${seg[1]}`, raw: seg[1] };
    return null;
  },
  pinterest(host, seg) {
    if (hostMatches(host, "pin.it") && seg[0]) return { id: `s:${seg[0]}`, raw: seg[0] };
    const pi = seg.indexOf("pin");
    const m = pi >= 0 && /(\d{6,})$/.exec(seg[pi + 1] || "");
    return m ? { id: m[1], raw: seg[pi + 1] } : null;
  },
  reddit(host, seg) {
    if (host === "v.redd.it" && seg[0]) return { id: `v:${seg[0]}`, raw: seg[0] };
    if (hostMatches(host, "redd.it") && /^[a-z0-9]{4,10}$/i.test(seg[0] || "")) return { id: seg[0].toLowerCase(), raw: seg[0] };
    const ci = seg.indexOf("comments");
    if (ci >= 0 && /^[a-z0-9]{4,10}$/i.test(seg[ci + 1] || "")) return { id: seg[ci + 1].toLowerCase(), raw: null };
    const si = seg.indexOf("s");
    if (si >= 1 && seg[0] === "r" && seg[si + 1]) return { id: `s:${seg[si + 1]}`, raw: seg[si + 1] };
    return null;
  },
  linkedin(host, seg, q, fullPath) {
    if (hostMatches(host, "lnkd.in") && seg[0]) return { id: `s:${seg[0]}`, raw: seg[0] };
    let m = /activity[-:](\d{10,})/.exec(fullPath);
    if (m) return { id: m[1], raw: null };
    m = /urn:li:(?:ugcPost|share):(\d{10,})/.exec(fullPath);
    return m ? { id: `ugc:${m[1]}`, raw: null } : null;
  },
};

function cleanQuery(u, platform) {
  const drop = TRACKING_BY_PLATFORM[platform];
  const kept = [];
  for (const [k, v] of u.searchParams) {
    const lk = k.toLowerCase();
    if (lk.startsWith("utm_") || TRACKING.has(lk) || (drop && drop.has(lk))) continue;
    kept.push([k, v]);
  }
  return kept;
}

/**
 * @returns {{platform,videoId,key,canonicalUrl,providerUrl,host,legacySourceId,legacySafe,legacyHosts}}
 * @throws AppError INVALID_URL | UNSUPPORTED_PLATFORM
 */
function normalizeVideoUrl(raw, opts = {}) {
  const { extraHosts = [], disabledPlatforms = [], maxUrlLength = 2048 } = opts;
  if (typeof raw !== "string") throw new AppError("INVALID_URL");
  let input = raw.trim();
  if (!input || input.length > maxUrlLength || /[\u0000-\u001f\s]/.test(input)) throw new AppError("INVALID_URL");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) input = "https://" + input;

  let u;
  try { u = new URL(input); } catch { throw new AppError("INVALID_URL"); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new AppError("INVALID_URL");
  if (u.username || u.password) throw new AppError("INVALID_URL");
  if (u.port && u.port !== "80" && u.port !== "443") throw new AppError("INVALID_URL");

  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!host.includes(".") || IPV4.test(host) || host.includes(":") || host.startsWith("[")) {
    throw new AppError("UNSUPPORTED_PLATFORM");
  }

  const platform = detectPlatform(host, extraHosts);
  if (!platform) throw new AppError("UNSUPPORTED_PLATFORM");
  if (disabledPlatforms.includes(platform)) {
    throw new AppError("UNSUPPORTED_PLATFORM",
      platform === "youtube" ? "YouTube downloads are not supported." : undefined);
  }

  const seg = u.pathname.split("/").filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
  const q = u.searchParams;
  const fullPath = decodeURIComponent(u.pathname.replace(/%(?![0-9a-f]{2})/gi, "%25"));
  const extracted = E[platform] ? E[platform](host, seg, q, fullPath) : null;

  const kept = cleanQuery(u, platform);
  const qs = new URLSearchParams(kept);
  const cleaned = `https://${host}${u.pathname}${qs.toString() ? "?" + qs.toString() : ""}`;

  let videoId, canonicalUrl;
  if (extracted) {
    videoId = extracted.id;
    canonicalUrl = extracted.canon || cleaned;
  } else {
    const sortedQs = [...kept].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("&");
    videoId = "h:" + sha1(`${host.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}?${sortedQs}`).slice(0, 24);
    canonicalUrl = cleaned;
  }

  const last = seg[seg.length - 1] || null;
  return {
    platform,
    videoId,
    key: `${platform}:${videoId}`,
    canonicalUrl,
    providerUrl: cleaned,
    host,
    // What the OLD code would have stored in Download.sourceId (only safe to reuse when
    // it provably equals the real id).
    legacySourceId: last,
    legacySafe: !!extracted && extracted.raw != null && extracted.raw === last,
    legacyHosts: legacyHosts(host),
  };
}

module.exports = { normalizeVideoUrl, detectPlatform, legacyHosts, PLATFORMS };
