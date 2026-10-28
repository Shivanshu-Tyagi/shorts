/** Tiny TTL + max-size cache (oldest-insertion eviction). */
class TTLCache {
  constructor({ ttlMs, max = 1000, now = Date.now } = {}) {
    this.ttlMs = ttlMs; this.max = max; this.now = now; this.map = new Map();
  }
  get(key) {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.exp <= this.now()) { this.map.delete(key); return undefined; }
    return e.val;
  }
  set(key, val, ttlMs = this.ttlMs) {
    if (!(ttlMs > 0)) return;
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { val, exp: this.now() + ttlMs });
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
  delete(key) { this.map.delete(key); }
  clear() { this.map.clear(); }
  get size() { return this.map.size; }
}
module.exports = { TTLCache };
