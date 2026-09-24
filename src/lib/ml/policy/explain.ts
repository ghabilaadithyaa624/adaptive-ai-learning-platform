/**
 * Machine-readable decision explanations.
 *
 * Two entry points:
 *   • `buildDecisionExplanation` — the full v3 record (objectives, gates,
 *     counterfactual, learner snapshot, narrative).
 *   • `decisionFromFactors` — an adapter that lets *any* selector (including the
 *     v2 weighted-factor selector) emit the same schema, so the guarantee
 *     "every served item carries an auditable decision record" holds whichever
 *     policy is active.
 *
 * Everything is templated from numbers — deterministic, no LLM, replayable.
 */
import { round } from "@/lib/utils";
import { prereqClause } from "@/lib/ml/explain";
import {
  DECISION_EXPLANATION_SCHEMA,
  type DecisionExplanation,
  type DecisionFactor,
  type DecisionGate,
  type DecisionObjective,
  type LearnerSkillState,
} from "@/lib/ml/interfaces";

/** Verb-first phrases so drivers compose grammatically after "this item …". */
const DRIVER_PHRASES: Record<string, (o: DecisionObjective) => string> = {
  expectedMasteryGain: (o) =>
    `maximises expected mastery gain${o.normalized >= 0.6 ? " (a large step forward)" : ""}`,
  zpdTargeting: () => "sits squarely in the learner's zone of proximal development",
  informationGain: (o) =>
    `provides ${o.normalized >= 0.75 ? "high" : o.normalized >= 0.4 ? "solid" : "modest"} expected information gain`,
  prerequisiteCorrectness: () => "builds only on prerequisites the learner has securely mastered",
  skillCoverage: () => "broadens coverage into an under-practised part of the map",
  retention: () => "is due for spaced review before it decays further",
  difficultyAppropriateness: () => "is pitched at the right difficulty for the current estimate",
  uncertaintyReduction: () => "sharpens a skill the model is still uncertain about",
  assessmentEfficiency: () => "keeps the session time-efficient",
  // v2 factor keys, so the adapter produces the same house style
  masteryGap: () => "targets the widest gap to the mastery goal",
  expectedLearningGain: () => "maximises expected mastery gain",
  difficultyFit: () => "sits squarely in the learner's zone of proximal development",
  spacedReview: () => "is due for spaced review before it decays further",
  uncertainty: () => "sharpens a skill the model is still uncertain about",
  exploration: () => "explores an under-sampled skill for better coverage",
};

export function narrateDecision(params: {
  skill: LearnerSkillState;
  masteryTarget: number;
  predictedCorrect: number;
  objectives: DecisionObjective[];
  gates: DecisionGate[];
}): string {
  const { skill, masteryTarget, predictedCorrect, objectives, gates } = params;
  const drivers = objectives
    .filter((o) => o.direction === "benefit" && o.contribution > 0 && DRIVER_PHRASES[o.key])
    .sort((a, b) => b.contribution - a.contribution);

  const lead = `Selected because ${skill.skillName} mastery is ${skill.mastery.toFixed(2)}, target is ${masteryTarget.toFixed(2)}`;
  const clauses: string[] = [];

  const prereq = prereqClause(skill);
  if (prereq) clauses.push(prereq);

  const [first, second] = drivers;
  if (first) clauses.push(`this item ${DRIVER_PHRASES[first.key](first)}`);
  if (second && second.key !== first?.key) clauses.push(`also ${DRIVER_PHRASES[second.key](second)}`);

  const relaxed = gates.filter((g) => g.relaxed);
  for (const gate of relaxed) clauses.push(`${gate.label.toLowerCase()} had to be relaxed (${gate.detail})`);

  clauses.push(`predicted success is ${(predictedCorrect * 100).toFixed(0)}%`);

  if (clauses.length === 1) return `${lead}, and ${clauses[0]}.`;
  const last = clauses.pop() as string;
  return `${lead}, ${clauses.join(", ")}, and ${last}.`;
}

export interface BuildDecisionInput {
  policyId: string;
  policyVersion: string;
  configFingerprint: string;
  skill: LearnerSkillState;
  questionId: number;
  skillId: number;
  skillName: string;
  score: number;
  rank: number;
  candidatesConsidered: number;
  candidatesFiltered: number;
  objectives: DecisionObjective[];
  gates: DecisionGate[];
  predictedCorrect: number;
  prereqLcb: number;
  masteryTarget: number;
  successTarget: number;
  comparison: { questionId: number; skillId: number; score: number; objectives: DecisionObjective[] } | null;
}

export function buildDecisionExplanation(input: BuildDecisionInput): DecisionExplanation {
  const topDrivers = [...input.objectives]
    .filter((o) => Math.abs(o.contribution) > 1e-9)
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
    .slice(0, 3)
    .map((o) => o.key);

  let counterfactual: DecisionExplanation["counterfactual"] = null;
  if (input.comparison) {
    const otherByKey = new Map(input.comparison.objectives.map((o) => [o.key, o.contribution]));
    const deciding = input.objectives
      .map((o) => ({ key: o.key, delta: round(o.contribution - (otherByKey.get(o.key) ?? 0), 4) }))
      .filter((d) => Math.abs(d.delta) > 1e-9)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .slice(0, 3);
    counterfactual = {
      runnerUpQuestionId: input.comparison.questionId,
      runnerUpSkillId: input.comparison.skillId,
      scoreMargin: round(input.score - input.comparison.score, 4),
      decidingObjectives: deciding,
    };
  }

  return {
    schema: DECISION_EXPLANATION_SCHEMA,
    policyId: input.policyId,
    policyVersion: input.policyVersion,
    configFingerprint: input.configFingerprint,
    questionId: input.questionId,
    skillId: input.skillId,
    skillName: input.skillName,
    // Reported as the sum of the *reported* contributions, so the record always
    // reconciles: an auditor can add up the objective column and get this number
    // back exactly. The unrounded score is what ranking actually used.
    score: round(
      input.objectives.reduce((acc, o) => acc + o.contribution, 0),
      6,
    ),
    rank: input.rank,
    candidatesConsidered: input.candidatesConsidered,
    candidatesFiltered: input.candidatesFiltered,
    objectives: input.objectives,
    gates: input.gates,
    topDrivers,
    counterfactual,
    learnerSnapshot: {
      mastery: round(input.skill.mastery, 3),
      uncertainty: round(input.skill.uncertainty, 3),
      attempts: input.skill.attempts,
      predictedSuccess: round(input.predictedCorrect, 3),
      prereqReadiness: round(input.skill.prereqReadiness, 3),
      prereqReadinessLcb: round(input.prereqLcb, 3),
      daysSincePractice: round(input.skill.daysSincePractice, 2),
      retention: round(input.skill.retention, 3),
    },
    targets: { mastery: round(input.masteryTarget, 3), success: round(input.successTarget, 3) },
    narrative: narrateDecision({
      skill: input.skill,
      masteryTarget: input.masteryTarget,
      predictedCorrect: input.predictedCorrect,
      objectives: input.objectives,
      gates: input.gates,
    }),
  };
}

/**
 * Adapter: turn a weighted-factor selector's output into the shared decision
 * schema. Used by the v2 selector so both policies are auditable through the
 * same contract (and so downstream consumers never branch on policy id).
 */
export function decisionFromFactors(input: {
  policyId: string;
  policyVersion: string;
  configFingerprint: string;
  skill: LearnerSkillState;
  questionId: number;
  score: number;
  rank: number;
  candidatesConsidered: number;
  candidatesFiltered: number;
  factors: DecisionFactor[];
  gates: DecisionGate[];
  predictedCorrect: number;
  masteryTarget: number;
  successTarget: number;
  explanation: string;
}): DecisionExplanation {
  const objectives: DecisionObjective[] = input.factors.map((factor) => ({
    key: factor.key,
    label: factor.key,
    raw: round(factor.value, 4),
    normalized: round(factor.value, 4),
    weight: round(factor.value === 0 ? 0 : Math.abs(factor.weighted / factor.value), 4),
    contribution: round(factor.weighted, 4),
    direction: factor.weighted < 0 ? "penalty" : "benefit",
    rationale: factor.detail,
  }));
  const topDrivers = [...objectives]
    .filter((o) => Math.abs(o.contribution) > 1e-9)
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
    .slice(0, 3)
    .map((o) => o.key);

  return {
    schema: DECISION_EXPLANATION_SCHEMA,
    policyId: input.policyId,
    policyVersion: input.policyVersion,
    configFingerprint: input.configFingerprint,
    questionId: input.questionId,
    skillId: input.skill.skillId,
    skillName: input.skill.skillName,
    score: round(input.score, 4),
    rank: input.rank,
    candidatesConsidered: input.candidatesConsidered,
    candidatesFiltered: input.candidatesFiltered,
    objectives,
    gates: input.gates,
    topDrivers,
    counterfactual: null,
    learnerSnapshot: {
      mastery: round(input.skill.mastery, 3),
      uncertainty: round(input.skill.uncertainty, 3),
      attempts: input.skill.attempts,
      predictedSuccess: round(input.predictedCorrect, 3),
      prereqReadiness: round(input.skill.prereqReadiness, 3),
      prereqReadinessLcb: round(input.skill.prereqReadiness, 3),
      daysSincePractice: round(input.skill.daysSincePractice, 2),
      retention: round(input.skill.retention, 3),
    },
    targets: { mastery: round(input.masteryTarget, 3), success: round(input.successTarget, 3) },
    narrative: input.explanation,
  };
}
