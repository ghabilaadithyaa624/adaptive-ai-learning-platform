/**
 * Regression tests for the v3 multi-objective adaptive policy.
 *
 * These lock the *behavioural contract* — the things a future refactor could
 * silently break and that the benchmark's aggregate numbers would hide:
 * hard gates, explainability, determinism, configurability, and the bounds
 * every objective is assumed to respect.
 */
import { describe, expect, it } from "vitest";
import {
  MultiObjectivePolicy,
  selectNextItemV3,
  POLICY_V3_ID,
  DEFAULT_POLICY_PARAMS,
  DEFAULT_POLICY_WEIGHTS,
  PRIOR_WEIGHTS,
  TUNED_WEIGHTS,
  TUNED_PARAMS,
  TUNING_PROVENANCE,
  BENEFIT_OBJECTIVES,
  PENALTY_OBJECTIVES,
  OBJECTIVE_METADATA,
  normalizeWeights,
  resolvePolicyConfig,
  getSelectionStrategy,
  resolvePolicyId,
  DEFAULT_POLICY_ID,
} from "@/lib/ml/policy";
import { DECISION_EXPLANATION_SCHEMA } from "@/lib/ml/interfaces";
import { bktModel } from "@/lib/ml/models/bkt";
import type {
  CandidateItem,
  LearnerSkillState,
  LearnerState,
  ResponseModel,
  SelectionInput,
} from "@/lib/ml/interfaces";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function skill(partial: Partial<LearnerSkillState> & { skillId: number; skillName: string }): LearnerSkillState {
  return {
    subjectName: "Math",
    mastery: 0.5,
    rawMastery: 0.5,
    confidence: 0.5,
    uncertainty: 0.3,
    attempts: 5,
    correct: 3,
    streak: 0,
    accuracy: 0.6,
    recentAccuracy: 0.6,
    responseRatio: 1,
    retention: 1,
    daysSincePractice: 1,
    velocity: 0,
    prereqReadiness: 1,
    prereqMastery: [],
    errorProfile: { type: "none", carelessRate: 0, strugglingRate: 0, guessRate: 0, label: "" },
    hintReliance: 0,
    hasHintData: false,
    avgDifficulty: 0.5,
    avgBloom: 3,
    difficultyBase: 0.5,
    pathAlignment: 0.5,
    prereqIds: [],
    ...partial,
  };
}

function learner(skills: LearnerSkillState[], overrides: Partial<LearnerState> = {}): LearnerState {
  return {
    studentId: 1,
    ability: 0.5,
    historicalAccuracy: 0.6,
    recentAccuracy: 0.6,
    avgResponseRatio: 1,
    velocity: 0,
    engagement: 0.6,
    context: { mode: "adaptive_quiz", itemsAnswered: 0, itemTarget: 8, sessionAccuracy: 0.6, fatigue: 0 },
    skills: new Map(skills.map((s) => [s.skillId, s])),
    ...overrides,
  };
}

function candidate(partial: Partial<CandidateItem> & { questionId: number; skillId: number }): CandidateItem {
  return {
    skillName: "Skill",
    subjectName: "Math",
    item: { difficulty: 0.5, bloom: 3, expectedTimeMs: 60_000 },
    estimatedSeconds: 60,
    text: "Q",
    ...partial,
  };
}

/** P(correct) falls linearly with difficulty — easy to reason about in tests. */
const linearResponse: ResponseModel = {
  id: "test-linear",
  predict: (ctx) => Math.max(0.02, Math.min(0.98, 1 - ctx.item.difficulty)),
};

function baseInput(overrides: Partial<SelectionInput> = {}): SelectionInput {
  return {
    learner: learner([skill({ skillId: 1, skillName: "Algebra" })]),
    candidates: [candidate({ questionId: 10, skillId: 1, skillName: "Algebra" })],
    seenQuestionIds: new Set(),
    askedSkillCounts: new Map(),
    askedBloomCounts: new Map(),
    responseModel: linearResponse,
    knowledgeModel: bktModel,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* Hard gates                                                          */
/* ------------------------------------------------------------------ */

describe("v3 policy — hard gates", () => {
  it("never serves a question the learner has already seen", () => {
    const res = selectNextItemV3(
      baseInput({
        candidates: [candidate({ questionId: 10, skillId: 1 }), candidate({ questionId: 11, skillId: 1 })],
        seenQuestionIds: new Set([10]),
      }),
    );
    expect(res.chosen?.candidate.questionId).toBe(11);
    const gate = res.chosen?.decision.gates.find((g) => g.key === "no-repeat");
    expect(gate?.filtered).toBe(1);
    expect(gate?.relaxed).toBe(false);
  });

  it("blocks a skill whose prerequisites are not confidently met", () => {
    const res = selectNextItemV3(
      baseInput({
        learner: learner([
          skill({ skillId: 1, skillName: "Foundations", mastery: 0.3, uncertainty: 0.2 }),
          skill({
            skillId: 2,
            skillName: "Advanced",
            prereqIds: [1],
            prereqReadiness: 0.3,
            prereqMastery: [{ skillId: 1, name: "Foundations", mastery: 0.3 }],
          }),
        ]),
        candidates: [
          candidate({ questionId: 20, skillId: 1, skillName: "Foundations" }),
          candidate({ questionId: 21, skillId: 2, skillName: "Advanced" }),
        ],
      }),
    );
    expect(res.chosen?.candidate.skillId).toBe(1);
    expect(res.chosen?.decision.gates.find((g) => g.key === "prerequisite-safety")?.filtered).toBe(1);
  });

  it("gates on a lower confidence bound, not the point estimate", () => {
    // Same point estimate, different uncertainty: the confident learner passes a
    // gate the uncertain one does not. This is the core v2 defect v3 fixes.
    const atGate = DEFAULT_POLICY_PARAMS.prereqGate + 0.05;
    const build = (uncertainty: number) =>
      selectNextItemV3(
        baseInput({
          learner: learner([
            skill({ skillId: 1, skillName: "Foundations", mastery: atGate, uncertainty }),
            skill({
              skillId: 2,
              skillName: "Advanced",
              prereqIds: [1],
              prereqReadiness: atGate,
              prereqMastery: [{ skillId: 1, name: "Foundations", mastery: atGate }],
            }),
          ]),
          candidates: [
            candidate({ questionId: 20, skillId: 1, skillName: "Foundations" }),
            candidate({ questionId: 21, skillId: 2, skillName: "Advanced" }),
          ],
        }),
      );

    const confident = build(0.01);
    const uncertain = build(0.6);
    expect(confident.chosen?.decision.gates.find((g) => g.key === "prerequisite-safety")?.filtered).toBe(0);
    expect(uncertain.chosen?.decision.gates.find((g) => g.key === "prerequisite-safety")?.filtered).toBe(1);
  });

  it("relaxes a gate rather than dead-ending the session, and says so", () => {
    // Only an unsafe item exists — the learner must still get a question.
    const res = selectNextItemV3(
      baseInput({
        learner: learner([
          skill({ skillId: 1, skillName: "Foundations", mastery: 0.2, uncertainty: 0.2 }),
          skill({
            skillId: 2,
            skillName: "Advanced",
            prereqIds: [1],
            prereqReadiness: 0.2,
            prereqMastery: [{ skillId: 1, name: "Foundations", mastery: 0.2 }],
          }),
        ]),
        candidates: [candidate({ questionId: 21, skillId: 2, skillName: "Advanced" })],
      }),
    );
    expect(res.chosen).not.toBeNull();
    const gate = res.chosen?.decision.gates.find((g) => g.key === "prerequisite-safety");
    expect(gate?.relaxed).toBe(true);
    // A relaxed gate must cost the item score via the risk penalty.
    const risk = res.chosen?.decision.objectives.find((o) => o.key === "prerequisiteRisk");
    expect(risk?.contribution).toBeLessThan(0);
  });

  it("returns null only when there is genuinely nothing to serve", () => {
    const res = selectNextItemV3(baseInput({ candidates: [] }));
    expect(res.chosen).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Explainability                                                      */
/* ------------------------------------------------------------------ */

describe("v3 policy — explainability", () => {
  const res = selectNextItemV3(
    baseInput({
      candidates: [
        candidate({ questionId: 10, skillId: 1, item: { difficulty: 0.3, bloom: 2, expectedTimeMs: 60_000 } }),
        candidate({ questionId: 11, skillId: 1, item: { difficulty: 0.55, bloom: 3, expectedTimeMs: 60_000 } }),
        candidate({ questionId: 12, skillId: 1, item: { difficulty: 0.9, bloom: 5, expectedTimeMs: 60_000 } }),
      ],
    }),
  );

  it("emits a machine-readable decision for every selected question", () => {
    const decision = res.chosen!.decision;
    expect(decision.schema).toBe(DECISION_EXPLANATION_SCHEMA);
    expect(decision.policyId).toBe(POLICY_V3_ID);
    expect(decision.questionId).toBe(res.chosen!.candidate.questionId);
    expect(decision.rank).toBe(1);
    expect(decision.candidatesConsidered).toBe(3);
    expect(decision.configFingerprint).toBeTruthy();
  });

  it("scores every objective, with contributions that reconstruct the score", () => {
    const decision = res.chosen!.decision;
    const keys = decision.objectives.map((o) => o.key).sort();
    expect(keys).toEqual([...BENEFIT_OBJECTIVES, ...PENALTY_OBJECTIVES].sort());
    const summed = decision.objectives.reduce((acc, o) => acc + o.contribution, 0);
    expect(summed).toBeCloseTo(decision.score, 6);
  });

  it("keeps every normalised objective inside [0, 1]", () => {
    for (const item of res.ranked) {
      for (const objective of item.decision.objectives) {
        expect(objective.normalized).toBeGreaterThanOrEqual(0);
        expect(objective.normalized).toBeLessThanOrEqual(1);
      }
    }
  });

  it("names the runner-up and what decided against it", () => {
    const cf = res.chosen!.decision.counterfactual;
    expect(cf).not.toBeNull();
    expect(cf!.runnerUpQuestionId).toBe(res.ranked[1].candidate.questionId);
    expect(cf!.scoreMargin).toBeGreaterThanOrEqual(0);
    expect(cf!.decidingObjectives.length).toBeGreaterThan(0);
  });

  it("orders topDrivers by absolute contribution", () => {
    const decision = res.chosen!.decision;
    const byContribution = [...decision.objectives]
      .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
      .map((o) => o.key);
    expect(decision.topDrivers).toEqual(byContribution.slice(0, decision.topDrivers.length));
  });

  it("carries a human-readable rationale alongside the structured record", () => {
    expect(res.chosen!.explanation.length).toBeGreaterThan(10);
    expect(res.chosen!.steps.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* Pedagogical behaviour                                               */
/* ------------------------------------------------------------------ */

describe("v3 policy — targeting behaviour", () => {
  it("prefers an item in the productive band over a trivial or impossible one", () => {
    const res = selectNextItemV3(
      baseInput({
        candidates: [
          candidate({ questionId: 10, skillId: 1, item: { difficulty: 0.02, bloom: 1, expectedTimeMs: 60_000 } }),
          candidate({ questionId: 11, skillId: 1, item: { difficulty: 0.35, bloom: 3, expectedTimeMs: 60_000 } }),
          candidate({ questionId: 12, skillId: 1, item: { difficulty: 0.99, bloom: 6, expectedTimeMs: 60_000 } }),
        ],
      }),
    );
    expect(res.chosen?.candidate.questionId).toBe(11);
  });

  it("breaks up a run on one skill once the consecutive cap is reached", () => {
    const cap = DEFAULT_POLICY_PARAMS.maxConsecutiveSameSkill;
    const res = selectNextItemV3(
      baseInput({
        learner: learner([
          skill({ skillId: 1, skillName: "Algebra" }),
          skill({ skillId: 2, skillName: "Geometry" }),
        ]),
        candidates: [
          candidate({ questionId: 10, skillId: 1, skillName: "Algebra" }),
          candidate({ questionId: 20, skillId: 2, skillName: "Geometry" }),
        ],
        recentSkillIds: Array.from({ length: cap }, () => 1),
      }),
    );
    expect(res.chosen?.candidate.skillId).toBe(2);
  });

  it("prefers an unseen skill over one already drilled this session", () => {
    const res = selectNextItemV3(
      baseInput({
        learner: learner([
          skill({ skillId: 1, skillName: "Algebra" }),
          skill({ skillId: 2, skillName: "Geometry" }),
        ]),
        candidates: [
          candidate({ questionId: 10, skillId: 1, skillName: "Algebra" }),
          candidate({ questionId: 20, skillId: 2, skillName: "Geometry" }),
        ],
        askedSkillCounts: new Map([[1, 3]]),
      }),
    );
    expect(res.chosen?.candidate.skillId).toBe(2);
  });

  it("is deterministic and breaks ties by question id", () => {
    const input = () =>
      baseInput({
        candidates: [
          candidate({ questionId: 30, skillId: 1 }),
          candidate({ questionId: 12, skillId: 1 }),
          candidate({ questionId: 25, skillId: 1 }),
        ],
      });
    const first = selectNextItemV3(input());
    const second = selectNextItemV3(input());
    expect(second.chosen?.candidate.questionId).toBe(first.chosen?.candidate.questionId);
    expect(second.ranked.map((r) => r.score)).toEqual(first.ranked.map((r) => r.score));
    // identical candidates differing only by id ⇒ lowest id wins
    expect(first.chosen?.candidate.questionId).toBe(12);
  });
});

/* ------------------------------------------------------------------ */
/* Configuration & provenance                                          */
/* ------------------------------------------------------------------ */

describe("v3 policy — configuration", () => {
  it("honours per-call weight overrides", () => {
    const candidates = [
      candidate({ questionId: 10, skillId: 1, item: { difficulty: 0.15, bloom: 1, expectedTimeMs: 30_000 } }),
      candidate({ questionId: 11, skillId: 1, item: { difficulty: 0.8, bloom: 5, expectedTimeMs: 240_000 } }),
    ];
    const timeBlind = new MultiObjectivePolicy({ weights: { assessmentEfficiency: 0 } }).select(
      baseInput({ candidates }),
    );
    const timeGreedy = new MultiObjectivePolicy({ weights: { assessmentEfficiency: 5 } }).select(
      baseInput({ candidates }),
    );
    // A policy that only cares about time must take the 30-second item.
    expect(timeGreedy.chosen?.candidate.questionId).toBe(10);
    expect(timeGreedy.chosen?.decision.configFingerprint).not.toBe(timeBlind.chosen?.decision.configFingerprint);
  });

  it("renormalises benefit weights so the score stays on a 0..1 scale", () => {
    const normalized = normalizeWeights({ ...PRIOR_WEIGHTS });
    const sum = BENEFIT_OBJECTIVES.reduce((acc, k) => acc + normalized[k], 0);
    expect(sum).toBeCloseTo(1, 6);
    // Doubling every benefit weight must not change the normalised vector.
    const doubled = normalizeWeights(
      Object.fromEntries(
        Object.entries(PRIOR_WEIGHTS).map(([k, v]) => [k, BENEFIT_OBJECTIVES.includes(k as never) ? v * 2 : v]),
      ) as typeof PRIOR_WEIGHTS,
    );
    for (const key of BENEFIT_OBJECTIVES) expect(doubled[key]).toBeCloseTo(normalized[key], 6);
  });

  it("produces a stable fingerprint for identical configuration", () => {
    expect(resolvePolicyConfig({}).fingerprint).toBe(resolvePolicyConfig({}).fingerprint);
    expect(resolvePolicyConfig({ weights: { retention: 0.5 } }).fingerprint).not.toBe(
      resolvePolicyConfig({}).fingerprint,
    );
  });

  it("documents every objective it ships", () => {
    for (const key of [...BENEFIT_OBJECTIVES, ...PENALTY_OBJECTIVES]) {
      const meta = OBJECTIVE_METADATA[key];
      expect(meta.rationale.length).toBeGreaterThan(30);
      expect(meta.evidence.length).toBeGreaterThan(20);
    }
  });

  it("ships the tuned weights and parameters the tuner reported", () => {
    // Guards against hand-editing `TUNED_WEIGHTS` without re-running the tuner.
    expect(DEFAULT_POLICY_WEIGHTS).toEqual(TUNED_WEIGHTS);
    expect(DEFAULT_POLICY_PARAMS.prereqGate).toBe(TUNED_PARAMS.prereqGate);
    expect(DEFAULT_POLICY_PARAMS.prereqPessimismZ).toBe(TUNED_PARAMS.prereqPessimismZ);
    expect(DEFAULT_POLICY_PARAMS.maxPerSkill).toBe(TUNED_PARAMS.maxPerSkill);
    // Tuning must have beaten its own starting point on the train objective.
    expect(TUNING_PROVENANCE.tunedUtility).toBeGreaterThan(TUNING_PROVENANCE.priorUtility);
  });

  it("resolves the serving strategy from configuration", () => {
    expect(resolvePolicyId("v2")).toBe("v2");
    expect(resolvePolicyId("v3")).toBe("v3");
    expect(resolvePolicyId(undefined)).toBe(DEFAULT_POLICY_ID);
    expect(getSelectionStrategy("v2").id).toContain("v2");
    expect(getSelectionStrategy("v3").id).toBe(POLICY_V3_ID);
  });
});
