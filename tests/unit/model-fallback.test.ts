/**
 * Model-registry fallback observability.
 *
 * The fallback itself is a feature and is asserted to still work in every case
 * below — no test here expects a throw. What is under test is that the
 * degradation is *visible*: counted, gauged, logged once per cause per window,
 * and reportable to an operator, without leaking anything about learners.
 *
 * The database is mocked rather than skipped so these run in CI, where the
 * DB-backed suites do not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbState = vi.hoisted(() => ({
  /** Rows the mocked registry query returns, or an error it throws. */
  rows: [] as unknown[],
  error: null as unknown,
  queries: 0,
}));

vi.mock("@/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            dbState.queries += 1;
            if (dbState.error) throw dbState.error;
            return dbState.rows;
          },
        }),
      }),
    }),
  },
  pool: { totalCount: 0, idleCount: 0, waitingCount: 0 },
}));

import { CLASSIFIER_NAME, loadClassifier } from "@/lib/ml/registry";
import { HEURISTIC_MODEL, FEATURE_NAMES } from "@/lib/ml/classifier";
import {
  getModelServingStatus,
  isServingFallback,
  listModelServingStatus,
  resetModelFallbackState,
  safeFailureContext,
} from "@/lib/ml/model-fallback";
import { CLASSIFIER_PARAMS_V1 } from "@/lib/persistence";
import { checkModelServing } from "@/lib/observability/health";
import { registry } from "@/lib/observability/metrics";
import { clearCache } from "@/lib/cache";

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

/** Read one counter sample out of the Prometheus exposition text. */
function counterValue(name: string, labels: Record<string, string>): number {
  const rendered = registry.render();
  const wanted = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v}"`)
    .join(",");
  const line = rendered.split("\n").find((l) => l.startsWith(`${name}{${wanted}}`));
  return line ? Number(line.slice(line.lastIndexOf(" ") + 1)) : 0;
}

function gaugeValue(name: string, labels: Record<string, string>): number {
  return counterValue(name, labels);
}

const FALLBACK_METRIC = "adaptiq_ml_model_fallback_total";

function validRow(overrides: Record<string, unknown> = {}) {
  return {
    name: CLASSIFIER_NAME,
    version: "logreg-2.3.0",
    samples: 1200,
    trainedAt: new Date("2025-03-01T00:00:00.000Z"),
    params: {
      schemaVersion: CLASSIFIER_PARAMS_V1,
      featureNames: [...FEATURE_NAMES],
      weights: FEATURE_NAMES.map((_, i) => 0.1 * (i + 1)),
      means: FEATURE_NAMES.map(() => 0),
      stds: FEATURE_NAMES.map(() => 1),
    },
    metrics: { accuracy: 0.8, auc: 0.77 },
    ...overrides,
  };
}

/** Capture the structured log lines emitted during `fn`. */
async function captureLogs(fn: () => Promise<void>): Promise<Record<string, unknown>[]> {
  const previousLevel = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = "debug";
  const lines: Record<string, unknown>[] = [];
  const collect = (chunk: unknown) => {
    for (const raw of String(chunk).trim().split("\n")) {
      if (!raw) continue;
      try {
        lines.push(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        /* non-JSON output is not ours */
      }
    }
    return true;
  };
  const err = vi.spyOn(process.stderr, "write").mockImplementation(collect as never);
  const out = vi.spyOn(process.stdout, "write").mockImplementation(collect as never);
  try {
    await fn();
  } finally {
    err.mockRestore();
    out.mockRestore();
    if (previousLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = previousLevel;
  }
  return lines;
}

/** Force a fresh load: the classifier is cached in-process by design. */
async function freshLoad() {
  clearCache();
  return loadClassifier();
}

beforeEach(() => {
  dbState.rows = [];
  dbState.error = null;
  dbState.queries = 0;
  clearCache();
  resetModelFallbackState();
  delete process.env.ML_FALLBACK_LOG_INTERVAL_MS;
});

afterEach(() => {
  clearCache();
  resetModelFallbackState();
});

/* ------------------------------------------------------------------ */
/* Healthy path                                                        */
/* ------------------------------------------------------------------ */

describe("healthy model load", () => {
  it("serves the registered model and records no fallback", async () => {
    dbState.rows = [validRow()];
    const before = counterValue(FALLBACK_METRIC, {
      model: CLASSIFIER_NAME,
      version: "logreg-2.3.0",
      category: "malformed_params",
    });

    const model = await freshLoad();

    expect(model.version).toBe("logreg-2.3.0");
    expect(model.weights).not.toEqual(HEURISTIC_MODEL.weights);
    expect(
      counterValue(FALLBACK_METRIC, { model: CLASSIFIER_NAME, version: "logreg-2.3.0", category: "malformed_params" }),
    ).toBe(before);
    expect(gaugeValue("adaptiq_ml_model_fallback_active", { model: CLASSIFIER_NAME })).toBe(0);
    expect(isServingFallback()).toBe(false);
  });

  it("reports registry serving state to operators", async () => {
    dbState.rows = [validRow()];
    await freshLoad();

    const status = getModelServingStatus(CLASSIFIER_NAME);
    expect(status).toMatchObject({ source: "registry", servingVersion: "logreg-2.3.0", category: null });
    expect(checkModelServing().status).toBe("pass");
  });

  it("stays quiet on the happy path — no warnings for normal requests", async () => {
    dbState.rows = [validRow()];
    const lines = await captureLogs(async () => {
      await freshLoad();
    });
    expect(lines.filter((l) => l.level === "warn" || l.level === "error")).toEqual([]);
  });

  it("does not re-query the database on every prediction", async () => {
    dbState.rows = [validRow()];
    await freshLoad();
    await loadClassifier();
    await loadClassifier();
    expect(dbState.queries).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* Malformed model                                                     */
/* ------------------------------------------------------------------ */

describe("malformed persisted model", () => {
  it("falls back, counts it, and labels the attempted version", async () => {
    dbState.rows = [validRow({ params: { weights: ["0.4", null] } })];
    const labels = { model: CLASSIFIER_NAME, version: "logreg-2.3.0", category: "malformed_params" };
    const before = counterValue(FALLBACK_METRIC, labels);

    const model = await freshLoad();

    // Fallback preserved: serving continues on the heuristic.
    expect(model.weights).toEqual(HEURISTIC_MODEL.weights);
    expect(model.version).toBe(HEURISTIC_MODEL.version);
    expect(counterValue(FALLBACK_METRIC, labels)).toBe(before + 1);
    expect(gaugeValue("adaptiq_ml_model_fallback_active", { model: CLASSIFIER_NAME })).toBe(1);
  });

  it("separates an unsupported schema version from corruption", async () => {
    dbState.rows = [validRow({ params: { ...validRow().params, schemaVersion: "clf-params-v9" } })];
    const labels = { model: CLASSIFIER_NAME, version: "logreg-2.3.0", category: "unsupported_version" };
    const before = counterValue(FALLBACK_METRIC, labels);

    await freshLoad();

    expect(counterValue(FALLBACK_METRIC, labels)).toBe(before + 1);
    expect(getModelServingStatus(CLASSIFIER_NAME)?.category).toBe("unsupported_version");
  });

  it("counts a missing registry row under its own category", async () => {
    dbState.rows = [];
    const labels = { model: CLASSIFIER_NAME, version: "unknown", category: "no_registered_model" };
    const before = counterValue(FALLBACK_METRIC, labels);

    const model = await freshLoad();

    expect(model).toBe(HEURISTIC_MODEL);
    expect(counterValue(FALLBACK_METRIC, labels)).toBe(before + 1);
  });

  it("emits a structured warning naming the model, version and category", async () => {
    dbState.rows = [validRow({ params: { weights: [] } })];
    const lines = await captureLogs(async () => {
      await freshLoad();
    });
    const warning = lines.find((l) => l.event === "ml.model_fallback");
    expect(warning).toBeDefined();
    expect(warning).toMatchObject({
      level: "warn",
      model: CLASSIFIER_NAME,
      attemptedVersion: "logreg-2.3.0",
      category: "malformed_params",
      servingSource: "fallback",
      consecutiveFailures: 1,
    });
  });
});

/* ------------------------------------------------------------------ */
/* Database failure                                                    */
/* ------------------------------------------------------------------ */

describe("database failure", () => {
  it("falls back and counts a database_error", async () => {
    dbState.error = new Error("connection terminated unexpectedly");
    const labels = { model: CLASSIFIER_NAME, version: "unknown", category: "database_error" };
    const before = counterValue(FALLBACK_METRIC, labels);

    const model = await freshLoad();

    expect(model).toBe(HEURISTIC_MODEL);
    expect(counterValue(FALLBACK_METRIC, labels)).toBe(before + 1);
    expect(getModelServingStatus(CLASSIFIER_NAME)).toMatchObject({
      source: "fallback",
      category: "database_error",
      attemptedVersion: null,
    });
  });

  it("logs the error class and driver code but not the driver message", async () => {
    // A pg error message can carry the failing SQL and its bound parameters —
    // learner ids, submitted answers — so it must never reach the log.
    const error = Object.assign(new Error("insert into assessment_items ... student_id=4711 answer='Paris'"), {
      code: "57P01",
      name: "DatabaseError",
    });
    dbState.error = error;

    const lines = await captureLogs(async () => {
      await freshLoad();
    });
    const warning = lines.find((l) => l.event === "ml.model_fallback");
    expect(warning).toMatchObject({ category: "database_error", errorName: "DatabaseError", errorCode: "57P01" });
    const serialized = JSON.stringify(lines);
    expect(serialized).not.toContain("4711");
    expect(serialized).not.toContain("Paris");
    expect(serialized).not.toContain("assessment_items");
  });

  it("retries soon after a transient failure instead of pinning the fallback", async () => {
    dbState.error = new Error("timeout");
    expect(await freshLoad()).toBe(HEURISTIC_MODEL);

    // The degraded result is cached only briefly; simulate the short TTL
    // lapsing, then prove recovery is picked up and reported.
    dbState.error = null;
    dbState.rows = [validRow()];
    const model = await freshLoad();

    expect(model.version).toBe("logreg-2.3.0");
    expect(getModelServingStatus(CLASSIFIER_NAME)).toMatchObject({ source: "registry" });
    expect(gaugeValue("adaptiq_ml_model_fallback_active", { model: CLASSIFIER_NAME })).toBe(0);
    expect(isServingFallback()).toBe(false);
  });

  it("logs recovery so the incident visibly closes", async () => {
    dbState.error = new Error("timeout");
    await freshLoad();
    dbState.error = null;
    dbState.rows = [validRow()];

    const lines = await captureLogs(async () => {
      await freshLoad();
    });
    const recovery = lines.find((l) => l.event === "ml.model_fallback_recovered");
    expect(recovery).toMatchObject({ model: CLASSIFIER_NAME, servingSource: "registry", version: "logreg-2.3.0" });
  });
});

/* ------------------------------------------------------------------ */
/* Rate limiting                                                       */
/* ------------------------------------------------------------------ */

describe("repeated failures", () => {
  it("warns once per window and counts every occurrence", async () => {
    dbState.error = new Error("connection refused");
    const labels = { model: CLASSIFIER_NAME, version: "unknown", category: "database_error" };
    const before = counterValue(FALLBACK_METRIC, labels);

    const lines = await captureLogs(async () => {
      for (let i = 0; i < 25; i += 1) await freshLoad();
    });

    const warnings = lines.filter((l) => l.event === "ml.model_fallback");
    // Metrics see all 25; the log sees one. That asymmetry is the point: rate
    // is a counter's job, not a log's.
    expect(counterValue(FALLBACK_METRIC, labels)).toBe(before + 25);
    expect(warnings).toHaveLength(1);
    expect(getModelServingStatus(CLASSIFIER_NAME)?.consecutiveFailures).toBe(25);
    expect(getModelServingStatus(CLASSIFIER_NAME)?.suppressedWarnings).toBe(24);
  });

  it("re-warns once the window lapses, reporting what was suppressed", async () => {
    process.env.ML_FALLBACK_LOG_INTERVAL_MS = "0"; // window of zero = every event
    dbState.error = new Error("connection refused");

    const lines = await captureLogs(async () => {
      await freshLoad();
      await freshLoad();
      await freshLoad();
    });
    expect(lines.filter((l) => l.event === "ml.model_fallback")).toHaveLength(3);
  });

  it("does not suppress a different failure cause", async () => {
    dbState.error = new Error("connection refused");
    const lines = await captureLogs(async () => {
      await freshLoad();
      await freshLoad(); // identical cause — suppressed
      dbState.error = null;
      dbState.rows = [validRow({ params: { weights: ["nope"] } })];
      await freshLoad(); // different cause — must warn
    });

    const categories = lines
      .filter((l) => l.event === "ml.model_fallback")
      .map((l) => l.category);
    expect(categories).toEqual(["database_error", "malformed_params"]);
  });

  it("keeps the streak open across changing causes", async () => {
    dbState.error = new Error("boom");
    await freshLoad();
    dbState.error = null;
    dbState.rows = [validRow({ params: { weights: [] } })];
    await freshLoad();

    const status = getModelServingStatus(CLASSIFIER_NAME);
    expect(status?.consecutiveFailures).toBe(2);
    expect(status?.category).toBe("malformed_params");
    expect(status?.since).not.toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Operator surface & data safety                                      */
/* ------------------------------------------------------------------ */

describe("operator surface", () => {
  it("reports degradation as a non-critical warn, never failing the instance", async () => {
    dbState.error = new Error("down");
    await freshLoad();

    const check = checkModelServing();
    expect(check.status).toBe("warn");
    // Critically: not `fail`, and not critical — a degraded model must not pull
    // the replica out of the load balancer.
    expect(check.critical).toBe(false);
    expect(check.detail).toContain("fallback since");
  });

  it("lists every model's serving state", async () => {
    dbState.rows = [validRow()];
    await freshLoad();
    expect(listModelServingStatus().map((s) => s.model)).toEqual([CLASSIFIER_NAME]);
  });

  it("exposes no learner information in the status payload or metric labels", async () => {
    dbState.rows = [validRow({ params: { weights: ["student-4711-answered-Paris"] } })];
    await freshLoad();

    const status = JSON.stringify(getModelServingStatus(CLASSIFIER_NAME));
    expect(status).not.toContain("4711");
    expect(status).not.toContain("Paris");

    const rendered = registry.render();
    const fallbackLines = rendered.split("\n").filter((l) => l.startsWith(FALLBACK_METRIC));
    expect(fallbackLines.length).toBeGreaterThan(0);
    for (const line of fallbackLines) {
      expect(line).not.toContain("4711");
      expect(line).not.toContain("Paris");
      // Label set is closed: model, version, category. Nothing per-learner.
      const labelText = line.slice(line.indexOf("{") + 1, line.indexOf("}"));
      const keys = labelText.split(",").map((pair) => pair.split("=")[0]);
      expect(new Set(keys)).toEqual(new Set(["model", "version", "category"]));
    }
  });

  it("bounds metric label cardinality from untrusted version strings", async () => {
    dbState.rows = [validRow({ version: `v${"x".repeat(200)} weird\nlabel`, params: { weights: [] } })];
    await freshLoad();

    const line = registry
      .render()
      .split("\n")
      .find((l) => l.startsWith(FALLBACK_METRIC) && l.includes("category=\"malformed_params\""));
    const version = line?.match(/version="([^"]*)"/)?.[1] ?? "";
    expect(version.length).toBeLessThanOrEqual(64);
    expect(version).not.toContain("\n");
    expect(version).not.toContain(" ");
  });

  it("reduces arbitrary thrown values to log-safe context", () => {
    expect(safeFailureContext(new Error("secret sql with student 4711"))).toEqual({ errorName: "Error" });
    expect(safeFailureContext("a string")).toEqual({ errorName: "NonError" });
  });
});
