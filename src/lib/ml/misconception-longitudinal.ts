/**
 * Longitudinal tracking of detected misconceptions — from first detection,
 * through remediation, to a resolution event that the evidence actually
 * supports.
 *
 * This layer sits ON TOP of `misconceptions.ts` and does not modify it. The
 * deterministic detector remains the single source of truth for *what* a
 * misconception is; this module only answers *what happened next*.
 *
 * ── The measurement problem this solves ─────────────────────────────────────
 *
 * "The learner stopped getting it wrong" is not evidence that a misconception
 * was fixed. It is equally consistent with:
 *
 *   - never being asked again (no opportunity to exhibit it),
 *   - being asked only questions where the misconception's distractor was not
 *     even an option (no opportunity, dressed up as success),
 *   - guessing correctly,
 *   - remembering the fix for ten minutes after the explanation.
 *
 * So resolution is defined against *opportunities to recur*, not against the
 * absence of errors, and it requires durability across time rather than a good
 * afternoon. An item only counts as an opportunity when the misconception's
 * distractor was actually present and selectable.
 *
 * ── Evidence rule (non-negotiable) ──────────────────────────────────────────
 *
 * Only learner RESPONSES are evidence. Remediation exposure — including every
 * LLM-generated explanation — is tracked as an *intervention*, never as proof
 * of an outcome. A tutor saying "now you understand" is a statement about the
 * tutor, not about the learner. `assertNoExposureEvidence` enforces this and a
 * test asserts that piling on exposures can never move an episode to resolved.
 */
import { clamp, round } from "@/lib/utils";
import type { MisconceptionConfidence, MisconceptionHypothesis } from "./misconceptions";

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

/**
 * One graded response, with enough item metadata to decide whether it was an
 * opportunity for a given misconception.
 */
export interface ResponseObservation {
  responseId?: number;
  questionId: number;
  skillId: number;
  subskill?: string | null;
  /** Option the learner chose (null = unanswered/timed out). */
  selectedOption: number | null;
  isCorrect: boolean;
  observedAt: Date | string;
  /** Decayed mastery snapshot at response time. */
  masteryAtObservation?: number;
  /**
   * Authored distractor metadata for the item as served. This is what makes an
   * item an "opportunity": if none of its options encode the misconception, the
   * learner could not have exhibited it and the item proves nothing.
   */
  distractorMeta?: { optionIndex: number; misconception?: string | null }[];
  /** Session grouping, when available — used for cross-session durability. */
  sessionId?: number | string | null;
}

/** Where a remediation came from. Used for attribution, never as evidence. */
export type RemediationSource =
  | "tutor_llm"
  | "tutor_deterministic"
  | "recommendation"
  | "targeted_practice"
  | "instructor"
  | "worked_example";

/**
 * Sources whose content is machine-generated prose. Listed explicitly so the
 * "never count an explanation as an outcome" rule is checkable rather than
 * merely intended.
 */
export const GENERATED_EXPLANATION_SOURCES: readonly RemediationSource[] = [
  "tutor_llm",
  "tutor_deterministic",
  "worked_example",
];

export interface RemediationExposure {
  source: RemediationSource;
  skillId: number;
  subskill?: string | null;
  /** Misconception label the remediation targeted, when it was targeted at one. */
  misconception?: string | null;
  occurredAt: Date | string;
  interactionId?: number;
  /** Learner-reported helpfulness. Recorded for analysis; NOT outcome evidence. */
  helpful?: boolean | null;
}

/** Expert/ground-truth label for a detected misconception, when one exists. */
export type GroundTruthLabel = "confirmed" | "refuted" | "unknown";

export interface MisconceptionGroundTruth {
  /** Hypothesis id, i.e. `${skillId}|${subskill}|${prereqId}|${normalized label}`. */
  hypothesisId: string;
  label: GroundTruthLabel;
  labelledBy?: string;
  labelledAt?: Date | string;
  note?: string;
}

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

export interface LongitudinalConfig {
  /** Clean post-remediation opportunities required to call it resolved. */
  minCleanOpportunities: number;
  /** Of those, how many must be answered correctly (not merely "not this error"). */
  minCorrectOpportunities: number;
  /**
   * Durability window: the confirming opportunity must land at least this many
   * days after the first clean one. Without it, "resolved" means "did well for
   * the rest of the session".
   */
  retentionDays: number;
  /** Clean opportunities must span at least this many distinct sessions. */
  minDistinctSessions: number;
  /** A recurrence this long after resolution reopens the episode. */
  recurrenceWatchDays: number;
  /** Confidence levels eligible for longitudinal tracking. */
  trackedConfidences: MisconceptionConfidence[];
}

/**
 * Defaults are deliberately conservative: the cost of wrongly declaring a
 * misconception resolved (the learner is advanced and quietly carries the error
 * forward) is much higher than the cost of leaving an episode open one more
 * week.
 */
export const DEFAULT_LONGITUDINAL_CONFIG: LongitudinalConfig = {
  minCleanOpportunities: 3,
  minCorrectOpportunities: 2,
  retentionDays: 7,
  minDistinctSessions: 2,
  recurrenceWatchDays: 30,
  trackedConfidences: ["MEDIUM", "HIGH"],
};

/* ------------------------------------------------------------------ */
/* Outputs                                                             */
/* ------------------------------------------------------------------ */

export type EpisodeStatus =
  /** Evidence supports a durable fix. */
  | "resolved"
  /** Exhibited again after remediation. */
  | "recurred"
  /** Clean so far, but not enough opportunities / time to call it. */
  | "temporarily_suppressed"
  /** No post-remediation opportunity to exhibit it at all. */
  | "insufficient_evidence";

export interface OpportunityRecord {
  questionId: number;
  observedAt: string;
  /** Learner selected a distractor encoding this misconception. */
  exhibited: boolean;
  isCorrect: boolean;
  masteryAtObservation: number | null;
  sessionId: string | null;
  /** Before the first remediation exposure. */
  preRemediation: boolean;
}

export interface MisconceptionEpisode {
  hypothesisId: string;
  studentId: number | string;
  skillId: number;
  subskill: string | null;
  misconception: string;
  confidenceAtDetection: MisconceptionConfidence;
  errorPattern: MisconceptionHypothesis["errorPattern"];

  /** First evidence of the error. */
  firstObservedAt: string;
  /**
   * When the detector would have *flagged* it — the observation that carried
   * confidence to MEDIUM. Distinct from first evidence, and the correct clock
   * start for "how long did we take to fix it".
   */
  detectedAt: string;
  detectionEvidenceCount: number;

  /** Interventions, in order. Attribution only. */
  remediations: { source: RemediationSource; occurredAt: string; targeted: boolean; helpful: boolean | null }[];
  firstRemediationAt: string | null;
  /** Days from detection to first remediation; null when never remediated. */
  timeToRemediationDays: number | null;

  /** Every subsequent item where this misconception COULD have been exhibited. */
  opportunities: OpportunityRecord[];
  postRemediationOpportunities: number;
  cleanOpportunities: number;
  recurrences: number;

  status: EpisodeStatus;
  /** Plain-language justification for the status. */
  statusReason: string;
  resolvedAt: string | null;
  /** Detection → resolution, in days. Null unless resolved. */
  timeToResolutionDays: number | null;

  masteryAtDetection: number | null;
  masteryLatest: number | null;
  masteryChange: number | null;
  /**
   * Post-resolution durability: mastery retained at the latest observation
   * relative to the resolution point. Null unless resolved with later evidence.
   */
  retention: number | null;

  groundTruth: GroundTruthLabel;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const toEpoch = (v: Date | string | number): number =>
  typeof v === "number" ? v : v instanceof Date ? v.getTime() : new Date(v).getTime();
const iso = (v: Date | string | number): string => new Date(toEpoch(v)).toISOString();
const DAY = 86_400_000;
const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Guard: exposures must never reach outcome-scoring code paths.
 *
 * Exported and called at the top of episode construction so the rule is
 * enforced by the type system *and* at runtime, rather than living in a comment
 * that a future refactor can quietly violate.
 */
export function assertNoExposureEvidence(candidate: unknown): asserts candidate is ResponseObservation[] {
  if (!Array.isArray(candidate)) throw new TypeError("evidence must be an array of learner responses");
  for (const entry of candidate) {
    if (entry && typeof entry === "object" && "source" in entry) {
      throw new TypeError(
        "remediation exposures cannot be used as resolution evidence — only graded learner responses count",
      );
    }
  }
}

/**
 * Did this item give the learner a chance to exhibit the misconception?
 *
 * Requires the same skill (and subskill, when the hypothesis is subskill
 * specific) AND an option encoding the misconception. The second condition is
 * the one that matters: without it, serving easier items that omit the trap
 * would look identical to fixing the misconception.
 */
export function isOpportunity(
  response: ResponseObservation,
  hypothesis: Pick<MisconceptionHypothesis, "skillId" | "subskill" | "misconception">,
): boolean {
  if (response.skillId !== hypothesis.skillId) return false;
  if (hypothesis.subskill && (response.subskill ?? null) !== hypothesis.subskill) return false;
  const target = normalize(hypothesis.misconception);
  return (response.distractorMeta ?? []).some((d) => d.misconception && normalize(d.misconception) === target);
}

/** Did the learner actually select the misconception's distractor? */
export function exhibitedMisconception(
  response: ResponseObservation,
  hypothesis: Pick<MisconceptionHypothesis, "misconception">,
): boolean {
  if (response.selectedOption == null || response.isCorrect) return false;
  const target = normalize(hypothesis.misconception);
  return (response.distractorMeta ?? []).some(
    (d) => d.optionIndex === response.selectedOption && d.misconception && normalize(d.misconception) === target,
  );
}

/**
 * Reconstruct when the detector would first have flagged this hypothesis.
 *
 * `detectMisconceptions` promotes to MEDIUM at the second distinct question, so
 * the detection instant is the timestamp of that observation — not of the first
 * error, which nobody could have acted on yet.
 */
function detectionInstant(hypothesis: MisconceptionHypothesis, evidenceTimes: number[]): number {
  const ordered = [...evidenceTimes].sort((a, b) => a - b);
  if (!ordered.length) return toEpoch(hypothesis.firstObserved);
  const index = Math.min(ordered.length - 1, 1); // 2nd distinct observation
  return ordered[index];
}

/* ------------------------------------------------------------------ */
/* Episode construction                                                */
/* ------------------------------------------------------------------ */

export interface BuildEpisodesParams {
  studentId: number | string;
  hypotheses: MisconceptionHypothesis[];
  /** Full response timeline for the learner (any order; sorted internally). */
  responses: ResponseObservation[];
  remediations?: RemediationExposure[];
  groundTruth?: MisconceptionGroundTruth[];
  config?: Partial<LongitudinalConfig>;
  /** Evaluation cut-off; defaults to the latest observed event. */
  asOf?: Date | string;
}

export function buildMisconceptionEpisodes(params: BuildEpisodesParams): MisconceptionEpisode[] {
  const config = { ...DEFAULT_LONGITUDINAL_CONFIG, ...(params.config ?? {}) };
  assertNoExposureEvidence(params.responses);

  const responses = [...params.responses].sort(
    (a, b) => toEpoch(a.observedAt) - toEpoch(b.observedAt) || a.questionId - b.questionId,
  );
  const remediations = [...(params.remediations ?? [])].sort((a, b) => toEpoch(a.occurredAt) - toEpoch(b.occurredAt));
  const truthByHypothesis = new Map((params.groundTruth ?? []).map((g) => [g.hypothesisId, g.label]));

  const latestEvent = Math.max(
    0,
    ...responses.map((r) => toEpoch(r.observedAt)),
    ...remediations.map((r) => toEpoch(r.occurredAt)),
  );
  const asOf = params.asOf ? toEpoch(params.asOf) : latestEvent;

  const tracked = params.hypotheses.filter((h) => config.trackedConfidences.includes(h.confidence));
  const episodes: MisconceptionEpisode[] = [];

  for (const hypothesis of tracked) {
    // ---- detection ----
    const evidenceTimes = responses
      .filter((r) => hypothesis.evidenceQuestionIds.includes(r.questionId) && exhibitedMisconception(r, hypothesis))
      .map((r) => toEpoch(r.observedAt));
    const detectedAt = detectionInstant(hypothesis, evidenceTimes);
    const firstObservedAt = toEpoch(hypothesis.firstObserved);

    // ---- remediation exposure ----
    // A remediation counts for this episode when it targets the same skill and
    // lands after detection. `targeted` records whether it also named the
    // misconception, which separates "got some help" from "got the right help".
    const relevant = remediations.filter(
      (r) => r.skillId === hypothesis.skillId && toEpoch(r.occurredAt) >= detectedAt && toEpoch(r.occurredAt) <= asOf,
    );
    const remediationRecords = relevant.map((r) => ({
      source: r.source,
      occurredAt: iso(r.occurredAt),
      targeted: Boolean(r.misconception && normalize(r.misconception) === normalize(hypothesis.misconception)),
      helpful: r.helpful ?? null,
    }));
    const firstRemediation = relevant.length ? toEpoch(relevant[0].occurredAt) : null;

    // ---- opportunities ----
    const opportunityRows = responses
      .filter((r) => {
        const t = toEpoch(r.observedAt);
        return t > detectedAt && t <= asOf && isOpportunity(r, hypothesis);
      })
      .map<OpportunityRecord>((r) => ({
        questionId: r.questionId,
        observedAt: iso(r.observedAt),
        exhibited: exhibitedMisconception(r, hypothesis),
        isCorrect: r.isCorrect,
        masteryAtObservation: r.masteryAtObservation ?? null,
        sessionId: r.sessionId != null ? String(r.sessionId) : null,
        preRemediation: firstRemediation === null ? true : toEpoch(r.observedAt) < firstRemediation,
      }));

    const postRemediation = opportunityRows.filter((o) => !o.preRemediation);
    const recurrences = postRemediation.filter((o) => o.exhibited);
    const clean = postRemediation.filter((o) => !o.exhibited);

    // ---- status ----
    const { status, statusReason, resolvedAt } = classifyEpisode({
      hasRemediation: firstRemediation !== null,
      postRemediation,
      clean,
      recurrences,
      config,
    });

    // ---- mastery / retention ----
    const masteryAtDetection =
      responses.find((r) => toEpoch(r.observedAt) >= detectedAt && r.skillId === hypothesis.skillId)
        ?.masteryAtObservation ?? null;
    const skillResponses = responses.filter((r) => r.skillId === hypothesis.skillId && toEpoch(r.observedAt) <= asOf);
    const masteryLatest = [...skillResponses].reverse().find((r) => r.masteryAtObservation != null)
      ?.masteryAtObservation ?? null;

    let retention: number | null = null;
    if (resolvedAt !== null) {
      const atResolution = postRemediation.find((o) => o.observedAt === iso(resolvedAt))?.masteryAtObservation ?? null;
      const after = skillResponses.filter((r) => toEpoch(r.observedAt) > resolvedAt && r.masteryAtObservation != null);
      if (atResolution != null && after.length) {
        const latestAfter = after[after.length - 1].masteryAtObservation as number;
        retention = atResolution > 0 ? round(clamp(latestAfter / atResolution, 0, 2), 3) : null;
      }
    }

    episodes.push({
      hypothesisId: hypothesis.id,
      studentId: params.studentId,
      skillId: hypothesis.skillId,
      subskill: hypothesis.subskill,
      misconception: hypothesis.misconception,
      confidenceAtDetection: hypothesis.confidence,
      errorPattern: hypothesis.errorPattern,

      firstObservedAt: iso(firstObservedAt),
      detectedAt: iso(detectedAt),
      detectionEvidenceCount: hypothesis.evidenceCount,

      remediations: remediationRecords,
      firstRemediationAt: firstRemediation === null ? null : iso(firstRemediation),
      timeToRemediationDays:
        firstRemediation === null ? null : round((firstRemediation - detectedAt) / DAY, 3),

      opportunities: opportunityRows,
      postRemediationOpportunities: postRemediation.length,
      cleanOpportunities: clean.length,
      recurrences: recurrences.length,

      status,
      statusReason,
      resolvedAt: resolvedAt === null ? null : iso(resolvedAt),
      timeToResolutionDays: resolvedAt === null ? null : round((resolvedAt - detectedAt) / DAY, 3),

      masteryAtDetection: masteryAtDetection ?? null,
      masteryLatest,
      masteryChange:
        masteryAtDetection != null && masteryLatest != null ? round(masteryLatest - masteryAtDetection, 4) : null,
      retention,

      groundTruth: truthByHypothesis.get(hypothesis.id) ?? "unknown",
    });
  }

  return episodes.sort((a, b) => a.detectedAt.localeCompare(b.detectedAt) || a.hypothesisId.localeCompare(b.hypothesisId));
}

/**
 * The four-way classification.
 *
 * Ordering matters: recurrence is checked first, because a learner who
 * exhibited the misconception again after remediation has not resolved it no
 * matter how many clean items surround the relapse.
 */
function classifyEpisode(params: {
  hasRemediation: boolean;
  postRemediation: OpportunityRecord[];
  clean: OpportunityRecord[];
  recurrences: OpportunityRecord[];
  config: LongitudinalConfig;
}): { status: EpisodeStatus; statusReason: string; resolvedAt: number | null } {
  const { hasRemediation, postRemediation, clean, recurrences, config } = params;

  if (!hasRemediation) {
    return {
      status: "insufficient_evidence",
      statusReason: "No remediation exposure recorded after detection.",
      resolvedAt: null,
    };
  }
  if (!postRemediation.length) {
    return {
      status: "insufficient_evidence",
      statusReason:
        "No post-remediation item presented this misconception's distractor, so the learner never had the chance to exhibit it.",
      resolvedAt: null,
    };
  }
  if (recurrences.length) {
    const last = recurrences[recurrences.length - 1];
    return {
      status: "recurred",
      statusReason: `Misconception exhibited again ${recurrences.length}× after remediation (most recently ${last.observedAt}).`,
      resolvedAt: null,
    };
  }

  // Clean so far — but is there enough of it, spread over enough time?
  const correct = clean.filter((o) => o.isCorrect).length;
  const sessions = new Set(clean.map((o) => o.sessionId ?? o.observedAt.slice(0, 10))).size;
  const shortfalls: string[] = [];

  if (clean.length < config.minCleanOpportunities) {
    shortfalls.push(`${clean.length}/${config.minCleanOpportunities} clean opportunities`);
  }
  if (correct < config.minCorrectOpportunities) {
    shortfalls.push(`${correct}/${config.minCorrectOpportunities} answered correctly`);
  }
  if (sessions < config.minDistinctSessions) {
    shortfalls.push(`${sessions}/${config.minDistinctSessions} distinct sessions`);
  }

  const first = clean.length ? toEpoch(clean[0].observedAt) : null;
  const durableIndex = clean.findIndex(
    (o) => first !== null && toEpoch(o.observedAt) - first >= config.retentionDays * DAY,
  );
  const spanDays = first !== null && clean.length ? (toEpoch(clean[clean.length - 1].observedAt) - first) / DAY : 0;
  if (durableIndex === -1) {
    shortfalls.push(`${round(spanDays, 1)}/${config.retentionDays} day retention window`);
  }

  if (shortfalls.length) {
    return {
      status: "temporarily_suppressed",
      statusReason: `Not exhibited since remediation, but evidence is short of the resolution bar: ${shortfalls.join(", ")}.`,
      resolvedAt: null,
    };
  }

  // Resolution instant = the opportunity that completed every criterion, so
  // time-to-resolution reflects when we could first justify the claim.
  const resolvedAtIndex = Math.max(durableIndex, config.minCleanOpportunities - 1);
  const resolvingOpportunity = clean[Math.min(resolvedAtIndex, clean.length - 1)];
  return {
    status: "resolved",
    statusReason:
      `${clean.length} clean opportunities (${correct} correct) across ${sessions} sessions spanning ` +
      `${round(spanDays, 1)} days with no recurrence.`,
    resolvedAt: toEpoch(resolvingOpportunity.observedAt),
  };
}
