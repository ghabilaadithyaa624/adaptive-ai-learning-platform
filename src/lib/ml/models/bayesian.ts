/**
 * Beta-Bernoulli Bayesian learner model — conforms to KnowledgeTracingModel.
 *
 * Mastery is the mean of a Beta(alpha, beta) posterior over the skill success
 * probability. This gives a principled, closed-form *uncertainty* (posterior
 * variance / SD) — the signal the item selector uses for active-learning style
 * "reduce uncertainty" exploration. Difficulty weights the evidence: getting a
 * hard item right is stronger evidence than getting an easy item right.
 *
 * Fully deterministic (no sampling — we use posterior mean, not Thompson draws).
 */
import { clamp } from "@/lib/utils";
import type {
  ItemDescriptor,
  KnowledgeTracingModel,
  SkillBelief,
  TraceObservation,
} from "@/lib/ml/interfaces";

export interface BayesianParams {
  priorAlpha: number;
  priorBeta: number;
  /** How strongly item difficulty weights a single observation. */
  difficultyWeight: number;
  /** Forgetting: counts decay toward the prior over time (evidence ages out). */
  forgetPerDay: number;
  /** Learning-transition bump applied on a correct response (skill acquisition). */
  learn: number;
}

export const DEFAULT_BAYESIAN: BayesianParams = {
  priorAlpha: 1.2,
  priorBeta: 2.2,
  difficultyWeight: 0.9,
  forgetPerDay: 0.02,
  learn: 0.05,
};

function mean(alpha: number, beta: number) {
  return alpha / (alpha + beta);
}

/** Normalised posterior SD → 0..1 uncertainty (max Beta SD is 0.5). */
function sd(alpha: number, beta: number) {
  const n = alpha + beta;
  const variance = (alpha * beta) / (n * n * (n + 1));
  return Math.sqrt(variance);
}

export class BayesianModel implements KnowledgeTracingModel<BayesianParams> {
  readonly id = "beta-bernoulli-v1";
  readonly kind = "bayesian" as const;

  private resolve(params?: Partial<BayesianParams>): BayesianParams {
    return { ...DEFAULT_BAYESIAN, ...(params ?? {}) };
  }

  private belief(alpha: number, beta: number): SkillBelief {
    const m = mean(alpha, beta);
    const uncertainty = clamp(sd(alpha, beta) / 0.5, 0.02, 1);
    return { mastery: clamp(m, 0.01, 0.995), uncertainty, confidence: 1 - uncertainty, stats: { alpha, beta } };
  }

  prior(params?: Partial<BayesianParams>): SkillBelief {
    const p = this.resolve(params);
    return this.belief(p.priorAlpha, p.priorBeta);
  }

  observe(belief: SkillBelief, obs: TraceObservation, params?: Partial<BayesianParams>): SkillBelief {
    const p = this.resolve(params);
    let alpha = belief.stats?.alpha ?? p.priorAlpha;
    let beta = belief.stats?.beta ?? p.priorBeta;
    // A correct answer on a hard item is worth more; a wrong answer on an easy
    // item is worth more. Difficulty defaults to 0.5 (neutral weight).
    const difficulty = clamp(obs.difficulty ?? 0.5, 0, 1);
    if (obs.isCorrect) {
      alpha += 1 + p.difficultyWeight * difficulty;
      // small learning transition — evidence of acquisition shifts the prior up
      alpha += p.learn;
    } else {
      beta += 1 + p.difficultyWeight * (1 - difficulty);
    }
    return this.belief(alpha, beta);
  }

  decay(belief: SkillBelief, elapsedDays: number, params?: Partial<BayesianParams>): SkillBelief {
    const p = this.resolve(params);
    const days = Math.max(0, elapsedDays);
    const alpha0 = p.priorAlpha;
    const beta0 = p.priorBeta;
    let alpha = belief.stats?.alpha ?? alpha0;
    let beta = belief.stats?.beta ?? beta0;
    // Evidence beyond the prior ages out exponentially: counts shrink toward the
    // prior, widening uncertainty and pulling mastery back toward the prior mean.
    const factor = Math.exp(-p.forgetPerDay * days);
    alpha = alpha0 + (alpha - alpha0) * factor;
    beta = beta0 + (beta - beta0) * factor;
    return this.belief(alpha, beta);
  }

  predictCorrect(belief: SkillBelief, item: ItemDescriptor, params?: Partial<BayesianParams>): number {
    void params;
    // Posterior predictive of success, shifted by item difficulty & bloom load.
    const m = belief.mastery;
    const difficultyGap = clamp(m - item.difficulty, -1, 1);
    const bloomLoad = ((item.bloom ?? 3) - 3) / 6;
    return clamp(0.5 + 0.5 * difficultyGap + 0.15 * (m - 0.5) - 0.12 * bloomLoad, 0.02, 0.98);
  }
}

export const bayesianModel = new BayesianModel();
