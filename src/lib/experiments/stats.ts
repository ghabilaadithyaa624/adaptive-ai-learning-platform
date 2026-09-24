/**
 * Statistics for experiment readouts.
 *
 * Scope note: these are *estimation* tools, not decision tools. There is no
 * `isSignificant`, no `winner`, no p-value threshold, and no power calculator
 * that tells you when to stop. Every function returns a point estimate with an
 * interval, and interpreting it is the reader's job.
 *
 * That is a deliberate constraint rather than an omission. A framework that
 * emits "variant B wins" invites shipping on the first boundary-crossing
 * interval, which in an always-on readout is a near-certainty regardless of
 * whether an effect exists. Reporting the interval and refusing to threshold it
 * keeps the multiple-comparisons problem visible to the person who has to
 * defend the decision.
 *
 * Everything here is deterministic: the bootstrap is seeded, so the same data
 * yields the same interval on every run.
 */

export interface Interval {
  lower: number;
  upper: number;
  /** Nominal coverage, e.g. 0.95. */
  level: number;
  method: string;
}

export interface SampleSummary {
  n: number;
  mean: number;
  sd: number;
  /** Standard error of the mean. */
  se: number;
  min: number;
  max: number;
  median: number;
  /** Mean with an uncertainty interval. Null when n < 2. */
  interval: Interval | null;
}

export const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function sampleSd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Two-sided critical value from Student's t.
 *
 * A small lookup with interpolation rather than an incomplete-beta
 * implementation: the table is exact at the tabulated df, the interpolation
 * error between them is well under the rounding we report, and it keeps a
 * numerically delicate special function out of a module that has to be right.
 */
function tCritical(df: number, level: number): number {
  const table: Record<number, [number, number]> = {
    // df: [t_0.90, t_0.95]  (two-sided 90% / 95%)
    1: [6.314, 12.706],
    2: [2.92, 4.303],
    3: [2.353, 3.182],
    4: [2.132, 2.776],
    5: [2.015, 2.571],
    6: [1.943, 2.447],
    8: [1.86, 2.306],
    10: [1.812, 2.228],
    15: [1.753, 2.131],
    20: [1.725, 2.086],
    30: [1.697, 2.042],
    50: [1.676, 2.009],
    100: [1.66, 1.984],
    200: [1.653, 1.972],
    1000: [1.646, 1.962],
  };
  const idx = level >= 0.95 ? 1 : 0;
  const keys = Object.keys(table)
    .map(Number)
    .sort((a, b) => a - b);
  if (df <= keys[0]) return table[keys[0]][idx];
  if (df >= keys[keys.length - 1]) return level >= 0.95 ? 1.96 : 1.645;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const a = keys[i];
    const b = keys[i + 1];
    if (df >= a && df <= b) {
      const w = (df - a) / (b - a);
      return table[a][idx] + (table[b][idx] - table[a][idx]) * w;
    }
  }
  return 1.96;
}

/** Mean, spread and a t-based interval for one sample. */
export function summarise(values: number[], level = 0.95): SampleSummary {
  const n = values.length;
  const sorted = [...values].sort((a, b) => a - b);
  const m = mean(values);
  const sd = sampleSd(values);
  const se = n > 0 ? sd / Math.sqrt(n) : 0;
  const interval =
    n >= 2
      ? {
          lower: m - tCritical(n - 1, level) * se,
          upper: m + tCritical(n - 1, level) * se,
          level,
          method: "student-t",
        }
      : null;
  return {
    n,
    mean: m,
    sd,
    se,
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    median: quantile(sorted, 0.5),
    interval,
  };
}

/* ------------------------------------------------------------------ */
/* Two-sample comparison                                               */
/* ------------------------------------------------------------------ */

export interface DifferenceEstimate {
  /** treatment mean − control mean. */
  absolute: number;
  /** Relative to the control mean. Null when the control mean is ~0. */
  relative: number | null;
  interval: Interval;
  /** Standardised mean difference (Hedges' g). Null when undefined. */
  effectSize: number | null;
}

/**
 * Welch's unequal-variance difference in means.
 *
 * Welch rather than pooled-variance Student because experiment arms routinely
 * differ in both size and spread — an arm that changes *who finishes* changes
 * the variance too, and the pooled test understates uncertainty exactly when
 * the treatment is doing something interesting.
 */
export function differenceInMeans(
  treatment: number[],
  control: number[],
  level = 0.95,
): DifferenceEstimate | null {
  const nT = treatment.length;
  const nC = control.length;
  if (nT < 2 || nC < 2) return null;

  const mT = mean(treatment);
  const mC = mean(control);
  const vT = sampleSd(treatment) ** 2;
  const vC = sampleSd(control) ** 2;
  const se = Math.sqrt(vT / nT + vC / nC);
  const absolute = mT - mC;

  // Welch–Satterthwaite degrees of freedom.
  const df =
    se === 0
      ? nT + nC - 2
      : (vT / nT + vC / nC) ** 2 /
        ((vT / nT) ** 2 / Math.max(1, nT - 1) + (vC / nC) ** 2 / Math.max(1, nC - 1));

  const t = tCritical(df, level);

  // Hedges' g: Cohen's d with the small-sample correction, which matters at the
  // cohort sizes a single-institution experiment actually reaches.
  const pooledSd = Math.sqrt(((nT - 1) * vT + (nC - 1) * vC) / Math.max(1, nT + nC - 2));
  const dof = nT + nC - 2;
  const correction = dof > 2 ? 1 - 3 / (4 * dof - 1) : 1;
  const effectSize = pooledSd > 0 ? (absolute / pooledSd) * correction : null;

  return {
    absolute,
    relative: Math.abs(mC) > 1e-9 ? absolute / mC : null,
    interval: { lower: absolute - t * se, upper: absolute + t * se, level, method: "welch-t" },
    effectSize,
  };
}

/* ------------------------------------------------------------------ */
/* Proportions                                                         */
/* ------------------------------------------------------------------ */

export interface ProportionSummary {
  successes: number;
  trials: number;
  rate: number;
  interval: Interval | null;
}

/**
 * Wilson score interval.
 *
 * Preferred over the normal approximation because completion and acceptance
 * rates sit near 0 or 1 often enough that Wald intervals produce bounds outside
 * [0, 1] — an interval that is visibly impossible destroys trust in the whole
 * readout.
 */
export function proportionSummary(successes: number, trials: number, level = 0.95): ProportionSummary {
  if (trials <= 0) return { successes, trials, rate: 0, interval: null };
  const z = level >= 0.95 ? 1.959964 : 1.644854;
  const p = successes / trials;
  const denom = 1 + (z * z) / trials;
  const centre = (p + (z * z) / (2 * trials)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / trials + (z * z) / (4 * trials * trials))) / denom;
  return {
    successes,
    trials,
    rate: p,
    interval: {
      lower: Math.max(0, centre - margin),
      upper: Math.min(1, centre + margin),
      level,
      method: "wilson",
    },
  };
}

/* ------------------------------------------------------------------ */
/* Bootstrap                                                           */
/* ------------------------------------------------------------------ */

/** Deterministic PRNG so bootstrap intervals are reproducible run to run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
    t = (t + Math.imul(t ^ (t >>> 7), t | 61)) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * Percentile bootstrap for the difference in means.
 *
 * Reported alongside the Welch interval rather than instead of it: when the two
 * disagree, the outcome distribution is skewed enough that the reader should
 * know before interpreting either. Metrics like time-to-mastery are routinely
 * that skewed.
 */
export function bootstrapDifference(
  treatment: number[],
  control: number[],
  opts: { iterations?: number; level?: number; seed?: number } = {},
): Interval | null {
  const iterations = opts.iterations ?? 2000;
  const level = opts.level ?? 0.95;
  const rand = mulberry32(opts.seed ?? 0x5eed);
  if (treatment.length < 2 || control.length < 2) return null;

  const diffs: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    let sumT = 0;
    for (let j = 0; j < treatment.length; j += 1) {
      sumT += treatment[Math.floor(rand() * treatment.length)];
    }
    let sumC = 0;
    for (let j = 0; j < control.length; j += 1) {
      sumC += control[Math.floor(rand() * control.length)];
    }
    diffs.push(sumT / treatment.length - sumC / control.length);
  }
  diffs.sort((a, b) => a - b);
  const alpha = (1 - level) / 2;
  return {
    lower: quantile(diffs, alpha),
    upper: quantile(diffs, 1 - alpha),
    level,
    method: `percentile-bootstrap-${iterations}`,
  };
}

/* ------------------------------------------------------------------ */
/* Sample-size context                                                 */
/* ------------------------------------------------------------------ */

/**
 * The smallest true difference this sample could resolve, expressed as the
 * half-width of the interval.
 *
 * This is the honest antidote to reading a null result as "no effect": if the
 * resolution is ±0.15 and the observed difference is 0.02, the experiment has
 * not shown the arms are equivalent — it has shown it cannot tell. Reported on
 * every comparison for exactly that reason.
 */
export function resolution(treatment: number[], control: number[], level = 0.95): number | null {
  const est = differenceInMeans(treatment, control, level);
  if (!est) return null;
  return (est.interval.upper - est.interval.lower) / 2;
}
