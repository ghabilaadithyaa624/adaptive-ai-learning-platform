/**
 * Uniform adapters for the three policies under test.
 *
 * Each adapter receives exactly the same view of the world (the same tracer
 * state, the same candidate pool, the same response model) and returns the item
 * it would serve plus the probability it would log. Differences in the benchmark
 * are therefore attributable to the *selection policy* alone.
 *
 *   legacy — `ml/adaptive.ts` (skill priority + ZPD distance + info), the
 *            pre-v2 selector, including its `masteryBefore = 0.5` shortcut.
 *   v2     — `ml/selection.ts` AdaptiveSelector (weighted 10-criteria blend).
 *   v3     — `ml/policy/v3.ts` MultiObjectivePolicy (gates + multi-objective).
 */
import { mean } from "@/lib/utils";
import { HEURISTIC_MODEL } from "@/lib/ml/classifier";
import { scoreCandidates, skillPriority, type AdaptiveCandidate } from "@/lib/ml/adaptive";
import { selectNextItemV2 } from "@/lib/ml/selection";
import { MultiObjectivePolicy } from "@/lib/ml/policy/v3";
import type { PolicyConfigOverrides } from "@/lib/ml/policy/types";
import type {
  CandidateItem,
  DecisionExplanation,
  KnowledgeTracingModel,
  LearnerState,
  ResponseModel,
} from "@/lib/ml/interfaces";
import { SKILL_BY_ID, hashUniform } from "./world";

export type PolicyId =
  | "oracle"
  | "random"
  | "difficulty-only"
  | "mastery-gap-only"
  | "legacy"
  | "v2"
  | "v3"
  | "v3-no-response"
  | "v3-true-mastery"
  | "v3-no-information"
  | "v3-no-prerequisite-weight"
  | "v3-no-diversity"
  | "v3-mastery-gap-skill"
  | "v3-calibrated-response"
  | "v3-oracle-response"
  | "irt-assisted";

export interface EstimatedSkill {
  skillId: number;
  mastery: number;
  attempts: number;
  correct: number;
  streak: number;
  lastPracticedAt: Date | null;
  daysSincePractice: number;
}

export interface PolicyContext {
  /** Cell seed — baselines that need randomness derive it from here, never `Math.random`. */
  seed: number;
  /** 0-based index of the item being selected, for seeded draws. */
  step: number;
  /**
   * A read-only window onto ground truth. **Only the oracle ceiling policy may
   * read this.** No shippable policy can, because in production there is no
   * such thing — it exists so the report can state how much of the achievable
   * learning any real policy actually captures.
   */
  truth: {
    /** True P(correct) for a candidate right now, fatigue included. */
    trueProbFor(questionId: number): number;
    /** True latent ability per skill right now. */
    abilityBySkill: ReadonlyMap<number, number>;
  };
  /** Composite learner state (shared tracer) — used by v2 and v3. */
  learner: LearnerState;
  /** Raw tracer state — used by the legacy selector. */
  estimates: EstimatedSkill[];
  candidates: CandidateItem[];
  seen: Set<number>;
  askedSkill: Map<number, number>;
  askedBloom: Map<number, number>;
  recentSkillIds: number[];
  responseModel: ResponseModel;
  knowledgeModel: KnowledgeTracingModel;
  masteryTarget: number;
}

export interface PolicyChoice {
  questionId: number;
  predictedCorrect: number;
  decision: DecisionExplanation | null;
}

export interface BenchPolicy {
  id: PolicyId;
  label: string;
  select(ctx: PolicyContext): PolicyChoice | null;
}

export const legacyPolicy: BenchPolicy = {
  id: "legacy",
  label: "Legacy selector",
  select(ctx) {
    const ability = mean(ctx.estimates.map((e) => e.mastery));
    const skillPriorities = new Map<number, number>();
    for (const e of ctx.estimates) {
      skillPriorities.set(
        e.skillId,
        skillPriority({
          skillId: e.skillId,
          mastery: e.mastery,
          attempts: e.attempts,
          // The legacy selector had no prerequisite model at all.
          prereqReadiness: 1,
          pathAlignment: 0.3,
          daysSincePractice: e.daysSincePractice,
        }),
      );
    }
    const candidates: AdaptiveCandidate[] = ctx.candidates.map((c) => ({
      questionId: c.questionId,
      skillId: c.skillId,
      skillName: c.skillName,
      difficultyBase: c.item.difficulty,
      bloom: c.item.bloom,
      estimatedSeconds: c.estimatedSeconds,
      text: c.text,
    }));
    const scored = scoreCandidates({
      candidates,
      skillPriorities,
      askedCounts: ctx.askedSkill,
      model: HEURISTIC_MODEL,
      ability,
      // The documented legacy defect: a fixed masteryBefore instead of the
      // learner's real per-skill mastery.
      baseSample: { ability, masteryBefore: 0.5, skillAccuracy: 0.5, evidence: 0.4, responseTimeMs: 30_000 },
      seen: ctx.seen,
    });
    const top = scored[0];
    if (!top) return null;
    return { questionId: top.candidate.questionId, predictedCorrect: top.probability, decision: null };
  },
};

export const v2Policy: BenchPolicy = {
  id: "v2",
  label: "Adaptive v2",
  select(ctx) {
    const { chosen } = selectNextItemV2({
      learner: ctx.learner,
      candidates: ctx.candidates,
      seenQuestionIds: ctx.seen,
      askedSkillCounts: ctx.askedSkill,
      askedBloomCounts: ctx.askedBloom,
      responseModel: ctx.responseModel,
      knowledgeModel: ctx.knowledgeModel,
      target: ctx.masteryTarget,
    });
    if (!chosen) return null;
    return {
      questionId: chosen.candidate.questionId,
      predictedCorrect: chosen.predictedCorrect,
      decision: chosen.decision,
    };
  },
};

/** v3 with a specific configuration (used by the tuner and the ablations). */
export function makeV3Policy(overrides: PolicyConfigOverrides = {}, label = "Optimized v3"): BenchPolicy {
  const policy = new MultiObjectivePolicy(overrides);
  return {
    id: "v3",
    label,
    select(ctx) {
      const { chosen } = policy.select({
        learner: ctx.learner,
        candidates: ctx.candidates,
        seenQuestionIds: ctx.seen,
        askedSkillCounts: ctx.askedSkill,
        askedBloomCounts: ctx.askedBloom,
        recentSkillIds: ctx.recentSkillIds,
        responseModel: ctx.responseModel,
        knowledgeModel: ctx.knowledgeModel,
        target: ctx.masteryTarget,
      });
      if (!chosen) return null;
      return {
        questionId: chosen.candidate.questionId,
        predictedCorrect: chosen.predictedCorrect,
        decision: chosen.decision,
      };
    },
  };
}

export const v3Policy = makeV3Policy();

/** Candidate pool built once per world (items never change during a session). */
export function buildCandidatePool(items: { id: number; skillId: number; difficulty: number; bloom: number; discrimination: number; estimatedSeconds: number }[]): CandidateItem[] {
  return items.map((item) => ({
    questionId: item.id,
    skillId: item.skillId,
    skillName: SKILL_BY_ID.get(item.skillId)?.name ?? `Skill ${item.skillId}`,
    subjectName: "Mathematics",
    item: {
      difficulty: item.difficulty,
      bloom: item.bloom,
      discrimination: item.discrimination,
      expectedTimeMs: item.estimatedSeconds * 1000,
    },
    estimatedSeconds: item.estimatedSeconds,
    text: `Item ${item.id}`,
  }));
}


/* ------------------------------------------------------------------ */
/* Baselines                                                           */
/* ------------------------------------------------------------------ */

/**
 * The baselines exist to answer a question the three real policies cannot
 * answer about themselves: how much of the measured benefit comes from being
 * *adaptive* at all, versus from merely serving unseen questions in a sensible
 * order? A policy that cannot beat `random` by a wide margin is not earning its
 * complexity.
 *
 * All three share the no-repeat constraint and the same response model, so they
 * differ from the real policies only in how they rank what is left.
 */

/** Predicted P(correct) from the shared response model, for fair Brier/ECE. */
function predictFor(ctx: PolicyContext, candidate: CandidateItem): number {
  const skill = ctx.learner.skills.get(candidate.skillId);
  if (!skill) return 0.5;
  return ctx.responseModel.predict({ learner: ctx.learner, skill, item: candidate.item });
}

function unseen(ctx: PolicyContext): CandidateItem[] {
  return ctx.candidates.filter((c) => !ctx.seen.has(c.questionId));
}

/** Uniformly random over unseen items. Seeded, so it is reproducible. */
export const randomPolicy: BenchPolicy = {
  id: "random",
  label: "Random selection",
  select(ctx) {
    const pool = unseen(ctx);
    if (!pool.length) return null;
    // Sort by id first so the pool order cannot depend on upstream iteration
    // order, then index with a seeded draw.
    const ordered = [...pool].sort((a, b) => a.questionId - b.questionId);
    const draw = hashUniform(ctx.seed, ctx.step, 9176);
    const chosen = ordered[Math.min(ordered.length - 1, Math.floor(draw * ordered.length))];
    return { questionId: chosen.questionId, predictedCorrect: predictFor(ctx, chosen), decision: null };
  },
};

/**
 * Difficulty matching only: pick the item whose difficulty is closest to the
 * learner's overall estimated ability. No skill choice, no prerequisites, no
 * coverage — the classic "keep it at the right level" heuristic in isolation.
 */
export const difficultyOnlyPolicy: BenchPolicy = {
  id: "difficulty-only",
  label: "Difficulty-only",
  select(ctx) {
    const pool = unseen(ctx);
    if (!pool.length) return null;
    const ability = mean(ctx.estimates.map((e) => e.mastery));
    let best: CandidateItem | null = null;
    let bestDistance = Infinity;
    for (const candidate of [...pool].sort((a, b) => a.questionId - b.questionId)) {
      const distance = Math.abs(candidate.item.difficulty - ability);
      if (distance < bestDistance - 1e-9) {
        bestDistance = distance;
        best = candidate;
      }
    }
    if (!best) return null;
    return { questionId: best.questionId, predictedCorrect: predictFor(ctx, best), decision: null };
  },
};

/**
 * Mastery-gap chasing only: always work on the least-mastered skill, taking its
 * lowest-numbered unseen item. No difficulty targeting, no prerequisites — the
 * "always fix the weakest thing" heuristic in isolation. It is the natural
 * strawman for a mastery-learning product and it is genuinely competitive on
 * coverage, which is exactly why it is worth measuring.
 */
export const masteryGapOnlyPolicy: BenchPolicy = {
  id: "mastery-gap-only",
  label: "Mastery-gap-only",
  select(ctx) {
    const pool = unseen(ctx);
    if (!pool.length) return null;
    const masteryBySkill = new Map(ctx.estimates.map((e) => [e.skillId, e.mastery]));
    let best: CandidateItem | null = null;
    let bestGap = -Infinity;
    for (const candidate of [...pool].sort((a, b) => a.questionId - b.questionId)) {
      const gap = ctx.masteryTarget - (masteryBySkill.get(candidate.skillId) ?? 0);
      if (gap > bestGap + 1e-9) {
        bestGap = gap;
        best = candidate;
      }
    }
    if (!best) return null;
    return { questionId: best.questionId, predictedCorrect: predictFor(ctx, best), decision: null };
  },
};

/** Every policy the benchmark compares, in report order (weakest first). */
export const BASELINE_POLICIES: BenchPolicy[] = [randomPolicy, difficultyOnlyPolicy, masteryGapOnlyPolicy];


/**
 * IDEAL-OBSERVER CEILING — not a shippable policy.
 *
 * Sees ground truth and serves the unseen item whose *true* success probability
 * is closest to `target`. It is the answer to "how much learning was even
 * available in this world?", which turns every other policy's score from an
 * uninterpretable number into a fraction of the achievable maximum.
 *
 * The default target of 0.75 is not arbitrary: a sweep of this policy over
 * targets 0.35..0.99 peaks there (see SIMULATION.md §"World validation"), which
 * is also the independent justification for the ZPD band the real policies aim
 * at. Any policy scoring near this ceiling is limited by the world, not itself.
 */
export function makeOraclePolicy(target = 0.75): BenchPolicy {
  return {
    id: "oracle",
    label: `Oracle ceiling (true p→${target})`,
    select(ctx) {
      let best: CandidateItem | null = null;
      let bestDistance = Infinity;
      for (const candidate of ctx.candidates) {
        if (ctx.seen.has(candidate.questionId)) continue;
        const distance = Math.abs(ctx.truth.trueProbFor(candidate.questionId) - target);
        if (distance < bestDistance - 1e-9) {
          bestDistance = distance;
          best = candidate;
        }
      }
      if (!best) return null;
      return { questionId: best.questionId, predictedCorrect: predictFor(ctx, best), decision: null };
    },
  };
}

export const oraclePolicy: BenchPolicy = makeOraclePolicy(0.75);
