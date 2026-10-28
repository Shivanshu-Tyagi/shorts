/**
 * POST /api/download-all
 * This file used to be a byte-for-byte copy of download.controller.js (two copies of the
 * same logic = two places that could call the paid provider). It is now an alias.
 */
const { handleDownload } = require("./download.controller");

exports.downloadAllVideo = handleDownload;
