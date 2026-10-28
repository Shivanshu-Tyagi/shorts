# Shorts Downloader Backend — Optimization Notes

## 1. Root cause: why one video cost several paid API calls

Audit of the original flow (`download.controller.js` → BullMQ → `download.worker.js` → `rapidapi.service.js`):

| # | Cause | Effect |
|---|-------|--------|
| 1 | **Controller called the provider, then the worker called it again** ("get fresh URL") | Every successful video = **2 paid calls**, always. |
| 2 | `rapidapi.service` retried 3× internally **and** BullMQ retried the job 3×, each attempt calling the provider again | One failing video could cost up to **1 + 3×3 = 10+** calls. |
| 3 | "Already have it" check only matched rows with `status: "ready"` | A request arriving while the first was still `pending` (double tap, 2 users, `failed` row) created a **new row + new job + 2 more calls**. No dedupe. |
| 4 | Identity = `hostname` + **last path segment** | `youtube.com/watch?v=A` and `…?v=B` both became `"watch"` (different videos merged ⇒ **wrong file served**); `instagram.com` vs `www.instagram.com` never matched (⇒ avoidable misses). |
| 5 | `download.controller.js` and `downloadAll.controller.js` were byte-identical copies | Two code paths to the paid API. |
| 6 | Any hostname was forwarded to the provider | Anyone could burn quota with arbitrary URLs. |
| 7 | `app.js` self-started the server **and** `server.js` started it again | Double `connectDB`/`listen` (worked only by accident of Express 5 passing the EADDRINUSE error to the callback). |
| 8 | Controller logged `req.headers` and the full body | Authorization headers/tokens in logs. |

## 2. New flow

```
POST /api/download {url, deviceId}
  validate + allow-list → normalize → key = "<platform>:<videoId>"
  ├─ in-process TTL cache / video_assets lookup (unique index on key)
  │   └─ miss → reuse legacy `downloads` row if its old sourceId is provably the real id (promoted, no provider call)
  ├─ READY        → reuse stored file                          0 provider calls
  ├─ NEGATIVE     → cached permanent failure (short TTL)       0 provider calls
  ├─ IN_PROGRESS  → join running job                           0 provider calls
  ├─ REQUEUE      → job lost but media URL still fresh         0 provider calls
  └─ NEEDS_PROVIDER → single-flight (in-process) + lease lock (Mongo, cross-instance)
                       → ONE provider operation → persist asset → enqueue job (jobId per generation)
worker: uses the URL already paid for. Refreshes via provider ONLY if the URL is expired/rejected, once per job.
```

Data model: new collection `video_assets` (one canonical record per video: metadata, formats, short-lived `sourceMedia`
URL with expiry, permanent `storage` reference, failure/negative-cache info, lock-free state) + `download_locks`
(lease locks, TTL index). `downloads` stays the per-device history; it gains an optional `assetKey` (existing rows
untouched; partial unique index `{deviceId, assetKey}`).

**Metadata ≠ downloadable file.** An asset is only "reusable" (`READY`) when `storage.cdnUrl` exists. Metadata with an expired
`sourceMedia` and no stored file is never returned as a valid download — it triggers one refresh.

## 3. Files

**New:** `src/config/index.js`, `src/utils/{videoUrl,netGuard,errors,logger,ttlCache,singleFlight,circuitBreaker}.js`,
`src/services/{download.service,videoProcessor,downloaderSettings,metrics.service,container}.js`,
`src/repositories/{mongo,memory}.js`, `src/models/{videoAsset,lock}.model.js`, `src/middleware/rateLimit.js`,
`src/controllers/metrics.controller.js`, `scripts/ensure-indexes.js`, `tests/*`, `.env.example`, `docs/*`.

**Modified:** `download.controller.js` (thin), `downloadAll.controller.js` (alias of the same handler),
`rapidapi.service.js` (bounded retry, timeout, breaker, metrics; `getVideoInfo` kept as legacy export),
`download.worker.js` (uses `videoProcessor`), `download.queue.js` (named exports), `download.model.js` (+`assetKey`, 2 partial indexes),
`download.routes.js` (+limiters, +metrics route), `setting.controller.js` & `vydoSetting.controller.js` (+`downloader` key),
`app.js` / `server.js` (single start, body limit, error handler, trust proxy), `package.json` (scripts, engines).
**Untouched:** auth/device/history/feed/stats/notification code, S3 service, ads config values, `sourceExtractor.js` (now unused, left in place).

## 4. Settings controllers — exact response change

`GET` ads/app config (both `setting.controller` and `vydoSetting.controller`): **every existing key/value is unchanged**.
One key is added under `data`:

```jsonc
"downloader": {
  "enabled": true,                                   // DOWNLOADER_ENABLED kill switch (enforced → 503)
  "supportedPlatforms": [ { "id": "youtube", "name": "YouTube", "domains": ["youtube.com","youtu.be"], "enabled": true }, … 9 platforms ],
  "maxUrlLength": 2048,                              // enforced
  "qualityPreference": ["hd_no_watermark","no_watermark","watermark"],   // enforced selection order
  "rateLimit": { "windowSeconds": 60, "maxRequestsPerDevice": 20 },      // enforced
  "provider": { "status": "available" }              // available | degraded | unavailable (live circuit-breaker state)
}
```
No keys, endpoints, hostnames or credentials are exposed (asserted by a test that greps the JSON for the secrets).
The settings are static code + environment (there is no DB-backed settings store; `AdsConfig` model is unused), so there is
no env-vs-DB precedence to preserve and nothing to invalidate; `provider.status` is computed live per call.

## 5. Error contract

Shape: `{ "success": false, "message": "...", "code": "..." }` (`code` is additive). Legacy conditions keep legacy status/message
(missing fields → 400 `url and deviceId required`; no media → 400 `No media found from API`; unknown → 500 `Download failed`).

| code | HTTP | meaning |
|---|---|---|
| INVALID_REQUEST / INVALID_URL / UNSUPPORTED_PLATFORM / NO_MEDIA | 400 | bad input / not allow-listed / nothing downloadable |
| VIDEO_UNAVAILABLE | 404 | provider says private/deleted/not found (new; was a 500) |
| RATE_LIMITED | 429 (+Retry-After) | our limiter |
| PROVIDER_RATE_LIMITED, PROVIDER_UNAVAILABLE, PROVIDER_AUTH, QUEUE_UNAVAILABLE, SERVICE_BUSY, DB_ERROR, DOWNLOADS_DISABLED | 503 (+Retry-After where known) | upstream/infra |
| PROVIDER_TIMEOUT, REQUEST_TIMEOUT | 504 | |
| PROVIDER_ERROR, PROVIDER_INVALID_RESPONSE | 502 | |

## 6. Behaviour changes you should know about (intentional)

1. **Platform allow-list.** Previously *any* host was forwarded to the paid provider. Now only the 9 platforms in your own feature-flag schema
   (YouTube, Instagram, Facebook, TikTok, X/Twitter, Snapchat, Pinterest, Reddit, LinkedIn) are accepted. If the provider handles others you use today,
   add them without code: `EXTRA_ALLOWED_HOSTS=vimeo.com,…`. **Check your traffic before deploying.**
2. Provider attempts default **2 total** (was 3 in the service ×3 BullMQ attempts). `PROVIDER_MAX_ATTEMPTS`.
3. Provider-side "not found/private" is now 404 instead of 500.
4. Repeated taps / failed rows reuse the device's existing row instead of creating duplicates.
5. Thumbnail (ffmpeg) failure no longer fails the whole job (falls back to the provider thumbnail).
6. Downloaded media is size-capped (`MAX_MEDIA_BYTES`, 200 MB) and fetched through an SSRF guard.
7. `app.js` no longer auto-starts when `require`d — `npm start` (`server.js`) is unchanged for you. If anything runs `node src/app.js` it still works.

## 7. Deployment / migration

1. Deploy code (jobs already in the queue with the old payload are still processed by a compatibility path — no provider call unless their URL is dead).
2. Indexes: automatic at boot (Mongoose `autoIndex`). For a large `downloads` collection run once off-peak
   `npm run db:ensure-indexes` (additive `createIndexes` only) and then set `MONGO_AUTO_INDEX=false`.
3. No data migration needed. Existing `ready` rows are reused lazily ("promote on read") when their old `sourceId` is trustworthy
   (not for YouTube `watch?v=` rows, whose old id was the useless `"watch"`).
4. Set `REDIS_URL` for **both** API and worker (it was absent from the supplied `.env`; BullMQ needs it). Set `TRUST_PROXY` behind a proxy.
5. Optional: `METRICS_TOKEN` enables `GET /api/internal/download-metrics` (counters, latency percentiles, cache-hit %, cost estimate if `PROVIDER_COST_PER_CALL_USD` set).
6. Rollback: revert code; new collections/indexes/`assetKey` are ignored by the old code.

## 8. Tests

`npm test` (zero new dependencies; Node ≥ 20.3 built-in runner). `npm run test:mongo` with `TEST_MONGO_URL` runs the store contract tests against real MongoDB.
`npm run test:measure` regenerates `docs/measurements.json`.


`npm run test:measure` regenerates `docs/measurements.json`.

## 9. Known limitations

* Redis lock not used: the lease lock lives in MongoDB (atomic with the data it protects, works without Redis). BullMQ's deterministic `jobId`
  still gives queue-level dedupe in Redis. A Redis backend can be added behind the same two store methods.
* Rate limiter is in-memory per process.
* Provider error schema (`error:true`, status codes) and media-URL lifetime are assumptions (no network access to verify); see `MEDIA_URL_TTL_SECONDS`. Tune after observing real traffic with the metrics endpoint.
* Short links (`vm.tiktok.com/XXXX`, `fb.watch/XXXX`) can't be resolved to a canonical id without a network call, so they cache under their own key.
* A client that disconnects does not cancel the shared provider call (others may be waiting on it and it is already billed).

## 10. Download limits & rewarded ads
See `docs/QUOTA_AND_REWARDS.md`.
