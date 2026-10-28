/**
 * Minimal circuit breaker protecting the paid provider during outages/misconfig.
 * closed -> (threshold consecutive failures) -> open -> (cooldown) -> half-open (1 probe)
 */
function createBreaker({ threshold = 5, cooldownMs = 30000, now = Date.now } = {}) {
  let failures = 0, openedAt = 0, probing = false, state = "closed";
  const refresh = () => {
    if (state === "open" && now() - openedAt >= cooldownMs) { state = "half-open"; probing = false; }
  };
  return {
    allow() {
      refresh();
      if (state === "closed") return true;
      if (state === "half-open" && !probing) { probing = true; return true; }
      return false;
    },
    success() { failures = 0; probing = false; state = "closed"; },
    failure() {
      refresh();
      failures += 1;
      probing = false;
      if (state === "half-open" || failures >= threshold) { state = "open"; openedAt = now(); }
    },
    state() { refresh(); return state; },
    retryAfterSec() { return Math.max(1, Math.ceil((cooldownMs - (now() - openedAt)) / 1000)); },
  };
}
module.exports = { createBreaker };
