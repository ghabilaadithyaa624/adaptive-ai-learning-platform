/**
 * Test database URL resolution — the single source of truth for whether the
 * DB-backed suites (integration / api / db / auth / e2e) can run.
 *
 * Precedence: TEST_DATABASE_URL > DATABASE_URL. A URL containing "placeholder"
 * is treated as *absent* — the env setup file assigns a placeholder so that
 * `@/db` can be imported without a live database (its pg Pool is lazy and only
 * connects on the first query, which the skipped suites never issue).
 *
 * This module is intentionally dependency-free so it can be imported from the
 * vitest global setup, the per-worker env setup, and the test helpers alike.
 */

export const PLACEHOLDER_DATABASE_URL = "postgres://placeholder:placeholder@127.0.0.1:1/placeholder";

export function resolveTestDatabaseUrl(): string | null {
  const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
  if (!url || url.includes("placeholder")) return null;
  return url;
}

export const hasDatabase = resolveTestDatabaseUrl() !== null;
