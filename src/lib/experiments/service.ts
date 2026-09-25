/**
 * Experiment service — persistence and the serving-path entry point.
 *
 * Everything that touches the database lives here so the decision logic in
 * `assignment.ts`, `attribution.ts` and `analysis.ts` stays pure and fully
 * testable. The rules this layer is responsible for:
 *
 *  • **Tenant scoping on every read.** A caller supplies the acting tenant and
 *    cannot opt out. Platform-wide experiments (`institution_id IS NULL`) are
 *    visible to all tenants; an institution's experiments are visible only to
 *    that institution.
 *
 *  • **Race-safe assignment.** The write is `ON CONFLICT DO NOTHING` followed by
 *    a re-read, so two concurrent requests for a new learner converge on one
 *    variant instead of racing to overwrite each other.
 *
 *  • **Exposure is separate from assignment.** Being enrolled is not being
 *    treated; `recordExposure` is called from the serving path at the moment an
 *    item is actually chosen by the variant's policy.
 */
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  assessmentItems,
  assessments,
  experimentAssignments,
  experimentExposures,
  experiments,
  masteryStates,
  recommendations as recommendationsTable,
  skills,
  users,
} from "@/db/schema";
import {
  ELIGIBILITY_BOUNDARY,
  ELIGIBILITY_SNAPSHOT_BOUNDARY,
  VARIANTS_BOUNDARY,
  parseEligibilityRule,
  parseEligibilitySnapshot,
  parseExperimentVariants,
  serializeEligibilitySnapshot,
  unwrapOrThrow,
} from "@/lib/persistence";
import { resolveAssignment, type AssignmentContext } from "./assignment";
import { effectiveStatus, withFingerprint } from "./lifecycle";
import type {
  AssignmentDecision,
  Experiment,
  ExperimentStatus,
  ExperimentVariant,
  LearnerEligibilitySnapshot,
  PrimaryMetricKey,
  SecondaryMetricKey,
} from "./types";
import type {
  AttributableActivity,
  AttributableAssessment,
  AttributableItem,
  AttributableRecommendation,
  AttributionSubject,
} from "./attribution";

/* ------------------------------------------------------------------ */
/* Tenant scope                                                        */
/* ------------------------------------------------------------------ */

/**
 * Who is asking. `institutionId: null` with `platformAdmin: true` sees
 * everything; anything else is confined to its own institution plus
 * platform-wide experiments.
 */
export interface TenantScope {
  /** The acting institution. Omit (or null) for platform scope. */
  institutionId?: number | null;
  platformAdmin?: boolean;
}

/** SQL predicate implementing the tenant rule. Used by every read in this file. */
function tenantFilter(scope: TenantScope) {
  if (scope.platformAdmin) return undefined;
  const institutionId = scope.institutionId ?? null;
  if (institutionId === null) return isNull(experiments.institutionId);
  return or(isNull(experiments.institutionId), eq(experiments.institutionId, institutionId));
}

/* ------------------------------------------------------------------ */
/* Row <-> domain mapping                                              */
/* ------------------------------------------------------------------ */

type ExperimentRow = typeof experiments.$inferSelect;

/**
 * Map a database row to the domain object.
 *
 * `variants` and `eligibility` are JSONB and are *parsed*, not cast: an
 * experiment whose arms cannot be read has no safe interpretation — serving a
 * default policy while recording an exposure against a treatment arm would
 * corrupt the experiment's results with no error anywhere. So a malformed row
 * throws a structured `PersistedDataError` and the read fails loudly.
 */
function toDomain(row: ExperimentRow): Experiment {
  const variants = unwrapOrThrow(parseExperimentVariants(row.variants ?? []), VARIANTS_BOUNDARY);
  const eligibility = unwrapOrThrow(parseEligibilityRule(row.eligibility), ELIGIBILITY_BOUNDARY);
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    hypothesis: row.hypothesis,
    institutionId: row.institutionId,
    status: row.status as ExperimentStatus,
    variants,
    eligibility,
    primaryMetric: row.primaryMetric as PrimaryMetricKey,
    secondaryMetrics: (row.secondaryMetrics as SecondaryMetricKey[]) ?? [],
    assignmentStrategy: row.assignmentStrategy === "rolling" ? "rolling" : "sticky",
    salt: row.salt,
    startAt: row.startAt,
    endAt: row.endAt,
    exclusionGroup: row.exclusionGroup,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

export async function listExperiments(scope: TenantScope): Promise<Experiment[]> {
  const filter = tenantFilter(scope);
  const rows = filter
    ? await db.select().from(experiments).where(filter)
    : await db.select().from(experiments);
  return rows.map(toDomain);
}

export async function getExperimentByKey(scope: TenantScope, key: string): Promise<Experiment | null> {
  const filter = tenantFilter(scope);
  const where = filter ? and(eq(experiments.key, key), filter) : eq(experiments.key, key);
  const rows = await db.select().from(experiments).where(where).limit(1);
  return rows[0] ? toDomain(rows[0]) : null;
}

/**
 * Experiments that could enrol a learner right now.
 *
 * Filters on *effective* status so a scheduled experiment whose start time has
 * passed is live even if no scheduler has updated the row yet, and a running
 * one whose end time has passed is not.
 */
export async function activeExperimentsFor(
  scope: TenantScope,
  now: Date,
): Promise<Experiment[]> {
  const all = await listExperiments(scope);
  return all.filter((e) => effectiveStatus(e, now) === "running");
}

/* ------------------------------------------------------------------ */
/* Learner snapshot                                                    */
/* ------------------------------------------------------------------ */

/**
 * Build the eligibility facts for a learner.
 *
 * Read once at assignment time and then frozen into the assignment row — see
 * `EligibilityRule` for why re-deriving it later biases the population.
 */
export async function buildLearnerSnapshot(studentId: number): Promise<LearnerEligibilitySnapshot | null> {
  const rows = await db
    .select({
      id: users.id,
      institutionId: users.institutionId,
      role: users.role,
      gradeLevel: users.gradeLevel,
      cohort: users.cohort,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.id, studentId))
    .limit(1);
  const user = rows[0];
  if (!user) return null;

  const [attemptRow] = await db
    .select({ total: sql<number>`coalesce(sum(${masteryStates.attempts}), 0)::int` })
    .from(masteryStates)
    .where(eq(masteryStates.studentId, studentId));

  const subjectRows = await db
    .selectDistinct({ subjectId: skills.subjectId })
    .from(masteryStates)
    .innerJoin(skills, eq(skills.id, masteryStates.skillId))
    .where(eq(masteryStates.studentId, studentId));

  return {
    studentId: user.id,
    institutionId: user.institutionId,
    role: user.role,
    gradeLevel: user.gradeLevel,
    cohort: user.cohort,
    priorAttempts: Number(attemptRow?.total ?? 0),
    createdAt: user.createdAt,
    subjectIds: subjectRows.map((r) => r.subjectId).filter((v): v is number => v !== null),
  };
}

/* ------------------------------------------------------------------ */
/* Assignment                                                          */
/* ------------------------------------------------------------------ */

/**
 * Resolve (and persist) a learner's variant for one experiment.
 *
 * Writes only when the decision is `assigned` and no record exists. The insert
 * is conflict-tolerant and followed by a re-read, so under concurrency the
 * first writer wins and every other caller returns that same variant rather
 * than its own recomputation.
 */
export async function assignLearner(params: {
  experiment: Experiment;
  learner: LearnerEligibilitySnapshot;
  now: Date;
  /** Keys of same-exclusion-group experiments this learner is already in. */
  conflictingEnrolments?: string[];
  /** When false, resolve without writing. Used by dry-run/preview surfaces. */
  persist?: boolean;
}): Promise<AssignmentDecision> {
  const { experiment, learner, now } = params;

  const existingRows = await db
    .select()
    .from(experimentAssignments)
    .where(
      and(
        eq(experimentAssignments.experimentId, experiment.id),
        eq(experimentAssignments.studentId, learner.studentId),
      ),
    )
    .limit(1);

  const existing = existingRows[0]
    ? {
        id: existingRows[0].id,
        experimentId: existingRows[0].experimentId,
        studentId: existingRows[0].studentId,
        variantKey: existingRows[0].variantKey,
        configFingerprint: existingRows[0].configFingerprint,
        bucket: existingRows[0].bucket,
        // A persisted assignment whose snapshot is unreadable cannot be used:
        // its population membership is exactly what the snapshot proves.
        eligibilitySnapshot: unwrapOrThrow(
          parseEligibilitySnapshot(existingRows[0].eligibilitySnapshot),
          ELIGIBILITY_SNAPSHOT_BOUNDARY,
        ),
        assignedAt: existingRows[0].assignedAt,
      }
    : null;

  const ctx: AssignmentContext = {
    // Serving uses effective status so a lapsed window stops treatment on time.
    experiment: { ...experiment, status: effectiveStatus(experiment, now) },
    learner,
    now,
    existing,
    conflictingEnrolments: params.conflictingEnrolments,
  };

  const decision = resolveAssignment(ctx);

  if (params.persist !== false && decision.outcome === "assigned" && !existing && decision.config) {
    await db
      .insert(experimentAssignments)
      .values({
        experimentId: experiment.id,
        studentId: learner.studentId,
        variantKey: decision.variantKey!,
        configFingerprint: decision.config.fingerprint,
        bucket: decision.bucket,
        eligibilitySnapshot: serializeEligibilitySnapshot(learner),
        assignedAt: now,
      })
      .onConflictDoNothing({
        target: [experimentAssignments.experimentId, experimentAssignments.studentId],
      });

    // Re-read: if a concurrent request won the race its variant is authoritative.
    const [confirmed] = await db
      .select()
      .from(experimentAssignments)
      .where(
        and(
          eq(experimentAssignments.experimentId, experiment.id),
          eq(experimentAssignments.studentId, learner.studentId),
        ),
      )
      .limit(1);

    if (confirmed && confirmed.variantKey !== decision.variantKey) {
      const variant = experiment.variants.find((v) => v.key === confirmed.variantKey);
      return {
        ...decision,
        variantKey: confirmed.variantKey,
        config: variant?.config ?? decision.config,
        bucket: confirmed.bucket,
        reason: "adopted concurrently-written assignment (race resolved by unique index)",
        fromPersisted: true,
      };
    }
  }

  return decision;
}

/**
 * Resolve every active experiment for a learner, honouring exclusion groups.
 *
 * Experiments are processed in a deterministic order (by key) so that when two
 * mutually exclusive experiments could both enrol a learner, the same one
 * always wins regardless of query order.
 */
export async function assignLearnerToActiveExperiments(params: {
  scope: TenantScope;
  studentId: number;
  now: Date;
}): Promise<AssignmentDecision[]> {
  const snapshot = await buildLearnerSnapshot(params.studentId);
  if (!snapshot) return [];

  const active = (await activeExperimentsFor(params.scope, params.now)).sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  );

  const enrolledByGroup = new Map<string, string[]>();
  const decisions: AssignmentDecision[] = [];

  for (const experiment of active) {
    const conflicts = experiment.exclusionGroup
      ? enrolledByGroup.get(experiment.exclusionGroup) ?? []
      : [];
    const decision = await assignLearner({
      experiment,
      learner: snapshot,
      now: params.now,
      conflictingEnrolments: conflicts,
    });
    decisions.push(decision);
    if (decision.outcome === "assigned" && experiment.exclusionGroup) {
      enrolledByGroup.set(experiment.exclusionGroup, [...conflicts, experiment.key]);
    }
  }

  return decisions;
}

/* ------------------------------------------------------------------ */
/* Exposure                                                            */
/* ------------------------------------------------------------------ */

/**
 * Record that a learner was actually served by a variant.
 *
 * Called from the serving path *after* an item is chosen, with the fingerprint
 * of the config that chose it. Appending (rather than upserting) keeps the full
 * exposure history, which is what makes a mid-run configuration change visible.
 */
export async function recordExposure(params: {
  experimentId: number;
  studentId: number;
  variantKey: string;
  configFingerprint: string;
  surface?: string;
  entityId?: number | null;
  occurredAt: Date;
}): Promise<void> {
  await db.insert(experimentExposures).values({
    experimentId: params.experimentId,
    studentId: params.studentId,
    variantKey: params.variantKey,
    configFingerprint: params.configFingerprint,
    surface: params.surface ?? "assessment.next-item",
    entityId: params.entityId ?? null,
    occurredAt: params.occurredAt,
  });
}

/* ------------------------------------------------------------------ */
/* Analysis inputs                                                     */
/* ------------------------------------------------------------------ */

export interface AnalysisDataset {
  subjects: AttributionSubject[];
  items: AttributableItem[];
  assessments: AttributableAssessment[];
  recommendations: AttributableRecommendation[];
  activity: AttributableActivity[];
  exposureByVariant: Record<string, number>;
}

/**
 * Load everything needed to compute metrics for one experiment.
 *
 * Only learners with BOTH an assignment and at least one exposure become
 * subjects. That join is the load-bearing part: it is what stops enrolment
 * alone from contributing outcome data.
 */
export async function loadAnalysisDataset(experiment: Experiment): Promise<AnalysisDataset> {
  // First exposure per learner, plus the variant that exposed them.
  const exposureRows = await db
    .select({
      studentId: experimentExposures.studentId,
      variantKey: experimentExposures.variantKey,
      firstExposureAt: sql<Date>`min(${experimentExposures.occurredAt})`,
      exposures: sql<number>`count(*)::int`,
    })
    .from(experimentExposures)
    .where(eq(experimentExposures.experimentId, experiment.id))
    .groupBy(experimentExposures.studentId, experimentExposures.variantKey);

  const assignmentRows = await db
    .select({
      studentId: experimentAssignments.studentId,
      variantKey: experimentAssignments.variantKey,
    })
    .from(experimentAssignments)
    .where(eq(experimentAssignments.experimentId, experiment.id));

  const assignedVariant = new Map(assignmentRows.map((r) => [r.studentId, r.variantKey]));

  // Collapse multiple exposure rows per learner to the earliest, and take the
  // variant from the ASSIGNMENT — attribution rule R2. A learner whose exposures
  // disagree with their assignment is still included here; `attributeMetrics`
  // drops the conflicting observations and counts them.
  const byStudent = new Map<number, { variantKey: string; firstExposureAt: Date }>();
  for (const row of exposureRows) {
    const variantKey = assignedVariant.get(row.studentId);
    if (!variantKey) continue; // exposed but never assigned — excluded, counted later
    const at = new Date(row.firstExposureAt);
    const prev = byStudent.get(row.studentId);
    if (!prev || at < prev.firstExposureAt) byStudent.set(row.studentId, { variantKey, firstExposureAt: at });
  }

  const studentIds = [...byStudent.keys()];
  if (!studentIds.length) {
    return {
      subjects: [],
      items: [],
      assessments: [],
      recommendations: [],
      activity: [],
      exposureByVariant: {},
    };
  }

  const learnerRows = await db
    .select({ id: users.id, institutionId: users.institutionId })
    .from(users)
    .where(inArray(users.id, studentIds));
  const institutionOf = new Map(learnerRows.map((r) => [r.id, r.institutionId]));

  const subjects: AttributionSubject[] = studentIds.map((studentId) => ({
    studentId,
    institutionId: institutionOf.get(studentId) ?? null,
    variantKey: byStudent.get(studentId)!.variantKey,
    firstExposureAt: byStudent.get(studentId)!.firstExposureAt,
  }));

  // Exposure counts per variant, for the readout header.
  const exposureByVariant: Record<string, number> = {};
  for (const s of subjects) {
    exposureByVariant[s.variantKey] = (exposureByVariant[s.variantKey] ?? 0) + 1;
  }

  // Items, joined to the exposure that served them where one exists.
  const itemRows = await db
    .select({
      studentId: assessments.studentId,
      assessmentId: assessmentItems.assessmentId,
      itemId: assessmentItems.id,
      skillId: assessmentItems.skillId,
      answeredAt: assessmentItems.createdAt,
      isCorrect: assessmentItems.isCorrect,
      responseTimeMs: assessmentItems.responseTimeMs,
      predictedCorrectProb: assessmentItems.predictedCorrectProb,
      masteryBefore: assessmentItems.masteryBefore,
      masteryAfter: assessmentItems.masteryAfter,
      exposedVariantKey: experimentExposures.variantKey,
    })
    .from(assessmentItems)
    .innerJoin(assessments, eq(assessments.id, assessmentItems.assessmentId))
    .leftJoin(
      experimentExposures,
      and(
        eq(experimentExposures.entityId, assessmentItems.id),
        eq(experimentExposures.experimentId, experiment.id),
      ),
    )
    .where(inArray(assessments.studentId, studentIds));

  const items: AttributableItem[] = itemRows.map((r) => ({
    studentId: r.studentId,
    institutionId: institutionOf.get(r.studentId) ?? null,
    assessmentId: r.assessmentId,
    skillId: r.skillId,
    exposedVariantKey: r.exposedVariantKey ?? null,
    answeredAt: r.answeredAt,
    isCorrect: r.isCorrect,
    responseTimeMs: r.responseTimeMs,
    predictedCorrectProb: r.predictedCorrectProb,
    masteryBefore: r.masteryBefore,
    masteryAfter: r.masteryAfter,
  }));

  const assessmentRows = await db
    .select({
      studentId: assessments.studentId,
      assessmentId: assessments.id,
      startedAt: assessments.startedAt,
      status: assessments.status,
    })
    .from(assessments)
    .where(inArray(assessments.studentId, studentIds));

  const recommendationRows = await db
    .select({
      studentId: recommendationsTable.studentId,
      createdAt: recommendationsTable.createdAt,
      status: recommendationsTable.status,
    })
    .from(recommendationsTable)
    .where(inArray(recommendationsTable.studentId, studentIds));

  // Engagement uses answered items as the activity signal, so it measures
  // practice days rather than logins.
  const activity: AttributableActivity[] = itemRows.map((r) => ({
    studentId: r.studentId,
    institutionId: institutionOf.get(r.studentId) ?? null,
    occurredAt: r.answeredAt,
  }));

  return {
    subjects,
    items,
    assessments: assessmentRows.map((r) => ({
      studentId: r.studentId,
      institutionId: institutionOf.get(r.studentId) ?? null,
      assessmentId: r.assessmentId,
      startedAt: r.startedAt,
      status: r.status,
    })),
    recommendations: recommendationRows.map((r) => ({
      studentId: r.studentId,
      institutionId: institutionOf.get(r.studentId) ?? null,
      createdAt: r.createdAt,
      status: r.status,
    })),
    activity,
    exposureByVariant,
  };
}

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */

export async function createExperiment(params: {
  scope: TenantScope;
  draft: {
    key: string;
    name: string;
    hypothesis?: string;
    institutionId: number | null;
    variants: (Omit<ExperimentVariant, "config"> & {
      config: Omit<ExperimentVariant["config"], "fingerprint">;
    })[];
    eligibility?: Experiment["eligibility"];
    primaryMetric: PrimaryMetricKey;
    secondaryMetrics?: SecondaryMetricKey[];
    assignmentStrategy?: Experiment["assignmentStrategy"];
    salt?: string;
    startAt: Date;
    endAt?: Date | null;
    exclusionGroup?: string | null;
  };
  createdBy?: number | null;
}): Promise<Experiment> {
  const { draft, scope } = params;

  // A tenant may only create experiments in its own scope. Platform admins may
  // create platform-wide ones.
  if (!scope.platformAdmin && draft.institutionId !== (scope.institutionId ?? null)) {
    throw new Error(
      `tenant scope violation: cannot create an experiment for institution ${draft.institutionId}`,
    );
  }

  const variants: ExperimentVariant[] = draft.variants.map((v) => ({
    ...v,
    config: withFingerprint(v.config),
  }));

  const [row] = await db
    .insert(experiments)
    .values({
      key: draft.key,
      name: draft.name,
      hypothesis: draft.hypothesis ?? "",
      institutionId: draft.institutionId,
      status: "draft",
      variants: variants as unknown as unknown[],
      eligibility: (draft.eligibility ?? {}) as Record<string, unknown>,
      primaryMetric: draft.primaryMetric,
      secondaryMetrics: draft.secondaryMetrics ?? [],
      assignmentStrategy: draft.assignmentStrategy ?? "sticky",
      // Default salt is derived from the key so it is stable and reproducible,
      // while still differing between experiments.
      salt: draft.salt ?? `salt-${draft.key}`,
      startAt: draft.startAt,
      endAt: draft.endAt ?? null,
      exclusionGroup: draft.exclusionGroup ?? null,
      createdBy: params.createdBy ?? null,
    })
    .returning();

  return toDomain(row);
}

export async function setExperimentStatus(params: {
  scope: TenantScope;
  experimentId: number;
  status: ExperimentStatus;
  now: Date;
}): Promise<Experiment> {
  const [row] = await db
    .update(experiments)
    .set({ status: params.status, updatedAt: params.now })
    .where(eq(experiments.id, params.experimentId))
    .returning();
  return toDomain(row);
}
