/**
 * Experimentation framework — database-backed tests.
 *
 * The pure decision rules are covered exhaustively in
 * `tests/unit/experiments.test.ts`. What can only be tested against a real
 * database lives here:
 *
 *   • the unique index that makes "one learner, one variant" race-safe
 *   • tenant scoping expressed as SQL predicates rather than in-memory checks
 *   • assignment persistence and stickiness across separate calls
 *   • exposure journaling and the assignment↔exposure join
 *   • lifecycle state surviving a round trip
 *
 * These skip cleanly when no `TEST_DATABASE_URL` is configured.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, describeDb, resetDatabase, closePool } from "../helpers/db";
import { seedFixtures, type Fixtures } from "../helpers/fixtures";
import { experimentAssignments, experimentExposures, experiments } from "@/db/schema";
import {
  assignLearner,
  assignLearnerToActiveExperiments,
  buildLearnerSnapshot,
  createExperiment,
  getExperimentByKey,
  listExperiments,
  loadAnalysisDataset,
  recordExposure,
  setExperimentStatus,
} from "@/lib/experiments/service";
import { withFingerprint } from "@/lib/experiments/lifecycle";
import type { Experiment } from "@/lib/experiments/types";

const NOW = new Date("2026-02-01T00:00:00Z");
const START = new Date("2026-01-01T00:00:00Z");

describeDb("database · experimentation framework", () => {
  let fx: Fixtures;

  beforeAll(async () => {
    fx = await seedFixtures();
  });

  afterAll(async () => {
    await closePool();
  });

  async function makeRunningExperiment(over: Partial<Parameters<typeof createExperiment>[0]["draft"]> = {}) {
    const created = await createExperiment({
      scope: { platformAdmin: true },
      draft: {
        key: over.key ?? "policy-trial",
        name: "Policy trial",
        institutionId: over.institutionId !== undefined ? over.institutionId : fx.institutions.northwind,
        primaryMetric: "masteryGain",
        secondaryMetrics: ["zpdHitRate", "completion"],
        startAt: START,
        endAt: null,
        variants: [
          {
            key: "control",
            label: "Mastery-gap baseline",
            allocationPct: 50,
            isControl: true,
            config: { policy: "mastery-gap-baseline", version: "1.0.0" },
          },
          {
            key: "treatment",
            label: "Adaptive v3",
            allocationPct: 50,
            isControl: false,
            config: { policy: "adaptive-v3", version: "1.0.0" },
          },
        ],
        ...over,
      },
    });
    return setExperimentStatus({
      scope: { platformAdmin: true },
      experimentId: created.id,
      status: "running",
      now: NOW,
    });
  }

  it("persists an experiment with its variants and fingerprints", async () => {
    await resetDatabase();
    fx = await seedFixtures();

    const experiment = await makeRunningExperiment();
    expect(experiment.id).toBeGreaterThan(0);
    expect(experiment.status).toBe("running");
    expect(experiment.variants).toHaveLength(2);
    for (const v of experiment.variants) {
      expect(v.config.fingerprint).toMatch(/@1\.0\.0#/);
    }

    const reloaded = await getExperimentByKey({ platformAdmin: true }, "policy-trial");
    expect(reloaded?.variants.map((v) => v.key).sort()).toEqual(["control", "treatment"]);
    expect(reloaded?.primaryMetric).toBe("masteryGain");
  });

  it("scopes experiment reads to the tenant", async () => {
    await resetDatabase();
    fx = await seedFixtures();

    await makeRunningExperiment({ key: "northwind-only", institutionId: fx.institutions.northwind });
    await makeRunningExperiment({ key: "eastvale-only", institutionId: fx.institutions.eastvale });
    await makeRunningExperiment({ key: "platform-wide", institutionId: null });

    const northwind = await listExperiments({ institutionId: fx.institutions.northwind });
    const keys = northwind.map((e) => e.key).sort();
    // Own experiments plus platform-wide ones, never the other tenant's.
    expect(keys).toEqual(["northwind-only", "platform-wide"]);
    expect(keys).not.toContain("eastvale-only");

    const eastvale = await listExperiments({ institutionId: fx.institutions.eastvale });
    expect(eastvale.map((e) => e.key).sort()).toEqual(["eastvale-only", "platform-wide"]);

    // A tenant cannot fetch another tenant's experiment even by exact key.
    expect(await getExperimentByKey({ institutionId: fx.institutions.northwind }, "eastvale-only")).toBeNull();

    // Platform admin sees everything.
    const all = await listExperiments({ platformAdmin: true, institutionId: null });
    expect(all).toHaveLength(3);
  });

  it("refuses to create an experiment outside the caller's tenant", async () => {
    await resetDatabase();
    fx = await seedFixtures();
    await expect(
      createExperiment({
        scope: { institutionId: fx.institutions.northwind },
        draft: {
          key: "cross-tenant",
          name: "Cross tenant",
          institutionId: fx.institutions.eastvale,
          primaryMetric: "masteryGain",
          startAt: START,
          variants: [
            { key: "a", label: "a", allocationPct: 50, isControl: true, config: { policy: "legacy", version: "1.0.0" } },
            { key: "b", label: "b", allocationPct: 50, isControl: false, config: { policy: "adaptive-v3", version: "1.0.0" } },
          ],
        },
      }),
    ).rejects.toThrow(/tenant scope violation/);
  });

  it("persists an assignment and reuses it on later calls", async () => {
    await resetDatabase();
    fx = await seedFixtures();
    const experiment = await makeRunningExperiment();
    const learner = (await buildLearnerSnapshot(fx.users.alice))!;
    expect(learner.institutionId).toBe(fx.institutions.northwind);

    const first = await assignLearner({ experiment, learner, now: NOW });
    expect(first.outcome).toBe("assigned");
    expect(first.fromPersisted).toBe(false);

    const rows = await db
      .select()
      .from(experimentAssignments)
      .where(eq(experimentAssignments.experimentId, experiment.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].variantKey).toBe(first.variantKey);
    // The snapshot is frozen so the population cannot drift at analysis time.
    expect((rows[0].eligibilitySnapshot as Record<string, unknown>).studentId).toBe(fx.users.alice);

    const second = await assignLearner({ experiment, learner, now: NOW });
    expect(second.variantKey).toBe(first.variantKey);
    expect(second.fromPersisted).toBe(true);

    // Still exactly one row — repeat calls must not duplicate enrolment.
    const after = await db
      .select()
      .from(experimentAssignments)
      .where(eq(experimentAssignments.experimentId, experiment.id));
    expect(after).toHaveLength(1);
  });

  it("enforces one variant per learner under concurrency", async () => {
    await resetDatabase();
    fx = await seedFixtures();
    const experiment = await makeRunningExperiment();
    const learner = (await buildLearnerSnapshot(fx.users.bob))!;

    // Ten simultaneous first-time assignments for the same learner.
    const decisions = await Promise.all(
      Array.from({ length: 10 }, () => assignLearner({ experiment, learner, now: NOW })),
    );
    const variants = new Set(decisions.map((d) => d.variantKey));
    expect(variants.size).toBe(1);

    const rows = await db
      .select()
      .from(experimentAssignments)
      .where(
        and(
          eq(experimentAssignments.experimentId, experiment.id),
          eq(experimentAssignments.studentId, fx.users.bob),
        ),
      );
    expect(rows).toHaveLength(1);
  });

  it("never assigns a learner from another institution", async () => {
    await resetDatabase();
    fx = await seedFixtures();
    const experiment = await makeRunningExperiment({ institutionId: fx.institutions.northwind });
    // carol belongs to eastvale.
    const carol = (await buildLearnerSnapshot(fx.users.carol))!;
    expect(carol.institutionId).toBe(fx.institutions.eastvale);

    const decision = await assignLearner({ experiment, learner: carol, now: NOW });
    expect(decision.outcome).toBe("tenant-mismatch");

    const rows = await db
      .select()
      .from(experimentAssignments)
      .where(eq(experimentAssignments.experimentId, experiment.id));
    expect(rows).toHaveLength(0);
  });

  it("excludes staff accounts by the default eligibility rule", async () => {
    await resetDatabase();
    fx = await seedFixtures();
    const experiment = await makeRunningExperiment();
    const teacher = (await buildLearnerSnapshot(fx.users.teacherA))!;
    const decision = await assignLearner({ experiment, learner: teacher, now: NOW });
    expect(decision.outcome).toBe("not-eligible");
  });

  it("honours exclusion groups across concurrent experiments", async () => {
    await resetDatabase();
    fx = await seedFixtures();
    await makeRunningExperiment({ key: "aaa-selection", exclusionGroup: "item-selection" });
    await makeRunningExperiment({ key: "bbb-selection", exclusionGroup: "item-selection" });

    const decisions = await assignLearnerToActiveExperiments({
      scope: { institutionId: fx.institutions.northwind },
      studentId: fx.users.alice,
      now: NOW,
    });
    const assigned = decisions.filter((d) => d.outcome === "assigned");
    const excluded = decisions.filter((d) => d.outcome === "excluded-by-group");
    // A learner must not be in two experiments that both change item selection.
    expect(assigned).toHaveLength(1);
    expect(excluded).toHaveLength(1);
    // Deterministic: the alphabetically-first key wins, every time.
    expect(assigned[0].experimentKey).toBe("aaa-selection");
  });

  it("records exposures and joins them to assignments for analysis", async () => {
    await resetDatabase();
    fx = await seedFixtures();
    const experiment = await makeRunningExperiment();
    const learner = (await buildLearnerSnapshot(fx.users.alice))!;
    const decision = await assignLearner({ experiment, learner, now: NOW });
    expect(decision.outcome).toBe("assigned");

    await recordExposure({
      experimentId: experiment.id,
      studentId: fx.users.alice,
      variantKey: decision.variantKey!,
      configFingerprint: decision.config!.fingerprint,
      entityId: null,
      occurredAt: new Date("2026-02-02T00:00:00Z"),
    });
    await recordExposure({
      experimentId: experiment.id,
      studentId: fx.users.alice,
      variantKey: decision.variantKey!,
      configFingerprint: decision.config!.fingerprint,
      entityId: null,
      occurredAt: new Date("2026-02-03T00:00:00Z"),
    });

    const rows = await db
      .select()
      .from(experimentExposures)
      .where(eq(experimentExposures.experimentId, experiment.id));
    expect(rows).toHaveLength(2);

    const dataset = await loadAnalysisDataset(experiment);
    expect(dataset.subjects).toHaveLength(1);
    // The attribution clock starts at the FIRST exposure.
    expect(dataset.subjects[0].firstExposureAt.toISOString()).toBe("2026-02-02T00:00:00.000Z");
    expect(dataset.exposureByVariant[decision.variantKey!]).toBe(1);
  });

  it("excludes assigned-but-never-exposed learners from analysis", async () => {
    await resetDatabase();
    fx = await seedFixtures();
    const experiment = await makeRunningExperiment();
    const learner = (await buildLearnerSnapshot(fx.users.alice))!;
    await assignLearner({ experiment, learner, now: NOW });

    // Enrolled, but the policy never actually served them.
    const dataset = await loadAnalysisDataset(experiment);
    expect(dataset.subjects).toHaveLength(0);
  });

  it("survives a lifecycle round trip and stops serving when paused", async () => {
    await resetDatabase();
    fx = await seedFixtures();
    const experiment = await makeRunningExperiment();
    const learner = (await buildLearnerSnapshot(fx.users.alice))!;
    expect((await assignLearner({ experiment, learner, now: NOW })).outcome).toBe("assigned");

    const paused = await setExperimentStatus({
      scope: { platformAdmin: true },
      experimentId: experiment.id,
      status: "paused",
      now: NOW,
    });
    expect(paused.status).toBe("paused");
    // Even an already-enrolled learner stops receiving treatment.
    expect((await assignLearner({ experiment: paused, learner, now: NOW })).outcome).toBe(
      "experiment-not-running",
    );

    const resumed = await setExperimentStatus({
      scope: { platformAdmin: true },
      experimentId: experiment.id,
      status: "running",
      now: NOW,
    });
    const after = await assignLearner({ experiment: resumed, learner, now: NOW });
    expect(after.outcome).toBe("assigned");
    // And they return to the SAME arm they were in before the pause.
    expect(after.fromPersisted).toBe(true);
  });

  it("stops serving once the end time passes, without a scheduler run", async () => {
    await resetDatabase();
    fx = await seedFixtures();
    const experiment = await makeRunningExperiment({ endAt: new Date("2026-01-15T00:00:00Z") });
    const learner = (await buildLearnerSnapshot(fx.users.alice))!;
    // Row still says "running"; effective status says otherwise.
    expect(experiment.status).toBe("running");
    const decision = await assignLearner({ experiment, learner, now: NOW });
    expect(decision.outcome).toBe("experiment-not-running");
  });

  it("keeps a unique key per tenant while allowing reuse across tenants", async () => {
    await resetDatabase();
    fx = await seedFixtures();
    await makeRunningExperiment({ key: "shared-key", institutionId: fx.institutions.northwind });
    // The same key in a different institution is a different experiment.
    await expect(
      makeRunningExperiment({ key: "shared-key", institutionId: fx.institutions.eastvale }),
    ).resolves.toBeDefined();

    const rows = await db.select().from(experiments).where(eq(experiments.key, "shared-key"));
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.institutionId)).size).toBe(2);
  });

  it("cascades assignment and exposure rows when an experiment is deleted", async () => {
    await resetDatabase();
    fx = await seedFixtures();
    const experiment = await makeRunningExperiment();
    const learner = (await buildLearnerSnapshot(fx.users.alice))!;
    const decision = await assignLearner({ experiment, learner, now: NOW });
    await recordExposure({
      experimentId: experiment.id,
      studentId: fx.users.alice,
      variantKey: decision.variantKey!,
      configFingerprint: decision.config!.fingerprint,
      entityId: null,
      occurredAt: NOW,
    });

    await db.delete(experiments).where(eq(experiments.id, experiment.id));

    expect(
      await db.select().from(experimentAssignments).where(eq(experimentAssignments.experimentId, experiment.id)),
    ).toHaveLength(0);
    expect(
      await db.select().from(experimentExposures).where(eq(experimentExposures.experimentId, experiment.id)),
    ).toHaveLength(0);
  });

  it("assigns every seeded student deterministically and reproducibly", async () => {
    await resetDatabase();
    fx = await seedFixtures();
    const experiment = await makeRunningExperiment();

    const studentIds = [fx.users.alice, fx.users.bob, fx.users.dave];
    const firstPass: Record<number, string | null> = {};
    for (const id of studentIds) {
      const learner = (await buildLearnerSnapshot(id))!;
      firstPass[id] = (await assignLearner({ experiment, learner, now: NOW })).variantKey;
    }

    // Re-resolving without persistence must reproduce the same variants.
    for (const id of studentIds) {
      const learner = (await buildLearnerSnapshot(id))!;
      const again = await assignLearner({ experiment, learner, now: NOW, persist: false });
      expect(again.variantKey).toBe(firstPass[id]);
    }
  });
});
