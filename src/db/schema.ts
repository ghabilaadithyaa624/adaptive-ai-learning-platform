import {
  boolean,
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
  institutionId: integer("institution_id"),
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
  userId: integer("user_id").notNull(),
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
  subjectId: integer("subject_id").notNull(),
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
  skillId: integer("skill_id").notNull(),
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
    .$type<{ optionIndex: number; misconception?: string; rationale?: string }[]>()
    .notNull()
    .default([]),
  estimatedSeconds: integer("estimated_seconds").notNull().default(60),

  /* --------------------------- authoring / provenance --------------------------- */
  authorId: integer("author_id"),
  source: text("source").notNull().default("human"), // human | ai | imported
  version: integer("version").notNull().default(1),

  /* ------------------------------- workflow ------------------------------- */
  status: text("status").notNull().default("draft"), // draft | review | validated | published | monitored | retired
  reviewedById: integer("reviewed_by_id"),
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
  questionId: integer("question_id").notNull(),
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
  studentId: integer("student_id").notNull(),
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
  assessmentId: integer("assessment_id").notNull(),
  questionId: integer("question_id").notNull(),
  skillId: integer("skill_id").notNull(),
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
  studentId: integer("student_id").notNull(),
  skillId: integer("skill_id").notNull(),
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
  studentId: integer("student_id").notNull(),
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
  pathId: integer("path_id").notNull(),
  skillId: integer("skill_id").notNull(),
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
  studentId: integer("student_id").notNull(),
  kind: text("kind").notNull().default("skill"), // skill | question | path | review
  skillId: integer("skill_id"),
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

export const activityEvents = pgTable("activity_events", {
  id: serial("id").primaryKey(),
  studentId: integer("student_id"),
  type: text("type").notNull().default("practice"), // practice | assessment | recommendation | path
  skillId: integer("skill_id"),
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
