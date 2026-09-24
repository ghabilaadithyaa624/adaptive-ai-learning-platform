import Redis from "ioredis";
import type { RateLimitStore, RateResult } from "./rate-limit";

/**
 * Redis-backed rate-limit store — a shared, atomic sliding-window-log limiter
 * for horizontally-scaled deployments (all app replicas count against the same
 * window). Activated automatically when `REDIS_URL` is set (see rate-limit.ts).
 *
 * The window is maintained as a sorted set (score = timestamp) and evaluated in
 * a single Lua script so the read-modify-write is atomic across concurrent
 * requests. On any Redis error the call degrades to the provided in-memory
 * fallback, so a Redis outage can never take the app down.
 */
const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)
if count >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retry = 1
  if oldest[2] then
    retry = math.ceil((window - (now - tonumber(oldest[2]))) / 1000)
    if retry < 1 then retry = 1 end
  end
  return {0, 0, retry}
else
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, window)
  return {1, limit - count - 1, 0}
end
`;

export class RedisRateLimitStore implements RateLimitStore {
  private redis: Redis;
  private prefix: string;
  private fallback: RateLimitStore | null;
  private loggedError = false;

  constructor(url: string, opts?: { prefix?: string; fallback?: RateLimitStore }) {
    this.prefix = opts?.prefix ?? "adaptiq:rl:";
    this.fallback = opts?.fallback ?? null;
    this.redis = new Redis(url, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      // Don't spam reconnects forever if the URL is wrong.
      retryStrategy: (times) => (times > 10 ? null : Math.min(times * 200, 2000)),
    });
    this.redis.on("error", (err: Error) => {
      if (!this.loggedError) {
        console.error("[rate-limit] Redis unavailable, using in-memory fallback:", err.message);
        this.loggedError = true;
      }
    });
    this.redis.on("ready", () => {
      this.loggedError = false;
    });
  }

  /** Close the Redis connection (graceful shutdown / tests). */
  async close(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }

  async hit(key: string, limit: number, windowMs: number): Promise<RateResult> {
    const now = Date.now();
    const member = `${now}-${Math.random().toString(36).slice(2)}`;
    try {
      const res = (await this.redis.eval(
        SLIDING_WINDOW_LUA,
        1,
        this.prefix + key,
        String(now),
        String(windowMs),
        String(limit),
        member,
      )) as [number, number, number];
      return { ok: Number(res[0]) === 1, remaining: Number(res[1]), retryAfterSec: Number(res[2]) };
    } catch {
      // Redis failed — degrade to per-instance limiting rather than dropping the control.
      if (this.fallback) return this.fallback.hit(key, limit, windowMs);
      return { ok: true, remaining: limit, retryAfterSec: 0 };
    }
  }
}

export function createRedisRateLimitStore(url: string, fallback?: RateLimitStore): RedisRateLimitStore {
  return new RedisRateLimitStore(url, { fallback });
}
