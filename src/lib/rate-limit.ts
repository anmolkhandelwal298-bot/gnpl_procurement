// In-memory sliding-window limiter. Correct for a single instance; for multiple instances put a shared store (Redis/Upstash) behind
// the same interface. Database-level safeguards (per-account lockout, bid idempotency, row locking) do not depend on it.
const buckets = new Map<string, number[]>();
let lastSweep = Date.now();

export function rateLimit(key: string, limit: number, windowMs: number): { ok: boolean; retryAfterSec: number } {
  const now = Date.now();
  if (now - lastSweep > 60_000) {
    lastSweep = now;
    for (const [k, v] of buckets) if (!v.length || now - v[v.length - 1] > 10 * 60_000) buckets.delete(k);
  }
  const hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) {
    buckets.set(key, hits);
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((windowMs - (now - hits[0])) / 1000)) };
  }
  hits.push(now);
  buckets.set(key, hits);
  return { ok: true, retryAfterSec: 0 };
}
export const resetRateLimits = () => buckets.clear();
