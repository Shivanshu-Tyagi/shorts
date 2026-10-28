# Download limits & rewarded-ad unlocks (Shorts + Vydo)

> **Scope / honesty note.** This delivery contains the **complete backend** (shared Settings API, quota engine, rewarded-ad
> verification, DB schema, tests). The **two Flutter apps were NOT part of the upload** (only `shorts.zip`, the Node backend, was
> provided) and there is no Flutter/Dart SDK in the build sandbox, so **no app code was written, no `flutter analyze` / build was run, and
> nothing about the apps is claimed as working.** Section 8 is the exact contract both apps must implement; section 10 lists what I need to do it.

## 1. How it works

```
app start → GET /api/ads-config | /api/vydo-ads-config ?deviceId=…        (limits + rewarded unit + this device's quota)
download  → POST /api/download {url, deviceId, appId}                       (quota reserved BEFORE any paid provider call)
            ├─ ok            → 200 {success,message,data,quota}
            └─ limit reached → 403 {code:DOWNLOAD_LIMIT_REACHED, quota}  → app offers the rewarded ad (only if quota.nextReward.eligible)
worker    → file stored → reservation COMMITTED (used+1)    |   failed → reservation RELEASED (nothing consumed)
ad        → POST /api/quota/reward/start        → {nonce, userId, adUnitId}
            app sets ServerSideVerificationOptions(userId=deviceId, customData=nonce) and shows the ad
            Google → GET /api/ads/ssv?…signature…  → backend verifies ECDSA signature → +N downloads (exactly once)
            app polls GET /api/quota (or POST …/reward/claim) until session.state == "granted"
```

Rules enforced on the server:
* `allowed = freeDownloads + unlocked`, `remaining = allowed − used − inProgress`; all sizes come from settings.
* A unit is **reserved** atomically before the provider is called (denied requests cost zero provider calls), **committed** only when the
  file is really stored, **released** on any failure. Reservations expire by TTL, so a lost job cannot leak quota.
* The same video for the same device is never charged twice (duplicate taps, retries, app restarts, concurrent requests).
* Re-opening a video the device already downloaded is free, even at 0 remaining.
* The ad is offered only when `remaining ≤ rewardShowWhenRemainingAtMost` **and no download is still in progress**
  (`nextReward.reason = DOWNLOADS_IN_PROGRESS` otherwise).
* A reward is credited **only** by a signed AdMob server-side-verification callback whose signature, age, ad unit, user and one-time nonce
  all check out. The app's own "user earned reward" event (or any app→server call) never credits anything.
  Replays, duplicates, concurrent callbacks, expired sessions, tampered/foreign callbacks credit nothing.
* Old app builds (no `appId`) behave exactly as before (not limited) until you set `REQUIRE_APP_ID=true`.
* Safety valve: quota is **inert until a rewarded ad unit is configured** for that app (otherwise users would be locked out with no way to unlock).

## 2. Settings fields (all dynamic; defaults in `src/config/quota.js`)

Precedence: **DB override (`app_settings`, per app) > env `DL_*` > built-in default.** Changes are visible on the next request in the process that
received the admin call and within `SETTINGS_CACHE_TTL_MS` (30 s) elsewhere. Invalid env/DB values are ignored; the admin API rejects them.

| field | default | range | meaning |
|---|---|---|---|
| `enabled` | true | bool | master switch |
| `freeDownloads` | **3** | 0–1000 | initial free downloads / device / app |
| `rewardedDownloads` | **3** | 0–1000 | unlocked per verified ad (0 disables rewards) |
| `rewardedAdsEnabled` | true | bool | |
| `maxRewardedAdsPerDay` | 10 | 0–100 | rolling 24 h, 0 = unlimited |
| `maxRewardedAdsTotal` | 0 | 0–100000 | lifetime, 0 = unlimited |
| `rewardCooldownSeconds` | 0 | 0–86400 | gap between rewards |
| `rewardShowWhenRemainingAtMost` | 0 | 0–1000 | offer an ad early |
| `rewardSessionTtlSeconds` | 600 | 30–3600 | ad session validity |
| `reservationTtlSeconds` | 1800 | 60–86400 | in-flight download hold (keep > worker job time) |
| `enforceWithoutRewardedAd` | false | bool | enforce even with no rewarded ad unit (not recommended) |
| `rewardVerification` | `ssv` | `ssv` / `client` | `client` is insecure and can only be enabled by env `ALLOW_CLIENT_REWARD_VERIFICATION=true` |
| `minAdWatchSeconds` | 5 | 0–120 | only for `client` mode |
| `statusPollIntervalMs` / `statusPollTimeoutMs` | 2000 / 30000 | | how the app should poll for the SSV result |

Plus `rewarded: {enabled, unitId}` per app (feeds `ads.rewarded` in the settings response; the existing literal `enabled:false, unitId:""` is the fallback).
Global (env only): `REQUIRE_APP_ID`, `SETTINGS_CACHE_TTL_MS`, `ADMIN_TOKEN`, `ADMOB_SSV_*`. See `.env.example`.

### Managing limits (no redeploy)
```
curl -X PUT $BASE/api/internal/settings/vydo -H "x-admin-token: $ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"downloadLimits":{"freeDownloads":3,"rewardedDownloads":3},"rewarded":{"enabled":true,"unitId":"ca-app-pub-XXXXXXXXXXXXXXXX/NNNNNNNNNN"}}'
# "key": null removes an override (falls back to env/default).  GET the same URL to inspect the resolved values.
```
`appId` is `shorts` or `vydo`. Unknown ids are rejected (clients cannot mint new free quota by inventing app names).

## 3. API reference (all JSON; errors: `{"success":false,"code","message", …extra}`)

### 3.1 Settings (existing endpoints, additive)
`GET /api/ads-config` (Shorts) and `GET /api/vydo-ads-config` (Vydo), optional `?deviceId=<id>` (or header `x-device-id`).
Every existing key is unchanged. Added: `data.downloadLimits`, `data.downloadQuota` (only with a valid deviceId), and `data.ads.rewarded` now reflects the DB override.
If the new layer fails the endpoint answers exactly as before (without the new keys).
```json
{
  "downloadLimits": {
    "enabled": true,
    "freeDownloads": 3,
    "rewardedDownloads": 3,
    "rewardedAdsEnabled": true,
    "maxRewardedAdsPerDay": 10,
    "maxRewardedAdsTotal": 0,
    "rewardCooldownSeconds": 0,
    "rewardShowWhenRemainingAtMost": 0,
    "rewardSessionTtlSeconds": 600,
    "reservationTtlSeconds": 1800,
    "enforceWithoutRewardedAd": false,
    "rewardVerification": "ssv",
    "minAdWatchSeconds": 5,
    "statusPollIntervalMs": 2000,
    "statusPollTimeoutMs": 30000,
    "enforced": true,
    "rewardedAdUnitConfigured": true
  },
  "ads.rewarded": {
    "enabled": true,
    "unitId": "ca-app-pub-1111111111111111/2222222222"
  },
  "downloadQuota": "(same object as GET /api/quota data)"
}
```

### 3.2 `POST /api/download` (existing; additive)
Request adds optional `appId` (`"shorts"|"vydo"`). Old payloads keep working.
Success adds top-level `quota` (full object below). Quota exhausted → **403**:
```json
{
  "success": false,
  "code": "DOWNLOAD_LIMIT_REACHED",
  "message": "Download limit reached. Watch a rewarded ad to unlock more downloads.",
  "quota": {
    "appId": "vydo",
    "enforced": true,
    "limits": {
      "freeDownloads": 3,
      "rewardedDownloadsPerAd": 3
    },
    "totalAllowed": 3,
    "used": 0,
    "inProgress": 3,
    "remaining": 0,
    "freeDownloads": {
      "total": 3,
      "used": 0,
      "remaining": 3
    },
    "rewarded": {
      "adCompleted": false,
      "completedAds": 0,
      "unlockedDownloads": 0,
      "usedFromRewards": 0,
      "remainingFromRewards": 0,
      "lastUnlockedDownloads": 0,
      "lastCompletedAt": null
    },
    "nextReward": {
      "eligible": false,
      "reason": "DOWNLOADS_IN_PROGRESS",
      "retryAfterSeconds": 0,
      "unlocksDownloads": 3,
      "adsRemainingToday": 10,
      "pollIntervalMs": 2000,
      "pollTimeoutMs": 30000
    },
    "session": {
      "state": "none"
    },
    "serverTime": 1791916071070
  }
}
```
(`quota.inProgress`/`remaining` shown right after the 3rd request; `nextReward.reason` is `DOWNLOADS_IN_PROGRESS` until the 3 downloads complete.)

### 3.3 `GET /api/quota?deviceId=&appId=`
Read-only (creates nothing). Returns `{success, message, data: <quota>, config: <downloadLimits public view>}`.
```json
{
  "appId": "vydo",
  "enforced": true,
  "limits": {
    "freeDownloads": 3,
    "rewardedDownloadsPerAd": 3
  },
  "totalAllowed": 6,
  "used": 3,
  "inProgress": 0,
  "remaining": 3,
  "freeDownloads": {
    "total": 3,
    "used": 3,
    "remaining": 0
  },
  "rewarded": {
    "adCompleted": true,
    "completedAds": 1,
    "unlockedDownloads": 3,
    "usedFromRewards": 0,
    "remainingFromRewards": 3,
    "lastUnlockedDownloads": 3,
    "lastCompletedAt": 1791916071075
  },
  "nextReward": {
    "eligible": false,
    "reason": "LIMIT_NOT_REACHED",
    "retryAfterSeconds": 0,
    "unlocksDownloads": 3,
    "adsRemainingToday": 9,
    "pollIntervalMs": 2000,
    "pollTimeoutMs": 30000
  },
  "session": {
    "state": "granted",
    "unlockedDownloads": 3,
    "grantedAt": 1791916071075
  },
  "serverTime": 1791916071081
}
```
`nextReward.reason`: `null | DISABLED | LIMIT_NOT_REACHED | DOWNLOADS_IN_PROGRESS | TOTAL_CAP | DAILY_CAP | COOLDOWN` (+ `retryAfterSeconds`).

### 3.4 `POST /api/quota/reward/start` `{deviceId, appId}`
200 → one-time session (repeated calls return the same live session). 403 `REWARD_NOT_ELIGIBLE` (+`Retry-After`, `quota`) otherwise.
```json
{
  "status": 200,
  "body": {
    "success": true,
    "message": "Reward session started.",
    "data": {
      "nonce": "6iRH07I5i_eURjJRJSGoKSF0xBVmtTck",
      "expiresAt": 1791916671071,
      "unlocksDownloads": 3,
      "userId": "dev-123",
      "verification": "ssv",
      "adUnitId": "ca-app-pub-1111111111111111/2222222222"
    },
    "quota": "(quota object, same shape as above)"
  }
}
```
### 3.5 `POST /api/quota/reward/claim` `{deviceId, appId, nonce}`
Reports the session outcome (`pending | granted | expired`). **In `ssv` mode it never credits anything** — it only reflects what Google's callback did. 404 for unknown/foreign nonce.
```json
{
  "status": 200,
  "body": {
    "success": true,
    "message": "Reward pending verification.",
    "data": {
      "sessionState": "pending",
      "verification": "ssv",
      "unlockedDownloads": 0
    },
    "quota": "(quota object)"
  }
}
```
### 3.6 `GET /api/ads/ssv?…` (called by Google)
`400 SSV_INVALID` bad/forged/stale signature · `503` keys/DB unavailable (Google retries) · `200` with `status`:
`granted | already_granted | expired | unknown_session | ad_unit_mismatch`.
```json
{
  "status": 200,
  "body": {
    "success": true,
    "status": "granted"
  }
}   // replay → {
  "success": true,
  "status": "already_granted"
}
{
  "status": 400,
  "body": {
    "success": false,
    "code": "SSV_INVALID",
    "message": "Invalid reward verification"
  }
}
```
### 3.7 Error codes added
`DOWNLOAD_LIMIT_REACHED 403` · `REWARD_NOT_ELIGIBLE 403` · `REWARD_SESSION_NOT_FOUND 404` · `REWARD_SESSION_EXPIRED 410` · `REWARD_CLIENT_CLAIM_DISABLED 403` · `SSV_INVALID 400` · `UNAUTHORIZED 401` · `NOT_FOUND 404` (+ existing `INVALID_REQUEST 400`, `RATE_LIMITED 429`, …).

## 4. Database changes (additive; existing data untouched)
| collection | change |
|---|---|
| `download_quotas` (new) | one doc per `(deviceId, appId)`: `used`, `reservations[{key,exp}]`, `rewardedGranted`, `rewardsCompleted`, `lastReward*`, `grants[]`, `sessions[]`. Unique index `{deviceId,appId}`. Every transition is a single-document atomic update. |
| `app_settings` (new) | `{appId (unique), downloadLimits{…}, rewarded{enabled,unitId}, version}` |
| `downloads` | new optional field `appId` (set only for quota-aware requests). No new index. |
Create indexes: automatic at boot, or `npm run db:ensure-indexes` (additive `createIndexes`, never drops). Rollback: deploy previous code; new collections/field are ignored.

## 5. AdMob setup (required for rewards to work)
1. In AdMob create a **Rewarded** ad unit for each app (Shorts and Vydo). Today both apps have `rewarded: {enabled:false, unitId:""}` — none exists yet.
2. Open each rewarded ad unit → **Server-side verification → Enable** → callback URL `https://<your BASE_URL>/api/ads/ssv`. Leave "user ID" enabled.
3. Set the unit ids on the server: the `PUT /api/internal/settings/:appId` call in §2 (also flips `rewarded.enabled`, which turns the quota on).
4. Pre-production: AdMob's "Verify URL" test sends a request that the server correctly answers `400`/`unknown_session` (it has no real nonce).
   **Unverified assumption:** AdMob sends `ad_unit` as the numeric id (the part after `/`); the matcher accepts either form, but confirm with a real callback.

## 6. Security model and limits (read this)
* **Identity is the client-sent `deviceId`** (this project has no user auth). Anyone who generates fresh random device ids gets fresh free downloads;
  per-IP rate limits only slow that down. Real protection needs **Play Integrity attestation** (needs a Google Cloud project + app change) or account login — not implemented.
* Quota/reward state is entirely server-side; reinstalling or clearing app data changes nothing **if the app keeps the same `deviceId`**
  (a reinstall that generates a new id = a new device — same limitation as above).
* SSV public keys are fetched from Google (`gstatic`) and cached 24 h; unknown key ids refresh at most once a minute.
* A reservation older than `reservationTtlSeconds` expires; if a download finishes after that it is not counted (user gets one free). Keep the TTL above the slowest job.
* Rate limits are in-memory per process.

## 7. Tests (`npm test`, no extra dependencies)
264 automated tests (all passing in the build sandbox) incl. 22+ store contract tests that also run against real MongoDB with `TEST_MONGO_URL=… npm run test:mongo`.
New: `quota.test.js` (settings precedence/validation, free limit, duplicates, concurrency, failures, restart, both apps), `reward.test.js` (real ECDSA SSV signing, tamper/replay/concurrent
callbacks, ad failure, caps, cooldown, client-mode gating, both apps), `quota-http.test.js` (controllers, admin API, both settings endpoints, error shapes).
Critical logic was mutation-tested (11 deliberate breakages: skipped signature check, trusted client claim, replay, no release, no limit, double charge, …) — every one is caught by at least one test.
**Not executed in the sandbox:** the Express wiring, the Mongoose/Mongo adapter (`src/repositories/mongo.js`), BullMQ, S3. Run `npm run test:mongo` once against a real MongoDB before deploying.

## 8. What each app must implement (identical in Shorts and Vydo) — NOT DONE, apps not provided
1. Send `appId` (`"shorts"` / `"vydo"`) in every `POST /api/download` and in all quota calls; keep sending the same stable `deviceId`.
2. On start and after every download/ad: read `quota` (from `/api/ads-config|/api/vydo-ads-config?deviceId=`, download responses, `GET /api/quota`). Display `remaining`, `used`, `rewarded.adCompleted`, `rewarded.lastUnlockedDownloads`.
   Never compute limits locally; use the numbers from the server.
3. On `403 DOWNLOAD_LIMIT_REACHED` (or when `quota.remaining == 0` and `nextReward.eligible`): show an "unlock more downloads" prompt; if `nextReward.eligible == false` show the `reason`/`retryAfterSeconds` instead (e.g. wait for in-progress downloads).
4. Rewarded flow: `POST /quota/reward/start` → load the rewarded ad with `adUnitId` → **before `show()`** set `ServerSideVerificationOptions(userId: data.userId, customData: data.nonce)` → show →
   on `onUserEarnedReward` do **not** unlock anything locally; show a loading state and poll `GET /quota` every `pollIntervalMs` up to `pollTimeoutMs` until `session.state == "granted"`; then refresh UI.
   On ad load/show failure or dismissal without reward: no unlock, show an error/retry, allow retry (the same session is reused).
5. Handle `429/503/504` with the server `Retry-After`; keep existing interstitial/banner/app-open behaviour untouched.
6. Optionally ship with the new build and then set `REQUIRE_APP_ID=true` + raise `minimumVersion`/`forceUpdate` in the existing settings.

## 9. Setup checklist (backend)
1. Deploy; set `REDIS_URL`, `MONGO_URL`, `ADMIN_TOKEN`, `BASE_URL` (+ `TRUST_PROXY` behind a proxy). Run `npm run db:ensure-indexes` (optional).
2. Create rewarded ad units + SSV callback (§5). `PUT` the unit ids (§2) — quota turns on for that app at that moment.
3. Verify with `GET /api/quota?deviceId=test&appId=vydo` and a test device.

## 10. Needed from you to finish the apps
* The **source of both Flutter apps** (or repos), the Flutter version, and which ad SDK/version they use (`google_mobile_ads`?), plus how `deviceId` is generated/stored today.
* The **AdMob rewarded ad unit IDs** (and permission/credentials to enable SSV in the AdMob console).
* Optional: Play Integrity setup if you want stronger anti-abuse.
