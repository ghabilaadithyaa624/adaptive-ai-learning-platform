/**
 * Metric attribution.
 *
 * Turning raw activity into per-learner metric values is where experiments
 * quietly go wrong, so the rules are stated here and enforced in one place
 * rather than repeated at each call site.
 *
 * **Attribution rules** (each one prevents a specific, named failure):
 *
 *  R1 — *Exposure gates attribution.* Only observations at or after the
 *       learner's FIRST exposure count. Otherwise a learner's pre-existing
 *       progress is credited to whichever arm they later joined, which
 *       manufactures an effect out of nothing but enrolment timing.
 *
 *  R2 — *One learner, one variant.* An observation is attributed to the variant
 *       recorded on the learner's assignment, never to the variant of the
 *       serving call. If those two ever disagree the observation is **dropped**
 *       and counted in `conflicts`, because a disagreement means something
 *       re-bucketed a learner mid-flight and the safe response is to lose the
 *       data point rather than to guess.
 *
 *  R3 — *Window bounds.* Observations after the experiment's `endAt` are
 *       excluded, so a long-running learner does not keep accruing outcomes
 *       into a concluded readout.
 *
 *  R4 — *Tenant scoping.* Observations are filtered to the experiment's
 *       institution. Enforced here as well as in SQL; a single missing
 *       predicate should not be able to leak one customer's outcomes into
 *       another's readout.
 *
 *  R5 — *Censoring is explicit.* Learners with no qualifying observation are
 *       excluded from the estimate and counted, never silently scored zero. A
 *       zero means "learned nothing"; absent means "we did not observe them",
 *       and averaging the second as the first biases every rate metric down.
 *
 * The functions here are pure and operate on plain records, so all of this is
 * testable without a database — which is the only way these rules stay true.
 */
import { MASTERY_TARGET } from "@/lib/utils";
import type { Experiment, MetricKey, PrimaryMetricKey, SecondaryMetricKey } from "./types";

/* ------------------------------------------------------------------ */
/* Input records                                                       */
/* ------------------------------------------------------------------ */

/** One answered item, joined to the learner and their institution. */
export interface AttributableItem {
  studentId: number;
  institutionId: number | null;
  assessmentId: number;
  skillId: number;
  /** Variant recorded on the EXPOSURE for this item, if the item was exposed. */
  exposedVariantKey: string | null;
  answeredAt: Date;
  isCorrect: boolean | null;
  responseTimeMs: number;
  predictedCorrectProb: number;
  masteryBefore: number;
  masteryAfter: number;
}

export interface AttributableAssessment {
  studentId: number;
  institutionId: number | null;
  assessmentId: number;
  startedAt: Date;
  status: string;
}

export interface AttributableRecommendation {
  studentId: number;
  institutionId: number | null;
  createdAt: Date;
  status: string;
}

/** Per-learner activity day, used for engagement. */
export interface AttributableActivity {
  studentId: number;
  institutionId: number | null;
  occurredAt: Date;
}

/** The learner's assignment + first exposure. Both are required to attribute. */
export interface AttributionSubject {
  studentId: number;
  institutionId: number | null;
  variantKey: string;
  firstExposureAt: Date;
}

export interface AttributionInput {
  experiment: Pick<Experiment, "institutionId" | "endAt">;
  subjects: AttributionSubject[];
  items: AttributableItem[];
  assessments?: AttributableAssessment[];
  recommendations?: AttributableRecommendation[];
  activity?: AttributableActivity[];
  /** Mastery threshold for the *-to-mastery metrics. */
  masteryThreshold?: number;
  /** Minimum days between practice and re-test to count as a retention probe. */
  retentionDelayDays?: number;
  /** ZPD band on predicted success probability. */
  zpdBand?: [number, number];
  /** Evaluation instant, for engagement denominators. Passed, never read. */
  now: Date;
}

/* ------------------------------------------------------------------ */
/* Output                                                              */
/* ------------------------------------------------------------------ */

/** One learner's value for one metric. The unit of analysis. */
export interface LearnerMetricValue {
  studentId: number;
  variantKey: string;
  value: number;
}

export interface MetricSeries {
  metric: MetricKey;
  /** Per-learner values, grouped by variant. */
  byVariant: Record<string, LearnerMetricValue[]>;
  /** Learners assigned but with no qualifying observation (R5). */
  censoredByVariant: Record<string, number>;
}

export interface AttributionDiagnostics {
  /** Observations dropped because exposure variant ≠ assignment variant (R2). */
  conflicts: number;
  /** Observations dropped for occurring before first exposure (R1). */
  beforeExposure: number;
  /** Observations dropped for occurring after the experiment window (R3). */
  afterWindow: number;
  /** Observations dropped for belonging to another tenant (R4). */
  crossTenant: number;
  /** Observations from learners with no assignment at all. */
  unassigned: number;
  /** Observations that passed every rule and were attributed. */
  attributed: number;
}

export interface AttributionResult {
  series: Record<MetricKey, MetricSeries>;
  diagnostics: AttributionDiagnostics;
}

/* ------------------------------------------------------------------ */
/* Filtering                                                           */
/* ------------------------------------------------------------------ */

interface Filterable {
  studentId: number;
  institutionId: number | null;
}

/**
 * Apply R1–R4 to a batch of observations, returning only what may be
 * attributed, plus the reason counts for everything rejected.
 *
 * Generic over the record type because the same rules govern items,
 * assessments, recommendations and activity — encoding them once is the point.
 */
function applyRules<T extends Filterable>(
  rows: T[],
  subjects: Map<number, AttributionSubject>,
  experiment: Pick<Experiment, "institutionId" | "endAt">,
  timeOf: (row: T) => Date,
  variantOf: (row: T) => string | null,
  diagnostics: AttributionDiagnostics,
): { row: T; subject: AttributionSubject }[] {
  const kept: { row: T; subject: AttributionSubject }[] = [];

  for (const row of rows) {
    // R4 — tenant scoping.
    if (experiment.institutionId !== null && row.institutionId !== experiment.institutionId) {
      diagnostics.crossTenant += 1;
      continue;
    }

    const subject = subjects.get(row.studentId);
    if (!subject) {
      diagnostics.unassigned += 1;
      continue;
    }

    // R4 again — the subject must also belong to the tenant. Guards against an
    // assignment row that was written before a learner was moved.
    if (experiment.institutionId !== null && subject.institutionId !== experiment.institutionId) {
      diagnostics.crossTenant += 1;
      continue;
    }

    const at = timeOf(row);

    // R1 — exposure gates attribution.
    if (at < subject.firstExposureAt) {
      diagnostics.beforeExposure += 1;
      continue;
    }

    // R3 — window bounds.
    if (experiment.endAt && at >= experiment.endAt) {
      diagnostics.afterWindow += 1;
      continue;
    }

    // R2 — one learner, one variant.
    const observed = variantOf(row);
    if (observed !== null && observed !== subject.variantKey) {
      diagnostics.conflicts += 1;
      continue;
    }

    diagnostics.attributed += 1;
    kept.push({ row, subject });
  }

  return kept;
}

/* ------------------------------------------------------------------ */
/* Metric computation                                                  */
/* ------------------------------------------------------------------ */

function emptySeries(metric: MetricKey, variantKeys: string[]): MetricSeries {
  return {
    metric,
    byVariant: Object.fromEntries(variantKeys.map((k) => [k, [] as LearnerMetricValue[]])),
    censoredByVariant: Object.fromEntries(variantKeys.map((k) => [k, 0])),
  };
}

/** Group attributed items by learner, in chronological order. */
function itemsByLearner(
  kept: { row: AttributableItem; subject: AttributionSubject }[],
): Map<number, { subject: AttributionSubject; items: AttributableItem[] }> {
  const grouped = new Map<number, { subject: AttributionSubject; items: AttributableItem[] }>();
  for (const { row, subject } of kept) {
    const entry = grouped.get(row.studentId) ?? { subject, items: [] };
    entry.items.push(row);
    grouped.set(row.studentId, entry);
  }
  for (const entry of grouped.values()) {
    entry.items.sort((a, b) => a.answeredAt.getTime() - b.answeredAt.getTime());
  }
  return grouped;
}

/**
 * Compute every primary and secondary metric from attributed observations.
 *
 * Each learner contributes at most one value per metric: the learner, not the
 * item, is the unit of randomisation, so the unit of analysis must match.
 * Averaging over items instead would weight heavy users more heavily and
 * understate the variance, producing intervals that are too narrow.
 */
export function attributeMetrics(input: AttributionInput): AttributionResult {
  const masteryThreshold = input.masteryThreshold ?? MASTERY_TARGET;
  const retentionDelayDays = input.retentionDelayDays ?? 7;
  const [zpdLow, zpdHigh] = input.zpdBand ?? [0.5, 0.85];

  const subjects = new Map(input.subjects.map((s) => [s.studentId, s]));
  const variantKeys = [...new Set(input.subjects.map((s) => s.variantKey))].sort();

  const diagnostics: AttributionDiagnostics = {
    conflicts: 0,
    beforeExposure: 0,
    afterWindow: 0,
    crossTenant: 0,
    unassigned: 0,
    attributed: 0,
  };

  const keptItems = applyRules(
    input.items,
    subjects,
    input.experiment,
    (r) => r.answeredAt,
    (r) => r.exposedVariantKey,
    diagnostics,
  );
  const grouped = itemsByLearner(keptItems);

  const series: Record<MetricKey, MetricSeries> = {
    masteryGain: emptySeries("masteryGain", variantKeys),
    timeToMastery: emptySeries("timeToMastery", variantKeys),
    retention: emptySeries("retention", variantKeys),
    questionsToMastery: emptySeries("questionsToMastery", variantKeys),
    zpdHitRate: emptySeries("zpdHitRate", variantKeys),
    recommendationAcceptance: emptySeries("recommendationAcceptance", variantKeys),
    completion: emptySeries("completion", variantKeys),
    informationGain: emptySeries("informationGain", variantKeys),
    calibration: emptySeries("calibration", variantKeys),
    engagement: emptySeries("engagement", variantKeys),
  };

  const push = (metric: MetricKey, subject: AttributionSubject, value: number) => {
    series[metric].byVariant[subject.variantKey]?.push({
      studentId: subject.studentId,
      variantKey: subject.variantKey,
      value,
    });
  };
  const censor = (metric: MetricKey, subject: AttributionSubject) => {
    const bucket = series[metric].censoredByVariant;
    bucket[subject.variantKey] = (bucket[subject.variantKey] ?? 0) + 1;
  };

  for (const subject of input.subjects) {
    const entry = grouped.get(subject.studentId);
    const items = entry?.items ?? [];
    const graded = items.filter((i) => i.isCorrect !== null);

    /* ---------------- primary: mastery gain ---------------- */
    // Summed per-item deltas rather than (final − initial), because a learner
    // who gains then decays should be credited with the learning that happened.
    if (items.length) {
      push("masteryGain", subject, items.reduce((s, i) => s + (i.masteryAfter - i.masteryBefore), 0));
    } else {
      censor("masteryGain", subject);
    }

    /* ---------------- primary: time / questions to mastery ---------------- */
    // Both are censored metrics: a learner who never crosses the threshold has
    // no value, and imputing one (e.g. the session length) would bias the
    // faster arm's average upward simply by having more crossings to average.
    let crossed = false;
    let msToMastery = 0;
    let itemsToMastery = 0;
    const peakBySkill = new Map<number, number>();
    for (const item of items) {
      msToMastery += item.responseTimeMs;
      itemsToMastery += 1;
      const prevPeak = peakBySkill.get(item.skillId) ?? 0;
      peakBySkill.set(item.skillId, Math.max(prevPeak, item.masteryAfter));
      if (item.masteryBefore < masteryThreshold && item.masteryAfter >= masteryThreshold) {
        crossed = true;
        break;
      }
    }
    if (crossed) {
      push("timeToMastery", subject, msToMastery / 60_000);
      push("questionsToMastery", subject, itemsToMastery);
    } else {
      censor("timeToMastery", subject);
      censor("questionsToMastery", subject);
    }

    /* ---------------- primary: retention ---------------- */
    // Accuracy on items in a skill re-encountered well after that skill peaked.
    const peakAt = new Map<number, { mastery: number; at: Date }>();
    const probes: boolean[] = [];
    for (const item of items) {
      const peak = peakAt.get(item.skillId);
      if (peak && item.answeredAt.getTime() - peak.at.getTime() >= retentionDelayDays * 86_400_000) {
        if (item.isCorrect !== null) probes.push(item.isCorrect);
      }
      if (!peak || item.masteryAfter >= peak.mastery) {
        peakAt.set(item.skillId, { mastery: item.masteryAfter, at: item.answeredAt });
      }
    }
    if (probes.length) {
      push("retention", subject, probes.filter(Boolean).length / probes.length);
    } else {
      censor("retention", subject);
    }

    /* ---------------- secondary: ZPD / information / calibration ---------------- */
    if (items.length) {
      const inBand = items.filter(
        (i) => i.predictedCorrectProb >= zpdLow && i.predictedCorrectProb <= zpdHigh,
      ).length;
      push("zpdHitRate", subject, inBand / items.length);
      push(
        "informationGain",
        subject,
        items.reduce((s, i) => s + 4 * i.predictedCorrectProb * (1 - i.predictedCorrectProb), 0) / items.length,
      );
    } else {
      censor("zpdHitRate", subject);
      censor("informationGain", subject);
    }

    if (graded.length) {
      push(
        "calibration",
        subject,
        graded.reduce((s, i) => s + Math.abs(i.predictedCorrectProb - (i.isCorrect ? 1 : 0)), 0) / graded.length,
      );
    } else {
      censor("calibration", subject);
    }
  }

  /* ---------------- secondary: completion ---------------- */
  if (input.assessments) {
    const kept = applyRules(
      input.assessments,
      subjects,
      input.experiment,
      (r) => r.startedAt,
      () => null,
      diagnostics,
    );
    const byLearner = new Map<number, { subject: AttributionSubject; total: number; completed: number }>();
    for (const { row, subject } of kept) {
      const e = byLearner.get(row.studentId) ?? { subject, total: 0, completed: 0 };
      e.total += 1;
      if (row.status === "completed") e.completed += 1;
      byLearner.set(row.studentId, e);
    }
    for (const subject of input.subjects) {
      const e = byLearner.get(subject.studentId);
      if (e && e.total > 0) push("completion", subject, e.completed / e.total);
      else censor("completion", subject);
    }
  } else {
    for (const subject of input.subjects) censor("completion", subject);
  }

  /* ---------------- secondary: recommendation acceptance ---------------- */
  if (input.recommendations) {
    const kept = applyRules(
      input.recommendations,
      subjects,
      input.experiment,
      (r) => r.createdAt,
      () => null,
      diagnostics,
    );
    const byLearner = new Map<number, { subject: AttributionSubject; total: number; accepted: number }>();
    for (const { row, subject } of kept) {
      const e = byLearner.get(row.studentId) ?? { subject, total: 0, accepted: 0 };
      e.total += 1;
      if (row.status === "accepted" || row.status === "completed") e.accepted += 1;
      byLearner.set(row.studentId, e);
    }
    for (const subject of input.subjects) {
      const e = byLearner.get(subject.studentId);
      if (e && e.total > 0) push("recommendationAcceptance", subject, e.accepted / e.total);
      else censor("recommendationAcceptance", subject);
    }
  } else {
    for (const subject of input.subjects) censor("recommendationAcceptance", subject);
  }

  /* ---------------- secondary: engagement ---------------- */
  if (input.activity) {
    const kept = applyRules(
      input.activity,
      subjects,
      input.experiment,
      (r) => r.occurredAt,
      () => null,
      diagnostics,
    );
    const daysByLearner = new Map<number, Set<string>>();
    for (const { row } of kept) {
      const set = daysByLearner.get(row.studentId) ?? new Set<string>();
      set.add(row.occurredAt.toISOString().slice(0, 10));
      daysByLearner.set(row.studentId, set);
    }
    for (const subject of input.subjects) {
      const days = daysByLearner.get(subject.studentId);
      const elapsed = Math.max(
        1,
        Math.ceil((input.now.getTime() - subject.firstExposureAt.getTime()) / 86_400_000),
      );
      if (days && days.size > 0) push("engagement", subject, Math.min(1, days.size / elapsed));
      else censor("engagement", subject);
    }
  } else {
    for (const subject of input.subjects) censor("engagement", subject);
  }

  return { series, diagnostics };
}

/** Convenience: the metric keys an experiment actually reports. */
export function reportedMetrics(
  primary: PrimaryMetricKey,
  secondary: SecondaryMetricKey[],
): MetricKey[] {
  return [primary, ...secondary.filter((k) => k !== (primary as unknown as SecondaryMetricKey))];
}
