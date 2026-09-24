import { defineConfig } from "drizzle-kit";

/**
 * Drizzle Kit configuration.
 *
 * - `generate` produces versioned SQL migrations in ./drizzle from the schema.
 * - `migrate` applies them to the database in $DATABASE_URL (production deploys).
 *
 * The test harness pushes the schema directly (see tests/setup/global.ts) for a
 * fast, disposable database; production uses the versioned migrations here.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
