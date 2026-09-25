/**
 * Small in-process TTL cache for STABLE, NON-student, low-cardinality data.
 *
 * WHAT MAY BE CACHED HERE (and only this):
 *   - subjects, the skill catalog, question *metadata* rollups
 *   - the ML model registry + the active classifier model
 * These change rarely (admin edits / model retrains) and are identical for every
 * caller, so a short TTL + explicit invalidation on write is safe.
 *
 * WHAT MUST NEVER BE CACHED HERE:
 *   - anything scoped to a student / learner (mastery, assessments, detail,
 *     recommendations, cohort snapshots). Per-student data is request-specific
 *     and would leak or go stale across users. Those functions are intentionally
 *     left uncached.
 *
 * WHY NOT REDIS: this is a single-process Next.js server and the cached payloads
 * are tiny and cheap to recompute. A process-local Map avoids the network hop,
 * serialization and operational cost of Redis with no downside. If/when the app
 * is scaled horizontally (multiple instances) and needs *shared* invalidation,
 * swap this module's get/set/invalidate for a Redis client (e.g. via a
 * `CACHE_URL` env) — the call sites do not change. Until then Redis is not
 * justified. Each instance also self-heals via the TTL, so cross-instance
 * staleness after a write is bounded by the (short) TTL even without Redis.
 */

type Entry<T> = { value: T; expiresAt: number };

const store = new Map<string, Entry<unknown>>();
// Coalesce concurrent misses so a cold cache doesn't stampede the DB.
const inflight = new Map<string, Promise<unknown>>();

export const CACHE_TTL = {
  /** Reference data edited only by admins. */
  reference: 60_000,
  /** Model registry / classifier — invalidated explicitly on retrain. */
  model: 300_000,
  /**
   * Retry window for a *degraded* model load (fallback in force). Short enough
   * that recovery is picked up promptly, long enough that a sustained outage
   * does not turn the hot assessment path into a query storm.
   */
  modelDegraded: 30_000,
} as const;

/**
 * Return the cached value for `key`, or compute it with `loader`, store it for
 * `ttlMs`, and return it. Concurrent misses share one in-flight load.
 *
 * `ttlMs` may be a function of the loaded value. That exists for degraded
 * results: caching a fallback for the full model TTL would pin a transient
 * failure in place for minutes after the cause cleared, while re-loading on
 * every request would hammer an already-unhealthy database. A value-dependent
 * TTL lets the caller keep the happy path cheap and retry the degraded path
 * soon.
 */
export async function cached<T>(
  key: string,
  ttlMs: number | ((value: T) => number),
  loader: () => Promise<T>,
): Promise<T> {
  const hit = store.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value as T;

  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;

  const promise = (async () => {
    try {
      const value = await loader();
      const ttl = typeof ttlMs === "function" ? ttlMs(value) : ttlMs;
      store.set(key, { value, expiresAt: Date.now() + ttl });
      return value;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, promise);
  return promise as Promise<T>;
}

/** Invalidate a single key (call after a write that changes it). */
export function invalidate(key: string): void {
  store.delete(key);
}

/** Invalidate every key beginning with `prefix`. */
export function invalidatePrefix(prefix: string): void {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

/** Test/introspection helper. */
export function clearCache(): void {
  store.clear();
  inflight.clear();
}

export const CACHE_KEYS = {
  subjects: "ref:subjects",
  skillCatalog: "ref:skill-catalog",
  classifier: "model:classifier",
  modelRegistry: "model:registry",
} as const;
