import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { log, metrics, now, registry } from "@/lib/observability";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const globalForDb = globalThis as typeof globalThis & {
  __arenaNextJsPostgresqlPool?: Pool;
  __arenaObservabilityInstrumented?: boolean;
};

/**
 * Connection-pool sizing (env-tunable).
 *
 * pg defaults to max=10 and no connection timeout. Under load an undersized
 * pool silently serializes requests, and a missing acquire timeout means a
 * borrowed-but-never-returned connection can hang a request forever. We expose
 * sensible, explicit production defaults; the observability layer already
 * exports `adaptiq_db_pool_connections{state}` so saturation is visible.
 */
const num = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const pool =
  globalForDb.__arenaNextJsPostgresqlPool ??
  new Pool({
    connectionString: databaseUrl,
    max: num(process.env.DB_POOL_MAX, 10),
    idleTimeoutMillis: num(process.env.DB_POOL_IDLE_MS, 30_000),
    connectionTimeoutMillis: num(process.env.DB_POOL_CONNECT_TIMEOUT_MS, 10_000),
  });

if (process.env.NODE_ENV !== "production") {
  globalForDb.__arenaNextJsPostgresqlPool = pool;
}

/**
 * Instrument the pool so EVERY query — from anywhere in the app, drizzle or raw
 * — records latency + error metrics and surfaces slow queries in the logs. We
 * wrap `pool.query` once (guarded against re-wrapping across hot-reloads).
 *
 * Only the SQL verb (select/insert/…) is used as a metric label; we never log
 * bind parameters, which can carry PII / credentials.
 */
function sqlVerb(text: unknown): string {
  const raw = typeof text === "string" ? text : typeof text === "object" && text && "text" in text ? String((text as { text: unknown }).text) : "";
  const match = raw.trimStart().slice(0, 12).match(/^[a-zA-Z]+/);
  return match ? match[0].toLowerCase() : "other";
}

const SLOW_QUERY_MS = Number(process.env.SLOW_QUERY_MS ?? 300);

if (!globalForDb.__arenaObservabilityInstrumented) {
  const original = pool.query.bind(pool);
  (pool as { query: unknown }).query = function instrumentedQuery(...args: unknown[]): unknown {
    const last = args[args.length - 1];
    const first = args[0];
    // Callback form or Submittable (cursor/stream): pass through untouched.
    if (
      typeof last === "function" ||
      (first && typeof first === "object" && typeof (first as { submit?: unknown }).submit === "function")
    ) {
      return original(...(args as Parameters<typeof original>));
    }
    const op = sqlVerb(first);
    const start = now();
    const record = (status: "ok" | "error") => {
      const ms = now() - start;
      metrics.dbQueryDuration.observe(ms / 1000, { op, status });
      if (status === "error") metrics.dbErrorsTotal.inc({ op });
      if (ms > SLOW_QUERY_MS) log.warn("db.slow_query", { op, durationMs: Math.round(ms), status });
    };
    try {
      const result = original(...(args as Parameters<typeof original>)) as unknown as Promise<unknown>;
      return result.then(
        (value) => {
          record("ok");
          return value;
        },
        (error) => {
          record("error");
          throw error;
        },
      );
    } catch (error) {
      record("error");
      throw error;
    }
  };

  // Refresh connection-pool saturation gauges at scrape time.
  registry.onCollect(() => {
    metrics.dbPoolConnections.set(pool.totalCount, { state: "total" });
    metrics.dbPoolConnections.set(pool.idleCount, { state: "idle" });
    metrics.dbPoolConnections.set(pool.waitingCount, { state: "waiting" });
  });

  // Surface unexpected pool-level failures (dead backends, etc.).
  pool.on("error", (error) => {
    metrics.appErrorsTotal.inc({ type: "db_pool" });
    log.exception("db.pool_error", error);
  });

  globalForDb.__arenaObservabilityInstrumented = true;
}

export const db = drizzle(pool);
