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
}, (t) => [uniqueIndex("users_email_idx").on(t.email)]);

export const sessions = pgTable("sessions", {
  id: serial("id").primaryKey(),
  token: text("token").notNull(),
  userId: integer("user_id").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("sessions_token_idx").on(t.token)]);

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
  stem: text("stem").notNull(),
  options: jsonb("options").$type<string[]>().notNull().default([]),
  correctIndex: integer("correct_index").notNull().default(0),
  difficultyLabel: text("difficulty_label").notNull().default("medium"), // easy | medium | hard | expert
  bloomLevel: text("bloom_level").notNull().default("apply"),
  explanation: text("explanation").notNull().default(""),
  estimatedSeconds: integer("estimated_seconds").notNull().default(60),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("questions_skill_idx").on(t.skillId)]);

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
});

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
}, (t) => [index("assessment_items_assessment_idx").on(t.assessmentId)]);

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
});

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
}, (t) => [index("recommendations_student_idx").on(t.studentId)]);

/* ------------------------------------------------------------------ */
/* Model registry + activity feed                                      */
/* ------------------------------------------------------------------ */

export const mlModels = pgTable("ml_models", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind").notNull().default("classifier"), // classifier | tracer | regressor | recommender
  version: text("version").notNull().default("1.0.0"),
  params: jsonb("params").$type<Record<string, unknown>>().notNull().default({}),
  metrics: jsonb("metrics").$type<Record<string, number>>().notNull().default({}),
  samples: integer("samples").notNull().default(0),
  trainedAt: timestamp("trained_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("ml_models_name_idx").on(t.name)]);

export const activityEvents = pgTable("activity_events", {
  id: serial("id").primaryKey(),
  studentId: integer("student_id"),
  type: text("type").notNull().default("practice"), // practice | assessment | recommendation | path
  skillId: integer("skill_id"),
  summary: text("summary").notNull(),
  value: real("value").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type Institution = typeof institutions.$inferSelect;
export type Skill = typeof skills.$inferSelect;
export type Subject = typeof subjects.$inferSelect;
export type Question = typeof questions.$inferSelect;
export type Assessment = typeof assessments.$inferSelect;
export type AssessmentItem = typeof assessmentItems.$inferSelect;
export type MasteryState = typeof masteryStates.$inferSelect;
export type LearningPath = typeof learningPaths.$inferSelect;
export type PathMilestone = typeof pathMilestones.$inferSelect;
export type Recommendation = typeof recommendations.$inferSelect;
export type MlModel = typeof mlModels.$inferSelect;
export type ActivityEvent = typeof activityEvents.$inferSelect;
