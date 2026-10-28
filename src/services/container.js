/**
 * Composition root: wires real infrastructure into the services.
 * Lazy, so unit tests (and the worker) never open connections they don't need.
 */
const { config } = require("../config");
const { metrics } = require("./metrics.service");
const logger = require("../utils/logger");
const { createDownloadService } = require("./download.service");
const { getProvider } = require("./rapidapi.service");

let service = null;
let quotaSvc = null, settingsSvc = null, ssv = null;

function queuePort() {
  const mod = () => require("../queues/download.queue");
  return {
    isReady: () => mod().connection.status === "ready",
    enqueue: (name, data, opts) => mod().downloadQueue.add(name, data, opts),
  };
}

function getAppSettings() {
  if (!settingsSvc) {
    const { createAppSettings } = require("./appSettings");
    settingsSvc = createAppSettings({ store: require("../repositories/mongo").settings, config });
  }
  return settingsSvc;
}

function getQuotaService() {
  if (!quotaSvc) {
    const { createQuotaService } = require("./quota.service");
    quotaSvc = createQuotaService({ quotas: require("../repositories/mongo").quotas, settings: getAppSettings(), metrics });
  }
  return quotaSvc;
}

function getSsvVerifier() {
  if (!ssv) {
    const { createSsvVerifier, createKeyProvider } = require("./adSsv");
    ssv = createSsvVerifier({
      keyProvider: createKeyProvider({ url: config.ssv.keysUrl, cacheMs: config.ssv.keyCacheMs }),
      maxAgeMs: config.ssv.maxAgeMs,
    });
  }
  return ssv;
}

function getDownloadService() {
  if (!service) {
    const { assets, rows } = require("../repositories/mongo");
    service = createDownloadService({ assets, rows, provider: getProvider(), queue: queuePort(), config, metrics, logger, quota: getQuotaService() });
  }
  return service;
}

module.exports = {
  getDownloadService, getQuotaService, getAppSettings, getSsvVerifier,
  queuePort,
  /** test seams */
  setDownloadService: (s) => { service = s; },
  setQuotaService: (s) => { quotaSvc = s; },
  setAppSettings: (s) => { settingsSvc = s; },
  setSsvVerifier: (s) => { ssv = s; },
};
