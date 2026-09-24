import { vi, afterAll, beforeAll, beforeEach, expect, it } from "vitest";

vi.mock("next/headers", () => import("../helpers/next-headers-mock"));
vi.mock("next/navigation", () => import("../helpers/next-navigation-mock"));

import { describeDb, closePool } from "../helpers/db";
import { seedFixtures, type Fixtures } from "../helpers/fixtures";
import { loginAs, logout } from "../helpers/session";
import { GET, POST, readJson } from "../helpers/http";
import { GET as mlGET, POST as mlPOST } from "@/app/api/ml/route";

const isFiniteNum = (v: unknown) => typeof v === "number" && Number.isFinite(v);

describeDb("API · ML registry (train / evaluate / predict)", () => {
  let fx: Fixtures;

  beforeAll(() => {
    (globalThis as { __adaptiqSeedPromise?: Promise<void> }).__adaptiqSeedPromise = Promise.resolve();
  });
  beforeEach(async () => {
    fx = await seedFixtures();
    await logout();
  });
  afterAll(async () => {
    await closePool();
  });

  it("GET returns the model registry and training sample count", async () => {
    await loginAs(fx.users.teacherA);
    const res = await mlGET(GET("/api/ml"));
    expect(res.status).toBe(200);
    const data = await readJson<{ models: unknown[]; trainingSamples: number }>(res);
    expect(Array.isArray(data.models)).toBe(true);
    expect(data.trainingSamples).toBeGreaterThanOrEqual(12); // fixtures' graded history
  });

  it("trains the difficulty classifier on observed responses and reports finite metrics", async () => {
    await loginAs(fx.users.teacherA);
    const res = await mlPOST(POST("/api/ml", { body: { action: "train" } }));
    expect(res.status).toBe(200);
    const data = await readJson<{ model: { metrics: Record<string, number>; datasetVersion: string }; comparison: { verdict: string } }>(res);
    expect(data.model).toBeTruthy();
    expect(isFiniteNum(data.model.metrics.accuracy)).toBe(true);
    expect(typeof data.model.datasetVersion).toBe("string");
    // Evidence-gated promotion decision is present (never a bare "better").
    expect(typeof data.comparison.verdict).toBe("string");
  });

  it("evaluates the served predictions with a full metric report", async () => {
    await loginAs(fx.users.teacherA);
    const res = await mlPOST(POST("/api/ml", { body: { action: "evaluate" } }));
    expect(res.status).toBe(200);
    const data = await readJson<{ samples: number; metrics: Record<string, number> }>(res);
    expect(data.samples).toBeGreaterThan(0);
    expect(isFiniteNum(data.metrics.accuracy)).toBe(true);
    expect(isFiniteNum(data.metrics.logLoss)).toBe(true);
    expect(isFiniteNum(data.metrics.brier)).toBe(true);
  });

  it("predicts success probability for an in-scope learner + question", async () => {
    await loginAs(fx.users.teacherA);
    const res = await mlPOST(
      POST("/api/ml", { body: { action: "predict", studentId: fx.users.alice, questionId: fx.questions.arithmetic[0] } }),
    );
    expect(res.status).toBe(200);
    const data = await readJson<{ predictions: { probability: number }[] }>(res);
    expect(data.predictions).toHaveLength(3); // authored / easier / harder scenarios
    expect(data.predictions.every((p) => p.probability >= 0 && p.probability <= 1)).toBe(true);
  });

  it("refuses prediction for a learner outside the caller's institution (403)", async () => {
    await loginAs(fx.users.teacherA); // Northwind
    const res = await mlPOST(
      POST("/api/ml", { body: { action: "predict", studentId: fx.users.carol, questionId: fx.questions.arithmetic[0] } }),
    );
    expect(res.status).toBe(403);
  });
});
