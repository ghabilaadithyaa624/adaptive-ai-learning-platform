/**
 * Vitest global setup — runs ONCE before the whole test run (main process).
 *
 * When a real test database is configured it pushes the current Drizzle schema
 * into it so the DB-backed suites have their tables. When no database is
 * configured it is a no-op and those suites skip themselves (see `describeDb`).
 *
 * Schema push is idempotent (`drizzle-kit push --force`) so re-runs are safe.
 * Set TEST_PUSH_SCHEMA=0 to skip the push (e.g. when the schema is already
 * provisioned by CI / a migration step).
 */
import { execSync } from "node:child_process";
import { resolveTestDatabaseUrl } from "../helpers/db-url";

export default async function globalSetup() {
  const url = resolveTestDatabaseUrl();
  if (!url) {
    console.warn(
      "\n[tests] No TEST_DATABASE_URL / DATABASE_URL set — DB-backed suites (db, api, auth, integration, e2e) will be SKIPPED.\n",
    );
    return;
  }
  if (process.env.TEST_PUSH_SCHEMA === "0") return;

  console.log("[tests] pushing Drizzle schema into the test database…");
  execSync(
    `npx drizzle-kit push --dialect=postgresql --schema=./src/db/schema.ts --url="${url}" --force`,
    { stdio: "inherit", cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url } },
  );
}
