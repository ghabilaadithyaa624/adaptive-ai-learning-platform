/**
 * Baseline selection strategies.
 *
 * These are the control arms for policy experiments. They exist in production —
 * not just in the offline benchmark — because an experiment that can only route
 * traffic between two adaptive policies cannot answer the question that matters:
 * *is the adaptive machinery earning its complexity at all?* The offline
 * simulation (see `SIMULATION.md` §6.1) found that a trivial mastery-gap
 * heuristic out-performed every shippable policy on simulated learning, so the
 * ability to run that heuristic as a live control arm is a requirement, not a
 * curiosity.
 *
 * All three obey the same hard contract as the real policies:
 *   • never repeat a question already served this session
 *   • emit a machine-readable `DecisionExplanation` for every selection
 *   • deterministic — the random baseline is seeded from stable identifiers,
 *     never from `Math.random`
 *
 * They deliberately do NOT respect prerequisites. That is the point of a
 * control: it isolates how much of the adaptive engine's measured benefit comes
 * from prerequisite safety versus from everything else.
 */
import type {
  CandidateItem,
  DecisionFactor,
  ItemSelectionStrategy,
  LearnerSkillState,
  ScoredItem,
  SelectionInput,
  SelectionResult,
} from "@/lib/ml/interfaces";
import { decisionFromFactors } from "./explain";
import { clamp, MASTERY_TARGET } from "@/lib/utils";

export const BASELINE_POLICY_VERSION = "1.0.0";

/**
 * Deterministic uniform draw in [0, 1) from three integers.
 *
 * A 32-bit integer mix (xorshift/multiply finaliser). The `>>> 0` coercions are
 * load-bearing: JavaScript bitwise operators yield *signed* int32, so without
 * them every draw lands in (-0.5, 0.5) and the "random" arm silently stops
 * being uniform. That exact bug once made a whole benchmark run meaningless.
 */
export function deterministicUniform(a: number, b: number, c: number): number {
  let h = (Math.trunc(a) | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (Math.trunc(b) | 0), 0x85ebca6b);
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h ^ (Math.trunc(c) | 0), 0xc2b2ae35);
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4_294_967_296;
}

/** Stable numeric hash of a string, for seeding from non-numeric identifiers. */
export function stableStringHash(value: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < value.length; i += 1) {
    h = (h ^ value.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function eligiblePool(input: SelectionInput): CandidateItem[] {
  return input.candidates
    .filter((c) => !input.seenQuestionIds.has(c.questionId))
    // Sort by id so the pool order never depends on upstream query ordering.
    .sort((a, b) => a.questionId - b.questionId);
}

function skillOf(input: SelectionInput, candidate: CandidateItem): LearnerSkillState | undefined {
  return input.learner.skills.get(candidate.skillId);
}

function predictFor(input: SelectionInput, candidate: CandidateItem): number {
  const skill = skillOf(input, candidate);
  if (!skill) return 0.5;
  return input.responseModel.predict({ learner: input.learner, skill, item: candidate.item });
}

/** Wrap a chosen candidate in the shared ScoredItem + DecisionExplanation shape. */
function toResult(params: {
  input: SelectionInput;
  policyId: string;
  chosen: CandidateItem | null;
  ordered: CandidateItem[];
  score: number;
  factors: DecisionFactor[];
  explanation: string;
}): SelectionResult {
  const { input, chosen, ordered } = params;
  const excluded = input.candidates.length - ordered.length;
  if (!chosen) return { chosen: null, ranked: [], excluded };

  const skill = skillOf(input, chosen);
  const predictedCorrect = predictFor(input, chosen);
  const fallbackSkill: LearnerSkillState = {
    skillId: chosen.skillId,
    skillName: chosen.skillName,
    subjectName: chosen.subjectName,
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

  const decision = decisionFromFactors({
    policyId: params.policyId,
    policyVersion: BASELINE_POLICY_VERSION,
    configFingerprint: `${params.policyId}@${BASELINE_POLICY_VERSION}`,
    skill: skill ?? fallbackSkill,
    questionId: chosen.questionId,
    score: params.score,
    rank: 1,
    candidatesConsidered: ordered.length,
    candidatesFiltered: excluded,
    factors: params.factors,
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
    predictedCorrect,
    masteryTarget: input.target ?? MASTERY_TARGET,
    successTarget: 0.75,
    explanation: params.explanation,
  });

  const scored: ScoredItem = {
    candidate: chosen,
    score: params.score,
    predictedCorrect,
    information: 4 * predictedCorrect * (1 - predictedCorrect),
    expectedLearningGain: clamp(
      ((input.target ?? MASTERY_TARGET) - (skill?.mastery ?? 0)) / (input.target ?? MASTERY_TARGET),
      0,
      1,
    ),
    factors: params.factors,
    explanation: params.explanation,
    steps: params.factors.map((f) => ({ label: f.key, value: f.value.toFixed(3), tone: "neutral" })),
    decision,
  };
  return { chosen: scored, ranked: [scored], excluded };
}

/* ------------------------------------------------------------------ */
/* random                                                              */
/* ------------------------------------------------------------------ */

/**
 * Uniformly random over unseen items — the floor any adaptive policy must beat.
 *
 * Seeded from (learnerId, items answered so far, question count) so the same
 * learner in the same session state always receives the same item. Replaying a
 * session reproduces it exactly, which is what makes a random arm auditable.
 */
export class RandomBaselinePolicy implements ItemSelectionStrategy {
  readonly id = "baseline-random";

  select(input: SelectionInput): SelectionResult {
    const ordered = eligiblePool(input);
    if (!ordered.length) return { chosen: null, ranked: [], excluded: input.candidates.length };

    const learnerSeed = input.learner.studentId;
    const draw = deterministicUniform(learnerSeed, input.seenQuestionIds.size, ordered.length);
    const chosen = ordered[Math.min(ordered.length - 1, Math.floor(draw * ordered.length))];

    return toResult({
      input,
      policyId: this.id,
      chosen,
      ordered,
      score: draw,
      factors: [
        {
          key: "uniformRandom",
          value: draw,
          weighted: draw,
          detail: "Uniform draw over unseen items (seeded control arm — no adaptation)",
        },
      ],
      explanation:
        "Random control arm: selected uniformly at random from unseen questions. " +
        "No learner state was consulted.",
    });
  }
}

/* ------------------------------------------------------------------ */
/* difficulty-only                                                     */
/* ------------------------------------------------------------------ */

/**
 * Matches item difficulty to the learner's overall estimated ability, ignoring
 * which skill needs work. Isolates "keep it at the right level" from every
 * other adaptive behaviour.
 */
export class DifficultyBaselinePolicy implements ItemSelectionStrategy {
  readonly id = "baseline-difficulty";

  select(input: SelectionInput): SelectionResult {
    const ordered = eligiblePool(input);
    if (!ordered.length) return { chosen: null, ranked: [], excluded: input.candidates.length };

    const ability = clamp(input.learner.ability, 0, 1);
    let chosen: CandidateItem | null = null;
    let bestDistance = Infinity;
    for (const candidate of ordered) {
      const distance = Math.abs(candidate.item.difficulty - ability);
      if (distance < bestDistance - 1e-9) {
        bestDistance = distance;
        chosen = candidate;
      }
    }

    const fit = clamp(1 - bestDistance, 0, 1);
    return toResult({
      input,
      policyId: this.id,
      chosen,
      ordered,
      score: fit,
      factors: [
        {
          key: "difficultyFit",
          value: fit,
          weighted: fit,
          detail: `Item difficulty is ${bestDistance.toFixed(3)} from estimated ability ${ability.toFixed(3)}`,
        },
      ],
      explanation:
        `Difficulty-matching control arm: chose the unseen item closest in difficulty to the ` +
        `learner's overall ability (${ability.toFixed(2)}). Skill priority and prerequisites were ignored.`,
    });
  }
}

/* ------------------------------------------------------------------ */
/* mastery-gap                                                         */
/* ------------------------------------------------------------------ */

/**
 * Always works the least-mastered skill, taking its easiest unseen item.
 *
 * The strongest of the three controls, and not by accident: "weakest topic
 * first, easy to hard" is a real curriculum, which is why it beat every
 * adaptive policy in offline simulation. Tie-breaking on *lowest difficulty* is
 * the load-bearing detail — see SIMULATION.md §6.1.
 */
export class MasteryGapBaselinePolicy implements ItemSelectionStrategy {
  readonly id = "baseline-mastery-gap";

  select(input: SelectionInput): SelectionResult {
    const ordered = eligiblePool(input);
    if (!ordered.length) return { chosen: null, ranked: [], excluded: input.candidates.length };

    const target = input.target ?? MASTERY_TARGET;
    let chosen: CandidateItem | null = null;
    let bestGap = -Infinity;
    let bestDifficulty = Infinity;

    for (const candidate of ordered) {
      const mastery = skillOf(input, candidate)?.mastery ?? 0;
      const gap = target - mastery;
      // Largest gap wins; within a skill, the easiest item wins.
      if (gap > bestGap + 1e-9 || (Math.abs(gap - bestGap) <= 1e-9 && candidate.item.difficulty < bestDifficulty)) {
        bestGap = gap;
        bestDifficulty = candidate.item.difficulty;
        chosen = candidate;
      }
    }

    const normalisedGap = clamp(bestGap / Math.max(1e-6, target), 0, 1);
    return toResult({
      input,
      policyId: this.id,
      chosen,
      ordered,
      score: normalisedGap,
      factors: [
        {
          key: "masteryGap",
          value: normalisedGap,
          weighted: normalisedGap,
          detail: `Largest gap to the ${target.toFixed(2)} mastery target (${bestGap.toFixed(3)})`,
        },
      ],
      explanation:
        "Mastery-gap control arm: chose the easiest unseen item in the least-mastered skill. " +
        "Difficulty targeting and prerequisites were ignored.",
    });
  }
}

export const randomBaselinePolicy = new RandomBaselinePolicy();
export const difficultyBaselinePolicy = new DifficultyBaselinePolicy();
export const masteryGapBaselinePolicy = new MasteryGapBaselinePolicy();
