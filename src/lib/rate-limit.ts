import { createRedisRateLimitStore } from "./rate-limit-redis";

/**
 * Rate limiting with a pluggable backing store.
 *
 * The default store is per-process memory (sliding window). It stops naive
 * brute-force / credential-stuffing from a single node and is a meaningful
 * control for single-instance deployments.
 *
 * For horizontally-scaled production, set `REDIS_URL` and the limiter switches
 * automatically to a shared, atomic Redis store (see rate-limit-redis.ts) so
 * limits are enforced across all replicas. A Redis outage degrades gracefully
 * to the in-memory fallback. You can also inject a custom store at startup via
 * `configureRateLimitStore()`.
 */

export type RateResult = { ok: boolean; remaining: number; retryAfterSec: number };

export interface RateLimitStore {
  /** Register one hit for `key` and report whether it is within `limit`/`windowMs`. */
  hit(key: string, limit: number, windowMs: number): Promise<RateResult>;
}

type Bucket = { hits: number[] };

/** Default: per-process sliding-window store. */
export class InMemoryRateLimitStore implements RateLimitStore {
  private buckets: Map<string, Bucket>;

  constructor(seed?: Map<string, Bucket>) {
    this.buckets = seed ?? new Map<string, Bucket>();
  }

  async hit(key: string, limit: number, windowMs: number): Promise<RateResult> {
    const now = Date.now();
    const bucket = this.buckets.get(key) ?? { hits: [] };
    bucket.hits = bucket.hits.filter((t) => now - t < windowMs);

    if (bucket.hits.length >= limit) {
      const oldest = bucket.hits[0]!;
      const retryAfterSec = Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000));
      this.buckets.set(key, bucket);
      return { ok: false, remaining: 0, retryAfterSec };
    }

    bucket.hits.push(now);
    this.buckets.set(key, bucket);

    // Opportunistic cleanup to bound memory.
    if (this.buckets.size > 5000) {
      for (const [k, b] of this.buckets) {
        b.hits = b.hits.filter((t) => now - t < windowMs);
        if (!b.hits.length) this.buckets.delete(k);
      }
    }

    return { ok: true, remaining: limit - bucket.hits.length, retryAfterSec: 0 };
  }
}

// Persist the default store's map across hot reloads / module reevaluation.
const globalForRl = globalThis as typeof globalThis & {
  __adaptiqRateBuckets?: Map<string, Bucket>;
  __adaptiqRateStore?: RateLimitStore;
};
const seed = globalForRl.__adaptiqRateBuckets ?? new Map<string, Bucket>();
globalForRl.__adaptiqRateBuckets = seed;

const inMemoryStore = new InMemoryRateLimitStore(seed);
let activeStore: RateLimitStore = globalForRl.__adaptiqRateStore ?? inMemoryStore;
globalForRl.__adaptiqRateStore = activeStore;

/** Swap the backing store (e.g. a Redis-backed one) at startup. */
export function configureRateLimitStore(store: RateLimitStore): void {
  activeStore = store;
  globalForRl.__adaptiqRateStore = store;
}

export async function rateLimit(key: string, limit: number, windowMs: number): Promise<RateResult> {
  return activeStore.hit(key, limit, windowMs);
}

// Auto-activate the shared Redis store when configured (skip in tests). Redis
// failures fall back to the in-memory store, so this can never break startup.
if (
  process.env.REDIS_URL &&
  process.env.NODE_ENV !== "test" &&
  !globalForRl.__adaptiqRateStore?.constructor?.name?.includes("Redis")
) {
  try {
    configureRateLimitStore(createRedisRateLimitStore(process.env.REDIS_URL, inMemoryStore));
  } catch (err) {
    console.error("[rate-limit] failed to initialize Redis store; using in-memory.", err);
  }
}

/** Read a positive integer env override, falling back to a default. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Common presets — each is overridable via environment variables so operators
 * can tighten/loosen limits without a code change. See .env.example.
 */
export const RATE_LIMITS = {
  login: {
    limit: envInt("RATE_LIMIT_LOGIN_MAX", 10),
    windowMs: envInt("RATE_LIMIT_LOGIN_WINDOW_MS", 5 * 60_000),
  },
  register: {
    limit: envInt("RATE_LIMIT_REGISTER_MAX", 5),
    windowMs: envInt("RATE_LIMIT_REGISTER_WINDOW_MS", 60 * 60_000),
  },
  mutation: {
    limit: envInt("RATE_LIMIT_MUTATION_MAX", 240),
    windowMs: envInt("RATE_LIMIT_MUTATION_WINDOW_MS", 60_000),
  },
} as const;
