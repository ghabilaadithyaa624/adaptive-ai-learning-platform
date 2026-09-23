/**
 * Adaptive item selection (CAT-style).
 *
 * Two stage strategy:
 *   1. Pick the focus skill: highest priority = low decayed mastery + weak
 *      evidence + prerequisite readiness (so we never jump ahead of prereqs).
 *   2. Inside that skill, choose the item whose predicted success probability
 *      sits closest to the flow band (default 0.75), maximising Fisher
 *      information p(1-p) without repeating recently seen items.
 */
import { clamp } from "@/lib/utils";
import type { ClassifierModel } from "./classifier";
import { predictProbability, type FeatureSample } from "./classifier";

export type AdaptiveCandidate = {
  questionId: number;
  skillId: number;
  skillName: string;
  difficultyBase: number;
  bloom: number;
  estimatedSeconds: number;
  text: string;
};

export type ScoredCandidate = {
  candidate: AdaptiveCandidate;
  probability: number;
  information: number;
  score: number;
  rationale: string;
};

export type SkillPriorityInput = {
  skillId: number;
  mastery: number;
  attempts: number;
  prereqReadiness: number;
  pathAlignment: number;
  daysSincePractice: number;
};

export function skillPriority(input: SkillPriorityInput) {
  const gap = clamp(1 - input.mastery);
  const evidence = clamp(input.attempts / 12);
  const staleness = clamp(input.daysSincePractice / 30);
  return clamp(
    gap * (0.6 + 0.4 * evidence) * (0.55 + 0.45 * input.prereqReadiness) * 0.75 +
      staleness * 0.15 +
      input.pathAlignment * 0.1,
    0,
    1,
  );
}

export function scoreCandidates(params: {
  candidates: AdaptiveCandidate[];
  skillPriorities: Map<number, number>;
  askedCounts: Map<number, number>;
  model: ClassifierModel;
  ability: number;
  baseSample: Omit<FeatureSample, "difficultyBase" | "bloom">;
  targetProb?: number;
  seen: Set<number>;
}) {
  const target = params.targetProb ?? 0.75;
  const scored: ScoredCandidate[] = [];

  for (const candidate of params.candidates) {
    if (params.seen.has(candidate.questionId)) continue;
    const probability = predictProbability(params.model, {
      ...params.baseSample,
      difficultyBase: candidate.difficultyBase,
      bloom: candidate.bloom,
    });
    const information = probability * (1 - probability) * 4;
    const distance = Math.abs(probability - target);
    const priority = params.skillPriorities.get(candidate.skillId) ?? 0.3;
    const seenInSkill = params.askedCounts.get(candidate.skillId) ?? 0;
    const coveragePenalty = clamp(seenInSkill / 6) * 0.35;
    const score = clamp(priority * 0.45 + (1 - distance) * 0.35 + information * 0.2 - coveragePenalty, -1, 2);
    const direction = probability > target ? "below" : "above";
    scored.push({
      candidate,
      probability,
      information,
      score,
      rationale:
        `Focus skill priority ${(priority * 100).toFixed(0)}/100 · predicted success ${(probability * 100).toFixed(0)}% ` +
        `(${direction === "below" ? "stretch item" : "consolidation item"}) · information gain ${information.toFixed(2)}`,
    });
  }

  scored.sort((a, b) => b.score - a.score || a.candidate.questionId - b.candidate.questionId);
  return scored;
}

export function selectNextItem(params: Parameters<typeof scoreCandidates>[0]) {
  const scored = scoreCandidates(params);
  return scored[0] ?? null;
}

export type AdaptiveStep = {
  label: string;
  value: string;
  tone: "sky" | "emerald" | "amber" | "rose" | "slate";
};

export function adaptiveRationale(candidate: ScoredCandidate, masteryBefore: number): AdaptiveStep[] {
  return [
    { label: "Latent mastery", value: `${(masteryBefore * 100).toFixed(0)}%`, tone: "sky" },
    { label: "Predicted success", value: `${(candidate.probability * 100).toFixed(0)}%`, tone: "emerald" },
    { label: "Item difficulty", value: `${(candidate.candidate.difficultyBase * 100).toFixed(0)}%`, tone: "amber" },
    { label: "Info gain", value: candidate.information.toFixed(2), tone: "slate" },
  ];
}
