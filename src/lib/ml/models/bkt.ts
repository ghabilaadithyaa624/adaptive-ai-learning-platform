/**
 * Bayesian Knowledge Tracing model — conforms to KnowledgeTracingModel.
 *
 * Wraps the existing, battle-tested primitives in `knowledge-tracing.ts`
 * (posterior / predictCorrect / applyDecay) so behaviour is unchanged, and adds
 * an evidence-based uncertainty estimate that BKT proper does not track.
 */
import { clamp } from "@/lib/utils";
import {
  DEFAULT_BKT,
  applyDecay,
  posterior,
  predictCorrect,
} from "@/lib/ml/knowledge-tracing";
import type {
  ItemDescriptor,
  KnowledgeTracingModel,
  SkillBelief,
  TraceObservation,
} from "@/lib/ml/interfaces";

export interface BktParamsExt {
  slip: number;
  guess: number;
  learn: number;
  forget: number;
  priorMastery: number;
}

export const DEFAULT_BKT_EXT: BktParamsExt = { ...DEFAULT_BKT, priorMastery: 0.3 };

/** Uncertainty shrinks with observed evidence: 1/(1+n) style decay. */
function uncertaintyFromCount(n: number) {
  return clamp(1 / (1 + 0.45 * n), 0.05, 1);
}

function count(belief: SkillBelief) {
  return belief.stats?.n ?? 0;
}

export class BktModel implements KnowledgeTracingModel<BktParamsExt> {
  readonly id = "bkt-v3";
  readonly kind = "bkt" as const;

  private resolve(params?: Partial<BktParamsExt>): BktParamsExt {
    return { ...DEFAULT_BKT_EXT, ...(params ?? {}) };
  }

  prior(params?: Partial<BktParamsExt>): SkillBelief {
    const p = this.resolve(params);
    return {
      mastery: clamp(p.priorMastery, 0.01, 0.995),
      uncertainty: 1,
      confidence: 0,
      stats: { n: 0 },
    };
  }

  observe(belief: SkillBelief, obs: TraceObservation, params?: Partial<BktParamsExt>): SkillBelief {
    const p = this.resolve(params);
    const next = posterior(belief.mastery, obs.isCorrect, p);
    const n = count(belief) + 1;
    const uncertainty = uncertaintyFromCount(n);
    return {
      mastery: next,
      uncertainty,
      confidence: 1 - uncertainty,
      stats: { n },
    };
  }

  decay(belief: SkillBelief, elapsedDays: number, params?: Partial<BktParamsExt>): SkillBelief {
    const p = this.resolve(params);
    const days = Math.max(0, elapsedDays);
    const decayed = applyDecay(belief.mastery, days > 0 ? new Date(Date.now() - days * 86_400_000) : null, p.forget);
    return { ...belief, mastery: decayed };
  }

  predictCorrect(belief: SkillBelief, item: ItemDescriptor, params?: Partial<BktParamsExt>): number {
    const p = this.resolve(params);
    // Base BKT prediction, then nudge by how far item difficulty sits from the
    // learner's mastery so difficulty & bloom actually move the estimate.
    const base = predictCorrect(belief.mastery, p);
    const difficultyGap = clamp(belief.mastery - item.difficulty, -1, 1);
    const bloomLoad = ((item.bloom ?? 3) - 3) / 6; // higher bloom → slightly harder
    const adjusted = base + 0.25 * difficultyGap - 0.12 * bloomLoad;
    return clamp(adjusted, 0.02, 0.98);
  }
}

export const bktModel = new BktModel();
