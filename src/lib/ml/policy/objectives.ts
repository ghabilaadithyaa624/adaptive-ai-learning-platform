/**
 * The ten objectives of the multi-objective adaptive policy.
 *
 * Every objective is a **pure function** of (learner state, skill state,
 * candidate item, session counters, policy params) returning
 * `{ raw, normalized, detail }`:
 *
 *   • `raw`        — the signal in its natural unit, for auditing
 *   • `normalized` — a 0..1 value, the only thing the weighted sum sees
 *   • `detail`     — a one-line, human-readable justification
 *
 * Normalising every objective to 0..1 is what makes the weights comparable and
 * the composite score interpretable: with benefit weights summing to 1, the
 * score is a convex combination, i.e. "expected utility of serving this item"
 * on the same scale for every learner, item and tenant.
 */
import { clamp } from "@/lib/utils";
import type {
  CandidateItem,
  KnowledgeTracingModel,
  LearnerSkillState,
  LearnerState,
  SkillBelief,
} from "@/lib/ml/interfaces";
import type { ObjectiveValue, PolicyParams } from "./types";

export interface ObjectiveContext {
  learner: LearnerState;
  skill: LearnerSkillState;
  candidate: CandidateItem;
  params: PolicyParams;
  /** P(correct) for this (learner, item) pair from the response model. */
  predictedCorrect: number;
  /** Conservative lower bound on the weakest prerequisite's mastery (0..1). */
  prereqLcb: number;
  /** Items already served on this skill this session. */
  askedInSkill: number;
  /** Items already served at this Bloom level this session. */
  askedInBloom: number;
  /** Items served on this skill immediately before now (blocked-practice run). */
  consecutiveSameSkill: number;
  /** How many still-gated downstream skills this skill would unblock. */
  gatedDownstream: number;
  /** Knowledge-tracing model used to simulate posterior updates. */
  knowledgeModel: KnowledgeTracingModel;
}

const pct = (n: number) => `${Math.round(n * 100)}%`;
const f2 = (n: number) => n.toFixed(2);

/* ------------------------------------------------------------------ */
/* Shared primitives                                                   */
/* ------------------------------------------------------------------ */

/**
 * Confidence-adaptive success target.
 *
 * Measurement wants p = 0.50 (maximum Fisher information); pedagogy wants
 * p ≈ `successTarget` (productive success). Which one should win depends on how
 * much we trust the current estimate, so we interpolate by confidence:
 *
 *   p* = 0.5 + (successTarget − 0.5) · confidence
 *
 * A cold-start learner is measured (0.50); a well-evidenced learner is taught
 * (0.75). v2 used the same idea with hand-picked endpoints (0.55 → 0.75); here
 * both endpoints are derived quantities.
 */
export function successTargetFor(skill: LearnerSkillState, params: PolicyParams): number {
  return 0.5 + (params.successTarget - 0.5) * clamp(skill.confidence, 0, 1);
}

/** Gaussian productive-difficulty kernel, peaked at `target`. */
export function zpdEfficiency(p: number, target: number, sigma: number): number {
  const z = (p - target) / Math.max(1e-6, sigma);
  return clamp(Math.exp(-0.5 * z * z), 0, 1);
}

/**
 * Pessimistic (lower-confidence-bound) prerequisite readiness.
 *
 * `uncertainty` is a normalised posterior SD (SD ≈ uncertainty × 0.5), so the
 * bound is `mastery − z · 0.5 · uncertainty` for the *weakest* prerequisite.
 * Pessimism is the fix for v2's premature unlocks: an over-confident point
 * estimate opened gates the learner was not actually ready for.
 */
export function prerequisiteLowerBound(
  skill: LearnerSkillState,
  skills: Map<number, LearnerSkillState>,
  params: PolicyParams,
): number {
  if (!skill.prereqIds.length) return 1;
  let worst = 1;
  for (const id of skill.prereqIds) {
    const prereq = skills.get(id);
    // Unknown prerequisite → fall back to the reported readiness (no extra credit).
    const mastery = prereq ? prereq.mastery : skill.prereqReadiness;
    const uncertainty = prereq ? prereq.uncertainty : 1;
    const lcb = clamp(mastery - params.prereqPessimismZ * 0.5 * uncertainty, 0, 1);
    if (lcb < worst) worst = lcb;
  }
  return worst;
}

function beliefOf(skill: LearnerSkillState): SkillBelief {
  return {
    mastery: skill.mastery,
    uncertainty: skill.uncertainty,
    confidence: skill.confidence,
    stats: { n: skill.attempts },
  };
}

function itemSeconds(candidate: CandidateItem): number {
  if (candidate.estimatedSeconds > 0) return candidate.estimatedSeconds;
  if (candidate.item.expectedTimeMs) return candidate.item.expectedTimeMs / 1000;
  return 60;
}

/* ------------------------------------------------------------------ */
/* 1. Expected mastery gain                                            */
/* ------------------------------------------------------------------ */

/**
 * Expected *true* learning from serving this item, under an explicit,
 * declared pedagogical model:
 *
 *   gain ≈ headroom × ZPD efficiency × prerequisite support
 *
 * - headroom `(target − mastery)/target`: mastery learning says progress is
 *   proportional to what is left to learn, and nothing above the target is worth
 *   paying for (spaced review handles over-learned skills).
 * - ZPD efficiency: practice outside the productive band mostly wastes time.
 * - prerequisite support: practice on an unsupported skill returns a fraction of
 *   the gain (learning hierarchies).
 *
 * The three combine multiplicatively because each is *necessary*: zero headroom,
 * zero band fit, or zero prerequisite support each drives real gain to ~0.
 *
 * This is the objective v2 lacked. v2's "expected learning gain" measured the
 * movement of the *estimate* (a simulated BKT posterior step), which is largest
 * exactly where evidence is thin — not where learning is largest.
 */
export function expectedMasteryGain(ctx: ObjectiveContext): ObjectiveValue {
  const { params, skill } = ctx;
  const headroom = clamp((params.masteryTarget - skill.mastery) / params.masteryTarget, 0, 1);
  const efficiency = zpdEfficiency(ctx.predictedCorrect, successTargetFor(skill, params), params.zpdSigma);
  const support = params.prereqGate > 0 ? clamp(ctx.prereqLcb / params.prereqGate, 0, 1) : 1;
  const value = clamp(headroom * efficiency * support, 0, 1);
  return {
    raw: value,
    normalized: value,
    detail: `headroom ${f2(headroom)} × ZPD efficiency ${f2(efficiency)} × prerequisite support ${f2(support)}`,
  };
}

/* ------------------------------------------------------------------ */
/* 2. Information gain                                                 */
/* ------------------------------------------------------------------ */

/**
 * Fisher information of a Bernoulli response, `a²·p·(1−p)`, normalised so an
 * average-discrimination item at p = 0.5 scores 1. Items with a calibrated,
 * above-average discrimination are worth more; uncalibrated banks behave exactly
 * like v2's `4p(1−p)`.
 */
export function informationGain(ctx: ObjectiveContext): ObjectiveValue {
  const p = ctx.predictedCorrect;
  const a = ctx.candidate.item.discrimination ?? ctx.params.referenceDiscrimination;
  const scale = (a / ctx.params.referenceDiscrimination) ** 2;
  const fisher = 4 * p * (1 - p);
  const value = clamp(fisher * scale, 0, 1);
  return {
    raw: fisher,
    normalized: value,
    detail: `Fisher information ${f2(fisher)} at predicted success ${pct(p)}${
      a !== ctx.params.referenceDiscrimination ? ` (discrimination ${f2(a)})` : ""
    }`,
  };
}

/* ------------------------------------------------------------------ */
/* 3. ZPD targeting                                                    */
/* ------------------------------------------------------------------ */

/** Proximity of predicted success to the confidence-adaptive success target. */
export function zpdTargeting(ctx: ObjectiveContext): ObjectiveValue {
  const target = successTargetFor(ctx.skill, ctx.params);
  const value = zpdEfficiency(ctx.predictedCorrect, target, ctx.params.zpdSigma);
  return {
    raw: ctx.predictedCorrect,
    normalized: value,
    detail: `predicted success ${pct(ctx.predictedCorrect)} vs target ${pct(target)}`,
  };
}

/* ------------------------------------------------------------------ */
/* 4. Prerequisite correctness                                         */
/* ------------------------------------------------------------------ */

/** Conservative prerequisite readiness relative to the gate (1 = fully ready). */
export function prerequisiteCorrectness(ctx: ObjectiveContext): ObjectiveValue {
  const value = ctx.params.prereqGate > 0 ? clamp(ctx.prereqLcb / ctx.params.prereqGate, 0, 1) : 1;
  return {
    raw: ctx.prereqLcb,
    normalized: value,
    detail: ctx.skill.prereqIds.length
      ? `weakest prerequisite lower bound ${f2(ctx.prereqLcb)} vs gate ${f2(ctx.params.prereqGate)}`
      : "no prerequisites — always safe",
  };
}

/** Penalty twin of (4): how far below the gate a relaxed item sits. */
export function prerequisiteRisk(ctx: ObjectiveContext): ObjectiveValue {
  const gate = ctx.params.prereqGate;
  const deficit = gate > 0 ? clamp((gate - ctx.prereqLcb) / gate, 0, 1) : 0;
  return {
    raw: deficit,
    normalized: deficit,
    detail: deficit > 0 ? `prerequisites ${f2(deficit)} below the safety gate` : "prerequisites satisfied",
  };
}

/* ------------------------------------------------------------------ */
/* 5. Skill coverage                                                   */
/* ------------------------------------------------------------------ */

/**
 * Curriculum breadth: diminishing-returns novelty of the skill this session,
 * blended with the number of *currently gated* downstream skills this item would
 * help unblock (two or more ⇒ full credit).
 */
export function skillCoverage(ctx: ObjectiveContext): ObjectiveValue {
  const novelty = 1 / (1 + Math.max(0, ctx.askedInSkill));
  const unblock = clamp(ctx.gatedDownstream / 2, 0, 1);
  const share = ctx.params.coverageUnblockShare;
  const value = clamp((1 - share) * novelty + share * unblock, 0, 1);
  return {
    raw: ctx.askedInSkill,
    normalized: value,
    detail: `${ctx.askedInSkill} item(s) on this skill so far; unblocks ${ctx.gatedDownstream} gated skill(s)`,
  };
}

/* ------------------------------------------------------------------ */
/* 6. Retention                                                        */
/* ------------------------------------------------------------------ */

/**
 * Forecast decay of knowledge worth protecting:
 *
 *   retrievability at the horizon  R_h = retention · exp(−forget · horizon)
 *   value at risk                  V   = mastery / target (capped at 1)
 *   objective                      V · (1 − R_h)
 *
 * High for a well-learned skill that is slipping; ~0 for a skill that was just
 * practised, and ~0 for a skill the learner never knew (that is a *learning*
 * target, which objective 1 already covers). Retrieval practice is scheduled
 * when recall is effortful but still likely — the classic spacing result.
 */
export function retention(ctx: ObjectiveContext): ObjectiveValue {
  const { params, skill } = ctx;
  const horizonRetrievability = clamp(
    skill.retention * Math.exp(-params.forgetPerDay * params.retentionHorizonDays),
    0,
    1,
  );
  const valueAtRisk = clamp(skill.mastery / params.masteryTarget, 0, 1);
  const value = clamp(valueAtRisk * (1 - horizonRetrievability), 0, 1);
  return {
    raw: horizonRetrievability,
    normalized: value,
    detail: `predicted recall in ${params.retentionHorizonDays}d is ${pct(horizonRetrievability)} (last practised ${
      Number.isFinite(skill.daysSincePractice) ? `${f2(skill.daysSincePractice)}d` : "never"
    } ago)`,
  };
}

/* ------------------------------------------------------------------ */
/* 7. Difficulty appropriateness                                       */
/* ------------------------------------------------------------------ */

/**
 * Fit in *item-parameter* space rather than probability space: the ideal item
 * sits a small desirable-difficulty offset above estimated mastery, at a Bloom
 * level the learner's mastery supports (≈ understand at m=0, ≈ evaluate at m=1).
 *
 * Deliberately independent of the response model: if the classifier is
 * miscalibrated, this objective still prevents absurd items from being served.
 */
export function difficultyAppropriateness(ctx: ObjectiveContext): ObjectiveValue {
  const { params, skill, candidate } = ctx;
  const ideal = clamp(skill.mastery + params.desirableDifficultyOffset, 0, 1);
  const difficultyFit = clamp(1 - Math.abs(candidate.item.difficulty - ideal) / params.difficultyTolerance, 0, 1);
  const idealBloom = 2 + 3 * clamp(skill.mastery, 0, 1);
  const bloomFit = clamp(1 - Math.abs(candidate.item.bloom - idealBloom) / 3, 0, 1);
  const baseFit = clamp((1 - params.bloomShare) * difficultyFit + params.bloomShare * bloomFit, 0, 1);
  const tags = (candidate.item.misconceptionTags ?? []).map(t => t.trim().toLowerCase());
  const targeted = (skill.misconceptions ?? []).some(h =>
    h.errorPattern === "repeated_misconception" && h.confidence !== "LOW" && tags.includes(h.misconception.trim().toLowerCase()),
  );
  // A small, transparent tie-breaking nudge: never override prerequisite gates
  // or difficulty fit, and never target a one-off/low-confidence hypothesis.
  const value = targeted ? clamp(baseFit + .1 * (1 - baseFit), 0, 1) : baseFit;
  return {
    raw: candidate.item.difficulty,
    normalized: value,
    detail: `difficulty ${f2(candidate.item.difficulty)} vs ideal ${f2(ideal)}; Bloom ${candidate.item.bloom} vs ideal ${f2(
      idealBloom,
    )}${targeted ? "; targets repeated misconception" : ""}`,
  };
}

/* ------------------------------------------------------------------ */
/* 8. Learner-uncertainty reduction                                    */
/* ------------------------------------------------------------------ */

/**
 * Expected posterior-variance reduction for this skill (Bayesian D-optimality),
 * scaled by how uncertain the skill currently is:
 *
 *   E[Var_after] = p·Var(belief | correct) + (1−p)·Var(belief | incorrect)
 *   objective    = uncertainty · (Var_before − E[Var_after]) / Var_before
 *
 * Unlike raw uncertainty (what v2 used), this asks what the *item* would
 * actually teach us about the learner, and it is item-sensitive whenever the
 * knowledge model weights evidence by difficulty (e.g. the Beta-Bernoulli model).
 */
export function uncertaintyReduction(ctx: ObjectiveContext): ObjectiveValue {
  const belief = beliefOf(ctx.skill);
  const before = belief.uncertainty ** 2;
  if (before <= 1e-9) {
    return { raw: 0, normalized: 0, detail: "state already fully determined" };
  }
  const obs = { difficulty: ctx.candidate.item.difficulty, bloom: ctx.candidate.item.bloom };
  const ifCorrect = ctx.knowledgeModel.observe(belief, { isCorrect: true, ...obs });
  const ifWrong = ctx.knowledgeModel.observe(belief, { isCorrect: false, ...obs });
  const p = ctx.predictedCorrect;
  const after = p * ifCorrect.uncertainty ** 2 + (1 - p) * ifWrong.uncertainty ** 2;
  const relative = clamp((before - after) / before, 0, 1);
  const value = clamp(ctx.skill.uncertainty * relative, 0, 1);
  return {
    raw: relative,
    normalized: value,
    detail: `cuts posterior variance by ${pct(relative)} on a skill with uncertainty ${f2(ctx.skill.uncertainty)}`,
  };
}

/* ------------------------------------------------------------------ */
/* 9. Assessment efficiency                                            */
/* ------------------------------------------------------------------ */

/**
 * Time economy. Learning per *minute* is the resource a learner actually spends,
 * so expected item time is scored against a reference budget. The term is
 * weighted up as session fatigue grows (late in a session, a 3-minute item costs
 * more than its clock time).
 */
export function assessmentEfficiency(ctx: ObjectiveContext): ObjectiveValue {
  const seconds = itemSeconds(ctx.candidate);
  const economy = clamp(1 - seconds / ctx.params.timeReferenceSeconds, 0, 1);
  const fatigue = clamp(ctx.learner.context.fatigue, 0, 1);
  const emphasis = ctx.params.efficiencyBaseline + (1 - ctx.params.efficiencyBaseline) * fatigue;
  const value = clamp(economy * emphasis, 0, 1);
  return {
    raw: seconds,
    normalized: value,
    detail: `${Math.round(seconds)}s of ${ctx.params.timeReferenceSeconds}s budget (fatigue ${f2(fatigue)})`,
  };
}

/* ------------------------------------------------------------------ */
/* 10. Repeated exposure (penalty)                                     */
/* ------------------------------------------------------------------ */

/**
 * Near-repeat pressure. Exact repeats are removed by a hard filter; this term
 * penalises drilling the same skill or Bloom level, blocked runs of the same
 * skill, and bank items that are already over-exposed across the cohort.
 */
export function repeatedExposure(ctx: ObjectiveContext): ObjectiveValue {
  const { params } = ctx;
  const skillTerm = clamp(ctx.askedInSkill / params.maxPerSkill, 0, 1);
  const streakTerm = clamp(ctx.consecutiveSameSkill / params.maxConsecutiveSameSkill, 0, 1);
  const bloomTerm = clamp(ctx.askedInBloom / params.maxPerBloom, 0, 1);
  const bankTerm = clamp(ctx.candidate.item.exposureRate ?? 0, 0, 1);
  const bankShare = clamp(1 - params.exposureSkillShare - params.exposureBloomShare, 0, 1);
  const value = clamp(
    params.exposureSkillShare * Math.max(skillTerm, streakTerm) +
      params.exposureBloomShare * bloomTerm +
      bankShare * bankTerm,
    0,
    1,
  );
  return {
    raw: ctx.askedInSkill,
    normalized: value,
    detail: `${ctx.askedInSkill} on this skill (${ctx.consecutiveSameSkill} in a row), ${ctx.askedInBloom} at this Bloom level`,
  };
}
