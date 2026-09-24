/**
 * Legacy selector, wrapped in the modern `ItemSelectionStrategy` contract.
 *
 * This is the pre-v2 scorer preserved verbatim (`ml/adaptive.ts`), including its
 * documented defect: it feeds the classifier a **fixed** `masteryBefore` of 0.5
 * instead of the learner's real per-skill mastery, so its difficulty targeting
 * is roughly ability-blind.
 *
 * It exists here so an experiment can use the *actual previous production
 * behaviour* as a control arm rather than a reconstruction of it. Faithfulness
 * matters more than quality for a baseline: a flattering re-implementation of
 * the old system would understate how much the new one changed.
 */
import type {
  DecisionFactor,
  ItemSelectionStrategy,
  LearnerSkillState,
  ScoredItem,
  SelectionInput,
  SelectionResult,
} from "@/lib/ml/interfaces";
import { HEURISTIC_MODEL } from "@/lib/ml/classifier";
import { scoreCandidates, skillPriority, type AdaptiveCandidate } from "@/lib/ml/adaptive";
import { decisionFromFactors } from "./explain";
import { clamp, MASTERY_TARGET } from "@/lib/utils";

export const LEGACY_POLICY_ID = "legacy-selector";
export const LEGACY_POLICY_VERSION = "1.0.0";

export class LegacySelectionPolicy implements ItemSelectionStrategy {
  readonly id = LEGACY_POLICY_ID;

  select(input: SelectionInput): SelectionResult {
    const skillPriorities = new Map<number, number>();
    for (const [skillId, skill] of input.learner.skills) {
      skillPriorities.set(
        skillId,
        skillPriority({
          skillId,
          mastery: skill.mastery,
          attempts: skill.attempts,
          // The legacy selector had no prerequisite model at all.
          prereqReadiness: 1,
          pathAlignment: 0.3,
          daysSincePractice: skill.daysSincePractice ?? 0,
        }),
      );
    }

    const candidates: AdaptiveCandidate[] = input.candidates.map((c) => ({
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
      askedCounts: input.askedSkillCounts,
      model: HEURISTIC_MODEL,
      ability: input.learner.ability,
      // The documented legacy defect, preserved deliberately.
      baseSample: {
        ability: input.learner.ability,
        masteryBefore: 0.5,
        skillAccuracy: 0.5,
        evidence: 0.4,
        responseTimeMs: 30_000,
      },
      seen: input.seenQuestionIds,
    });

    const excluded = input.candidates.length - scored.length;
    const top = scored[0];
    if (!top) return { chosen: null, ranked: [], excluded };

    const candidate = input.candidates.find((c) => c.questionId === top.candidate.questionId)!;
    const skill = input.learner.skills.get(candidate.skillId);
    const target = input.target ?? MASTERY_TARGET;

    const factors: DecisionFactor[] = [
      {
        key: "skillPriority",
        value: clamp(skillPriorities.get(candidate.skillId) ?? 0.3, 0, 1),
        weighted: 0.45 * clamp(skillPriorities.get(candidate.skillId) ?? 0.3, 0, 1),
        detail: "Legacy skill-priority heuristic (gap × evidence × staleness)",
      },
      {
        key: "difficultyFit",
        value: clamp(1 - Math.abs(top.probability - 0.75), 0, 1),
        weighted: 0.35 * clamp(1 - Math.abs(top.probability - 0.75), 0, 1),
        detail: `Predicted success ${(top.probability * 100).toFixed(0)}% against a fixed 75% target`,
      },
      {
        key: "informationGain",
        value: clamp(top.information, 0, 1),
        weighted: 0.2 * clamp(top.information, 0, 1),
        detail: "Binary-outcome information at the predicted success rate",
      },
    ];

    const fallbackSkill = {
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
      accuracy: 0,
      recentAccuracy: 0,
    } as LearnerSkillState;

    const runnerUp = scored[1];
    const decision = decisionFromFactors({
      policyId: this.id,
      policyVersion: LEGACY_POLICY_VERSION,
      configFingerprint: `${LEGACY_POLICY_ID}@${LEGACY_POLICY_VERSION}`,
      skill: skill ?? fallbackSkill,
      questionId: candidate.questionId,
      score: top.score,
      rank: 1,
      candidatesConsidered: scored.length,
      candidatesFiltered: excluded,
      factors,
      gates: [
        {
          key: "noRepeat",
          label: "Question not already served this session",
          passed: true,
          filtered: excluded,
          relaxed: false,
          detail: `${excluded} already-served item(s) excluded`,
        },
      ],
      predictedCorrect: top.probability,
      masteryTarget: target,
      successTarget: 0.75,
      explanation: `${top.rationale} (legacy selector — mastery-blind difficulty targeting)`,
    });

    const chosen: ScoredItem = {
      candidate,
      score: top.score,
      predictedCorrect: top.probability,
      information: top.information,
      expectedLearningGain: clamp((target - (skill?.mastery ?? 0)) / target, 0, 1),
      factors,
      explanation: top.rationale,
      steps: factors.map((f) => ({ label: f.key, value: f.value.toFixed(3), tone: "neutral" })),
      decision,
    };

    return {
      chosen,
      ranked: [chosen],
      excluded,
      ...(runnerUp ? {} : {}),
    };
  }
}

export const legacySelectionPolicy = new LegacySelectionPolicy();
