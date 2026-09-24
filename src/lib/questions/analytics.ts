/**
 * Question-performance analytics.
 *
 * Reads observed responses, runs classical + IRT-ready item analysis
 * (`analyzeItem`) and persists both a historical snapshot (`item_statistics`)
 * and the latest rollup on the `questions` row (quality score, success rate,
 * discrimination, exposure, calibration container, quality flags).
 *
 * Respondent ability uses a *rest-score* (a learner's accuracy on their OTHER
 * items) so the discrimination statistic is not inflated by part-whole overlap.
 */
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { assessmentItems, assessments, itemStatistics, questions } from "@/db/schema";
import { analyzeItem, calibrationFromAnalysis, type ItemAnalysis, type ItemResponse } from "@/lib/ml/item-analysis";
import { difficultyLabelForValue } from "@/lib/questions/constants";
import { clamp, mean, round } from "@/lib/utils";

export interface ItemAnalyticsResult {
  questionId: number;
  sampleSize: number;
  facility: number;
  discrimination: number | null;
  qualityScore: number;
  flags: string[];
}

export interface AnalyticsReport {
  analyzedAt: string;
  itemsWithData: number;
  itemsUpdated: number;
  results: ItemAnalyticsResult[];
  summary: {
    totalItems: number;
    itemsWithResponses: number;
    meanQuality: number;
    meanDiscrimination: number | null;
    meanFacility: number | null;
    flaggedItems: number;
    lowQualityItems: number; // qualityScore < 0.4 among items with a reliable sample
    flagCounts: Record<string, number>;
  };
}

const LOW_QUALITY_THRESHOLD = 0.4;

/**
 * Recompute analytics for every question (or a single one) and persist results.
 */
export async function computeAndPersistItemStatistics(opts: { questionId?: number } = {}): Promise<AnalyticsReport> {
  const now = new Date();

  // 1) Load the item bank (metadata needed for analysis).
  const questionRows = await db
    .select({
      id: questions.id,
      options: questions.options,
      correctIndex: questions.correctIndex,
      difficultyLabel: questions.difficultyLabel,
    })
    .from(questions)
    .where(opts.questionId ? eq(questions.id, opts.questionId) : undefined);

  const questionMeta = new Map(questionRows.map((q) => [q.id, q]));

  // 2) Load all answered responses joined to their student.
  const responseRows = await db
    .select({
      questionId: assessmentItems.questionId,
      studentId: assessments.studentId,
      isCorrect: assessmentItems.isCorrect,
      studentAnswer: assessmentItems.studentAnswer,
      responseTimeMs: assessmentItems.responseTimeMs,
    })
    .from(assessmentItems)
    .innerJoin(assessments, eq(assessments.id, assessmentItems.assessmentId));

  // 3) Per-student totals (across ALL their answered items) for rest-score ability.
  const studentTotals = new Map<number, { answered: number; correct: number }>();
  for (const r of responseRows) {
    if (r.isCorrect === null) continue;
    const t = studentTotals.get(r.studentId) ?? { answered: 0, correct: 0 };
    t.answered += 1;
    t.correct += r.isCorrect ? 1 : 0;
    studentTotals.set(r.studentId, t);
  }

  // 4) Exposure counts: how many times each item was served (answered or not).
  const exposureRows = await db
    .select({ questionId: assessmentItems.questionId, total: sql<number>`count(*)::int` })
    .from(assessmentItems)
    .groupBy(assessmentItems.questionId);
  const exposureMap = new Map(exposureRows.map((row) => [row.questionId, Number(row.total)]));

  // 5) Group answered responses by question.
  const byQuestion = new Map<number, typeof responseRows>();
  for (const r of responseRows) {
    if (r.isCorrect === null) continue;
    if (opts.questionId && r.questionId !== opts.questionId) continue;
    const list = byQuestion.get(r.questionId) ?? [];
    list.push(r);
    byQuestion.set(r.questionId, list);
  }

  const results: ItemAnalyticsResult[] = [];
  const analyses: ItemAnalysis[] = [];
  let itemsUpdated = 0;

  for (const [questionId, rows] of byQuestion) {
    const meta = questionMeta.get(questionId);
    if (!meta) continue;

    const responses: ItemResponse[] = rows.map((r) => {
      const totals = studentTotals.get(r.studentId) ?? { answered: 1, correct: 0 };
      const restAnswered = Math.max(1, totals.answered - 1);
      const restCorrect = totals.correct - (r.isCorrect ? 1 : 0);
      const ability = clamp(restCorrect / restAnswered, 0, 1);
      return {
        correct: Boolean(r.isCorrect),
        ability,
        chosenOption: r.studentAnswer,
        responseTimeMs: r.responseTimeMs,
      };
    });

    const analysis = analyzeItem(responses, {
      optionCount: meta.options.length,
      correctIndex: meta.correctIndex,
      authoredDifficultyLabel: meta.difficultyLabel,
    });
    analyses.push(analysis);

    const calibration = calibrationFromAnalysis(analysis, now);

    // Persist a history snapshot.
    await db.insert(itemStatistics).values({
      questionId,
      sampleSize: analysis.sampleSize,
      facility: analysis.facility,
      discrimination: analysis.discrimination ?? 0,
      discriminationIndex: analysis.discriminationIndex,
      meanResponseTimeMs: analysis.meanResponseTimeMs,
      qualityScore: analysis.qualityScore,
      flags: analysis.flags,
      distractorAnalysis: analysis.options as unknown as Record<string, unknown>[],
      calibration: calibration as unknown as Record<string, unknown>,
      computedAt: now,
    });

    // Update the live rollup on the question row.
    await db
      .update(questions)
      .set({
        qualityScore: analysis.qualityScore,
        successRate: analysis.successRate,
        discrimination: analysis.discrimination ?? 0,
        exposureCount: exposureMap.get(questionId) ?? analysis.sampleSize,
        calibration: calibration as unknown as Record<string, unknown>,
        qualityFlags: analysis.flags,
        lastAnalyzedAt: now,
        // Refine numeric difficulty toward the observed value once we have a reliable sample.
        ...(analysis.reliable ? { difficultyValue: round(clamp(1 - analysis.facility, 0, 1), 3) } : {}),
      })
      .where(eq(questions.id, questionId));
    itemsUpdated += 1;

    results.push({
      questionId,
      sampleSize: analysis.sampleSize,
      facility: analysis.facility,
      discrimination: analysis.discrimination,
      qualityScore: analysis.qualityScore,
      flags: analysis.flags,
    });
  }

  // Bank-level summary.
  const flagCounts: Record<string, number> = {};
  for (const a of analyses) for (const f of a.flags) flagCounts[f] = (flagCounts[f] ?? 0) + 1;
  const discriminations = analyses.map((a) => a.discrimination).filter((d): d is number => d != null);
  const reliableAnalyses = analyses.filter((a) => a.reliable);

  const totalItems = opts.questionId ? 1 : questionRows.length;

  const summary = {
    totalItems,
    itemsWithResponses: analyses.length,
    meanQuality: analyses.length ? round(mean(analyses.map((a) => a.qualityScore)), 3) : 0,
    meanDiscrimination: discriminations.length ? round(mean(discriminations), 3) : null,
    meanFacility: analyses.length ? round(mean(analyses.map((a) => a.facility)), 3) : null,
    flaggedItems: analyses.filter((a) => a.flags.some((f) => f !== "insufficient_sample")).length,
    lowQualityItems: reliableAnalyses.filter((a) => a.qualityScore < LOW_QUALITY_THRESHOLD).length,
    flagCounts,
  };

  return {
    analyzedAt: now.toISOString(),
    itemsWithData: analyses.length,
    itemsUpdated,
    results,
    summary,
  };
}

/** Increment exposure counters for items that were just served (called by the engine). */
export async function recordExposure(questionIds: number[]) {
  if (!questionIds.length) return;
  await db
    .update(questions)
    .set({ exposureCount: sql`${questions.exposureCount} + 1` })
    .where(inArray(questions.id, questionIds));
}

/** Convenience: nearest difficulty band for a numeric value (re-exported for callers). */
export { difficultyLabelForValue };
