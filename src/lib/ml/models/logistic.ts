/**
 * Logistic response model — conforms to ResponseModel.
 *
 * Adapts the existing trained logistic-regression classifier (classifier.ts) to
 * the ResponseModel contract by projecting the rich LearnerState onto the
 * classifier's feature vector. This is the default P(correct) predictor used by
 * the item selector, so we keep using the model that is trained on live data.
 */
import type { ClassifierModel } from "@/lib/ml/classifier";
import { HEURISTIC_MODEL, predictProbability } from "@/lib/ml/classifier";
import type { ResponseContext, ResponseModel } from "@/lib/ml/interfaces";

export class LogisticResponseModel implements ResponseModel {
  readonly id: string;
  constructor(private readonly model: ClassifierModel = HEURISTIC_MODEL) {
    this.id = `logistic:${model.version}`;
  }

  predict(ctx: ResponseContext): number {
    const { learner, skill, item } = ctx;
    const responseTimeMs =
      ctx.responseTimeMs ?? item.expectedTimeMs ?? (skill.avgDifficulty * 60_000 || 30_000);
    return predictProbability(this.model, {
      ability: learner.ability,
      masteryBefore: skill.mastery,
      difficultyBase: item.difficulty,
      bloom: item.bloom,
      responseTimeMs,
      skillAccuracy: skill.accuracy,
      evidence: skill.confidence,
    });
  }
}

/** A ResponseModel backed by a KnowledgeTracingModel's predictCorrect. */
export function responseModelFromKnowledge(
  km: import("@/lib/ml/interfaces").KnowledgeTracingModel,
): ResponseModel {
  return {
    id: `km:${km.id}`,
    predict(ctx: ResponseContext) {
      const belief = {
        mastery: ctx.skill.mastery,
        uncertainty: ctx.skill.uncertainty,
        confidence: ctx.skill.confidence,
        stats: { n: ctx.skill.attempts },
      };
      return km.predictCorrect(belief, ctx.item);
    },
  };
}
