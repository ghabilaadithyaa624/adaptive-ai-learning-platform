/**
 * Per-worker environment normalization. Runs (via `setupFiles`) before any test
 * module is imported, so that:
 *   - `@/db` sees a DATABASE_URL and can be imported everywhere (it only
 *     *connects* on the first query — skipped suites never query);
 *   - dates/number formatting are deterministic (fixed TZ) so assertions do not
 *     depend on the machine's locale/timezone;
 *   - NODE_ENV is "test" (keeps the pg pool off the production singleton path).
 */
import { PLACEHOLDER_DATABASE_URL, resolveTestDatabaseUrl } from "../helpers/db-url";

if (!process.env.NODE_ENV) {
  // vitest sets NODE_ENV=test by default, but be explicit for direct runs.
  (process.env as Record<string, string>).NODE_ENV = "test";
}
process.env.TZ = "UTC";

const url = resolveTestDatabaseUrl();
process.env.DATABASE_URL = url ?? PLACEHOLDER_DATABASE_URL;
