/**
 * Adaptive item selection — v2 (implements ItemSelectionStrategy).
 *
 * Scores every candidate item with a transparent, weighted blend of ten
 * criteria and returns the best one together with a human-readable explanation.
 * All ten requested signals are represented:
 *
 *   1 mastery gap            → gap component
 *   2 expected learning gain → simulated posterior step via the knowledge model
 *   3 information gain        → Fisher info 4·p·(1-p)
 *   4 appropriate difficulty  → distance to an adaptive ZPD success target
 *   5 prerequisite constraints→ hard-ish penalty when prereqs are unmet
 *   6 question diversity      → penalty for over-asked skills/bloom levels
 *   7 avoid repeats           → hard filter on already-served question ids
 *   8 exploration/exploitation→ deterministic UCB1 bonus for thin evidence
 *   9 spaced review           → bonus for mastered-but-decaying skills
 *  10 uncertainty             → active-learning bonus for high-uncertainty skills
 *
 * Deterministic: identical input → identical output (ties broken by question id).
 */
import { clamp, round } from "@/lib/utils";
import { MASTERY_TARGET } from "@/lib/utils";
import { ucbBonus } from "@/lib/ml/models/bandit";
import { composeExplanation } from "@/lib/ml/explain";
import { decisionFromFactors } from "@/lib/ml/policy/explain";
import { fingerprint } from "@/lib/ml/policy/weights";
import type {
  CandidateItem,
  DecisionFactor,
  DecisionGate,
  ItemSelectionStrategy,
  LearnerSkillState,
  ScoredItem,
  SelectionInput,
  SelectionResult,
  SelectionWeights,
  SkillBelief,
} from "@/lib/ml/interfaces";

export const DEFAULT_SELECTION_WEIGHTS: SelectionWeights = {
  masteryGap: 0.22,
  expectedLearningGain: 0.2,
  informationGain: 0.14,
  difficultyFit: 0.18,
  spacedReview: 0.06,
  uncertainty: 0.1,
  exploration: 0.06,
  diversityPenalty: 0.1,
  prereqPenalty: 0.35,
};

/**
 * Below this prerequisite readiness we treat the skill as gated. Set at the
 * "proficient" band (0.6): advancing before a prerequisite is proficient tends
 * to unlock skills the learner is not truly ready for, because the mastery
 * estimate can run ahead of true ability early on.
 */
export const PREREQ_GATE = 0.6;

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

function beliefFrom(skill: LearnerSkillState): SkillBelief {
  return {
    mastery: skill.mastery,
    uncertainty: skill.uncertainty,
    confidence: skill.confidence,
    stats: { n: skill.attempts },
  };
}

export class AdaptiveSelector implements ItemSelectionStrategy {
  readonly id = "adaptive-selector-v2";
  readonly version = "2.0.0";

  select(input: SelectionInput): SelectionResult {
    const target = input.target ?? MASTERY_TARGET;
    const weights = { ...DEFAULT_SELECTION_WEIGHTS, ...(input.weights ?? {}) };
    const totalAttempts = [...input.learner.skills.values()].reduce((a, s) => a + s.attempts, 0);
    const askedBloom = input.askedBloomCounts ?? new Map<number, number>();

    let excluded = 0;
    // Staged items keep a reference to the skill state so the audit record can be
    // attached after sorting (it needs the final rank).
    const staged: { item: Omit<ScoredItem, "decision">; skill: LearnerSkillState }[] = [];

    // Resolve every candidate's skill once so the prerequisite gate can see the
    // whole pool: if any item's prerequisites are met, we route *away* from items
    // whose prerequisites are not, instead of merely penalising them. This keeps
    // the learner from being pushed into skills they are not ready for while
    // never dead-ending (if everything is gated, we fall back to scoring them).
    const resolved = input.candidates
      .filter((candidate) => !input.seenQuestionIds.has(candidate.questionId))
      .map((candidate) => ({
        candidate,
        skill: input.learner.skills.get(candidate.skillId) ?? fallbackSkill(candidate),
      }));
    excluded = input.candidates.length - resolved.length;
    const ungatedAvailable = resolved.some(({ skill }) => skill.prereqReadiness >= PREREQ_GATE);

    for (const { candidate, skill } of resolved) {
      // (5) prerequisite constraint — hard gate when a ready alternative exists.
      if (ungatedAvailable && skill.prereqReadiness < PREREQ_GATE) {
        excluded += 1;
        continue;
      }

      const belief = beliefFrom(skill);

      const predictedCorrect = clamp(
        input.responseModel.predict({ learner: input.learner, skill, item: candidate.item }),
        0.02,
        0.98,
      );

      // (1) mastery gap
      const gap = clamp(target - skill.mastery, 0, 1);

      // (2) expected learning gain — simulate a posterior step
      const mCorrect = input.knowledgeModel.observe(belief, {
        isCorrect: true,
        difficulty: candidate.item.difficulty,
        bloom: candidate.item.bloom,
      }).mastery;
      const mWrong = input.knowledgeModel.observe(belief, {
        isCorrect: false,
        difficulty: candidate.item.difficulty,
        bloom: candidate.item.bloom,
      }).mastery;
      const expectedMastery = predictedCorrect * mCorrect + (1 - predictedCorrect) * mWrong;
      const expectedLearningGain = clamp(Math.max(0, expectedMastery - skill.mastery) * 6, 0, 1);

      // (3) information gain (Fisher info for a Bernoulli, normalised to 0..1)
      const information = clamp(4 * predictedCorrect * (1 - predictedCorrect), 0, 1);

      // (4) appropriate difficulty — adaptive ZPD target.
      // Thin evidence → aim near 0.55 (max information); confident → aim ~0.72
      // (flow / productive success). fit peaks at the target.
      const zpdTarget = 0.55 + 0.2 * skill.confidence;
      const difficultyFit = clamp(1 - Math.abs(predictedCorrect - zpdTarget) / 0.5, 0, 1);

      // (9) spaced review — mastered but decaying
      const spacedReview =
        skill.mastery >= target * 0.9 ? clamp((1 - skill.retention) * 1.2 + clamp(skill.daysSincePractice / 30) * 0.4) : 0;

      // (10) uncertainty (active learning)
      const uncertainty = skill.uncertainty;

      // (8) exploration — UCB1 bonus for under-sampled skills
      const exploration = ucbBonus(skill.attempts, totalAttempts);

      // (6) diversity penalty — over-asked skills / bloom levels this session
      const askedSkill = input.askedSkillCounts.get(candidate.skillId) ?? 0;
      const askedBloomN = askedBloom.get(candidate.item.bloom) ?? 0;
      const diversity = clamp(clamp(askedSkill / 4) * 0.7 + clamp(askedBloomN / 4) * 0.3);

      // (5) prerequisite constraint — penalise gated skills
      const prereq = skill.prereqReadiness < PREREQ_GATE
        ? clamp((PREREQ_GATE - skill.prereqReadiness) / PREREQ_GATE)
        : 0;

      const factors: DecisionFactor[] = [
        { key: "masteryGap", value: gap, weighted: weights.masteryGap * gap, detail: `${(gap * 100).toFixed(0)}pt gap to target` },
        { key: "expectedLearningGain", value: expectedLearningGain, weighted: weights.expectedLearningGain * expectedLearningGain, detail: `expected mastery step` },
        { key: "informationGain", value: information, weighted: weights.informationGain * information, detail: `info ${information.toFixed(2)}` },
        { key: "difficultyFit", value: difficultyFit, weighted: weights.difficultyFit * difficultyFit, detail: `ZPD fit (target ${(zpdTarget * 100).toFixed(0)}%)` },
        { key: "spacedReview", value: spacedReview, weighted: weights.spacedReview * spacedReview, detail: `review pressure` },
        { key: "uncertainty", value: uncertainty, weighted: weights.uncertainty * uncertainty, detail: `uncertainty ${uncertainty.toFixed(2)}` },
        { key: "exploration", value: exploration, weighted: weights.exploration * exploration, detail: `exploration bonus` },
        { key: "diversity", value: diversity, weighted: -weights.diversityPenalty * diversity, detail: `diversity penalty` },
        { key: "prereq", value: prereq, weighted: -weights.prereqPenalty * prereq, detail: prereq > 0 ? `prerequisites unmet` : `prerequisites met` },
      ];

      const score = factors.reduce((acc, f) => acc + f.weighted, 0);
      const explanation = composeExplanation({ skill, target, predictedCorrect, factors });

      staged.push({
        skill,
        item: {
          candidate,
          score: round(score, 4),
          predictedCorrect: round(predictedCorrect, 3),
          information: round(information, 3),
          expectedLearningGain: round(clamp(Math.max(0, expectedMastery - skill.mastery)), 4),
          factors,
          explanation,
          steps: [
            { label: "Mastery", value: skill.mastery.toFixed(2), tone: "sky" },
            { label: "Predicted success", value: `${(predictedCorrect * 100).toFixed(0)}%`, tone: "emerald" },
            { label: "Difficulty", value: candidate.item.difficulty.toFixed(2), tone: "amber" },
            { label: "Info gain", value: information.toFixed(2), tone: "violet" },
            { label: "Exp. gain", value: (expectedMastery - skill.mastery).toFixed(3), tone: "slate" },
          ],
        },
      });
    }

    staged.sort((a, b) => b.item.score - a.item.score || a.item.candidate.questionId - b.item.candidate.questionId);

    const gates: DecisionGate[] = [
      {
        key: "no-repeat",
        label: "No repeated questions",
        passed: true,
        relaxed: false,
        filtered: input.candidates.length - resolved.length,
        detail: `${input.candidates.length - resolved.length} already-served item(s) removed`,
      },
      {
        key: "prerequisite-gate",
        label: "Prerequisite gate",
        passed: true,
        relaxed: !ungatedAvailable,
        filtered: Math.max(0, excluded - (input.candidates.length - resolved.length)),
        detail: ungatedAvailable
          ? `point-estimate readiness gate at ${PREREQ_GATE.toFixed(2)}`
          : "no prerequisite-ready item existed; gated items were scored with a penalty",
      },
    ];
    const configFingerprint = fingerprint({ selector: this.id, weights, target, gate: PREREQ_GATE });

    const scored: ScoredItem[] = staged.map(({ item, skill }, index) => ({
      ...item,
      decision: decisionFromFactors({
        policyId: this.id,
        policyVersion: this.version,
        configFingerprint,
        skill,
        questionId: item.candidate.questionId,
        score: item.score,
        rank: index + 1,
        candidatesConsidered: input.candidates.length,
        candidatesFiltered: excluded,
        factors: item.factors,
        gates,
        predictedCorrect: item.predictedCorrect,
        masteryTarget: target,
        // v2's adaptive ZPD target (documented in the difficultyFit factor).
        successTarget: 0.55 + 0.2 * skill.confidence,
        explanation: item.explanation,
      }),
    }));

    return { chosen: scored[0] ?? null, ranked: scored, excluded };
  }
}

export const adaptiveSelector = new AdaptiveSelector();

/** Convenience: run the default selector. */
export function selectNextItemV2(input: SelectionInput): SelectionResult {
  return adaptiveSelector.select(input);
}
