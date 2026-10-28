const { test, describe, afterEach, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const { buildHarness } = require("./helpers");
const logger = require("../src/utils/logger");
const { createVideoProcessor } = require("../src/services/videoProcessor");
const { openGuardedStream, createGuardedLookup, MediaFetchError } = require("../src/utils/netGuard");

class Unrecoverable extends Error {}
let H, media, tmp, uploads, mediaHits;

async function startMedia() {
  const server = http.createServer((req, res) => {
    mediaHits.push(req.url);
    if (req.url.startsWith("/good")) { res.writeHead(200, { "content-type": "video/mp4" }); return res.end(Buffer.alloc(2048, 1)); }
    if (req.url.startsWith("/gone")) { res.writeHead(403); return res.end(); }
    if (req.url.startsWith("/flaky")) { res.writeHead(503); return res.end(); }
    if (req.url.startsWith("/huge")) { res.writeHead(200, { "content-type": "video/mp4" }); return res.end(Buffer.alloc(5000, 1)); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

const relaxed = { isBlocked: () => false, lookup: createGuardedLookup({ isBlocked: () => false }), allowedPorts: null };
function mkProcessor(extra = {}) {
  return createVideoProcessor({
    assets: H.stores.assets, rows: H.stores.rows, service: H.service, provider: H.provider, config: H.config, metrics: H.metrics, logger, fs,
    openStream: (u, o) => openGuardedStream(u, { ...o, ...relaxed }),
    generateThumbnail: async (_v, t) => fs.writeFileSync(t, "jpg"),
    uploadToS3: async (_stream, key) => { uploads.push(key); return key; },
    cdnDomain: "cdn.example.test", tmpDir: tmp, UnrecoverableError: Unrecoverable, ...extra,
  });
}
const job = (data, attemptsMade = 0, attempts = 3) => ({ data, attemptsMade, opts: { attempts } });

async function seedAsset(over = {}) {
  const key = "instagram:ZZZZZ00001";
  await H.stores.assets.create({ key, platform: "instagram", videoId: "ZZZZZ00001", canonicalUrl: "https://www.instagram.com/p/ZZZZZ00001/",
    providerUrl: "https://www.instagram.com/p/ZZZZZ00001/", title: "T", status: "queued", generation: 1, queuedAt: Date.now(), fileKey: "videos/abc-123.mp4",
    sourceMedia: { url: `${media.base}/good.mp4`, quality: "hd", fetchedAt: Date.now(), expiresAt: Date.now() + 600e3 }, ...over });
  for (const d of ["dev-a", "dev-b"]) await H.stores.rows.insert({ deviceId: d, assetKey: key, status: "pending", platform: "www.instagram.com", sourceId: "ZZZZZ00001" });
  return key;
}
const leftovers = () => fs.readdirSync(tmp);

beforeEach(async () => {
  mediaHits = []; uploads = []; tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wk-")); media = await startMedia();
  H = await buildHarness({ env: { MEDIA_REFRESH_MAX: "1" } });
});
afterEach(async () => { await H.close(); media.server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe("worker: zero provider calls on the happy path", () => {
  test("uses the URL already paid for; completes the asset AND every joined device row", async () => {
    const key = await seedAsset();
    const out = await mkProcessor().process(job({ assetKey: key, generation: 1 }));
    assert.equal(out.ok, true);
    assert.equal(H.fake.calls, 0, "OLD code made a 2nd provider call here for every single video");
    const a = await H.stores.assets.getByKey(key);
    assert.equal(a.status, "ready"); assert.equal(a.storage.cdnUrl, "https://cdn.example.test/videos/abc-123.mp4");
    assert.equal(a.sourceMedia, null, "short-lived URL dropped once stored");
    assert.deepEqual(uploads, ["videos/abc-123.mp4", "thumbnails/abc-123.jpg"]);
    assert.ok(H.stores.rows.__all().every((r) => r.status === "ready" && r.cdnUrl === a.storage.cdnUrl));
    assert.deepEqual(leftovers(), [], "tmp files cleaned up");
  });
  test("already stored by another job -> no download, no upload, rows finalized", async () => {
    const key = await seedAsset({ status: "ready", storage: { cdnUrl: "https://cdn.test/x.mp4", thumbnailCdn: null } });
    const out = await mkProcessor().process(job({ assetKey: key }));
    assert.equal(out.skipped, "already_ready"); assert.equal(mediaHits.length, 0); assert.equal(uploads.length, 0);
    assert.ok(H.stores.rows.__all().every((r) => r.status === "ready"));
  });
});

describe("worker: refresh only when the URL is really dead, and only once", () => {
  test("CDN rejects the URL (403) -> ONE provider refresh, then success", async () => {
    const key = await seedAsset({ sourceMedia: { url: `${media.base}/gone.mp4`, fetchedAt: Date.now() - 1000, expiresAt: Date.now() + 600e3 } });
    // provider returns a different, working URL
    H.fake.behavior = () => ({ json: { error: false, title: "T2", thumbnail: "", duration: 3, medias: [{ type: "video", quality: "hd_no_watermark", url: `${media.base}/good.mp4` }] } });
    const out = await mkProcessor().process(job({ assetKey: key }));
    assert.equal(out.ok, true); assert.equal(H.fake.calls, 1);
    assert.equal((await H.stores.assets.getByKey(key)).providerCalls, 1);
  });
  test("clock says expired -> refresh before even trying the dead URL", async () => {
    const key = await seedAsset({ sourceMedia: { url: `${media.base}/gone.mp4`, fetchedAt: 1, expiresAt: Date.now() - 5 } });
    H.fake.behavior = () => ({ json: { medias: [{ type: "video", url: `${media.base}/good.mp4` }] } });
    await mkProcessor().process(job({ assetKey: key }));
    assert.equal(H.fake.calls, 1); assert.ok(!mediaHits.some((u) => u.startsWith("/gone")), "did not waste a request on the known-dead URL");
  });
  test("still rejected after the single refresh -> permanent failure, NO further provider calls, no retry", async () => {
    const key = await seedAsset({ sourceMedia: { url: `${media.base}/gone.mp4`, fetchedAt: Date.now() - 1000, expiresAt: Date.now() + 600e3 } });
    H.fake.behavior = () => ({ json: { medias: [{ type: "video", url: `${media.base}/gone2.mp4` }] } });
    await assert.rejects(mkProcessor().process(job({ assetKey: key })), Unrecoverable);
    assert.equal(H.fake.calls, 1, "bounded: exactly one refresh");
    const a = await H.stores.assets.getByKey(key);
    assert.equal(a.status, "failed"); assert.equal(a.failure.permanent, true);
    assert.ok(H.stores.rows.__all().every((r) => r.status === "failed"));
  });
  test("two workers racing to refresh the same expired URL cost ONE provider call", async () => {
    const key = await seedAsset({ sourceMedia: { url: `${media.base}/gone.mp4`, fetchedAt: Date.now() - 1000, expiresAt: Date.now() + 600e3 } });
    H.fake.behavior = () => ({ delayMs: 120, json: { medias: [{ type: "video", url: `${media.base}/good.mp4` }] } });
    const svc2 = H.newService();
    const p1 = mkProcessor().process(job({ assetKey: key }));
    const p2 = mkProcessor({ service: svc2 }).process(job({ assetKey: key }));
    await Promise.all([p1, p2]);
    assert.equal(H.fake.calls, 1);
  });
});

describe("worker: failure handling is bounded and never permanent", () => {
  test("transient CDN error on a non-final attempt: rethrown for BullMQ retry, asset NOT marked failed, 0 provider calls", async () => {
    const key = await seedAsset({ sourceMedia: { url: `${media.base}/flaky.mp4`, fetchedAt: Date.now(), expiresAt: Date.now() + 600e3 } });
    await assert.rejects(mkProcessor().process(job({ assetKey: key }, 0, 3)), (e) => e instanceof MediaFetchError && e.kind === "transient");
    assert.notEqual((await H.stores.assets.getByKey(key)).status, "failed"); assert.equal(H.fake.calls, 0);
  });
  test("transient error on the FINAL attempt: marked failed with a SHORT cooldown (not permanent)", async () => {
    const key = await seedAsset({ sourceMedia: { url: `${media.base}/flaky.mp4`, fetchedAt: Date.now(), expiresAt: Date.now() + 600e3 } });
    await assert.rejects(mkProcessor().process(job({ assetKey: key }, 2, 3)));
    const a = await H.stores.assets.getByKey(key);
    assert.equal(a.status, "failed"); assert.equal(a.failure.permanent, false);
    assert.ok(a.failure.expiresAt - Date.now() <= H.config.reuse.transientCooldownMs + 50);
    // after the cooldown a user can retry, and the still-fresh URL is re-queued with NO provider call
    await new Promise((r) => setTimeout(r, H.config.reuse.transientCooldownMs + 30)); H.service.__cache.clear();
    await H.service.requestDownload({ url: "https://www.instagram.com/p/ZZZZZ00001/", deviceId: "dev-z" });
    assert.equal(H.fake.calls, 0); assert.equal(H.queue.jobs.length, 1);
  });
  test("oversized download is aborted mid-stream (permanent) and leaves no tmp files", async () => {
    const key = await seedAsset({ sourceMedia: { url: `${media.base}/huge.mp4`, fetchedAt: Date.now(), expiresAt: Date.now() + 600e3 } });
    const cfg = { ...H.config, media: { ...H.config.media, maxBytes: 1000 } };
    await assert.rejects(mkProcessor({ config: cfg }).process(job({ assetKey: key })), Unrecoverable);
    assert.deepEqual(leftovers(), []); assert.equal(uploads.length, 0);
  });
  test("S3 upload failure is retryable and cleans tmp", async () => {
    const key = await seedAsset();
    await assert.rejects(mkProcessor({ uploadToS3: async () => { throw new Error("S3 503"); } }).process(job({ assetKey: key }, 0, 3)), /S3 503/);
    assert.deepEqual(leftovers(), []); assert.notEqual((await H.stores.assets.getByKey(key)).status, "failed");
  });
  test("thumbnail (ffmpeg) failure is non-fatal: video still ready, history falls back to provider thumbnail", async () => {
    const key = await seedAsset();
    await mkProcessor({ generateThumbnail: async () => { throw new Error("ffmpeg"); } }).process(job({ assetKey: key }));
    const a = await H.stores.assets.getByKey(key); assert.equal(a.status, "ready"); assert.equal(a.storage.thumbnailCdn, null);
  });
  test("SSRF: provider-supplied URL pointing at an internal address is refused (default policy)", async () => {
    const key = await seedAsset({ sourceMedia: { url: "http://169.254.169.254/latest/meta-data/", fetchedAt: Date.now(), expiresAt: Date.now() + 600e3 } });
    await assert.rejects(mkProcessor({ openStream: openGuardedStream }).process(job({ assetKey: key })), Unrecoverable);
    assert.equal((await H.stores.assets.getByKey(key)).failure.code, "DOWNLOAD_UNAVAILABLE");
  });
});

describe("worker: jobs enqueued by the OLD controller (in flight during deploy)", () => {
  test("legacy payload processed from the stored URL with ZERO provider calls", async () => {
    const { row } = await H.stores.rows.insert({ deviceId: "d", status: "pending", downloadUrl: `${media.base}/good.mp4`, fileKey: "videos/legacy-1.mp4", platform: "www.instagram.com", sourceId: "x" });
    const out = await mkProcessor().process(job({ videoId: row._id, originalUrl: "https://www.instagram.com/p/ZZZZZ00001/", fileKey: "videos/legacy-1.mp4" }));
    assert.equal(out.legacy, true); assert.equal(H.fake.calls, 0);
    const r = await H.stores.rows.getById(row._id); assert.equal(r.status, "ready"); assert.equal(r.cdnUrl, "https://cdn.example.test/videos/legacy-1.mp4");
  });
  test("legacy job whose URL expired: one refresh only", async () => {
    const { row } = await H.stores.rows.insert({ deviceId: "d", status: "pending", downloadUrl: `${media.base}/gone.mp4`, fileKey: "videos/legacy-2.mp4", platform: "www.instagram.com", sourceId: "x" });
    H.fake.behavior = () => ({ json: { medias: [{ type: "video", url: `${media.base}/good.mp4` }] } });
    await mkProcessor().process(job({ videoId: row._id, originalUrl: "https://www.instagram.com/p/ZZZZZ00001/", fileKey: "videos/legacy-2.mp4" }));
    assert.equal(H.fake.calls, 1);
  });
});
