/** Produces genuinely signed AdMob-style SSV callbacks with a locally generated EC P-256 key. */
const crypto = require("crypto");

function createSigner(keyId = 3335741209) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = publicKey.export({ type: "spki", format: "pem" });
  const enc = encodeURIComponent;
  function build(over = {}, { signWith = privateKey, kid = keyId, tamper } = {}) {
    const p = { ad_network: "5450213213286189855", ad_unit: "2222222222", custom_data: "NONCE", reward_amount: "1", reward_item: "reward",
      timestamp: String(Date.now()), transaction_id: crypto.randomBytes(16).toString("hex"), user_id: "device-1", ...over };
    const message = Object.entries(p).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${enc(v)}`).join("&");
    const sig = crypto.sign("sha256", Buffer.from(message), { key: signWith, dsaEncoding: "der" }).toString("base64url");
    let query = `${message}&signature=${sig}&key_id=${kid}`;
    if (tamper) query = tamper(query);
    return { query, params: p, url: `/api/ads/ssv?${query}` };
  }
  return { keyId, pem, build, keyProvider: async (id) => (String(id) === String(keyId) ? pem : null) };
}
module.exports = { createSigner };
