/**
 * DB-suite gating + low-level database access for tests.
 *
 * `describeDb` is `describe` when a test database is configured and
 * `describe.skip` otherwise, so the DB-backed suites degrade gracefully (and
 * loudly) instead of failing when no database is available. All database access
 * inside those suites must live inside `beforeAll`/`it` (never at describe
 * scope) because a skipped `describe` still evaluates its callback body.
 */
import { describe } from "vitest";
import { sql } from "drizzle-orm";
import { db, pool } from "@/db";
import { hasDatabase } from "./db-url";

export { hasDatabase, db, pool };

export const describeDb = hasDatabase ? describe : describe.skip;

/** Tables in FK-safe truncation order (children first is unnecessary with CASCADE). */
const ALL_TABLES = [
  "audit_logs",
  "tutor_interactions",
  "activity_events",
  "model_evaluations",
  "ml_models",
  "recommendations",
  "path_milestones",
  "learning_paths",
  "mastery_states",
  "assessment_items",
  "assessments",
  "item_statistics",
  "questions",
  "skills",
  "subjects",
  "sessions",
  "users",
  "institutions",
];

/**
 * Reset every table to a clean, empty state with identity sequences restarted,
 * so each DB suite starts from a fully deterministic baseline (IDs are stable
 * within a suite). Runs are serial (`fileParallelism: false`) so this never
 * races another suite.
 */
export async function resetDatabase(): Promise<void> {
  await db.execute(sql.raw(`TRUNCATE TABLE ${ALL_TABLES.join(", ")} RESTART IDENTITY CASCADE;`));
}

/** Close the shared pool — called by the DB suites' final teardown if needed. */
export async function closePool(): Promise<void> {
  await pool.end().catch(() => {});
}
