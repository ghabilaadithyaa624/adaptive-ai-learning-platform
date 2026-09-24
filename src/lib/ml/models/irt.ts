/**
 * Item Response Theory model (2PL) — conforms to KnowledgeTracingModel.
 *
 * Tracks a latent ability `theta` (logit scale) per skill. Each response nudges
 * theta by one online gradient (Newton) step; P(correct) is the 2PL curve
 *   p = 1 / (1 + exp(-a (theta - b)))
 * where b (difficulty) is mapped from the 0..1 item difficulty and a is the
 * discrimination. Uncertainty comes from the inverse Fisher information, which
 * is exactly how CAT standard errors are computed. Fully deterministic.
 */
import { clamp } from "@/lib/utils";
import type {
  ItemDescriptor,
  KnowledgeTracingModel,
  SkillBelief,
  TraceObservation,
} from "@/lib/ml/interfaces";

export interface IrtParams {
  /** Prior ability on the logit scale. */
  priorTheta: number;
  /** Default discrimination when an item doesn't specify one. */
  discrimination: number;
  /** Online learning rate for the theta update. */
  learnRate: number;
  /** Forgetting: theta drifts toward the prior over time. */
  forgetPerDay: number;
  /** Logit range that maps to mastery 0..1. */
  scale: number;
}

export const DEFAULT_IRT: IrtParams = {
  priorTheta: -0.4,
  discrimination: 1.1,
  learnRate: 0.6,
  forgetPerDay: 0.01,
  scale: 2.2,
};

const sigmoid = (z: number) => 1 / (1 + Math.exp(-clamp(z, -30, 30)));

/** Map item difficulty 0..1 → IRT b parameter on the logit scale. */
function difficultyToB(difficulty: number, scale: number) {
  return (clamp(difficulty, 0, 1) - 0.5) * 2 * scale;
}

/** Map theta (logit) → mastery probability 0..1. */
function thetaToMastery(theta: number, scale: number) {
  return clamp(sigmoid(theta / (scale / 2.2)), 0.01, 0.995);
}

export class IrtModel implements KnowledgeTracingModel<IrtParams> {
  readonly id = "irt-2pl-v1";
  readonly kind = "irt" as const;

  private resolve(params?: Partial<IrtParams>): IrtParams {
    return { ...DEFAULT_IRT, ...(params ?? {}) };
  }

  prior(params?: Partial<IrtParams>): SkillBelief {
    const p = this.resolve(params);
    return {
      mastery: thetaToMastery(p.priorTheta, p.scale),
      uncertainty: 1,
      confidence: 0,
      stats: { theta: p.priorTheta, information: 0, n: 0 },
    };
  }

  observe(belief: SkillBelief, obs: TraceObservation, params?: Partial<IrtParams>): SkillBelief {
    const p = this.resolve(params);
    const theta = belief.stats?.theta ?? p.priorTheta;
    const a = obs.difficulty !== undefined ? p.discrimination : p.discrimination;
    const b = difficultyToB(obs.difficulty ?? 0.5, p.scale);
    const pCorrect = sigmoid(a * (theta - b));
    const y = obs.isCorrect ? 1 : 0;
    // Newton/gradient step on the log-likelihood of a 2PL response.
    const gradient = a * (y - pCorrect);
    const nextTheta = clamp(theta + p.learnRate * gradient, -6, 6);
    // Accumulate Fisher information: I = a^2 * p * (1-p).
    const information = (belief.stats?.information ?? 0) + a * a * pCorrect * (1 - pCorrect);
    const n = (belief.stats?.n ?? 0) + 1;
    const se = information > 0 ? 1 / Math.sqrt(information) : 1;
    const uncertainty = clamp(se, 0.05, 1);
    return {
      mastery: thetaToMastery(nextTheta, p.scale),
      uncertainty,
      confidence: 1 - uncertainty,
      stats: { theta: nextTheta, information, n },
    };
  }

  decay(belief: SkillBelief, elapsedDays: number, params?: Partial<IrtParams>): SkillBelief {
    const p = this.resolve(params);
    const days = Math.max(0, elapsedDays);
    const theta = belief.stats?.theta ?? p.priorTheta;
    // Exponential drift of ability back toward the prior.
    const factor = Math.exp(-p.forgetPerDay * days);
    const nextTheta = p.priorTheta + (theta - p.priorTheta) * factor;
    return {
      ...belief,
      mastery: thetaToMastery(nextTheta, p.scale),
      stats: { ...(belief.stats ?? {}), theta: nextTheta },
    };
  }

  predictCorrect(belief: SkillBelief, item: ItemDescriptor, params?: Partial<IrtParams>): number {
    const p = this.resolve(params);
    const theta = belief.stats?.theta ?? p.priorTheta;
    const a = item.discrimination ?? p.discrimination;
    const b = difficultyToB(item.difficulty, p.scale);
    const bloomLoad = ((item.bloom ?? 3) - 3) / 6;
    return clamp(sigmoid(a * (theta - b) - 0.5 * bloomLoad), 0.02, 0.98);
  }
}

export const irtModel = new IrtModel();
