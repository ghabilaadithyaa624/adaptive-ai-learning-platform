import { afterAll, beforeEach, expect, it } from "vitest";
import { db, describeDb, closePool } from "../helpers/db";
import { seedFixtures } from "../helpers/fixtures";
import { trainAndPersistClassifier, loadClassifier, CLASSIFIER_NAME } from "@/lib/ml/registry";
import { getModelEvaluations, getModelRegistry } from "@/lib/queries";
import { mlModels } from "@/db/schema";

const allFinite = (xs: number[]) => xs.every((x) => Number.isFinite(x));

describeDb("integration · ML training, evaluation & registry", () => {
  beforeEach(async () => {
    await seedFixtures();
  });
  afterAll(async () => {
    await closePool();
  });

  it("trains a classifier from observed responses and persists it to the registry", async () => {
    const { model, datasetVersion, featureVersion, heldOutSamples } = await trainAndPersistClassifier();
    expect(model.weights.length).toBeGreaterThan(0);
    expect(allFinite(model.weights)).toBe(true);
    expect(allFinite([model.metrics.accuracy, model.metrics.logLoss, model.metrics.brier])).toBe(true);
    expect(typeof datasetVersion).toBe("string");
    expect(featureVersion).toMatch(/feat/);
    expect(heldOutSamples).toBeGreaterThanOrEqual(0);

    // Persisted to mlModels and loadable.
    const registry = await getModelRegistry();
    expect(registry.some((m) => m.name === CLASSIFIER_NAME)).toBe(true);
    const loaded = await loadClassifier();
    expect(loaded.weights).toEqual(model.weights);
  });

  it("training is DETERMINISTIC — identical data yields identical weights", async () => {
    const first = await trainAndPersistClassifier();
    // Re-seed the exact same deterministic dataset and retrain.
    await seedFixtures();
    const second = await trainAndPersistClassifier();
    expect(second.model.weights).toEqual(first.model.weights);
    expect(second.model.means).toEqual(first.model.means);
    expect(second.model.stds).toEqual(first.model.stds);
    expect(second.datasetVersion).toEqual(first.datasetVersion);
  });

  it("appends an immutable evaluation record with a promotion verdict", async () => {
    const { promotion } = await trainAndPersistClassifier();
    expect(["improved", "regressed", "mixed", "insufficient-evidence", "incomparable", "unchanged"]).toContain(
      promotion.verdict,
    );

    const evals = await getModelEvaluations(CLASSIFIER_NAME, 10);
    expect(evals.length).toBeGreaterThanOrEqual(1);
    expect(evals[0].modelName).toBe(CLASSIFIER_NAME);

    // The registry keeps exactly one current row per model (upsert by name).
    const rows = await db.select().from(mlModels);
    expect(rows.filter((r) => r.name === CLASSIFIER_NAME)).toHaveLength(1);
  });
});
