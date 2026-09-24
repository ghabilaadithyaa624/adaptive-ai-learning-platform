import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    globals: false,
    // Normalize env (DATABASE_URL/TZ) before any test module imports `@/db`.
    setupFiles: ["tests/setup/env.ts"],
    // Push the Drizzle schema once when a test database is configured.
    globalSetup: ["tests/setup/global.ts"],
    // DB-backed suites share one database and reset it per file; run files
    // serially so they never race each other. Determinism over raw speed.
    fileParallelism: false,
    reporters: ["default"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
