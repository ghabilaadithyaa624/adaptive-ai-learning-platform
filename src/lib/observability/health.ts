/**
 * Health checks for the application, PostgreSQL, and critical dependencies.
 *
 * Three consumption modes (see OBSERVABILITY.md § "Health"):
 *   - liveness  — is the process running? (no external calls; used to restart a
 *                 wedged container without cascading failures)
 *   - readiness — can we serve traffic right now? (PostgreSQL reachable + core
 *                 schema present; used to gate load-balancer / k8s routing)
 *   - deep      — full detail for humans and the /api/health dashboard endpoint
 *
 * These checks are intentionally cheap and side-effect free — in particular they
 * do NOT trigger database seeding.
 */
import { sql } from "drizzle-orm";
import { db, pool } from "@/db";
import { now } from "./metrics";
import { round } from "@/lib/utils";
import { listModelServingStatus } from "@/lib/ml/model-fallback";

export type CheckStatus = "pass" | "warn" | "fail";

export type Check = {
  name: string;
  status: CheckStatus;
  latencyMs?: number;
  detail?: string;
  critical: boolean;
};

const startedAt = Date.now();

async function timed<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T; ms: number } | { ok: false; error: unknown; ms: number }> {
  const t0 = now();
  try {
    const value = await fn();
    return { ok: true, value, ms: now() - t0 };
  } catch (error) {
    return { ok: false, error, ms: now() - t0 };
  }
}

/** PostgreSQL reachability + round-trip latency (a critical dependency). */
export async function checkPostgres(): Promise<Check> {
  const result = await timed(() => db.execute(sql`select 1 as ok`));
  if (result.ok) {
    return {
      name: "postgres",
      status: result.ms > 500 ? "warn" : "pass",
      latencyMs: round(result.ms, 1),
      critical: true,
      detail: result.ms > 500 ? "elevated query latency" : undefined,
    };
  }
  return { name: "postgres", status: "fail", latencyMs: round(result.ms, 1), critical: true, detail: "unreachable" };
}

/** Core schema presence — a migration gap is a critical, non-obvious failure. */
export async function checkSchema(): Promise<Check> {
  const result = await timed(() =>
    db.execute(
      sql`select count(*)::int as present from information_schema.tables
          where table_schema = 'public'
          and table_name in ('users','skills','questions','assessments','recommendations')`,
    ),
  );
  if (!result.ok) {
    return { name: "schema", status: "fail", latencyMs: round(result.ms, 1), critical: true, detail: "check failed" };
  }
  const present = Number((result.value.rows?.[0] as { present?: number } | undefined)?.present ?? 0);
  const ok = present >= 5;
  return {
    name: "schema",
    status: ok ? "pass" : "fail",
    latencyMs: round(result.ms, 1),
    critical: true,
    detail: ok ? undefined : `only ${present}/5 core tables present — migrations may be pending`,
  };
}

/** Connection-pool saturation — a warn signal, not a hard failure. */
export function checkPool(): Check {
  const waiting = pool.waitingCount;
  return {
    name: "db_pool",
    status: waiting > 0 ? "warn" : "pass",
    critical: false,
    detail: `total=${pool.totalCount} idle=${pool.idleCount} waiting=${waiting}`,
  };
}

/**
 * Is prediction traffic being served by a fallback model?
 *
 * Reported as a NON-CRITICAL warn, never a fail. A fallback classifier still
 * produces usable predictions, and no governance policy here requires failing
 * closed on model degradation — marking it critical would let a corrupt JSONB
 * column pull the instance out of the load balancer and turn a quality problem
 * into an outage. Operators get the signal; the decision stays human.
 *
 * Process-local by design: it answers "is *this* replica degraded", which is
 * what a per-instance health endpoint is for. The Prometheus gauge
 * `adaptiq_ml_model_fallback_active` aggregates the same signal across replicas.
 */
export function checkModelServing(): Check {
  const statuses = listModelServingStatus();
  const degraded = statuses.filter((s) => s.source === "fallback");
  if (!degraded.length) {
    const serving = statuses.map((s) => `${s.model}@${s.servingVersion}`).join(" ");
    return {
      name: "ml_model_serving",
      status: "pass",
      critical: false,
      detail: serving || "no model loaded in this process yet",
    };
  }
  return {
    name: "ml_model_serving",
    status: "warn",
    critical: false,
    detail: degraded
      .map((s) => `${s.model}: fallback since ${s.since} (${s.category}, ${s.consecutiveFailures} failed loads)`)
      .join("; "),
  };
}

function overall(checks: Check[]): CheckStatus {
  if (checks.some((c) => c.critical && c.status === "fail")) return "fail";
  if (checks.some((c) => c.status !== "pass")) return "warn";
  return "pass";
}

export function uptimeSeconds(): number {
  return round((Date.now() - startedAt) / 1000, 0);
}

/** Liveness: the event loop is turning. No dependency calls. */
export function liveness(): { status: "pass"; uptimeSeconds: number } {
  return { status: "pass", uptimeSeconds: uptimeSeconds() };
}

/** Readiness: PostgreSQL reachable and core schema present. */
export async function readiness(): Promise<{ status: CheckStatus; checks: Check[] }> {
  const checks = [await checkPostgres(), await checkSchema()];
  return { status: overall(checks), checks };
}

/** Deep health: everything, for the dashboard endpoint. */
export async function deepHealth(): Promise<{ status: CheckStatus; checks: Check[]; uptimeSeconds: number }> {
  const [postgres, schema] = await Promise.all([checkPostgres(), checkSchema()]);
  const checks = [postgres, schema, checkPool(), checkModelServing()];
  return { status: overall(checks), checks, uptimeSeconds: uptimeSeconds() };
}
