/**
 * Paired statistics for policy comparison.
 *
 * Because every policy is run on exactly the same cells with common random
 * numbers, comparisons are *paired* — the right analysis is on the per-cell
 * differences, not on the marginal means. We report three complementary things:
 *
 *   • effect size   — Cohen's dz on the paired differences
 *   • uncertainty   — a deterministic (seeded) bootstrap CI of the mean difference
 *   • robustness    — an exact two-sided sign test, which makes no distributional
 *                     assumption and is insensitive to a single lucky cell
 *
 * A claim of improvement requires all three to agree (see `protocol.ts`).
 */
import { hashUniform } from "./world";

export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function sd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

export interface BootstrapCI {
  mean: number;
  lower: number;
  upper: number;
  iterations: number;
}

/**
 * Percentile bootstrap of the mean paired difference. Resampling indices come
 * from the hash-based uniform stream, so the interval is identical on every run
 * and on every machine.
 */
export function bootstrapMeanCI(values: number[], opts: { iterations?: number; alpha?: number; seed?: number } = {}): BootstrapCI {
  const iterations = opts.iterations ?? 2000;
  const alpha = opts.alpha ?? 0.05;
  const seed = opts.seed ?? 20260924;
  if (!values.length) return { mean: 0, lower: 0, upper: 0, iterations };
  const means: number[] = [];
  for (let b = 0; b < iterations; b += 1) {
    let sum = 0;
    for (let i = 0; i < values.length; i += 1) {
      const u = hashUniform(seed, b, i);
      sum += values[Math.min(values.length - 1, Math.floor(u * values.length))];
    }
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);
  const lo = Math.floor((alpha / 2) * (iterations - 1));
  const hi = Math.ceil((1 - alpha / 2) * (iterations - 1));
  return { mean: mean(values), lower: means[lo], upper: means[hi], iterations };
}

function logFactorial(n: number): number {
  let acc = 0;
  for (let i = 2; i <= n; i += 1) acc += Math.log(i);
  return acc;
}

function binomialPmf(k: number, n: number): number {
  return Math.exp(logFactorial(n) - logFactorial(k) - logFactorial(n - k) - n * Math.log(2));
}

export interface SignTest {
  wins: number;
  losses: number;
  ties: number;
  pValue: number;
}

/** Exact two-sided sign test on paired differences (ties dropped). */
export function signTest(values: number[], epsilon = 1e-9): SignTest {
  const wins = values.filter((v) => v > epsilon).length;
  const losses = values.filter((v) => v < -epsilon).length;
  const ties = values.length - wins - losses;
  const n = wins + losses;
  if (n === 0) return { wins, losses, ties, pValue: 1 };
  const k = Math.min(wins, losses);
  let tail = 0;
  for (let i = 0; i <= k; i += 1) tail += binomialPmf(i, n);
  return { wins, losses, ties, pValue: Math.min(1, 2 * tail) };
}

/** Paired effect size (Cohen's dz). */
export function cohensDz(values: number[]): number {
  const s = sd(values);
  return s === 0 ? 0 : mean(values) / s;
}

export interface PairedComparison {
  metric: string;
  /** true = larger is better. */
  higherIsBetter: boolean;
  candidate: number;
  baseline: number;
  absoluteDelta: number;
  relativeDelta: number;
  ci: BootstrapCI;
  sign: SignTest;
  dz: number;
  winRate: number;
  n: number;
}

/**
 * Compare a candidate against a baseline on one metric, cell by cell.
 * Differences are oriented so that positive always means "candidate is better".
 */
export function comparePaired(params: {
  metric: string;
  higherIsBetter: boolean;
  candidate: number[];
  baseline: number[];
  seed?: number;
}): PairedComparison {
  const { metric, higherIsBetter, candidate, baseline } = params;
  const n = Math.min(candidate.length, baseline.length);
  const deltas: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const raw = candidate[i] - baseline[i];
    deltas.push(higherIsBetter ? raw : -raw);
  }
  const candidateMean = mean(candidate.slice(0, n));
  const baselineMean = mean(baseline.slice(0, n));
  const absolute = candidateMean - baselineMean;
  const denominator = Math.abs(baselineMean);
  const oriented = higherIsBetter ? absolute : -absolute;
  const sign = signTest(deltas);
  return {
    metric,
    higherIsBetter,
    candidate: candidateMean,
    baseline: baselineMean,
    absoluteDelta: absolute,
    relativeDelta: denominator > 1e-9 ? oriented / denominator : 0,
    ci: bootstrapMeanCI(deltas, { seed: params.seed }),
    sign,
    dz: cohensDz(deltas),
    winRate: sign.wins + sign.losses > 0 ? sign.wins / (sign.wins + sign.losses) : 0,
    n,
  };
}
