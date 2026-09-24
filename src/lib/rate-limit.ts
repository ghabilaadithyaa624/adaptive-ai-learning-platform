/**
 * Best-effort in-process rate limiter (sliding window).
 *
 * NOTE: This is per-instance memory only. It stops naive brute-force /
 * credential-stuffing from a single node and is a meaningful control for
 * single-instance / low-scale deployments. For horizontally-scaled production
 * it MUST be backed by a shared store (Redis/Upstash) — the interface here is
 * intentionally swappable.
 */

type Bucket = { hits: number[]; };

const globalForRl = globalThis as typeof globalThis & {
  __adaptiqRateBuckets?: Map<string, Bucket>;
};

const buckets = globalForRl.__adaptiqRateBuckets ?? new Map<string, Bucket>();
globalForRl.__adaptiqRateBuckets = buckets;

export type RateResult = { ok: boolean; remaining: number; retryAfterSec: number };

export function rateLimit(key: string, limit: number, windowMs: number): RateResult {
  const now = Date.now();
  const bucket = buckets.get(key) ?? { hits: [] };
  // drop entries outside the window
  bucket.hits = bucket.hits.filter((t) => now - t < windowMs);

  if (bucket.hits.length >= limit) {
    const oldest = bucket.hits[0];
    const retryAfterSec = Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000));
    buckets.set(key, bucket);
    return { ok: false, remaining: 0, retryAfterSec };
  }

  bucket.hits.push(now);
  buckets.set(key, bucket);

  // opportunistic cleanup to bound memory
  if (buckets.size > 5000) {
    for (const [k, b] of buckets) {
      b.hits = b.hits.filter((t) => now - t < windowMs);
      if (!b.hits.length) buckets.delete(k);
    }
  }

  return { ok: true, remaining: limit - bucket.hits.length, retryAfterSec: 0 };
}

/** Common presets. */
export const RATE_LIMITS = {
  login: { limit: 10, windowMs: 5 * 60_000 }, // 10 / 5 min per key
  register: { limit: 5, windowMs: 60 * 60_000 }, // 5 / hour per key
  mutation: { limit: 240, windowMs: 60_000 }, // generous per-user write ceiling
} as const;
