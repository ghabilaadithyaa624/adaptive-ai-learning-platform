/**
 * Adaptive policy v3 — explicit multi-objective item selection.
 *
 * Structure (in evaluation order):
 *
 *   1. HARD GATES (lexicographic, each with a documented relaxation rule)
 *        G1 no-repeat            — never re-serve a question already answered
 *        G2 prerequisite safety  — never serve a skill whose weakest prerequisite
 *                                  fails a *pessimistic* readiness bound, unless
 *                                  nothing else is available
 *        G3 exposure cap         — never exceed the per-skill / consecutive-run
 *                                  caps while an alternative exists
 *   2. OBJECTIVE SCORING (transparent scalarisation)
 *        score = Σ wᵢ·objectiveᵢ  −  Σ pⱼ·penaltyⱼ
 *        with benefit weights renormalised to sum to 1, so `score` is an
 *        interpretable 0..1 expected-utility (penalties can push it negative).
 *   3. EXPLANATION — every scored item carries a machine-readable
 *      `DecisionExplanation`: objective-by-objective contributions, the gates
 *      that fired, the learner snapshot, and the counterfactual against the
 *      runner-up.
 *
 * Why gates *and* weights? Safety properties (prerequisites, repeats, exposure)
 * must not be purchasable by a high score on another objective — a pure weighted
 * sum always has a price at which it will do the unsafe thing. Constraints are
 * therefore enforced lexicographically and only *relaxed* (never silently
 * ignored) when the constraint set is infeasible; a relaxed gate is recorded and
 * additionally priced through the `prerequisiteRisk` penalty.
 *
 * Deterministic: identical input → identical output; ties break by question id.
 */
import { clamp, round } from "@/lib/utils";
import type {
  CandidateItem,
  DecisionFactor,
  DecisionGate,
  DecisionObjective,
  ItemSelectionStrategy,
  LearnerSkillState,
  ScoredItem,
  SelectionInput,
  SelectionResult,
} from "@/lib/ml/interfaces";
import { buildDecisionExplanation } from "./explain";
import {
  assessmentEfficiency,
  difficultyAppropriateness,
  expectedMasteryGain,
  informationGain,
  prerequisiteCorrectness,
  prerequisiteLowerBound,
  prerequisiteRisk,
  repeatedExposure,
  retention,
  skillCoverage,
  successTargetFor,
  uncertaintyReduction,
  zpdTargeting,
  type ObjectiveContext,
} from "./objectives";
import { OBJECTIVE_METADATA, resolvePolicyConfig } from "./weights";
import {
  BENEFIT_OBJECTIVES,
  PENALTY_OBJECTIVES,
  type ObjectiveKey,
  type ObjectiveValue,
  type PolicyConfigOverrides,
  type ResolvedPolicyConfig,
} from "./types";

/** Objective key → pure objective function. The single source of dispatch. */
const OBJECTIVE_FNS: Record<ObjectiveKey, (ctx: ObjectiveContext) => ObjectiveValue> = {
  expectedMasteryGain,
  informationGain,
  zpdTargeting,
  prerequisiteCorrectness,
  skillCoverage,
  retention,
  difficultyAppropriateness,
  uncertaintyReduction,
  assessmentEfficiency,
  repeatedExposure,
  prerequisiteRisk,
};

export const POLICY_V3_ID = "adaptive-policy-v3";
export const POLICY_V3_VERSION = "3.0.0";

interface Evaluation {
  candidate: CandidateItem;
  skill: LearnerSkillState;
  prereqLcb: number;
  predictedCorrect: number;
  objectives: DecisionObjective[];
  score: number;
  information: number;
  expectedGain: number;
  successTarget: number;
}

function fallbackSkill(candidate: CandidateItem): LearnerSkillState {
  return {
    skillId: candidate.skillId,
    skillName: candidate.skillName,
    subjectName: candidate.subjectName,
    mastery: 0.3,
    rawMastery: 0.3,
    confidence: 0,
    uncertainty: 1,
    attempts: 0,
    correct: 0,
    streak: 0,
    accuracy: 0.5,
    recentAccuracy: 0.5,
    responseRatio: 1,
    retention: 1,
    daysSincePractice: 999,
    velocity: 0,
    prereqReadiness: 1,
    prereqMastery: [],
    errorProfile: { type: "insufficient-data", carelessRate: 0, strugglingRate: 0, guessRate: 0, label: "No data" },
    hintReliance: 0,
    hasHintData: false,
    avgDifficulty: candidate.item.difficulty,
    avgBloom: candidate.item.bloom,
    difficultyBase: candidate.item.difficulty,
    pathAlignment: 0.3,
    prereqIds: [],
  };
}

export class MultiObjectivePolicy implements ItemSelectionStrategy {
  readonly id = POLICY_V3_ID;
  readonly version = POLICY_V3_VERSION;
  readonly config: ResolvedPolicyConfig;

  constructor(overrides: PolicyConfigOverrides = {}) {
    this.config = resolvePolicyConfig(overrides);
  }

  /** A copy of this policy with different weights/params (for A/B + tuning). */
  withConfig(overrides: PolicyConfigOverrides): MultiObjectivePolicy {
    return new MultiObjectivePolicy({
      weights: { ...this.config.weights, ...(overrides.weights ?? {}) },
      params: { ...this.config.params, ...(overrides.params ?? {}) },
    });
  }

  select(input: SelectionInput): SelectionResult {
    const config = input.policyConfig
      ? resolvePolicyConfig({
          weights: { ...this.config.weights, ...(input.policyConfig.weights ?? {}) },
          params: { ...this.config.params, ...(input.policyConfig.params ?? {}) },
        })
      : this.config;
    const params = input.target !== undefined ? { ...config.params, masteryTarget: input.target } : config.params;
    const weights = config.normalizedWeights;

    /* ---------------- gate G1: never repeat a served question -------------- */
    const unseen = input.candidates.filter((c) => !input.seenQuestionIds.has(c.questionId));
    const repeatFiltered = input.candidates.length - unseen.length;

    const skillFor = (candidate: CandidateItem) =>
      input.learner.skills.get(candidate.skillId) ?? fallbackSkill(candidate);

    // Pessimistic prerequisite bound per skill (computed once).
    const lcbBySkill = new Map<number, number>();
    for (const skill of input.learner.skills.values()) {
      lcbBySkill.set(skill.skillId, prerequisiteLowerBound(skill, input.learner.skills, params));
    }
    const lcbFor = (skill: LearnerSkillState) => {
      const cached = lcbBySkill.get(skill.skillId);
      if (cached !== undefined) return cached;
      const computed = prerequisiteLowerBound(skill, input.learner.skills, params);
      lcbBySkill.set(skill.skillId, computed);
      return computed;
    };

    // How many *currently gated* skills each skill would unblock (graph value).
    const gatedDownstream = new Map<number, number>();
    for (const skill of input.learner.skills.values()) {
      if (lcbFor(skill) >= params.prereqGate) continue;
      for (const prereqId of skill.prereqIds) {
        gatedDownstream.set(prereqId, (gatedDownstream.get(prereqId) ?? 0) + 1);
      }
    }

    /* ------------- gate G2: prerequisite safety (relaxable) ---------------- */
    const prereqSafe = unseen.filter((c) => lcbFor(skillFor(c)) >= params.prereqGate);
    const prereqRelaxed = prereqSafe.length === 0 && unseen.length > 0;
    const afterPrereq = prereqRelaxed ? unseen : prereqSafe;
    const prereqFiltered = unseen.length - afterPrereq.length;

    /* ------------- gate G3: exposure caps (relaxable) ---------------------- */
    const recent = input.recentSkillIds ?? [];
    const consecutiveFor = (skillId: number) => {
      let run = 0;
      for (let i = recent.length - 1; i >= 0; i -= 1) {
        if (recent[i] !== skillId) break;
        run += 1;
      }
      return run;
    };
    const withinExposure = afterPrereq.filter((c) => {
      const asked = input.askedSkillCounts.get(c.skillId) ?? 0;
      return asked < params.maxPerSkill && consecutiveFor(c.skillId) < params.maxConsecutiveSameSkill;
    });
    const exposureRelaxed = withinExposure.length === 0 && afterPrereq.length > 0;
    const pool = exposureRelaxed ? afterPrereq : withinExposure;
    const exposureFiltered = afterPrereq.length - pool.length;

    /* ----------------------------- scoring --------------------------------- */
    const askedBloom = input.askedBloomCounts ?? new Map<number, number>();
    const evaluations: Evaluation[] = pool.map((candidate) => {
      const skill = skillFor(candidate);
      const prereqLcb = lcbFor(skill);
      const predictedCorrect = clamp(
        input.responseModel.predict({ learner: input.learner, skill, item: candidate.item }),
        0.02,
        0.98,
      );
      const ctx: ObjectiveContext = {
        learner: input.learner,
        skill,
        candidate,
        params,
        predictedCorrect,
        prereqLcb,
        askedInSkill: input.askedSkillCounts.get(candidate.skillId) ?? 0,
        askedInBloom: askedBloom.get(candidate.item.bloom) ?? 0,
        consecutiveSameSkill: consecutiveFor(candidate.skillId),
        gatedDownstream: gatedDownstream.get(candidate.skillId) ?? 0,
        knowledgeModel: input.knowledgeModel,
      };

      const objectives: DecisionObjective[] = [];
      let score = 0;
      let information = 0;
      let expectedGain = 0;

      for (const key of BENEFIT_OBJECTIVES) {
        const value = OBJECTIVE_FNS[key](ctx);
        const weight = weights[key];
        const contribution = weight * value.normalized;
        score += contribution;
        if (key === "informationGain") information = value.raw;
        if (key === "expectedMasteryGain") expectedGain = value.normalized;
        objectives.push({
          key,
          label: OBJECTIVE_METADATA[key].label,
          raw: round(value.raw, 4),
          normalized: round(value.normalized, 4),
          weight: round(weight, 4),
          contribution: round(contribution, 6),
          direction: "benefit",
          rationale: value.detail,
        });
      }
      for (const key of PENALTY_OBJECTIVES) {
        const value = OBJECTIVE_FNS[key](ctx);
        const weight = weights[key];
        const contribution = -weight * value.normalized;
        score += contribution;
        objectives.push({
          key,
          label: OBJECTIVE_METADATA[key].label,
          raw: round(value.raw, 4),
          normalized: round(value.normalized, 4),
          weight: round(weight, 4),
          contribution: round(contribution, 6),
          direction: "penalty",
          rationale: value.detail,
        });
      }

      return {
        candidate,
        skill,
        prereqLcb,
        predictedCorrect,
        objectives,
        score: round(score, 6),
        information,
        expectedGain,
        successTarget: successTargetFor(skill, params),
      };
    });

    evaluations.sort((a, b) => b.score - a.score || a.candidate.questionId - b.candidate.questionId);

    const gates = (chosenSkillLcb: number | null): DecisionGate[] => [
      {
        key: "no-repeat",
        label: "No repeated questions",
        passed: true,
        relaxed: false,
        filtered: repeatFiltered,
        detail: `${repeatFiltered} already-served item(s) removed`,
      },
      {
        key: "prerequisite-safety",
        label: "Prerequisite safety gate",
        passed: chosenSkillLcb === null ? false : chosenSkillLcb >= params.prereqGate,
        relaxed: prereqRelaxed,
        filtered: prereqFiltered,
        detail: prereqRelaxed
          ? "no prerequisite-safe item existed; the safest available item was served and priced as risk"
          : `${prereqFiltered} item(s) removed for unmet prerequisites (pessimistic bound, gate ${params.prereqGate.toFixed(
              2,
            )})`,
      },
      {
        key: "exposure-cap",
        label: "Exposure cap",
        passed: !exposureRelaxed,
        relaxed: exposureRelaxed,
        filtered: exposureFiltered,
        detail: exposureRelaxed
          ? "every remaining item exceeded the exposure caps; caps relaxed to avoid a dead-end"
          : `max ${params.maxPerSkill}/skill and ${params.maxConsecutiveSameSkill} consecutive on one skill`,
      },
    ];

    const totalConsidered = input.candidates.length;
    const totalFiltered = repeatFiltered + prereqFiltered + exposureFiltered;

    const scored: ScoredItem[] = evaluations.map((evaluation, index) => {
      // Rank 1 is explained against the runner-up ("why this one");
      // every other item is explained against the winner ("why not this one").
      const comparison = index === 0 ? evaluations[1] : evaluations[0];
      const factors: DecisionFactor[] = evaluation.objectives.map((o) => ({
        key: o.key,
        value: o.normalized,
        weighted: o.contribution,
        detail: o.rationale,
      }));
      const decision = buildDecisionExplanation({
        policyId: this.id,
        policyVersion: this.version,
        configFingerprint: config.fingerprint,
        skill: evaluation.skill,
        questionId: evaluation.candidate.questionId,
        skillId: evaluation.candidate.skillId,
        skillName: evaluation.candidate.skillName,
        score: evaluation.score,
        rank: index + 1,
        candidatesConsidered: totalConsidered,
        candidatesFiltered: totalFiltered,
        objectives: evaluation.objectives,
        gates: gates(evaluation.prereqLcb),
        predictedCorrect: evaluation.predictedCorrect,
        prereqLcb: evaluation.prereqLcb,
        masteryTarget: params.masteryTarget,
        successTarget: evaluation.successTarget,
        comparison: comparison
          ? {
              questionId: comparison.candidate.questionId,
              skillId: comparison.candidate.skillId,
              score: comparison.score,
              objectives: comparison.objectives,
            }
          : null,
      });

      return {
        candidate: evaluation.candidate,
        score: round(evaluation.score, 4),
        predictedCorrect: round(evaluation.predictedCorrect, 3),
        information: round(evaluation.information, 3),
        expectedLearningGain: round(evaluation.expectedGain, 4),
        factors,
        explanation: decision.narrative,
        steps: [
          { label: "Mastery", value: evaluation.skill.mastery.toFixed(2), tone: "sky" },
          { label: "Predicted success", value: `${(evaluation.predictedCorrect * 100).toFixed(0)}%`, tone: "emerald" },
          { label: "Difficulty", value: evaluation.candidate.item.difficulty.toFixed(2), tone: "amber" },
          { label: "Info gain", value: evaluation.information.toFixed(2), tone: "violet" },
          { label: "Exp. gain", value: evaluation.expectedGain.toFixed(2), tone: "slate" },
        ],
        decision,
      };
    });

    return { chosen: scored[0] ?? null, ranked: scored, excluded: totalFiltered };
  }
}

/** Default instance (benchmark-tuned weights). */
export const multiObjectivePolicy = new MultiObjectivePolicy();

/** Convenience: run the default v3 policy. */
export function selectNextItemV3(input: SelectionInput): SelectionResult {
  return multiObjectivePolicy.select(input);
}
