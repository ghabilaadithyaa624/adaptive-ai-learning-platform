/**
 * Deterministic exploration bonuses for the item selector.
 *
 * We treat each skill as an "arm" and use UCB1 — the classic
 * exploration/exploitation rule — which is fully deterministic given the pull
 * counts (unlike Thompson sampling, which we deliberately avoid to keep the
 * engine reproducible and explainable).
 *
 *   ucb = mean_reward + c * sqrt( ln(totalPulls + 1) / (armPulls + 1) )
 *
 * The bonus term is what we surface: it is large for skills with little evidence
 * and shrinks as a skill is practised, implementing principled exploration.
 */
import { clamp } from "@/lib/utils";

/** UCB1 exploration bonus, normalised to roughly 0..1. */
export function ucbBonus(armPulls: number, totalPulls: number, c = 0.9) {
  const bonus = c * Math.sqrt(Math.log(totalPulls + 1) / (armPulls + 1));
  return clamp(bonus, 0, 1);
}

/** Full UCB score = exploit (mean reward) + explore (bonus). */
export function ucbScore(meanReward: number, armPulls: number, totalPulls: number, c = 0.9) {
  return clamp(meanReward, 0, 1) + ucbBonus(armPulls, totalPulls, c);
}
