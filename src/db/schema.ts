import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/* ------------------------------------------------------------------ */
/* Institutions & users                                                */
/* ------------------------------------------------------------------ */

export const institutions = pgTable("institutions", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  type: text("type").notNull().default("school"), // school | university | bootcamp | corporate
  plan: text("plan").notNull().default("growth"), // starter | growth | enterprise
  region: text("region").notNull().default("Global"),
  seats: integer("seats").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("institutions_slug_idx").on(t.slug)]);

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("student"), // student | teacher | trainer | institution | admin
  institutionId: integer("institution_id").references(() => institutions.id, { onDelete: "set null" }),
  gradeLevel: text("grade_level"),
  cohort: text("cohort"),
  avatarColor: text("avatar_color").notNull().default("#4f46e5"),
  goal: text("goal"),
  status: text("status").notNull().default("active"), // active | invited | suspended
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("users_email_idx").on(t.email),
  index("users_institution_idx").on(t.institutionId),
  index("users_role_idx").on(t.role),
]);

export const sessions = pgTable("sessions", {
  id: serial("id").primaryKey(),
  token: text("token").notNull(),
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("sessions_token_idx").on(t.token),
  index("sessions_user_idx").on(t.userId),
  index("sessions_expires_idx").on(t.expiresAt),
]);

/* ------------------------------------------------------------------ */
/* Skills & question bank                                              */
/* ------------------------------------------------------------------ */

export const subjects = pgTable("subjects", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  code: text("code").notNull(),
  color: text("color").notNull().default("#6366f1"),
});

export const skills = pgTable("skills", {
  id: serial("id").primaryKey(),
  subjectId: integer("subject_id").references(() => subjects.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  code: text("code").notNull(),
  description: text("description").notNull().default(""),
  difficultyBase: real("difficulty_base").notNull().default(0.5),
  gradeBand: text("grade_band").notNull().default("Core"),
  prereqIds: jsonb("prereq_ids").$type<number[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("skills_code_idx").on(t.code)]);

export const questions = pgTable("questions", {
  id: serial("id").primaryKey(),
  skillId: integer("skill_id").references(() => skills.id, { onDelete: "cascade" }).notNull(),
  /** Optional finer-grained subskill/topic tag within the skill. */
  subskill: text("subskill"),
  /** Question-level prerequisite skills (independent of the skill taxonomy edges). */
  prerequisiteSkillIds: jsonb("prerequisite_skill_ids").$type<number[]>().notNull().default([]),
  stem: text("stem").notNull(),
  options: jsonb("options").$type<string[]>().notNull().default([]),
  correctIndex: integer("correct_index").notNull().default(0),
  difficultyLabel: text("difficulty_label").notNull().default("medium"), // easy | medium | hard | expert
  /** Numeric difficulty on a 0..1 scale (authored, later refined by calibration). */
  difficultyValue: real("difficulty_value").notNull().default(0.55),
  bloomLevel: text("bloom_level").notNull().default("apply"),
  /** Webb's Depth of Knowledge — recall | skill_concept | strategic_thinking | extended_thinking. */
  cognitiveComplexity: text("cognitive_complexity").notNull().default("skill_concept"),
  explanation: text("explanation").notNull().default(""),
  /** Progressive hints shown before revealing the answer. */
  hints: jsonb("hints").$type<string[]>().notNull().default([]),
  /** Per-distractor pedagogy: which misconception each wrong option targets. */
  distractorMeta: jsonb("distractor_meta")
    .$type<{ optionIndex: number; misconception?: string; rationale?: string; prerequisiteSkillId?: number }[]>()
    .notNull()
    .default([]),
  estimatedSeconds: integer("estimated_seconds").notNull().default(60),

  /* --------------------------- authoring / provenance --------------------------- */
  authorId: integer("author_id").references(() => users.id, { onDelete: "set null" }),
  source: text("source").notNull().default("human"), // human | ai | imported
  version: integer("version").notNull().default(1),

  /* ------------------------------- workflow ------------------------------- */
  status: text("status").notNull().default("draft"), // draft | review | validated | published | monitored | retired
  reviewedById: integer("reviewed_by_id").references(() => users.id, { onDelete: "set null" }),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  reviewNotes: text("review_notes"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  retiredAt: timestamp("retired_at", { withTimezone: true }),

  /* --------------------- latest psychometric snapshot --------------------- */
  qualityScore: real("quality_score").notNull().default(0),
  exposureCount: integer("exposure_count").notNull().default(0),
  successRate: real("success_rate").notNull().default(0),
  discrimination: real("discrimination").notNull().default(0),
  /** IRT-ready calibration container (see CalibrationParams). Empty until calibrated. */
  calibration: jsonb("calibration").$type<Record<string, unknown>>().notNull().default({}),
  /** Latest quality flags from item analysis (e.g. too_easy, low_discrimination). */
  qualityFlags: jsonb("quality_flags").$type<string[]>().notNull().default([]),
  lastAnalyzedAt: timestamp("last_analyzed_at", { withTimezone: true }),

  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("questions_skill_idx").on(t.skillId),
  index("questions_status_idx").on(t.status),
]);

/**
 * Immutable history of item-analysis / calibration runs. Each analytics pass
 * appends a snapshot so we can track item drift over time and swap in a full
 * IRT estimator later without touching the `questions` row shape.
 */
export const itemStatistics = pgTable("item_statistics", {
  id: serial("id").primaryKey(),
  questionId: integer("question_id").references(() => questions.id, { onDelete: "cascade" }).notNull(),
  sampleSize: integer("sample_size").notNull().default(0),
  facility: real("facility").notNull().default(0), // proportion correct (p-value)
  discrimination: real("discrimination").notNull().default(0), // corrected point-biserial
  discriminationIndex: real("discrimination_index"), // upper-lower 27%
  meanResponseTimeMs: integer("mean_response_time_ms"),
  qualityScore: real("quality_score").notNull().default(0),
  flags: jsonb("flags").$type<string[]>().notNull().default([]),
  /** Per-option distractor analysis for this window. */
  distractorAnalysis: jsonb("distractor_analysis").$type<Record<string, unknown>[]>().notNull().default([]),
  /** IRT/CTT calibration container for this run. */
  calibration: jsonb("calibration").$type<Record<string, unknown>>().notNull().default({}),
  windowStart: timestamp("window_start", { withTimezone: true }),
  windowEnd: timestamp("window_end", { withTimezone: true }),
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("item_stats_question_idx").on(t.questionId),
  index("item_stats_computed_idx").on(t.computedAt),
]);

/* ------------------------------------------------------------------ */
/* Assessment / adaptive quiz sessions                                 */
/* ------------------------------------------------------------------ */

export const assessments = pgTable("assessments", {
  id: serial("id").primaryKey(),
  studentId: integer("student_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  mode: text("mode").notNull().default("adaptive_quiz"), // diagnostic | adaptive_quiz | practice
  status: text("status").notNull().default("in_progress"), // in_progress | completed | abandoned
  targetSkillIds: jsonb("target_skill_ids").$type<number[]>().notNull().default([]),
  itemTarget: integer("item_target").notNull().default(8),
  ability: real("ability").notNull().default(0.5),
  score: real("score"),
  predictedScore: real("predicted_score"),
  forecastLabel: text("forecast_label"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (t) => [
  // Assessments are almost always read by learner (dashboards, history, engine)
  // and frequently filtered by status. Without these, every studentId lookup
  // is a Seq Scan (profiled: 1.8–3.4x slower + full-table reads).
  index("assessments_student_idx").on(t.studentId),
  index("assessments_student_status_idx").on(t.studentId, t.status),
]);

export const assessmentItems = pgTable("assessment_items", {
  id: serial("id").primaryKey(),
  assessmentId: integer("assessment_id").references(() => assessments.id, { onDelete: "cascade" }).notNull(),
  questionId: integer("question_id").references(() => questions.id, { onDelete: "cascade" }).notNull(),
  skillId: integer("skill_id").references(() => skills.id, { onDelete: "cascade" }).notNull(),
  sequence: integer("sequence").notNull().default(1),
  studentAnswer: integer("student_answer"),
  isCorrect: boolean("is_correct"),
  responseTimeMs: integer("response_time_ms").notNull().default(0),
  predictedCorrectProb: real("predicted_correct_prob").notNull().default(0.5),
  assignedDifficulty: real("assigned_difficulty").notNull().default(0.5),
  masteryBefore: real("mastery_before").notNull().default(0.5),
  masteryAfter: real("mastery_after").notNull().default(0.5),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("assessment_items_assessment_idx").on(t.assessmentId),
  // Item-level analytics and calibration join/aggregate by question.
  index("assessment_items_question_idx").on(t.questionId),
]);

/* ------------------------------------------------------------------ */
/* Knowledge tracing state                                             */
/* ------------------------------------------------------------------ */

export const masteryStates = pgTable("mastery_states", {
  id: serial("id").primaryKey(),
  studentId: integer("student_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  skillId: integer("skill_id").references(() => skills.id, { onDelete: "cascade" }).notNull(),
  mastery: real("mastery").notNull().default(0.4),
  priorMastery: real("prior_mastery").notNull().default(0.4),
  attempts: integer("attempts").notNull().default(0),
  correct: integer("correct").notNull().default(0),
  streak: integer("streak").notNull().default(0),
  slip: real("slip").notNull().default(0.1),
  guess: real("guess").notNull().default(0.2),
  learnRate: real("learn_rate").notNull().default(0.22),
  history: jsonb("history").$type<{ t: string; m: number }[]>().notNull().default([]),
  lastPracticedAt: timestamp("last_practiced_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("mastery_student_skill_idx").on(t.studentId, t.skillId)]);

/* ------------------------------------------------------------------ */
/* Personalized learning paths                                         */
/* ------------------------------------------------------------------ */

export const learningPaths = pgTable("learning_paths", {
  id: serial("id").primaryKey(),
  studentId: integer("student_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  objective: text("objective").notNull().default(""),
  status: text("status").notNull().default("active"), // draft | active | paused | completed
  strategy: text("strategy").notNull().default("gap-ordered"),
  targetMastery: real("target_mastery").notNull().default(0.85),
  progress: real("progress").notNull().default(0),
  projectedCompletion: text("projected_completion"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("learning_paths_student_idx").on(t.studentId)]);

export const pathMilestones = pgTable("path_milestones", {
  id: serial("id").primaryKey(),
  pathId: integer("path_id").references(() => learningPaths.id, { onDelete: "cascade" }).notNull(),
  skillId: integer("skill_id").references(() => skills.id, { onDelete: "cascade" }).notNull(),
  position: integer("position").notNull().default(1),
  status: text("status").notNull().default("available"), // locked | available | in_progress | completed
  targetMastery: real("target_mastery").notNull().default(0.85),
  currentMastery: real("current_mastery").notNull().default(0),
  dueDate: text("due_date"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (t) => [index("path_milestones_path_idx").on(t.pathId)]);

/* ------------------------------------------------------------------ */
/* Recommendation engine output                                        */
/* ------------------------------------------------------------------ */

export const recommendations = pgTable("recommendations", {
  id: serial("id").primaryKey(),
  studentId: integer("student_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  kind: text("kind").notNull().default("skill"), // skill | question | path | review
  skillId: integer("skill_id").references(() => skills.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  reason: text("reason").notNull().default(""),
  priority: real("priority").notNull().default(0.5),
  confidence: real("confidence").notNull().default(0.6),
  factors: jsonb("factors").$type<Record<string, number>>().notNull().default({}),
  model: text("model").notNull().default("hybrid-v2"),
  status: text("status").notNull().default("new"), // new | accepted | dismissed | completed
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  actedAt: timestamp("acted_at", { withTimezone: true }),
}, (t) => [
  // Composite serves both the studentId-only lookups (prefix) and the common
  // `studentId + status` filter used by the recommendation queue.
  index("recommendations_student_status_idx").on(t.studentId, t.status),
]);

/* ------------------------------------------------------------------ */
/* Model registry + activity feed                                      */
/* ------------------------------------------------------------------ */

export const mlModels = pgTable("ml_models", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind").notNull().default("classifier"), // classifier | tracer | regressor | recommender
  version: text("version").notNull().default("1.0.0"),
  // Reproducibility provenance: which data + feature definitions produced this model.
  datasetVersion: text("dataset_version"), // signature of the training rows (count + span + checksum)
  featureVersion: text("feature_version"), // version of the feature pipeline
  params: jsonb("params").$type<Record<string, unknown>>().notNull().default({}),
  hyperparams: jsonb("hyperparams").$type<Record<string, unknown>>().notNull().default({}),
  metrics: jsonb("metrics").$type<Record<string, number>>().notNull().default({}),
  samples: integer("samples").notNull().default(0),
  trainedAt: timestamp("trained_at", { withTimezone: true }).notNull().defaultNow(),
  evaluatedAt: timestamp("evaluated_at", { withTimezone: true }), // when held-out metrics were computed
}, (t) => [uniqueIndex("ml_models_name_idx").on(t.name)]);

/**
 * Immutable evaluation history. Every retrain appends a row so we can compare a
 * candidate against its predecessors and detect regressions over time — the
 * `mlModels` row only holds the latest snapshot, this keeps the audit trail.
 */
export const modelEvaluations = pgTable("model_evaluations", {
  id: serial("id").primaryKey(),
  modelName: text("model_name").notNull(),
  kind: text("kind").notNull().default("classifier"),
  version: text("version").notNull(),
  datasetVersion: text("dataset_version"),
  featureVersion: text("feature_version"),
  split: text("split").notNull().default("test"), // test | validation | train
  metrics: jsonb("metrics").$type<Record<string, number>>().notNull().default({}),
  detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}), // confusion matrix, reliability bins, comparison
  hyperparams: jsonb("hyperparams").$type<Record<string, unknown>>().notNull().default({}),
  samples: integer("samples").notNull().default(0),
  trainedAt: timestamp("trained_at", { withTimezone: true }).notNull().defaultNow(),
  evaluatedAt: timestamp("evaluated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("model_eval_name_idx").on(t.modelName),
  index("model_eval_evaluated_idx").on(t.evaluatedAt),
]);

/* ------------------------------------------------------------------ */
/* Security audit log                                                   */
/* ------------------------------------------------------------------ */

// NOTE: audit_logs intentionally has NO foreign keys on actorId /
// targetStudentId / institutionId. A security/forensic trail must survive the
// deletion of the referenced accounts, and identity is preserved via the
// denormalized actorEmail/actorRole snapshots, so we keep the raw ids rather
// than cascading or nulling them.
export const auditLogs = pgTable("audit_logs", {
  id: serial("id").primaryKey(),
  actorId: integer("actor_id"),
  actorRole: text("actor_role"),
  actorEmail: text("actor_email"),
  action: text("action").notNull(), // auth.login | auth.register | student.read | user.update | ...
  resource: text("resource"), // students | users | institutions | assessments | ...
  resourceId: text("resource_id"),
  targetStudentId: integer("target_student_id"),
  institutionId: integer("institution_id"),
  outcome: text("outcome").notNull().default("success"), // success | denied | failure
  ip: text("ip"),
  detail: text("detail"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("audit_actor_idx").on(t.actorId),
  index("audit_action_idx").on(t.action),
  index("audit_created_idx").on(t.createdAt),
]);

/* ------------------------------------------------------------------ */
/* AI tutor interactions                                               */
/* ------------------------------------------------------------------ */

/**
 * Every AI-tutor exchange is recorded as a learning event so its downstream
 * impact can be evaluated (does tutoring on a skill precede a mastery gain?).
 *
 * IMPORTANT ARCHITECTURE INVARIANT: the tutor is a *read-only* consumer of the
 * learner model. It NEVER writes `mastery_states`, `assessment_items` or
 * `assessments` — the deterministic engine remains the single source of truth.
 * This table (plus a lightweight `activity_events` row) is the only persistence
 * the tutor performs. `masteryAtTime` is a read-only SNAPSHOT captured for later
 * correlation, not an input the LLM can mutate.
 */
export const tutorInteractions = pgTable("tutor_interactions", {
  id: serial("id").primaryKey(),
  studentId: integer("student_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  /** Skill the exchange was grounded in (null for skill-agnostic requests). */
  skillId: integer("skill_id").references(() => skills.id, { onDelete: "set null" }),
  /** Assessment the exchange was tied to, when tutoring happens mid-session. */
  assessmentId: integer("assessment_id").references(() => assessments.id, { onDelete: "set null" }),
  /** Assessment item in play, when the request references a specific item. */
  itemId: integer("item_id").references(() => assessmentItems.id, { onDelete: "set null" }),
  /** Capability actually served (may differ from the requested one — see policy). */
  intent: text("intent").notNull(), // explain | hint | socratic | worked_example | diagnose | remediate | next_activity
  /** The intent the learner asked for, before policy adjustments. */
  requestedIntent: text("requested_intent"),
  /** Difficulty register the response was pitched at. */
  difficulty: text("difficulty").notNull().default("core"), // foundational | core | stretch
  /** Read-only snapshot of decayed mastery at request time (for later eval). */
  masteryAtTime: real("mastery_at_time"),
  /** True when the answer key was deliberately withheld (active assessment). */
  withheldAnswer: boolean("withheld_answer").notNull().default(false),
  /** Which generation backend produced the response. */
  provider: text("provider").notNull().default("deterministic"),
  model: text("model"),
  latencyMs: integer("latency_ms").notNull().default(0),
  responseChars: integer("response_chars").notNull().default(0),
  /** Post-generation safety findings (e.g. leaked_answer_redacted). */
  safetyFlags: jsonb("safety_flags").$type<string[]>().notNull().default([]),
  /** Optional learner feedback for later usefulness analysis. */
  helpful: boolean("helpful"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("tutor_interactions_student_created_idx").on(t.studentId, t.createdAt.desc()),
  index("tutor_interactions_skill_idx").on(t.skillId),
  index("tutor_interactions_assessment_idx").on(t.assessmentId),
]);

export const activityEvents = pgTable("activity_events", {
  id: serial("id").primaryKey(),
  studentId: integer("student_id").references(() => users.id, { onDelete: "cascade" }),
  type: text("type").notNull().default("practice"), // practice | assessment | recommendation | path
  skillId: integer("skill_id").references(() => skills.id, { onDelete: "set null" }),
  summary: text("summary").notNull(),
  value: real("value").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // Activity feeds read `where student_id=? order by created_at desc limit N`.
  // Without this it was a Seq Scan over the whole feed (profiled: 5.6x slower,
  // EXPLAIN exec 4.46ms -> 0.08ms at 30k rows).
  index("activity_student_created_idx").on(t.studentId, t.createdAt.desc()),
  // Platform-wide feed (no student filter) still orders by recency.
  index("activity_created_idx").on(t.createdAt.desc()),
]);

/* ------------------------------------------------------------------ */
/* Experimentation                                                     */
/* ------------------------------------------------------------------ */

/**
 * A controlled comparison of adaptive-learning policies.
 *
 * `institution_id` is the tenant boundary: NULL means a platform-wide
 * experiment, any other value scopes it to one institution. Every read path
 * filters on it.
 *
 * `variants`, `eligibility` and the metric lists are JSONB because their shape
 * is owned by `src/lib/experiments/types.ts` and validated there — the database
 * stores the definition, the application enforces its semantics.
 */
export const experiments = pgTable("experiments", {
  id: serial("id").primaryKey(),
  key: text("key").notNull(),
  name: text("name").notNull(),
  hypothesis: text("hypothesis").notNull().default(""),
  institutionId: integer("institution_id").references(() => institutions.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("draft"), // draft|scheduled|running|paused|completed|archived
  variants: jsonb("variants").$type<unknown[]>().notNull().default([]),
  eligibility: jsonb("eligibility").$type<Record<string, unknown>>().notNull().default({}),
  primaryMetric: text("primary_metric").notNull(),
  secondaryMetrics: jsonb("secondary_metrics").$type<string[]>().notNull().default([]),
  assignmentStrategy: text("assignment_strategy").notNull().default("sticky"), // sticky | rolling
  /** Hash salt — distinct per experiment so bucketing is uncorrelated across experiments. */
  salt: text("salt").notNull(),
  startAt: timestamp("start_at", { withTimezone: true }).notNull(),
  endAt: timestamp("end_at", { withTimezone: true }),
  /** Experiments sharing a group never enrol the same learner. */
  exclusionGroup: text("exclusion_group"),
  createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // Keys are unique per tenant, so two institutions may both run "policy-v3-vs-v2".
  //
  // Two partial indexes rather than one composite: SQL treats NULLs as
  // DISTINCT, so a plain unique index on (institution_id, key) would happily
  // accept two platform-wide experiments with the same key — and then
  // `getExperimentByKey` returns an arbitrary one of them. Splitting on
  // nullness closes that hole without depending on Postgres 15's
  // NULLS NOT DISTINCT.
  uniqueIndex("experiments_tenant_key_idx")
    .on(t.institutionId, t.key)
    .where(sql`${t.institutionId} is not null`),
  uniqueIndex("experiments_global_key_idx")
    .on(t.key)
    .where(sql`${t.institutionId} is null`),
  index("experiments_status_idx").on(t.status),
  index("experiments_institution_idx").on(t.institutionId),
  index("experiments_window_idx").on(t.startAt, t.endAt),
]);

/**
 * A learner's binding to one variant.
 *
 * The unique index on (experiment_id, student_id) is the database-level
 * guarantee behind "one learner, one variant": even a race between two
 * concurrent serving requests cannot produce two arms for the same learner.
 * Assignment writes use ON CONFLICT DO NOTHING and re-read, so the first write
 * wins and the loser adopts it.
 */
export const experimentAssignments = pgTable("experiment_assignments", {
  id: serial("id").primaryKey(),
  experimentId: integer("experiment_id").references(() => experiments.id, { onDelete: "cascade" }).notNull(),
  studentId: integer("student_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  variantKey: text("variant_key").notNull(),
  /** Config fingerprint at assignment time. */
  configFingerprint: text("config_fingerprint").notNull(),
  /** The uniform draw that produced the bucket — lets anyone re-verify the assignment. */
  bucket: real("bucket").notNull(),
  /** Frozen eligibility facts, so the population cannot drift at analysis time. */
  eligibilitySnapshot: jsonb("eligibility_snapshot").$type<Record<string, unknown>>().notNull().default({}),
  assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("experiment_assignment_unique_idx").on(t.experimentId, t.studentId),
  index("experiment_assignment_variant_idx").on(t.experimentId, t.variantKey),
  index("experiment_assignment_student_idx").on(t.studentId),
]);

/**
 * One moment a learner actually experienced a variant.
 *
 * Separate from assignment because assignment alone must never license metric
 * attribution — a learner enrolled but never served by the policy would
 * otherwise contribute outcomes to an arm that never touched them. The first
 * exposure timestamp is the clock every metric starts from.
 */
export const experimentExposures = pgTable("experiment_exposures", {
  id: serial("id").primaryKey(),
  experimentId: integer("experiment_id").references(() => experiments.id, { onDelete: "cascade" }).notNull(),
  studentId: integer("student_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  variantKey: text("variant_key").notNull(),
  /** Fingerprint actually in force when served — detects mid-run config edits. */
  configFingerprint: text("config_fingerprint").notNull(),
  surface: text("surface").notNull().default("assessment.next-item"),
  /** Related domain row (assessment item id) for attribution joins. */
  entityId: integer("entity_id"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("experiment_exposure_lookup_idx").on(t.experimentId, t.studentId, t.occurredAt),
  index("experiment_exposure_variant_idx").on(t.experimentId, t.variantKey),
  index("experiment_exposure_entity_idx").on(t.entityId),
]);

/* ------------------------------------------------------------------ */
/* Misconception longitudinal tracking                                 */
/* ------------------------------------------------------------------ */

/**
 * One misconception episode per (learner, hypothesis): detected, remediated,
 * then either resolved, recurred, or still unproven.
 *
 * The rows are a DERIVED, recomputable projection of responses + remediations —
 * the deterministic detector in `lib/ml/misconceptions.ts` remains the source of
 * truth, and an episode can always be rebuilt from the underlying evidence by
 * `buildMisconceptionEpisodes`. Persisting it buys queryable history and a
 * stable place to attach expert labels, not a second opinion.
 *
 * `ground_truth_label` is the hook for real-learner evaluation: until an expert
 * fills it in, detection precision is unmeasured — which the metrics layer
 * reports as `null` rather than as a flattering default.
 */
export const misconceptionEpisodes = pgTable("misconception_episodes", {
  id: serial("id").primaryKey(),
  studentId: integer("student_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  skillId: integer("skill_id").references(() => skills.id, { onDelete: "cascade" }).notNull(),
  /** Detector hypothesis id: `skillId|subskill|prereqId|normalized label`. */
  hypothesisId: text("hypothesis_id").notNull(),
  subskill: text("subskill"),
  misconception: text("misconception").notNull(),
  confidenceAtDetection: text("confidence_at_detection").notNull(), // MEDIUM | HIGH
  errorPattern: text("error_pattern").notNull(),

  /** First error evidence vs. when the detector would have flagged it. */
  firstObservedAt: timestamp("first_observed_at", { withTimezone: true }).notNull(),
  detectedAt: timestamp("detected_at", { withTimezone: true }).notNull(),
  detectionEvidenceCount: integer("detection_evidence_count").notNull().default(0),

  firstRemediationAt: timestamp("first_remediation_at", { withTimezone: true }),
  /** resolved | recurred | temporarily_suppressed | insufficient_evidence */
  status: text("status").notNull().default("insufficient_evidence"),
  statusReason: text("status_reason").notNull().default(""),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),

  postRemediationOpportunities: integer("post_remediation_opportunities").notNull().default(0),
  cleanOpportunities: integer("clean_opportunities").notNull().default(0),
  recurrences: integer("recurrences").notNull().default(0),

  masteryAtDetection: real("mastery_at_detection"),
  masteryLatest: real("mastery_latest"),
  retention: real("retention"),

  /** Expert label for detection-quality evaluation. confirmed | refuted | unknown */
  groundTruthLabel: text("ground_truth_label").notNull().default("unknown"),
  groundTruthBy: integer("ground_truth_by").references(() => users.id, { onDelete: "set null" }),
  groundTruthAt: timestamp("ground_truth_at", { withTimezone: true }),
  groundTruthNote: text("ground_truth_note"),

  /** Opportunity-by-opportunity trail, so a status can always be re-derived. */
  opportunities: jsonb("opportunities").$type<unknown[]>().notNull().default([]),
  /** Config the status was computed under — thresholds change over time. */
  evaluationConfig: jsonb("evaluation_config").$type<Record<string, unknown>>().notNull().default({}),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("misconception_episode_student_hypothesis_idx").on(t.studentId, t.hypothesisId),
  index("misconception_episode_status_idx").on(t.status, t.detectedAt.desc()),
  index("misconception_episode_skill_idx").on(t.skillId),
]);

/**
 * Remediation exposures attached to an episode.
 *
 * `counts_as_evidence` is stored as a hard `false` for every generated
 * explanation. It exists so the rule survives contact with future query
 * authors: an analyst joining this table cannot accidentally treat "the tutor
 * explained it" as "the learner fixed it", because the column says otherwise
 * and the check constraint keeps it that way.
 */
export const misconceptionRemediations = pgTable("misconception_remediations", {
  id: serial("id").primaryKey(),
  episodeId: integer("episode_id").references(() => misconceptionEpisodes.id, { onDelete: "cascade" }).notNull(),
  studentId: integer("student_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  /** tutor_llm | tutor_deterministic | recommendation | targeted_practice | instructor | worked_example */
  source: text("source").notNull(),
  tutorInteractionId: integer("tutor_interaction_id").references(() => tutorInteractions.id, { onDelete: "set null" }),
  recommendationId: integer("recommendation_id").references(() => recommendations.id, { onDelete: "set null" }),
  /** True when the remediation named this specific misconception. */
  targeted: boolean("targeted").notNull().default(false),
  /** Learner-reported usefulness. Analysis only — never outcome evidence. */
  helpful: boolean("helpful"),
  /** ALWAYS false: interventions are never evidence of resolution. */
  countsAsEvidence: boolean("counts_as_evidence").notNull().default(false),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("misconception_remediation_episode_idx").on(t.episodeId, t.occurredAt),
  check("misconception_remediation_not_evidence", sql`${t.countsAsEvidence} = false`),
]);

export type User = typeof users.$inferSelect;
export type Institution = typeof institutions.$inferSelect;
export type Skill = typeof skills.$inferSelect;
export type Subject = typeof subjects.$inferSelect;
export type Question = typeof questions.$inferSelect;
export type ItemStatistic = typeof itemStatistics.$inferSelect;
export type Assessment = typeof assessments.$inferSelect;
export type AssessmentItem = typeof assessmentItems.$inferSelect;
export type MasteryState = typeof masteryStates.$inferSelect;
export type LearningPath = typeof learningPaths.$inferSelect;
export type PathMilestone = typeof pathMilestones.$inferSelect;
export type Recommendation = typeof recommendations.$inferSelect;
export type MlModel = typeof mlModels.$inferSelect;
export type ModelEvaluation = typeof modelEvaluations.$inferSelect;
export type ActivityEvent = typeof activityEvents.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;
export type TutorInteraction = typeof tutorInteractions.$inferSelect;
export type MisconceptionEpisodeRow = typeof misconceptionEpisodes.$inferSelect;
export type MisconceptionRemediationRow = typeof misconceptionRemediations.$inferSelect;
export type ExperimentRow = typeof experiments.$inferSelect;
export type ExperimentAssignmentRow = typeof experimentAssignments.$inferSelect;
export type ExperimentExposureRow = typeof experimentExposures.$inferSelect;
