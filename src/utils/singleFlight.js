/**
 * In-process single-flight: concurrent callers with the same key share ONE
 * running promise (success AND failure). The entry is removed as soon as the
 * promise settles, so a failure can never block later callers.
 */
function createSingleFlight() {
  const inflight = new Map();
  async function run(key, fn) {
    const existing = inflight.get(key);
    if (existing) return { result: await existing, shared: true };
    const p = (async () => fn())();
    inflight.set(key, p);
    const cleanup = () => { if (inflight.get(key) === p) inflight.delete(key); };
    p.then(cleanup, cleanup);
    return { result: await p, shared: false };
  }
  return { run, size: () => inflight.size };
}
module.exports = { createSingleFlight };
