/**
 * Cohort-level evaluation metrics for misconception detection and remediation.
 *
 * Built from `MisconceptionEpisode[]`; no database access, no LLM, deterministic.
 *
 * Every rate here reports its own denominator. A recurrence rate of 0.2 means
 * something completely different over "episodes that had any opportunity to
 * recur" than over "all detections", and most of the misleading dashboards in
 * this space come from quietly picking the flattering one.
 */
import { round } from "@/lib/utils";
import type { EpisodeStatus, MisconceptionEpisode } from "./misconception-longitudinal";

/* ------------------------------------------------------------------ */
/* Detection quality                                                   */
/* ------------------------------------------------------------------ */

export interface DetectionQualityMetrics {
  /** Episodes carrying an expert label. */
  labelled: number;
  /** Detections labelled `confirmed`. */
  truePositives: number;
  /** Detections labelled `refuted`. */
  falsePositives: number;
  /**
   * TP / (TP + FP) over labelled detections. Null when nothing is labelled —
   * never silently 0 or 1.
   */
  precision: number | null;
  /**
   * FP / (TP + FP): the share of detections that were wrong. This is a false
   * *discovery* rate.
   */
  falseDiscoveryRate: number | null;
  /**
   * TRUE false-positive rate, FP / (FP + TN). Requires labelled negatives —
   * candidate misconceptions an expert examined and ruled absent — which
   * detections alone cannot supply. Null until `labelledNegatives` is provided.
   *
   * Reported separately from `falseDiscoveryRate` because the two are routinely
   * conflated, and the difference decides whether a precision number is
   * meaningful.
   */
  falsePositiveRate: number | null;
  /** Share of all episodes that carry a label. Low coverage ⇒ weak evidence. */
  labelCoverage: number;
}

export interface LabelledNegatives {
  /** Candidates an expert examined and ruled ABSENT that the detector also did not flag. */
  trueNegatives: number;
  /** Candidates an expert ruled absent that the detector DID flag, if counted externally. */
  falsePositives?: number;
}

export function detectionQuality(
  episodes: MisconceptionEpisode[],
  labelledNegatives?: LabelledNegatives,
): DetectionQualityMetrics {
  const labelled = episodes.filter((e) => e.groundTruth !== "unknown");
  const tp = labelled.filter((e) => e.groundTruth === "confirmed").length;
  const fp = labelled.filter((e) => e.groundTruth === "refuted").length;
  const denom = tp + fp;

  const totalFp = fp + (labelledNegatives?.falsePositives ?? 0);
  const tn = labelledNegatives?.trueNegatives ?? null;

  return {
    labelled: labelled.length,
    truePositives: tp,
    falsePositives: fp,
    precision: denom ? round(tp / denom, 4) : null,
    falseDiscoveryRate: denom ? round(fp / denom, 4) : null,
    falsePositiveRate: tn !== null && totalFp + tn > 0 ? round(totalFp / (totalFp + tn), 4) : null,
    labelCoverage: episodes.length ? round(labelled.length / episodes.length, 4) : 0,
  };
}

/* ------------------------------------------------------------------ */
/* Remediation & resolution                                            */
/* ------------------------------------------------------------------ */

export interface RemediationMetrics {
  episodes: number;
  byStatus: Record<EpisodeStatus, number>;

  /** Detections that received any remediation exposure. */
  remediated: number;
  /** remediated / episodes — did the system respond to what it detected? */
  remediationResponseRate: number | null;
  /** Of remediated episodes, the share whose remediation named the misconception. */
  targetedRemediationRate: number | null;
  /** Median days from detection to first remediation. */
  medianTimeToRemediationDays: number | null;

  /**
   * Episodes that had at least one post-remediation opportunity — the only ones
   * whose outcome is informative at all.
   */
  evaluable: number;
  /** resolved / evaluable. */
  resolutionRate: number | null;
  /**
   * recurred / evaluable. Denominator is opportunities-to-recur, NOT all
   * detections: an episode never re-tested cannot recur and must not dilute it.
   */
  recurrenceRate: number | null;
  /** Share of evaluable episodes still short of the resolution bar. */
  suppressedRate: number | null;
  /** Episodes with no post-remediation opportunity, as a share of all. */
  unevaluableRate: number | null;

  medianTimeToResolutionDays: number | null;
  meanTimeToResolutionDays: number | null;

  /** Mean mastery delta, detection → latest, for resolved episodes. */
  downstreamMasteryGainResolved: number | null;
  /** Same, for recurred episodes — the contrast is the interesting part. */
  downstreamMasteryGainRecurred: number | null;
  /** Mean mastery delta across all episodes with mastery data. */
  downstreamMasteryGainOverall: number | null;

  /** Mean retention ratio among resolved episodes with post-resolution data. */
  meanRetention: number | null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return round(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2, 4);
}

function meanOf(values: number[]): number | null {
  if (!values.length) return null;
  return round(values.reduce((a, b) => a + b, 0) / values.length, 4);
}

export function remediationMetrics(episodes: MisconceptionEpisode[]): RemediationMetrics {
  const byStatus: Record<EpisodeStatus, number> = {
    resolved: 0,
    recurred: 0,
    temporarily_suppressed: 0,
    insufficient_evidence: 0,
  };
  for (const e of episodes) byStatus[e.status] += 1;

  const remediated = episodes.filter((e) => e.firstRemediationAt !== null);
  const targeted = remediated.filter((e) => e.remediations.some((r) => r.targeted));
  const evaluable = episodes.filter((e) => e.postRemediationOpportunities > 0);
  const resolved = episodes.filter((e) => e.status === "resolved");
  const recurred = episodes.filter((e) => e.status === "recurred");

  const gain = (list: MisconceptionEpisode[]) =>
    meanOf(list.map((e) => e.masteryChange).filter((x): x is number => x != null));

  return {
    episodes: episodes.length,
    byStatus,

    remediated: remediated.length,
    remediationResponseRate: episodes.length ? round(remediated.length / episodes.length, 4) : null,
    targetedRemediationRate: remediated.length ? round(targeted.length / remediated.length, 4) : null,
    medianTimeToRemediationDays: median(
      remediated.map((e) => e.timeToRemediationDays).filter((x): x is number => x != null),
    ),

    evaluable: evaluable.length,
    resolutionRate: evaluable.length ? round(resolved.length / evaluable.length, 4) : null,
    recurrenceRate: evaluable.length ? round(recurred.length / evaluable.length, 4) : null,
    suppressedRate: evaluable.length
      ? round(evaluable.filter((e) => e.status === "temporarily_suppressed").length / evaluable.length, 4)
      : null,
    unevaluableRate: episodes.length
      ? round(episodes.filter((e) => e.postRemediationOpportunities === 0).length / episodes.length, 4)
      : null,

    medianTimeToResolutionDays: median(
      resolved.map((e) => e.timeToResolutionDays).filter((x): x is number => x != null),
    ),
    meanTimeToResolutionDays: meanOf(
      resolved.map((e) => e.timeToResolutionDays).filter((x): x is number => x != null),
    ),

    downstreamMasteryGainResolved: gain(resolved),
    downstreamMasteryGainRecurred: gain(recurred),
    downstreamMasteryGainOverall: gain(episodes),

    meanRetention: meanOf(resolved.map((e) => e.retention).filter((x): x is number => x != null)),
  };
}

/* ------------------------------------------------------------------ */
/* Combined report                                                     */
/* ------------------------------------------------------------------ */

export interface MisconceptionEvaluationReport {
  generatedFrom: { episodes: number; learners: number; skills: number };
  detection: DetectionQualityMetrics;
  remediation: RemediationMetrics;
  /** Per-misconception breakdown, worst recurrence first. */
  byMisconception: {
    misconception: string;
    skillId: number;
    episodes: number;
    resolved: number;
    recurred: number;
    recurrenceRate: number | null;
    medianTimeToResolutionDays: number | null;
  }[];
  /** Caveats that apply to THIS report, computed from its own denominators. */
  caveats: string[];
}

export function evaluateMisconceptionProgram(
  episodes: MisconceptionEpisode[],
  labelledNegatives?: LabelledNegatives,
): MisconceptionEvaluationReport {
  const detection = detectionQuality(episodes, labelledNegatives);
  const remediation = remediationMetrics(episodes);

  const groups = new Map<string, MisconceptionEpisode[]>();
  for (const e of episodes) {
    const key = `${e.skillId}|${e.misconception}`;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }

  const byMisconception = [...groups.entries()]
    .map(([, list]) => {
      const evaluable = list.filter((e) => e.postRemediationOpportunities > 0);
      const recurred = list.filter((e) => e.status === "recurred");
      const resolved = list.filter((e) => e.status === "resolved");
      return {
        misconception: list[0].misconception,
        skillId: list[0].skillId,
        episodes: list.length,
        resolved: resolved.length,
        recurred: recurred.length,
        recurrenceRate: evaluable.length ? round(recurred.length / evaluable.length, 4) : null,
        medianTimeToResolutionDays: median(
          resolved.map((e) => e.timeToResolutionDays).filter((x): x is number => x != null),
        ),
      };
    })
    .sort((a, b) => (b.recurrenceRate ?? -1) - (a.recurrenceRate ?? -1) || b.episodes - a.episodes);

  // Caveats are derived, not boilerplate: they only appear when the data
  // actually warrants them, so they stay worth reading.
  const caveats: string[] = [];
  if (detection.precision === null) {
    caveats.push("No ground-truth labels — precision and false-positive rate are unmeasured, not good.");
  } else if (detection.labelCoverage < 0.2) {
    caveats.push(
      `Only ${(detection.labelCoverage * 100).toFixed(1)}% of episodes are labelled; precision is an estimate from a small, possibly non-random sample.`,
    );
  }
  if (detection.falsePositiveRate === null) {
    caveats.push(
      "False-positive rate requires labelled negatives (candidates ruled absent); only the false-discovery rate is available.",
    );
  }
  // Fires at a quarter, not a half: if 25% of detections can never be checked,
  // the headline resolution rate already describes a filtered population.
  if ((remediation.unevaluableRate ?? 0) >= 0.25) {
    caveats.push(
      `${remediation.episodes - remediation.evaluable}/${remediation.episodes} episodes had no post-remediation opportunity to recur — ` +
        "resolution and recurrence rates describe only the subset that was re-tested.",
    );
  }
  if (remediation.evaluable > 0 && remediation.evaluable < 30) {
    caveats.push(`Only ${remediation.evaluable} evaluable episodes — rates are noisy at this sample size.`);
  }
  if (remediation.meanRetention === null && remediation.byStatus.resolved > 0) {
    caveats.push("No post-resolution observations yet, so retention is unverified for resolved episodes.");
  }

  return {
    generatedFrom: {
      episodes: episodes.length,
      learners: new Set(episodes.map((e) => String(e.studentId))).size,
      skills: new Set(episodes.map((e) => e.skillId)).size,
    },
    detection,
    remediation,
    byMisconception,
    caveats,
  };
}
