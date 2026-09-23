import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { assessmentItems, questions, skills } from "@/db/schema";
import { fail, ok, toNumber, withUser } from "@/lib/api";
import { loadSkillFeatures } from "@/lib/engine";
import { labelPrediction, predictProbability } from "@/lib/ml/classifier";
import { loadClassifier, trainAndPersistClassifier } from "@/lib/ml/registry";
import { getModelRegistry } from "@/lib/queries";
import { round } from "@/lib/utils";

export const dynamic = "force-dynamic";

const DIFFICULTY_VALUE: Record<string, number> = { easy: 0.3, medium: 0.55, hard: 0.75, expert: 0.9 };
const BLOOM_VALUE: Record<string, number> = { remember: 1, understand: 2, apply: 3, analyze: 4, evaluate: 5, create: 6 };

export async function GET() {
  return withUser(async () => {
    const [models, sampleRows] = await Promise.all([
      getModelRegistry(),
      db.select({ total: sql<number>`count(*)::int` }).from(assessmentItems),
    ]);
    return ok({ models, trainingSamples: Number(sampleRows[0]?.total ?? 0) });
  });
}

export async function POST(request: Request) {
  return withUser(async (user) => {
    if (user.role === "student") return fail("Learners cannot retrain models.", 403);
    const body = (await request.json()) as Record<string, unknown>;
    const action = String(body.action ?? "train");

    if (action === "train") {
      const model = await trainAndPersistClassifier();
      const models = await getModelRegistry();
      return ok({
        model: {
          version: model.version,
          samples: model.samples,
          metrics: model.metrics,
        },
        models,
      });
    }

    if (action === "predict") {
      const studentId = toNumber(body.studentId, 0);
      let questionId = toNumber(body.questionId, 0);
      if (!studentId) return fail("A learner is required for prediction.");

      let questionRow = null as null | typeof questions.$inferSelect;
      let skillName = "";
      if (questionId) {
        const rows = await db
          .select({ question: questions, skillName: skills.name })
          .from(questions)
          .innerJoin(skills, eq(skills.id, questions.skillId))
          .where(eq(questions.id, questionId))
          .limit(1);
        questionRow = rows[0]?.question ?? null;
        skillName = rows[0]?.skillName ?? "";
      } else {
        const rows = await db
          .select({ question: questions, skillName: skills.name })
          .from(questions)
          .innerJoin(skills, eq(skills.id, questions.skillId))
          .limit(1);
        questionRow = rows[0]?.question ?? null;
        skillName = rows[0]?.skillName ?? "";
        questionId = questionRow?.id ?? 0;
      }
      if (!questionRow) return fail("Question not found", 404);

      const skill = await loadSkillFeatures(studentId, questionRow.skillId);
      const model = await loadClassifier();
      const difficulty = DIFFICULTY_VALUE[questionRow.difficultyLabel] ?? 0.55;
      const bloom = BLOOM_VALUE[questionRow.bloomLevel] ?? 3;

      const scenarios = [
        { name: "as authored", difficultyBase: difficulty, bloom },
        { name: "one band easier", difficultyBase: Math.max(0.15, difficulty - 0.2), bloom: Math.max(1, bloom - 1) },
        { name: "one band harder", difficultyBase: Math.min(0.95, difficulty + 0.2), bloom: Math.min(6, bloom + 1) },
      ];

      const predictions = scenarios.map((scenario) => {
        const probability = predictProbability(model, {
          ability: skill.ability,
          masteryBefore: skill.mastery,
          difficultyBase: scenario.difficultyBase,
          bloom: scenario.bloom,
          responseTimeMs: questionRow.estimatedSeconds * 1000,
          skillAccuracy: skill.skillAccuracy,
          evidence: skill.evidence,
        });
        return {
          name: scenario.name,
          probability: round(probability, 3),
          label: labelPrediction(probability),
        };
      });

      return ok({
        questionId,
        skillName,
        mastery: round(skill.mastery, 3),
        ability: round(skill.ability, 3),
        evidence: round(skill.evidence, 2),
        modelVersion: model.version,
        metrics: model.metrics,
        predictions,
        recommendation: predictions[0].label.hint,
      });
    }

    if (action === "evaluate") {
      const rows = await db
        .select({ isCorrect: assessmentItems.isCorrect, predicted: assessmentItems.predictedCorrectProb })
        .from(assessmentItems)
        .where(and(eq(assessmentItems.isCorrect, true)));
      const all = await db
        .select({ isCorrect: assessmentItems.isCorrect, predicted: assessmentItems.predictedCorrectProb })
        .from(assessmentItems);
      const evaluated = all.filter((row) => row.isCorrect !== null);
      const correct = evaluated.filter((row) => row.isCorrect);
      const accuracy = evaluated.length ? correct.length / evaluated.length : 0;
      const meanPredicted = evaluated.length
        ? evaluated.reduce((acc, row) => acc + row.predicted, 0) / evaluated.length
        : 0;
      return ok({
        samples: evaluated.length,
        observedAccuracy: round(accuracy, 3),
        meanPredicted,
        calibrationGap: round(meanPredicted - accuracy, 3),
        truePositives: correct.length,
      });
    }

    return fail("Unsupported action.");
  });
}
