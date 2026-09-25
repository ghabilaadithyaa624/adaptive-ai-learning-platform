/**
 * Longitudinal misconception tracking: synthetic multi-session learner
 * timelines exercising every path through the four-way classification.
 *
 * The timelines are built with an explicit day/session clock rather than
 * `Date.now()`, so a retention window means the same thing on every run.
 */
import { describe, expect, it } from "vitest";

import { detectMisconceptions, type MisconceptionEvidence } from "@/lib/ml/misconceptions";
import {
  DEFAULT_LONGITUDINAL_CONFIG,
  GENERATED_EXPLANATION_SOURCES,
  assertNoExposureEvidence,
  buildMisconceptionEpisodes,
  exhibitedMisconception,
  isOpportunity,
  type RemediationExposure,
  type ResponseObservation,
} from "@/lib/ml/misconception-longitudinal";
import {
  detectionQuality,
  evaluateMisconceptionProgram,
  remediationMetrics,
} from "@/lib/ml/misconception-metrics";

/* ------------------------------------------------------------------ */
/* Synthetic timeline builder                                          */
/* ------------------------------------------------------------------ */

const EPOCH = Date.UTC(2026, 0, 1);
const MISCONCEPTION = "adds numerators and denominators";
const OTHER_MISCONCEPTION = "inverts the divisor";
const SKILL = 2;

const at = (day: number, minute = 0) => new Date(EPOCH + day * 86_400_000 + minute * 60_000);

/** An item whose option 1 encodes the tracked misconception. */
function trapItem(params: {
  questionId: number;
  day: number;
  /** "exhibit" = picks the misconception option, "other" = a different wrong option. */
  outcome: "correct" | "exhibit" | "other";
  mastery?: number;
  session?: number;
  minute?: number;
  misconception?: string;
}): ResponseObservation {
  const label = params.misconception ?? MISCONCEPTION;
  return {
    questionId: params.questionId,
    skillId: SKILL,
    subskill: null,
    selectedOption: params.outcome === "correct" ? 0 : params.outcome === "exhibit" ? 1 : 2,
    isCorrect: params.outcome === "correct",
    observedAt: at(params.day, params.minute ?? 0),
    masteryAtObservation: params.mastery ?? 0.4,
    sessionId: params.session ?? params.day,
    distractorMeta: [
      { optionIndex: 1, misconception: label },
      { optionIndex: 2, misconception: OTHER_MISCONCEPTION },
    ],
  };
}

/** An item on the same skill that does NOT offer the misconception option. */
function nonTrapItem(questionId: number, day: number, isCorrect = true): ResponseObservation {
  return {
    questionId,
    skillId: SKILL,
    subskill: null,
    selectedOption: isCorrect ? 0 : 2,
    isCorrect,
    observedAt: at(day),
    masteryAtObservation: 0.5,
    sessionId: day,
    distractorMeta: [{ optionIndex: 2, misconception: OTHER_MISCONCEPTION }],
  };
}

function remediation(day: number, source: RemediationExposure["source"] = "tutor_llm", targeted = true): RemediationExposure {
  return {
    source,
    skillId: SKILL,
    misconception: targeted ? MISCONCEPTION : undefined,
    occurredAt: at(day, 30),
  };
}

/** Two detections of the misconception on days 1 and 2 → MEDIUM confidence. */
const DETECTION_RESPONSES: ResponseObservation[] = [
  trapItem({ questionId: 101, day: 1, outcome: "exhibit", mastery: 0.35 }),
  trapItem({ questionId: 102, day: 2, outcome: "exhibit", mastery: 0.33 }),
];

function hypothesesFrom(responses: ResponseObservation[]) {
  const evidence: MisconceptionEvidence[] = responses.map((r) => ({
    questionId: r.questionId,
    skillId: r.skillId,
    subskill: r.subskill,
    selectedOption: r.selectedOption,
    distractor: null,
    misconception:
      r.distractorMeta?.find((d) => d.optionIndex === r.selectedOption)?.misconception ?? null,
    prerequisiteSkillId: null,
    isCorrect: r.isCorrect,
    responseTimeRatio: 1,
    observedAt: r.observedAt,
    masteryAtObservation: r.masteryAtObservation,
  }));
  return detectMisconceptions(evidence);
}

function build(params: {
  responses: ResponseObservation[];
  remediations?: RemediationExposure[];
  asOf?: Date;
  config?: Partial<typeof DEFAULT_LONGITUDINAL_CONFIG>;
}) {
  const responses = [...DETECTION_RESPONSES, ...params.responses];
  return buildMisconceptionEpisodes({
    studentId: 1,
    hypotheses: hypothesesFrom(responses),
    responses,
    remediations: params.remediations,
    config: params.config,
    asOf: params.asOf,
  });
}

/* ------------------------------------------------------------------ */
/* Source-of-truth model is untouched                                  */
/* ------------------------------------------------------------------ */

describe("deterministic detector is unchanged", () => {
  it("still produces the same hypotheses from the same evidence", () => {
    const hypotheses = hypothesesFrom(DETECTION_RESPONSES);
    expect(hypotheses).toHaveLength(1);
    expect(hypotheses[0].misconception).toBe(MISCONCEPTION);
    expect(hypotheses[0].confidence).toBe("MEDIUM");
    expect(hypotheses[0].errorPattern).toBe("repeated_misconception");
    expect(hypotheses[0].evidenceCount).toBe(2);
  });

  it("only tracks medium/high-confidence hypotheses longitudinally", () => {
    const single = [trapItem({ questionId: 101, day: 1, outcome: "exhibit" })];
    const hypotheses = hypothesesFrom(single);
    expect(hypotheses[0].confidence).toBe("LOW");

    const episodes = buildMisconceptionEpisodes({
      studentId: 1,
      hypotheses,
      responses: single,
      remediations: [remediation(2)],
    });
    expect(episodes).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Opportunity semantics                                               */
/* ------------------------------------------------------------------ */

describe("opportunity detection", () => {
  const hypothesis = { skillId: SKILL, subskill: null, misconception: MISCONCEPTION };

  it("counts an item only when the misconception's distractor was available", () => {
    expect(isOpportunity(trapItem({ questionId: 1, day: 5, outcome: "correct" }), hypothesis)).toBe(true);
    expect(isOpportunity(nonTrapItem(2, 5), hypothesis)).toBe(false);
  });

  it("ignores items on other skills", () => {
    const other = { ...trapItem({ questionId: 3, day: 5, outcome: "correct" }), skillId: 99 };
    expect(isOpportunity(other, hypothesis)).toBe(false);
  });

  it("recognises exhibition only when the misconception option was chosen", () => {
    expect(exhibitedMisconception(trapItem({ questionId: 4, day: 5, outcome: "exhibit" }), hypothesis)).toBe(true);
    expect(exhibitedMisconception(trapItem({ questionId: 5, day: 5, outcome: "other" }), hypothesis)).toBe(false);
    expect(exhibitedMisconception(trapItem({ questionId: 6, day: 5, outcome: "correct" }), hypothesis)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* The four-way classification                                         */
/* ------------------------------------------------------------------ */

describe("genuine resolution", () => {
  it("requires clean opportunities, correctness, sessions AND a retention window", () => {
    const [episode] = build({
      remediations: [remediation(3)],
      responses: [
        trapItem({ questionId: 201, day: 4, outcome: "correct", mastery: 0.5, session: 4 }),
        trapItem({ questionId: 202, day: 6, outcome: "correct", mastery: 0.58, session: 6 }),
        trapItem({ questionId: 203, day: 14, outcome: "correct", mastery: 0.66, session: 14 }),
      ],
    });

    expect(episode.status).toBe("resolved");
    expect(episode.recurrences).toBe(0);
    expect(episode.cleanOpportunities).toBe(3);
    expect(episode.resolvedAt).toBe(at(14).toISOString());
    // Clock starts at DETECTION (day 2, the 2nd observation), not first error.
    expect(episode.detectedAt).toBe(at(2).toISOString());
    expect(episode.timeToResolutionDays).toBe(12);
    expect(episode.statusReason).toContain("no recurrence");
  });

  it("reports mastery change and time-to-remediation", () => {
    const [episode] = build({
      remediations: [remediation(3)],
      responses: [
        trapItem({ questionId: 201, day: 4, outcome: "correct", mastery: 0.5, session: 4 }),
        trapItem({ questionId: 202, day: 6, outcome: "correct", mastery: 0.58, session: 6 }),
        trapItem({ questionId: 203, day: 14, outcome: "correct", mastery: 0.72, session: 14 }),
      ],
    });
    expect(episode.masteryAtDetection).toBeCloseTo(0.33, 5);
    expect(episode.masteryLatest).toBeCloseTo(0.72, 5);
    expect(episode.masteryChange).toBeCloseTo(0.39, 4);
    expect(episode.timeToRemediationDays).toBeCloseTo(1.02, 1);
  });
});

describe("temporary disappearance", () => {
  it("does not call it resolved when everything happened in one session", () => {
    const [episode] = build({
      remediations: [remediation(3)],
      responses: [
        trapItem({ questionId: 201, day: 3, outcome: "correct", session: 3, minute: 45 }),
        trapItem({ questionId: 202, day: 3, outcome: "correct", session: 3, minute: 50 }),
        trapItem({ questionId: 203, day: 3, outcome: "correct", session: 3, minute: 55 }),
      ],
    });
    expect(episode.status).toBe("temporarily_suppressed");
    expect(episode.statusReason).toContain("retention window");
    expect(episode.statusReason).toContain("distinct sessions");
    expect(episode.timeToResolutionDays).toBeNull();
  });

  it("does not call it resolved on too few opportunities, however spread out", () => {
    const [episode] = build({
      remediations: [remediation(3)],
      responses: [
        trapItem({ questionId: 201, day: 4, outcome: "correct", session: 4 }),
        trapItem({ questionId: 202, day: 30, outcome: "correct", session: 30 }),
      ],
    });
    expect(episode.status).toBe("temporarily_suppressed");
    expect(episode.statusReason).toContain("2/3 clean opportunities");
  });

  it("does not accept 'not this error' as mastery — correctness is required", () => {
    // Three clean, well-spread opportunities, but the learner kept getting them
    // wrong via a DIFFERENT distractor. The tracked misconception is absent, yet
    // there is no evidence of understanding.
    const [episode] = build({
      remediations: [remediation(3)],
      responses: [
        trapItem({ questionId: 201, day: 4, outcome: "other", session: 4 }),
        trapItem({ questionId: 202, day: 9, outcome: "other", session: 9 }),
        trapItem({ questionId: 203, day: 14, outcome: "other", session: 14 }),
      ],
    });
    expect(episode.status).toBe("temporarily_suppressed");
    expect(episode.statusReason).toContain("0/2 answered correctly");
  });
});

describe("insufficient evidence", () => {
  it("flags episodes that were never remediated", () => {
    const [episode] = build({
      responses: [trapItem({ questionId: 201, day: 4, outcome: "correct", session: 4 })],
    });
    expect(episode.status).toBe("insufficient_evidence");
    expect(episode.statusReason).toContain("No remediation exposure");
    expect(episode.firstRemediationAt).toBeNull();
    expect(episode.timeToRemediationDays).toBeNull();
  });

  it("flags a learner who was never re-tested on the misconception", () => {
    // Plenty of subsequent practice — but none of it offered the trap, so the
    // silence proves nothing. This is the failure mode that makes naive
    // "error disappeared" metrics look great.
    const [episode] = build({
      remediations: [remediation(3)],
      responses: [nonTrapItem(301, 5), nonTrapItem(302, 9), nonTrapItem(303, 20)],
    });
    expect(episode.status).toBe("insufficient_evidence");
    expect(episode.statusReason).toContain("never had the chance to exhibit it");
    expect(episode.postRemediationOpportunities).toBe(0);
  });
});

describe("recurrence", () => {
  it("marks recurrence when the misconception reappears after remediation", () => {
    const [episode] = build({
      remediations: [remediation(3)],
      responses: [
        trapItem({ questionId: 201, day: 4, outcome: "correct", session: 4 }),
        trapItem({ questionId: 202, day: 11, outcome: "exhibit", session: 11 }),
      ],
    });
    expect(episode.status).toBe("recurred");
    expect(episode.recurrences).toBe(1);
    expect(episode.resolvedAt).toBeNull();
  });

  it("recurrence outranks an otherwise resolution-worthy record", () => {
    const [episode] = build({
      remediations: [remediation(3)],
      responses: [
        trapItem({ questionId: 201, day: 4, outcome: "correct", session: 4 }),
        trapItem({ questionId: 202, day: 6, outcome: "correct", session: 6 }),
        trapItem({ questionId: 203, day: 14, outcome: "correct", session: 14 }),
        trapItem({ questionId: 204, day: 21, outcome: "exhibit", session: 21 }),
        trapItem({ questionId: 205, day: 28, outcome: "correct", session: 28 }),
      ],
    });
    expect(episode.status).toBe("recurred");
    expect(episode.cleanOpportunities).toBe(4);
  });

  it("errors before remediation are not recurrence", () => {
    const [episode] = build({
      remediations: [remediation(10)],
      responses: [
        trapItem({ questionId: 201, day: 4, outcome: "exhibit", session: 4 }),
        trapItem({ questionId: 202, day: 12, outcome: "correct", session: 12 }),
        trapItem({ questionId: 203, day: 14, outcome: "correct", session: 14 }),
        trapItem({ questionId: 204, day: 22, outcome: "correct", session: 22 }),
      ],
    });
    expect(episode.status).toBe("resolved");
    expect(episode.recurrences).toBe(0);
    expect(episode.opportunities.filter((o) => o.preRemediation)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* LLM explanations are never evidence                                 */
/* ------------------------------------------------------------------ */

describe("generated explanations are exposure, never outcome evidence", () => {
  it("cannot resolve an episode no matter how many explanations are delivered", () => {
    const manyExplanations = Array.from({ length: 25 }, (_, i) =>
      remediation(3 + i, i % 2 === 0 ? "tutor_llm" : "worked_example"),
    );
    const [episode] = build({ remediations: manyExplanations, responses: [] });
    expect(episode.status).toBe("insufficient_evidence");
    expect(episode.remediations.length).toBeGreaterThan(20);
    expect(episode.resolvedAt).toBeNull();
  });

  it("a helpful=true rating does not count either", () => {
    const [episode] = build({
      remediations: [{ ...remediation(3), helpful: true }],
      responses: [trapItem({ questionId: 201, day: 4, outcome: "correct", session: 4 })],
    });
    expect(episode.remediations[0].helpful).toBe(true);
    expect(episode.status).toBe("temporarily_suppressed");
  });

  it("refuses exposures passed as response evidence", () => {
    expect(() =>
      assertNoExposureEvidence([{ source: "tutor_llm", skillId: SKILL, occurredAt: at(1) }]),
    ).toThrow(/cannot be used as resolution evidence/);
    expect(() =>
      buildMisconceptionEpisodes({
        studentId: 1,
        hypotheses: hypothesesFrom(DETECTION_RESPONSES),
        responses: [remediation(3)] as never,
      }),
    ).toThrow(/only graded learner responses/);
  });

  it("names the generated sources explicitly so the rule is checkable", () => {
    expect(GENERATED_EXPLANATION_SOURCES).toContain("tutor_llm");
    expect(GENERATED_EXPLANATION_SOURCES).toContain("worked_example");
  });
});

/* ------------------------------------------------------------------ */
/* Longitudinal cohort metrics                                         */
/* ------------------------------------------------------------------ */

describe("cohort metrics", () => {
  function cohort() {
    const resolved = build({
      remediations: [remediation(3)],
      responses: [
        trapItem({ questionId: 201, day: 4, outcome: "correct", mastery: 0.5, session: 4 }),
        trapItem({ questionId: 202, day: 6, outcome: "correct", mastery: 0.6, session: 6 }),
        trapItem({ questionId: 203, day: 14, outcome: "correct", mastery: 0.7, session: 14 }),
      ],
    }).map((e) => ({ ...e, studentId: 1, groundTruth: "confirmed" as const }));

    const recurred = build({
      remediations: [remediation(3)],
      responses: [
        trapItem({ questionId: 201, day: 4, outcome: "correct", mastery: 0.45, session: 4 }),
        trapItem({ questionId: 202, day: 11, outcome: "exhibit", mastery: 0.4, session: 11 }),
      ],
    }).map((e) => ({ ...e, studentId: 2, groundTruth: "confirmed" as const }));

    const unevaluable = build({
      remediations: [remediation(3)],
      responses: [nonTrapItem(301, 5)],
    }).map((e) => ({ ...e, studentId: 3, groundTruth: "refuted" as const }));

    const unremediated = build({ responses: [] }).map((e) => ({ ...e, studentId: 4 }));

    return [...resolved, ...recurred, ...unevaluable, ...unremediated];
  }

  it("computes every required metric with an explicit denominator", () => {
    const metrics = remediationMetrics(cohort());
    expect(metrics.episodes).toBe(4);
    expect(metrics.byStatus).toEqual({
      resolved: 1,
      recurred: 1,
      temporarily_suppressed: 0,
      insufficient_evidence: 2,
    });
    // 3 of 4 got remediation; only 2 of those could be evaluated.
    expect(metrics.remediationResponseRate).toBe(0.75);
    expect(metrics.evaluable).toBe(2);
    expect(metrics.resolutionRate).toBe(0.5);
    expect(metrics.recurrenceRate).toBe(0.5);
    expect(metrics.medianTimeToResolutionDays).toBe(12);
    expect(metrics.downstreamMasteryGainResolved).toBeGreaterThan(0);
  });

  it("excludes un-retested episodes from the recurrence denominator", () => {
    const metrics = remediationMetrics(cohort());
    // Naively dividing recurrences by all detections would report 0.25 and make
    // the programme look twice as effective as the evidence supports.
    expect(metrics.recurrenceRate).toBe(0.5);
    expect(metrics.unevaluableRate).toBe(0.5);
  });

  it("separates false-discovery rate from a true false-positive rate", () => {
    const quality = detectionQuality(cohort());
    expect(quality.truePositives).toBe(2);
    expect(quality.falsePositives).toBe(1);
    expect(quality.precision).toBeCloseTo(0.6667, 3);
    expect(quality.falseDiscoveryRate).toBeCloseTo(0.3333, 3);
    // No labelled negatives supplied ⇒ FPR is unmeasurable, reported as null.
    expect(quality.falsePositiveRate).toBeNull();

    const withNegatives = detectionQuality(cohort(), { trueNegatives: 17 });
    expect(withNegatives.falsePositiveRate).toBeCloseTo(1 / 18, 4);
  });

  it("returns null — not zero — when nothing is labelled", () => {
    const unlabelled = cohort().map((e) => ({ ...e, groundTruth: "unknown" as const }));
    const quality = detectionQuality(unlabelled);
    expect(quality.precision).toBeNull();
    expect(quality.falseDiscoveryRate).toBeNull();
    expect(quality.labelCoverage).toBe(0);
  });

  it("emits caveats derived from the actual data", () => {
    const report = evaluateMisconceptionProgram(cohort());
    expect(report.caveats.join(" ")).toContain("no post-remediation opportunity");
    expect(report.caveats.join(" ")).toContain("noisy at this sample size");
    expect(report.caveats.join(" ")).toContain("labelled negatives");

    const unlabelled = cohort().map((e) => ({ ...e, groundTruth: "unknown" as const }));
    expect(evaluateMisconceptionProgram(unlabelled).caveats.join(" ")).toContain(
      "unmeasured, not good",
    );
  });

  it("ranks misconceptions by recurrence", () => {
    const report = evaluateMisconceptionProgram(cohort());
    expect(report.byMisconception[0].misconception).toBe(MISCONCEPTION);
    expect(report.generatedFrom.learners).toBe(4);
  });
});

/* ------------------------------------------------------------------ */
/* Determinism & configurability                                       */
/* ------------------------------------------------------------------ */

describe("robustness", () => {
  it("is deterministic and order-independent", () => {
    const responses = [
      trapItem({ questionId: 201, day: 4, outcome: "correct", session: 4 }),
      trapItem({ questionId: 202, day: 6, outcome: "correct", session: 6 }),
      trapItem({ questionId: 203, day: 14, outcome: "correct", session: 14 }),
    ];
    const forward = build({ remediations: [remediation(3)], responses });
    const shuffled = build({ remediations: [remediation(3)], responses: [...responses].reverse() });
    expect(JSON.stringify(shuffled)).toBe(JSON.stringify(forward));
  });

  it("honours a stricter resolution bar", () => {
    const responses = [
      trapItem({ questionId: 201, day: 4, outcome: "correct", session: 4 }),
      trapItem({ questionId: 202, day: 6, outcome: "correct", session: 6 }),
      trapItem({ questionId: 203, day: 14, outcome: "correct", session: 14 }),
    ];
    expect(build({ remediations: [remediation(3)], responses })[0].status).toBe("resolved");
    expect(
      build({ remediations: [remediation(3)], responses, config: { retentionDays: 30 } })[0].status,
    ).toBe("temporarily_suppressed");
    expect(
      build({ remediations: [remediation(3)], responses, config: { minCleanOpportunities: 5 } })[0].status,
    ).toBe("temporarily_suppressed");
  });

  it("respects an as-of cut-off so history can be replayed", () => {
    const responses = [
      trapItem({ questionId: 201, day: 4, outcome: "correct", session: 4 }),
      trapItem({ questionId: 202, day: 6, outcome: "correct", session: 6 }),
      trapItem({ questionId: 203, day: 14, outcome: "correct", session: 14 }),
      trapItem({ questionId: 204, day: 20, outcome: "exhibit", session: 20 }),
    ];
    // As of day 15 the evidence supported resolution...
    expect(build({ remediations: [remediation(3)], responses, asOf: at(15) })[0].status).toBe("resolved");
    // ...and by day 21 it did not. Both statements are true of their moment.
    expect(build({ remediations: [remediation(3)], responses, asOf: at(21) })[0].status).toBe("recurred");
  });

  it("keeps a full opportunity trail so any status can be re-derived", () => {
    const [episode] = build({
      remediations: [remediation(3)],
      responses: [
        trapItem({ questionId: 201, day: 4, outcome: "correct", session: 4 }),
        trapItem({ questionId: 202, day: 11, outcome: "exhibit", session: 11 }),
      ],
    });
    expect(episode.opportunities).toHaveLength(2);
    expect(episode.opportunities.map((o) => o.exhibited)).toEqual([false, true]);
    expect(episode.opportunities.every((o) => o.observedAt && o.questionId)).toBe(true);
  });
});
