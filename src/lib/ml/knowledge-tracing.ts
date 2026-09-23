/**
 * Bayesian Knowledge Tracing (BKT) with forgetting-curve decay.
 *
 * Each (student, skill) pair keeps latent mastery P(L) plus the four classic
 * BKT parameters. Every observed response produces a posterior update, then a
 * learning transition, then exponential decay based on time since practice.
 */
import { clamp, daysBetween } from "@/lib/utils";

export const DEFAULT_BKT = {
  slip: 0.1,
  guess: 0.2,
  learn: 0.22,
  forget: 0.035,
};

export type BktParams = typeof DEFAULT_BKT;

export function applyDecay(mastery: number, lastPracticedAt: Date | string | null, forget = DEFAULT_BKT.forget) {
  if (!lastPracticedAt) return mastery;
  const days = Math.max(0, daysBetween(lastPracticedAt));
  return clamp(mastery * Math.exp(-forget * days), 0.01, 0.995);
}

export function posterior(mastery: number, isCorrect: boolean, params: BktParams = DEFAULT_BKT) {
  const { slip, guess, learn } = params;
  const numerator = isCorrect ? mastery * (1 - slip) : mastery * slip;
  const denominator = isCorrect
    ? mastery * (1 - slip) + (1 - mastery) * guess
    : mastery * slip + (1 - mastery) * (1 - guess);
  const posteriorMastery = denominator === 0 ? mastery : numerator / denominator;
  const learned = posteriorMastery + (1 - posteriorMastery) * learn;
  return clamp(learned, 0.01, 0.995);
}

export function predictCorrect(mastery: number, params: BktParams = DEFAULT_BKT) {
  const { slip, guess } = params;
  return clamp(mastery * (1 - slip) + (1 - mastery) * guess, 0.02, 0.98);
}

export function decayedMastery(
  state: { mastery: number; lastPracticedAt: Date | string | null },
  params: BktParams = DEFAULT_BKT,
) {
  return applyDecay(state.mastery, state.lastPracticedAt, params.forget);
}
