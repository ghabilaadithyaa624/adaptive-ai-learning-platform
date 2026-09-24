/**
 * Stage 1 — Learner Context.
 *
 * Assembles the read-only view of the learner model the tutor reasons over:
 * current skill, mastery estimate, recent mistakes, prerequisites, current
 * learning path + milestone, recommended activity, learner goal and assessment
 * context.
 *
 * This module ONLY reads. It reuses the same deterministic learner-state builder
 * the adaptive engine uses (`buildLearnerState`) so the tutor sees exactly the
 * signals the engine sees — it never recomputes mastery or writes any state.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  assessmentItems,
  assessments,
  learningPaths,
  masteryStates,
  pathMilestones,
  questions,
  recommendations,
  skills,
  subjects,
  users,
} from "@/db/schema";
import { applyDecay } from "@/lib/ml/knowledge-tracing";
import { buildLearnerState, type RawResponse, type RawSkillState } from "@/lib/ml/learner-state";
import { DIFFICULTY_VALUE, BLOOM_VALUE } from "@/lib/engine";
import { MASTERY_TARGET, round } from "@/lib/utils";
import type {
  ActiveAssessmentContext,
  CurrentMilestoneView,
  LearnerTutorContext,
  PrereqView,
  RecentMistake,
  RecommendedActivityView,
} from "./types";

const PREREQ_MET = 0.6;

/** Map a numeric difficulty back to the nearest authored label for display. */
function difficultyLabel(value: number): string {
  const entries = Object.entries(DIFFICULTY_VALUE);
  let best = "medium";
  let bestDist = Infinity;
  for (const [label, v] of entries) {
    const d = Math.abs(v - value);
    if (d < bestDist) {
      bestDist = d;
      best = label;
    }
  }
  return best;
}

function bloomLabel(value: number): string {
  const entries = Object.entries(BLOOM_VALUE);
  let best = "apply";
  let bestDist = Infinity;
  for (const [label, v] of entries) {
    const d = Math.abs(v - value);
    if (d < bestDist) {
      bestDist = d;
      best = label;
    }
  }
  return best;
}

export interface AssembleContextOptions {
  skillId?: number;
  assessmentId?: number;
  itemId?: number;
}

/**
 * Build the complete learner context. `now` is injectable for deterministic
 * tests; defaults to wall-clock in production.
 */
export async function assembleLearnerContext(
  studentId: number,
  options: AssembleContextOptions = {},
  now: Date = new Date(),
): Promise<LearnerTutorContext | null> {
  const userRows = await db
    .select({ id: users.id, name: users.name, goal: users.goal, gradeLevel: users.gradeLevel, role: users.role })
    .from(users)
    .where(eq(users.id, studentId))
    .limit(1);
  const user = userRows[0];
  if (!user) return null;

  // Load, in parallel, everything the learner-state builder + context need.
  const [masteryRows, skillRows, recentItemRows, pathRows, recRows] = await Promise.all([
    db.select().from(masteryStates).where(eq(masteryStates.studentId, studentId)),
    db
      .select({ skill: skills, subjectName: subjects.name })
      .from(skills)
      .innerJoin(subjects, eq(subjects.id, skills.subjectId)),
    db
      .select({
        responseId: assessmentItems.id,
        questionId: questions.id,
        skillId: assessmentItems.skillId,
        isCorrect: assessmentItems.isCorrect,
        studentAnswer: assessmentItems.studentAnswer,
        options: questions.options,
        distractorMeta: questions.distractorMeta,
        subskill: questions.subskill,
        masteryBefore: assessmentItems.masteryBefore,
        responseTimeMs: assessmentItems.responseTimeMs,
        estimatedSeconds: questions.estimatedSeconds,
        difficultyLabel: questions.difficultyLabel,
        bloomLevel: questions.bloomLevel,
        stem: questions.stem,
        createdAt: assessmentItems.createdAt,
      })
      .from(assessmentItems)
      .innerJoin(assessments, eq(assessments.id, assessmentItems.assessmentId))
      .innerJoin(questions, eq(questions.id, assessmentItems.questionId))
      .where(eq(assessments.studentId, studentId))
      .orderBy(desc(assessmentItems.createdAt))
      .limit(120),
    db
      .select({ path: learningPaths })
      .from(learningPaths)
      .where(and(eq(learningPaths.studentId, studentId), eq(learningPaths.status, "active")))
      .orderBy(desc(learningPaths.createdAt)),
    db
      .select({ rec: recommendations, skillName: skills.name })
      .from(recommendations)
      .leftJoin(skills, eq(skills.id, recommendations.skillId))
      .where(and(eq(recommendations.studentId, studentId), eq(recommendations.status, "new")))
      .orderBy(desc(recommendations.priority))
      .limit(1),
  ]);

  const skillById = new Map(skillRows.map((r) => [r.skill.id, r]));

  // ---- Rich learner state (same builder the engine uses) ----
  const stateBySkill = new Map(masteryRows.map((r) => [r.skillId, r]));
  const rawSkillStates: RawSkillState[] = skillRows.map((row) => {
    const state = stateBySkill.get(row.skill.id);
    return {
      skillId: row.skill.id,
      skillName: row.skill.name,
      subjectName: row.subjectName,
      mastery: state ? state.mastery : 0.2,
      attempts: state?.attempts ?? 0,
      correct: state?.correct ?? 0,
      streak: state?.streak ?? 0,
      history: state?.history ?? [],
      lastPracticedAt: state?.lastPracticedAt ?? null,
      prereqIds: row.skill.prereqIds ?? [],
      difficultyBase: row.skill.difficultyBase,
    };
  });

  const responses: RawResponse[] = recentItemRows
    .filter((row) => row.isCorrect !== null)
    .map((row) => ({
      skillId: row.skillId,
      isCorrect: Boolean(row.isCorrect),
      responseId: row.responseId,
      questionId: row.questionId,
      subskill: row.subskill,
      selectedOption: row.studentAnswer,
      distractor: row.studentAnswer == null ? null : row.options[row.studentAnswer] ?? null,
      misconception: row.studentAnswer == null ? null : row.distractorMeta.find(d => d.optionIndex === row.studentAnswer)?.misconception ?? null,
      prerequisiteSkillId: row.studentAnswer == null ? null : row.distractorMeta.find(d => d.optionIndex === row.studentAnswer)?.prerequisiteSkillId ?? null,
      masteryAtObservation: row.masteryBefore,
      responseTimeMs: row.responseTimeMs,
      estimatedSeconds: row.estimatedSeconds,
      difficulty: DIFFICULTY_VALUE[row.difficultyLabel] ?? 0.55,
      bloom: BLOOM_VALUE[row.bloomLevel] ?? 3,
      createdAt: row.createdAt,
    }));

  const learnerState = buildLearnerState({ studentId, skillStates: rawSkillStates, responses, now });

  // ---- Assessment context (read-only; never queues a new item) ----
  const assessment = await loadAssessmentContext(studentId, options.assessmentId, skillById);

  // ---- Focus-skill resolution ----
  const focusSkillId = resolveFocusSkill({
    requested: options.skillId,
    assessment,
    pathRows,
    recSkillId: recRows[0]?.rec.skillId ?? null,
    learnerState,
    masteryRows,
    skillById,
  });

  const focusSkill = focusSkillId != null ? buildFocusSkill(focusSkillId, learnerState, skillById) : null;

  // ---- Recent mistakes (most recent incorrect / slip responses) ----
  const recentMistakes: RecentMistake[] = recentItemRows
    .filter((row) => row.isCorrect === false)
    .slice(0, 5)
    .map((row) => ({
      skillId: row.skillId,
      skillName: skillById.get(row.skillId)?.skill.name ?? "Skill",
      difficulty: row.difficultyLabel,
      bloom: row.bloomLevel,
      responseRatio: round(row.responseTimeMs / Math.max(1000, row.estimatedSeconds * 1000), 2),
      daysAgo: round(Math.max(0, (now.getTime() - new Date(row.createdAt).getTime()) / 86_400_000), 1),
      stem: row.stem,
    }));

  // ---- Current learning path + milestone ----
  const currentMilestone = await loadCurrentMilestone(pathRows.map((r) => r.path), skillById);

  // ---- Recommended activity ----
  const recommendedActivity = buildRecommendedActivity({
    rec: recRows[0] ?? null,
    currentMilestone,
    coldStart: masteryRows.length === 0,
    focusSkill,
  });

  return {
    studentId,
    studentName: user.name,
    gradeLevel: user.gradeLevel,
    goal: user.goal,
    focusSkill,
    ability: learnerState.ability,
    recentMistakes,
    currentMilestone,
    recommendedActivity,
    assessment,
    coldStart: masteryRows.length === 0,
  };
}

/* --------------------------- helpers --------------------------- */

type SkillRow = { skill: typeof skills.$inferSelect; subjectName: string };

async function loadAssessmentContext(
  studentId: number,
  assessmentId: number | undefined,
  skillById: Map<number, SkillRow>,
): Promise<ActiveAssessmentContext | null> {
  const rows = assessmentId
    ? await db.select().from(assessments).where(eq(assessments.id, assessmentId)).limit(1)
    : await db
        .select()
        .from(assessments)
        .where(and(eq(assessments.studentId, studentId), eq(assessments.status, "in_progress")))
        .orderBy(desc(assessments.startedAt))
        .limit(1);
  const assessment = rows[0];
  // Only surface assessments that belong to this learner.
  if (!assessment || assessment.studentId !== studentId) return null;

  const items = await db
    .select({
      item: assessmentItems,
      stem: questions.stem,
      skillName: skills.name,
    })
    .from(assessmentItems)
    .innerJoin(questions, eq(questions.id, assessmentItems.questionId))
    .innerJoin(skills, eq(skills.id, assessmentItems.skillId))
    .where(eq(assessmentItems.assessmentId, assessment.id));

  const answered = items.filter((i) => i.item.studentAnswer !== null);
  const pending = items.find((i) => i.item.studentAnswer === null) ?? null;

  return {
    assessmentId: assessment.id,
    title: assessment.title,
    mode: assessment.mode,
    status: assessment.status,
    itemsAnswered: answered.length,
    itemTarget: assessment.itemTarget,
    pendingItem: pending
      ? {
          itemId: pending.item.id,
          questionId: pending.item.questionId,
          skillId: pending.item.skillId,
          skillName: pending.skillName ?? skillById.get(pending.item.skillId)?.skill.name ?? "Skill",
          stem: pending.stem,
        }
      : null,
  };
}

function resolveFocusSkill(params: {
  requested?: number;
  assessment: ActiveAssessmentContext | null;
  pathRows: { path: typeof learningPaths.$inferSelect }[];
  recSkillId: number | null;
  learnerState: ReturnType<typeof buildLearnerState>;
  masteryRows: (typeof masteryStates.$inferSelect)[];
  skillById: Map<number, SkillRow>;
}): number | null {
  const { requested, assessment, recSkillId, learnerState, masteryRows, skillById } = params;
  // 1. Explicit request wins (if it is a real skill).
  if (requested && skillById.has(requested)) return requested;
  // 2. The skill of the item the learner is actively working on.
  if (assessment?.pendingItem) return assessment.pendingItem.skillId;
  // 3. The active recommendation's skill.
  if (recSkillId && skillById.has(recSkillId)) return recSkillId;
  // 4. The learner's weakest practised skill (most in need of help).
  if (masteryRows.length) {
    const weakest = [...learnerState.skills.values()]
      .filter((s) => s.attempts > 0)
      .sort((a, b) => a.mastery - b.mastery)[0];
    if (weakest) return weakest.skillId;
  }
  // 5. Cold start: the most foundational skill in the taxonomy.
  const foundational = [...skillById.values()]
    .filter((r) => (r.skill.prereqIds ?? []).length === 0)
    .sort((a, b) => a.skill.difficultyBase - b.skill.difficultyBase)[0];
  return foundational?.skill.id ?? null;
}

function buildFocusSkill(
  skillId: number,
  learnerState: ReturnType<typeof buildLearnerState>,
  skillById: Map<number, SkillRow>,
): LearnerTutorContext["focusSkill"] {
  const row = skillById.get(skillId);
  if (!row) return null;
  const s = learnerState.skills.get(skillId);
  const prereqIds = row.skill.prereqIds ?? [];
  const prereqs: PrereqView[] = prereqIds.map((id) => {
    const ps = learnerState.skills.get(id);
    const mastery = ps ? ps.mastery : 0;
    return {
      skillId: id,
      skillName: skillById.get(id)?.skill.name ?? `Skill ${id}`,
      mastery: round(mastery, 3),
      met: mastery >= PREREQ_MET,
    };
  });

  return {
    skillId,
    skillName: row.skill.name,
    subjectName: row.subjectName,
    description: row.skill.description,
    difficultyBase: row.skill.difficultyBase,
    mastery: s ? s.mastery : 0,
    confidence: s ? s.confidence : 0,
    attempts: s ? s.attempts : 0,
    accuracy: s ? s.accuracy : 0,
    recentAccuracy: s ? s.recentAccuracy : 0,
    errorType: s ? s.errorProfile.type : "insufficient-data",
    errorLabel: s ? s.errorProfile.label : "No responses yet on this skill",
    misconceptions: s?.misconceptions ?? [],
    prereqReadiness: s ? s.prereqReadiness : prereqs.length ? 0 : 1,
    prereqs,
  };
}

async function loadCurrentMilestone(
  paths: (typeof learningPaths.$inferSelect)[],
  skillById: Map<number, SkillRow>,
): Promise<CurrentMilestoneView | null> {
  if (!paths.length) return null;
  const pathIds = paths.map((p) => p.id);
  const milestones = await db
    .select()
    .from(pathMilestones)
    .where(inArray(pathMilestones.pathId, pathIds))
    .orderBy(pathMilestones.position);

  // The "current" milestone is the first not-yet-completed one, preferring
  // in-progress > available > locked, on the most recent active path.
  for (const path of paths) {
    const own = milestones.filter((m) => m.pathId === path.id);
    const ordered = [
      ...own.filter((m) => m.status === "in_progress"),
      ...own.filter((m) => m.status === "available"),
      ...own.filter((m) => m.status === "locked"),
    ];
    const m = ordered[0];
    if (m) {
      return {
        pathId: path.id,
        pathTitle: path.title,
        objective: path.objective,
        milestoneId: m.id,
        skillId: m.skillId,
        skillName: skillById.get(m.skillId)?.skill.name ?? "Skill",
        position: m.position,
        status: m.status,
        currentMastery: round(m.currentMastery, 3),
        targetMastery: round(m.targetMastery, 3),
      };
    }
  }
  return null;
}

function buildRecommendedActivity(params: {
  rec: { rec: typeof recommendations.$inferSelect; skillName: string | null } | null;
  currentMilestone: CurrentMilestoneView | null;
  coldStart: boolean;
  focusSkill: LearnerTutorContext["focusSkill"];
}): RecommendedActivityView | null {
  const { rec, currentMilestone, coldStart, focusSkill } = params;
  if (rec) {
    return {
      kind: rec.rec.kind,
      skillId: rec.rec.skillId,
      title: rec.rec.title,
      reason: rec.rec.reason,
      priority: round(rec.rec.priority, 3),
      source: "recommendation",
    };
  }
  if (currentMilestone) {
    return {
      kind: "path",
      skillId: currentMilestone.skillId,
      title: `Advance milestone: ${currentMilestone.skillName}`,
      reason: `Next step on "${currentMilestone.pathTitle}" — mastery ${Math.round(
        currentMilestone.currentMastery * 100,
      )}% toward ${Math.round(currentMilestone.targetMastery * 100)}% target.`,
      priority: 0.6,
      source: "milestone",
    };
  }
  if (coldStart || (focusSkill && focusSkill.attempts < 4)) {
    return {
      kind: "diagnostic",
      skillId: focusSkill?.skillId ?? null,
      title: focusSkill ? `Short diagnostic on ${focusSkill.skillName}` : "Start a baseline diagnostic",
      reason: "Not enough evidence yet — a short checkpoint calibrates the learner model before deeper practice.",
      priority: 0.5,
      source: "diagnostic",
    };
  }
  if (focusSkill && focusSkill.mastery < MASTERY_TARGET) {
    return {
      kind: "skill",
      skillId: focusSkill.skillId,
      title: `Targeted practice: ${focusSkill.skillName}`,
      reason: `Mastery ${Math.round(focusSkill.mastery * 100)}% is below the ${Math.round(
        MASTERY_TARGET * 100,
      )}% target.`,
      priority: 0.55,
      source: "recommendation",
    };
  }
  return null;
}
