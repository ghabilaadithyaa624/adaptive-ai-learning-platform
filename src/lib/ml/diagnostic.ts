/** Deterministic cold-start diagnostic selection and stopping policy. */
import { clamp, mean } from "@/lib/utils";
import type { CandidateItem, LearnerState } from "./interfaces";

export type DiagnosticKind = "random" | "fixed" | "adaptive";
export interface DiagnosticConfig { minItems: number; maxItems: number; targetMeanUncertainty: number; minSkillCoverage: number }
export const DEFAULT_DIAGNOSTIC_CONFIG: DiagnosticConfig = { minItems: 6, maxItems: 12, targetMeanUncertainty: .58, minSkillCoverage: .75 };

export interface DiagnosticInput {
  kind: DiagnosticKind;
  learner: LearnerState;
  candidates: CandidateItem[];
  seenQuestionIds: Set<number>;
  targetSkillIds: number[];
  /** Stable seed; never use answer content or answer keys. */
  seed?: number;
}

const hash = (seed: number, id: number) => {
  let x = (seed ^ Math.imul(id, 0x45d9f3b)) | 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b); x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
};

/** Expected normalized Beta(1,1)-posterior variance after one Bernoulli response. */
function expectedUncertainty(learner: LearnerState, c: CandidateItem): number {
  const s = learner.skills.get(c.skillId);
  const n = s?.attempts ?? 0;
  const correct = s?.correct ?? 0;
  const a = 1 + correct, b = 1 + n - correct;
  const p = a / (a + b);
  const variance = (aa: number, bb: number) => (aa * bb) / ((aa + bb) ** 2 * (aa + bb + 1));
  return clamp(12 * (p * variance(a + 1, b) + (1 - p) * variance(a, b + 1)));
}

/**
 * Selects diagnostic items without accepting answer keys. Foundations are
 * sampled before dependent skills; adaptive mode then maximizes expected
 * uncertainty reduction with broad-coverage and moderate-difficulty terms.
 */
export function selectDiagnosticItem(input: DiagnosticInput): CandidateItem | null {
  const target = new Set(input.targetSkillIds);
  const pool = input.candidates.filter(c => target.has(c.skillId) && !input.seenQuestionIds.has(c.questionId));
  if (!pool.length) return null;
  const ordered = [...pool].sort((a, b) => a.questionId - b.questionId);
  if (input.kind === "random") return [...ordered].sort((a, b) => hash(input.seed ?? 0, a.questionId) - hash(input.seed ?? 0, b.questionId) || a.questionId - b.questionId)[0];

  const score = (c: CandidateItem) => {
    const s = input.learner.skills.get(c.skillId);
    const attempts = s?.attempts ?? 0;
    const foundation = (s?.prereqIds.length ?? 0) === 0 ? 1 : 0;
    const coverage = attempts === 0 ? 1 : 0;
    const difficultyFit = 1 - Math.abs(c.item.difficulty - .5);
    if (input.kind === "fixed") return foundation * coverage * 100 + coverage * 10 + difficultyFit;
    const current = s?.uncertainty ?? 1;
    const reduction = Math.max(0, current - expectedUncertainty(input.learner, c));
    // Coverage dominates only until every foundation has evidence. No response
    // is interpreted as proof of weakness; all skill estimates retain uncertainty.
    return foundation * (attempts === 0 ? 4 : .2) + coverage * 2 + reduction * 3 + difficultyFit * .35 + (c.item.discrimination ?? 1) * .15;
  };
  return ordered.reduce((best, c) => score(c) > score(best) + 1e-12 ? c : best);
}

export function diagnosticProgress(learner: LearnerState, targetSkillIds: number[]) {
  const states = targetSkillIds.map(id => learner.skills.get(id)).filter(Boolean);
  const covered = states.filter(s => s!.attempts > 0).length;
  return {
    skills: states.length,
    covered,
    coverage: states.length ? covered / states.length : 0,
    meanUncertainty: states.length ? mean(states.map(s => s!.uncertainty)) : 1,
  };
}

/** Early stopping requires both breadth and confidence; never stops on low scores alone. */
export function shouldStopDiagnostic(learner: LearnerState, targetSkillIds: number[], answered: number, config = DEFAULT_DIAGNOSTIC_CONFIG): boolean {
  return shouldStopDiagnosticEvidence(
    targetSkillIds.map(id => ({ skillId: id, attempts: learner.skills.get(id)?.attempts ?? 0, uncertainty: learner.skills.get(id)?.uncertainty ?? 1 })),
    answered,
    config,
  );
}

export function shouldStopDiagnosticEvidence(
  evidence: { skillId: number; attempts: number; uncertainty: number }[],
  answered: number,
  config = DEFAULT_DIAGNOSTIC_CONFIG,
): boolean {
  if (answered >= config.maxItems) return true;
  if (answered < config.minItems || !evidence.length) return false;
  const coverage = evidence.filter(e => e.attempts > 0).length / evidence.length;
  return coverage >= config.minSkillCoverage && mean(evidence.map(e => e.uncertainty)) <= config.targetMeanUncertainty;
}
