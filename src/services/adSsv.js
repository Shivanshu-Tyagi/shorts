/**
 * AdMob rewarded-ad Server-Side Verification (SSV).
 * Google calls  GET <callback>?ad_network=..&ad_unit=..&custom_data=..&reward_amount=..&reward_item=..
 *                             &timestamp=..&transaction_id=..&user_id=..&signature=..&key_id=..
 * `signature` is ECDSA/SHA-256 (DER, base64url) over the RAW query string preceding "&signature=".
 * Public keys: https://www.gstatic.com/admob/reward/verifier-keys.json
 */
const crypto = require("crypto");
const { AppError } = require("../utils/errors");

function createKeyProvider({ url, cacheMs, fetchImpl = globalThis.fetch, now = Date.now }) {
  let keys = new Map(), fetchedAt = 0, lastTry = 0;
  async function refresh() {
    lastTry = now();
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`keys http ${res.status}`);
    const body = await res.json();
    const m = new Map();
    for (const k of body.keys || []) if (k && k.keyId != null && k.pem) m.set(String(k.keyId), k.pem);
    if (!m.size) throw new Error("no keys");
    keys = m; fetchedAt = now();
  }
  return async function getKey(keyId) {
    const id = String(keyId);
    const stale = now() - fetchedAt > cacheMs;
    if ((stale || !keys.has(id)) && now() - lastTry > 60000) { try { await refresh(); } catch (e) { if (!keys.size) throw e; } } // unknown key: refresh at most 1/min
    return keys.get(id) || null;
  };
}

function createSsvVerifier({ keyProvider, now = Date.now, maxAgeMs = 3600000, maxFutureMs = 300000 }) {
  /** @returns {Promise<Record<string,string>>} verified params. @throws AppError(SSV_INVALID) */
  return async function verify(rawQuery) {
    const bad = () => new AppError("SSV_INVALID");
    if (typeof rawQuery !== "string" || !rawQuery || rawQuery.length > 4096) throw bad();
    const idx = rawQuery.indexOf("&signature=");
    if (idx <= 0) throw bad();
    const message = rawQuery.slice(0, idx);
    const p = new URLSearchParams(rawQuery);
    const sig = p.get("signature"), keyId = p.get("key_id");
    if (!sig || !keyId) throw bad();
    let pem;
    try { pem = await keyProvider(keyId); } catch (e) { throw new AppError("SERVICE_BUSY", undefined, { cause: e }); } // keys unreachable: let Google retry
    if (!pem) throw bad();
    let ok = false;
    try {
      ok = crypto.verify("sha256", Buffer.from(message), { key: pem, dsaEncoding: "der" }, Buffer.from(sig.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
    } catch { ok = false; }
    if (!ok) throw bad();
    const params = Object.fromEntries(p.entries());
    for (const k of ["transaction_id", "timestamp", "user_id", "custom_data", "ad_unit"]) if (!params[k]) throw bad();
    const ts = Number(params.timestamp), t = now();
    if (!Number.isFinite(ts) || t - ts > maxAgeMs || ts - t > maxFutureMs) throw bad();
    return params;
  };
}

/** configured "ca-app-pub-123/456" vs SSV "ad_unit" (AdMob sends the numeric ad-unit id). */
const adUnitMatches = (configured, ssvAdUnit) => {
  if (!configured || !ssvAdUnit) return false;
  const c = configured.trim(), s = String(ssvAdUnit).trim();
  return c === s || c.split("/").pop() === s.split("/").pop();
};

module.exports = { createSsvVerifier, createKeyProvider, adUnitMatches };
