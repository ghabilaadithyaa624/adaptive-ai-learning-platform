import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { assessmentItems, questions, skills } from "@/db/schema";
import { ok, toNumber, withAuth } from "@/lib/api";
import { loadSkillFeatures } from "@/lib/engine";
import { labelPrediction, predictProbability } from "@/lib/ml/classifier";
import { evaluateClassification } from "@/lib/ml/evaluation";
import { CLASSIFIER_NAME, loadClassifier, trainAndPersistClassifier } from "@/lib/ml/registry";
import { getModelServingStatus } from "@/lib/ml/model-fallback";
import { getModelEvaluations, getModelRegistry } from "@/lib/queries";
import { round } from "@/lib/utils";
import { badRequest } from "@/lib/http";
import { oneOf, readJsonBody } from "@/lib/validation";
import { assertStudentAccess, requireCapability } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";
import { events, now } from "@/lib/observability";
import { BLOOM_TO_VALUE, DIFFICULTY_TO_VALUE } from "@/lib/questions/constants";

export const dynamic = "force-dynamic";

const DIFFICULTY_VALUE: Record<string, number> = DIFFICULTY_TO_VALUE;
const BLOOM_VALUE: Record<string, number> = BLOOM_TO_VALUE;

export async function GET(request: Request) {
  return withAuth(request, async ({ user }) => {
    requireCapability(user, "viewModels", "You do not have permission to view the model registry.", "ml.view");
    const [models, sampleRows] = await Promise.all([
      getModelRegistry(),
      db.select({ total: sql<number>`count(*)::int` }).from(assessmentItems),
    ]);
    // Touch the load path so the reported serving state reflects a real load
    // rather than whatever this process happened to do earlier (or nothing at
    // all, on a replica that has served no predictions yet).
    const active = await loadClassifier();
    return ok({
      models,
      trainingSamples: Number(sampleRows[0]?.total ?? 0),
      // Operator answer to "is production on a fallback model right now?".
      // Purely operational fields — no learner data.
      serving: getModelServingStatus(CLASSIFIER_NAME) ?? {
        model: CLASSIFIER_NAME,
        source: "registry" as const,
        servingVersion: active.version,
        attemptedVersion: null,
        category: null,
        since: null,
        consecutiveFailures: 0,
        suppressedWarnings: 0,
        lastEventAt: new Date().toISOString(),
      },
    });
  });
}

export async function POST(request: Request) {
  return withAuth(request, async ({ user, ip }) => {
    requireCapability(user, "trainModels", "Learners cannot operate the model registry.", "ml.operate");
    const body = await readJsonBody(request);
    const action = oneOf(body.action, ["train", "predict", "evaluate"] as const, "action", "train");

    if (action === "train") {
      const trainStart = now();
      let trained;
      try {
        trained = await trainAndPersistClassifier();
      } catch (error) {
        events.modelError("difficulty-classifier", "train", error);
        throw error;
      }
      const { model, promotion, datasetVersion, featureVersion, heldOutSamples } = trained;
      events.modelTrained({
        model: "difficulty-classifier",
        version: model.version,
        samples: model.samples,
        verdict: promotion.verdict,
        promote: promotion.promote,
        durationMs: Math.round(now() - trainStart),
      });
      const [models, evaluations] = await Promise.all([getModelRegistry(), getModelEvaluations("difficulty-classifier", 10)]);
      await recordAudit({
        actor: user,
        action: "ml.train",
        resource: "ml_models",
        detail: `${model.version} · verdict=${promotion.verdict}`,
        ip,
      });
      return ok({
        model: {
          version: model.version,
          samples: model.samples,
          metrics: model.metrics,
          datasetVersion,
          featureVersion,
          heldOutSamples,
        },
        // Evidence-gated verdict — never claims "better" without a held-out win.
        comparison: {
          verdict: promotion.verdict,
          promote: promotion.promote,
          reasons: promotion.reasons,
          improvements: promotion.comparison.improvements,
          regressions: promotion.comparison.regressions,
          regressionAlerts: promotion.regressionAlerts.map((m) => ({ metric: m.metric, delta: m.delta })),
          metrics: promotion.comparison.metrics,
        },
        models,
        evaluations,
      });
    }

    if (action === "predict") {
      const studentId = toNumber(body.studentId, 0);
      let questionId = toNumber(body.questionId, 0);
      if (!studentId) throw badRequest("A learner is required for prediction.");
      // Authorization: only predict for a learner in the caller's scope.
      await assertStudentAccess(user, studentId, "ml.predict");

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
      if (!questionRow) throw badRequest("Question not found.");

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
        return { name: scenario.name, probability: round(probability, 3), label: labelPrediction(probability) };
      });

      events.modelPrediction({
        model: "difficulty-classifier",
        surface: "api",
        count: predictions.length,
        studentId,
        questionId,
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

    // evaluate — comprehensive report on the classifier's live serving predictions.
    const all = await db
      .select({
        isCorrect: assessmentItems.isCorrect,
        predicted: assessmentItems.predictedCorrectProb,
        createdAt: assessmentItems.createdAt,
      })
      .from(assessmentItems)
      .orderBy(assessmentItems.createdAt);
    const evaluated = all.filter((row) => row.isCorrect !== null);
    const labels = evaluated.map((row) => (row.isCorrect ? 1 : 0));
    const scores = evaluated.map((row) => row.predicted);

    if (!evaluated.length) {
      return ok({ samples: 0, message: "No labelled responses to evaluate yet." });
    }

    const report = evaluateClassification(labels, scores);
    // Temporal-holdout view: evaluate the most-recent 20% of served predictions,
    // so operators see how the deployed model performs on the newest data.
    const holdoutStart = Math.floor(evaluated.length * 0.8);
    const recent = evaluated.slice(holdoutStart);
    const recentReport = recent.length
      ? evaluateClassification(recent.map((r) => (r.isCorrect ? 1 : 0)), recent.map((r) => r.predicted))
      : null;

    const evaluations = await getModelEvaluations("difficulty-classifier", 10);

    return ok({
      samples: evaluated.length,
      // full metric coverage
      metrics: {
        accuracy: round(report.accuracy, 4),
        precision: round(report.precision, 4),
        recall: round(report.recall, 4),
        f1: round(report.f1, 4),
        specificity: round(report.specificity, 4),
        rocAuc: report.rocAuc === null ? null : round(report.rocAuc, 4),
        rocAucApplicable: report.rocAucApplicable,
        prAuc: report.prAuc === null ? null : round(report.prAuc, 4),
        prAucApplicable: report.prAucApplicable,
        logLoss: round(report.logLoss, 4),
        brier: round(report.brier, 4),
        calibrationError: round(report.calibrationError, 4),
        maxCalibrationError: round(report.maxCalibrationError, 4),
        baseRate: round(report.baseRate, 4),
      },
      confusion: report.confusion,
      reliability: report.reliability.filter((bin) => bin.count > 0),
      recentHoldout: recentReport
        ? {
            samples: recentReport.samples,
            accuracy: round(recentReport.accuracy, 4),
            rocAuc: recentReport.rocAuc === null ? null : round(recentReport.rocAuc, 4),
            logLoss: round(recentReport.logLoss, 4),
            calibrationError: round(recentReport.calibrationError, 4),
          }
        : null,
      history: evaluations,
    });
  });
}
