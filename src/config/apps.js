/**
 * The two apps that share this backend. `rewarded` here is only the FALLBACK that mirrors the
 * values that were hardcoded in setting.controller.js / vydoSetting.controller.js; a DB override
 * (see services/appSettings.js) wins. Both are disabled/blank today: a real AdMob rewarded ad unit
 * must be created and set before reward unlocking can work.
 */
const APPS = Object.freeze({
  shorts: Object.freeze({ id: "shorts", packageName: "com.stackearn.shorts_downloader", rewarded: Object.freeze({ enabled: false, unitId: "" }) }),
  vydo: Object.freeze({ id: "vydo", packageName: "com.vydo_all_video_downloader", rewarded: Object.freeze({ enabled: false, unitId: "" }) }),
});
const isKnownApp = (id) => typeof id === "string" && Object.prototype.hasOwnProperty.call(APPS, id);
module.exports = { APPS, isKnownApp };
