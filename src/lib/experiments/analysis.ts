/**
 * Experiment readout.
 *
 * ## The framework does not declare winners
 *
 * This is enforced structurally, not by convention. `VariantComparison` has no
 * `winner`, no `significant`, no `recommendation` and no `pValue` — there is
 * nothing for a caller to read that would let a dashboard render "Variant B
 * wins 🎉" without the reader doing the interpretation themselves.
 *
 * Three reasons this is the right default for *learning* experiments:
 *
 *  1. **Peeking.** Learning outcomes accrue over weeks, so readouts get checked
 *     repeatedly. Any fixed threshold applied to a repeatedly-viewed interval
 *     will eventually be crossed by noise alone.
 *  2. **Multiplicity.** With four primary and six secondary metrics across
 *     several arms, something is nearly always "significant". Emitting a
 *     verdict per metric would industrialise that error.
 *  3. **The metrics disagree on purpose.** A policy can raise mastery gain and
 *     depress completion. Which trade is acceptable is a product judgement, and
 *     collapsing it into one boolean hides the judgement rather than making it.
 *
 * What is provided instead: point estimates, uncertainty intervals, effect
 * sizes, censoring counts, sample sizes, and an explicit statement of the
 * smallest difference the data could resolve. Enough to decide; not enough to
 * avoid deciding.
 */
import {
  bootstrapDifference,
  differenceInMeans,
  resolution,
  summarise,
  type DifferenceEstimate,
  type Interval,
  type SampleSummary,
} from "./stats";
import { METRIC_DEFINITIONS, type Experiment, type MetricKey } from "./types";
import type { AttributionResult } from "./attribution";

export interface VariantMetricSummary {
  variantKey: string;
  /** Learners contributing a value. */
  summary: SampleSummary;
  /** Learners assigned and exposed but with no qualifying observation. */
  censored: number;
  /** Share of exposed learners that contributed. Low values warn of bias. */
  coverage: number;
}

/**
 * A comparison of one variant against the control on one metric.
 *
 * Note what is absent. There is no verdict field of any kind — see the module
 * docstring.
 */
export interface VariantComparison {
  variantKey: string;
  controlKey: string;
  metric: MetricKey;
  /** treatment − control, with a Welch interval and Hedges' g. Null if n < 2. */
  difference: DifferenceEstimate | null;
  /** Percentile bootstrap on the same difference; disagreement signals skew. */
  bootstrapInterval: Interval | null;
  /**
   * Half-width of the interval — the smallest difference this sample could
   * resolve. Reported so a null result is not misread as evidence of no effect.
   */
  resolution: number | null;
  /** True when `higherIsBetter` is false for this metric (rendering hint only). */
  lowerIsBetter: boolean;
}

export interface MetricReadout {
  metric: MetricKey;
  label: string;
  definition: string;
  unit: string;
  isPrimary: boolean;
  variants: VariantMetricSummary[];
  comparisons: VariantComparison[];
}

export interface ExperimentReadout {
  experimentId: number;
  experimentKey: string;
  status: string;
  controlKey: string | null;
  generatedAt: Date;
  /** Exposed learners per variant. */
  exposureByVariant: Record<string, number>;
  primary: MetricReadout | null;
  secondary: MetricReadout[];
  diagnostics: AttributionResult["diagnostics"];
  /**
   * Machine-readable statements about what this readout does NOT establish.
   * Emitted with the data so a downstream consumer cannot strip the caveats by
   * rendering only the numbers.
   */
  interpretationNotes: string[];
}

function summariseMetric(
  metric: MetricKey,
  attribution: AttributionResult,
  controlKey: string | null,
  isPrimary: boolean,
): MetricReadout {
  const series = attribution.series[metric];
  const def = METRIC_DEFINITIONS[metric];

  const variantKeys = Object.keys(series.byVariant).sort();
  const variants: VariantMetricSummary[] = variantKeys.map((key) => {
    const values = series.byVariant[key].map((v) => v.value);
    const censored = series.censoredByVariant[key] ?? 0;
    const exposed = values.length + censored;
    return {
      variantKey: key,
      summary: summarise(values),
      censored,
      coverage: exposed > 0 ? values.length / exposed : 0,
    };
  });

  const comparisons: VariantComparison[] = [];
  if (controlKey && series.byVariant[controlKey]) {
    const control = series.byVariant[controlKey].map((v) => v.value);
    for (const key of variantKeys) {
      if (key === controlKey) continue;
      const treatment = series.byVariant[key].map((v) => v.value);
      comparisons.push({
        variantKey: key,
        controlKey,
        metric,
        difference: differenceInMeans(treatment, control),
        // Seeded from the variant name so the interval is stable across runs
        // but differs between arms (independent resamples, not a shared stream).
        bootstrapInterval: bootstrapDifference(treatment, control, {
          seed: [...key].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7),
        }),
        resolution: resolution(treatment, control),
        lowerIsBetter: !def.higherIsBetter,
      });
    }
  }

  return {
    metric,
    label: def.label,
    definition: def.definition,
    unit: def.unit,
    isPrimary,
    variants,
    comparisons,
  };
}

/**
 * Build the full readout for an experiment.
 *
 * Deterministic: the same attribution input always produces the same numbers,
 * including bootstrap bounds.
 */
export function buildReadout(params: {
  experiment: Pick<
    Experiment,
    "id" | "key" | "status" | "variants" | "primaryMetric" | "secondaryMetrics"
  >;
  attribution: AttributionResult;
  exposureByVariant: Record<string, number>;
  generatedAt: Date;
}): ExperimentReadout {
  const { experiment, attribution } = params;
  const controlKey = experiment.variants.find((v) => v.isControl)?.key ?? null;

  const primary = summariseMetric(experiment.primaryMetric, attribution, controlKey, true);
  const secondary = experiment.secondaryMetrics.map((m) =>
    summariseMetric(m, attribution, controlKey, false),
  );

  const notes: string[] = [
    "This readout reports estimates with uncertainty intervals. It does not declare a winning variant; " +
      "no field in this payload identifies one.",
    "Intervals are nominal and not corrected for repeated viewing or for testing multiple metrics. " +
      "An interval that excludes zero on one of ten metrics is not, on its own, evidence of an effect.",
    "`resolution` on each comparison is the smallest difference the current sample could distinguish. " +
      "A difference smaller than it means the experiment is uninformative for that metric, not that the " +
      "arms are equivalent.",
  ];

  // Surface the specific integrity risks this run actually has, rather than a
  // generic disclaimer that readers learn to skip.
  const d = attribution.diagnostics;
  if (d.conflicts > 0) {
    notes.push(
      `${d.conflicts} observation(s) were dropped because the serving variant disagreed with the ` +
        "learner's assigned variant. That indicates re-bucketing during the run — investigate before " +
        "trusting these numbers.",
    );
  }
  if (d.unassigned > 0) {
    notes.push(
      `${d.unassigned} observation(s) came from learners with no assignment record and were excluded.`,
    );
  }
  if (d.crossTenant > 0) {
    notes.push(
      `${d.crossTenant} observation(s) were rejected as belonging to another institution. In normal ` +
        "operation this should be zero.",
    );
  }

  // A zero-width interval is a pathology, not a precise result: it happens when
  // every learner in an arm produced an identical value (often n=2 with no
  // spread yet), and it renders as infinite certainty in any UI that plots it.
  // Call it out explicitly rather than letting the number speak for itself.
  for (const readout of [primary, ...secondary]) {
    for (const c of readout.comparisons) {
      if (c.difference && c.difference.interval.upper - c.difference.interval.lower < 1e-9) {
        notes.push(
          `Metric "${readout.metric}", variant "${c.variantKey}": the interval has zero width because ` +
            "every observation within each arm was identical. That is an artefact of a tiny or " +
            "degenerate sample, not precision — treat this comparison as uninformative.",
        );
      }
    }
    for (const v of readout.variants) {
      if (v.censored > 0 && v.coverage < 0.5) {
        notes.push(
          `Metric "${readout.metric}", variant "${v.variantKey}": only ${(v.coverage * 100).toFixed(0)}% ` +
            `of exposed learners produced a value (${v.censored} censored). The estimate describes the ` +
            "learners who reached the metric, which may not represent the arm.",
        );
      }
    }
  }

  return {
    experimentId: experiment.id,
    experimentKey: experiment.key,
    status: experiment.status,
    controlKey,
    generatedAt: params.generatedAt,
    exposureByVariant: params.exposureByVariant,
    primary,
    secondary,
    diagnostics: attribution.diagnostics,
    interpretationNotes: notes,
  };
}

/**
 * Render a readout as plain text for logs, CLI or a copy-paste summary.
 *
 * The formatter is as neutral as the data: it prints every arm in a stable
 * order, never sorts by performance, never bolds a leader, and never omits a
 * metric that moved the "wrong" way.
 */
export function formatReadout(readout: ExperimentReadout): string {
  const L: string[] = [];
  const num = (v: number, d = 4) => (Number.isFinite(v) ? v.toFixed(d) : "n/a");

  L.push(`Experiment ${readout.experimentKey} (#${readout.experimentId}) — status: ${readout.status}`);
  L.push(`Generated ${readout.generatedAt.toISOString()}`);
  L.push("");
  L.push("Exposure by variant:");
  for (const [key, count] of Object.entries(readout.exposureByVariant).sort()) {
    L.push(`  ${key}: ${count} learner(s)`);
  }
  L.push("");

  const section = (r: MetricReadout) => {
    L.push(`## ${r.label}${r.isPrimary ? " (primary)" : ""} — ${r.metric}`);
    L.push(`   ${r.definition}`);
    L.push("");
    L.push("   | variant | n | mean | 95% interval | censored | coverage |");
    L.push("   | --- | ---: | ---: | :--- | ---: | ---: |");
    for (const v of r.variants) {
      const ci = v.summary.interval
        ? `[${num(v.summary.interval.lower)}, ${num(v.summary.interval.upper)}]`
        : "n/a";
      L.push(
        `   | ${v.variantKey} | ${v.summary.n} | ${num(v.summary.mean)} | ${ci} | ${v.censored} | ` +
          `${(v.coverage * 100).toFixed(0)}% |`,
      );
    }
    if (r.comparisons.length) {
      L.push("");
      L.push(`   vs control (${r.comparisons[0].controlKey}):`);
      for (const c of r.comparisons) {
        if (!c.difference) {
          L.push(`     ${c.variantKey}: insufficient data (n < 2 in one arm)`);
          continue;
        }
        const d = c.difference;
        const rel = d.relative === null ? "n/a" : `${(d.relative * 100).toFixed(1)}%`;
        L.push(
          `     ${c.variantKey}: ${d.absolute >= 0 ? "+" : ""}${num(d.absolute)} (${rel}), ` +
            `95% CI [${num(d.interval.lower)}, ${num(d.interval.upper)}], ` +
            `g=${d.effectSize === null ? "n/a" : num(d.effectSize, 2)}, ` +
            `resolution ±${c.resolution === null ? "n/a" : num(c.resolution)}`,
        );
        if (c.bootstrapInterval) {
          L.push(
            `        bootstrap CI [${num(c.bootstrapInterval.lower)}, ${num(c.bootstrapInterval.upper)}]`,
          );
        }
      }
    }
    L.push("");
  };

  if (readout.primary) section(readout.primary);
  for (const r of readout.secondary) section(r);

  L.push("Attribution diagnostics:");
  const d = readout.diagnostics;
  L.push(
    `  attributed=${d.attributed} conflicts=${d.conflicts} beforeExposure=${d.beforeExposure} ` +
      `afterWindow=${d.afterWindow} crossTenant=${d.crossTenant} unassigned=${d.unassigned}`,
  );
  L.push("");
  L.push("Interpretation notes:");
  for (const note of readout.interpretationNotes) L.push(`  - ${note}`);

  return L.join("\n");
}
