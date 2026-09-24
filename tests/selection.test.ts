import { describe, expect, it } from "vitest";
import { selectNextItemV2, DEFAULT_SELECTION_WEIGHTS } from "@/lib/ml/selection";
import { bktModel } from "@/lib/ml/models/bkt";
import type {
  CandidateItem,
  LearnerSkillState,
  LearnerState,
  ResponseModel,
  SelectionInput,
} from "@/lib/ml/interfaces";

function skill(partial: Partial<LearnerSkillState> & { skillId: number; skillName: string }): LearnerSkillState {
  return {
    subjectName: "Math",
    mastery: 0.5,
    rawMastery: 0.5,
    confidence: 0.5,
    uncertainty: 0.5,
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

function learner(skills: LearnerSkillState[]): LearnerState {
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

/** ResponseModel whose P(correct) is a simple function of item difficulty. */
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

describe("selectNextItemV2", () => {
  it("(7) hard-excludes already-served questions", () => {
    const res = selectNextItemV2(
      baseInput({
        candidates: [candidate({ questionId: 10, skillId: 1 }), candidate({ questionId: 11, skillId: 1 })],
        seenQuestionIds: new Set([10]),
      }),
    );
    expect(res.excluded).toBe(1);
    expect(res.chosen?.candidate.questionId).toBe(11);
  });

  it("returns null when every candidate has been seen", () => {
    const res = selectNextItemV2(baseInput({ seenQuestionIds: new Set([10]) }));
    expect(res.chosen).toBeNull();
  });

  it("produces a house-style explanation naming the skill, mastery and target", () => {
    const res = selectNextItemV2(baseInput());
    const text = res.chosen!.explanation;
    expect(text).toContain("Selected because");
    expect(text).toContain("Algebra");
    expect(text).toContain("target is");
    expect(text).toMatch(/predicted success is \d+%/);
  });

  it("(4) targets the zone of proximal development — picks the ZPD-fit item", () => {
    // three items: too easy, well-fitted, too hard (difficulty controls P via linearResponse)
    const res = selectNextItemV2(
      baseInput({
        learner: learner([skill({ skillId: 1, skillName: "Algebra", mastery: 0.5, confidence: 0.5 })]),
        candidates: [
          candidate({ questionId: 1, skillId: 1, item: { difficulty: 0.05, bloom: 3 } }), // p≈0.95 too easy
          candidate({ questionId: 2, skillId: 1, item: { difficulty: 0.35, bloom: 3 } }), // p≈0.65 fitted
          candidate({ questionId: 3, skillId: 1, item: { difficulty: 0.95, bloom: 3 } }), // p≈0.05 too hard
        ],
      }),
    );
    expect(res.chosen?.candidate.questionId).toBe(2);
  });

  it("(1) prefers the skill with the larger mastery gap, all else equal", () => {
    const res = selectNextItemV2(
      baseInput({
        learner: learner([
          skill({ skillId: 1, skillName: "Strong", mastery: 0.8, confidence: 0.6 }),
          skill({ skillId: 2, skillName: "Weak", mastery: 0.35, confidence: 0.6 }),
        ]),
        candidates: [
          candidate({ questionId: 1, skillId: 1, skillName: "Strong", item: { difficulty: 0.4, bloom: 3 } }),
          candidate({ questionId: 2, skillId: 2, skillName: "Weak", item: { difficulty: 0.4, bloom: 3 } }),
        ],
      }),
    );
    expect(res.chosen?.candidate.skillName).toBe("Weak");
  });

  it("(5) penalises items whose prerequisites are not yet met", () => {
    const gated = learner([
      skill({ skillId: 1, skillName: "Gated", mastery: 0.4, prereqReadiness: 0.1, prereqMastery: [{ skillId: 9, name: "Basics", mastery: 0.1 }] }),
      skill({ skillId: 2, skillName: "Ready", mastery: 0.4, prereqReadiness: 1 }),
    ]);
    const res = selectNextItemV2(
      baseInput({
        learner: gated,
        candidates: [
          candidate({ questionId: 1, skillId: 1, skillName: "Gated", item: { difficulty: 0.4, bloom: 3 } }),
          candidate({ questionId: 2, skillId: 2, skillName: "Ready", item: { difficulty: 0.4, bloom: 3 } }),
        ],
      }),
    );
    expect(res.chosen?.candidate.skillName).toBe("Ready");
    // the gated item is routed away from entirely (hard-excluded) when a ready
    // alternative exists, rather than merely down-weighted
    expect(res.ranked.find((r) => r.candidate.skillName === "Gated")).toBeUndefined();
    expect(res.excluded).toBe(1);
  });

  it("(5) still scores a gated item when no ready alternative exists (no dead-end)", () => {
    const allGated = learner([
      skill({ skillId: 1, skillName: "OnlyGated", mastery: 0.4, prereqReadiness: 0.1, prereqMastery: [{ skillId: 9, name: "Basics", mastery: 0.1 }] }),
    ]);
    const res = selectNextItemV2(
      baseInput({ learner: allGated, candidates: [candidate({ questionId: 1, skillId: 1, skillName: "OnlyGated" })] }),
    );
    expect(res.chosen?.candidate.skillName).toBe("OnlyGated");
    expect(res.chosen!.factors.find((f) => f.key === "prereq")!.weighted).toBeLessThan(0);
  });

  it("(6) diversity: over-asked skills are penalised", () => {
    const twoSkills = learner([
      skill({ skillId: 1, skillName: "Overasked", mastery: 0.4 }),
      skill({ skillId: 2, skillName: "Fresh", mastery: 0.4 }),
    ]);
    const res = selectNextItemV2(
      baseInput({
        learner: twoSkills,
        candidates: [
          candidate({ questionId: 1, skillId: 1, skillName: "Overasked", item: { difficulty: 0.4, bloom: 3 } }),
          candidate({ questionId: 2, skillId: 2, skillName: "Fresh", item: { difficulty: 0.4, bloom: 3 } }),
        ],
        askedSkillCounts: new Map([[1, 4]]),
      }),
    );
    expect(res.chosen?.candidate.skillName).toBe("Fresh");
  });

  it("(8) exploration: low-evidence skills get a larger exploration bonus", () => {
    const res = selectNextItemV2(
      baseInput({
        learner: learner([
          skill({ skillId: 1, skillName: "New", attempts: 0, mastery: 0.4 }),
          skill({ skillId: 2, skillName: "Seen", attempts: 30, mastery: 0.4 }),
        ]),
        candidates: [
          candidate({ questionId: 1, skillId: 1, skillName: "New", item: { difficulty: 0.4, bloom: 3 } }),
          candidate({ questionId: 2, skillId: 2, skillName: "Seen", item: { difficulty: 0.4, bloom: 3 } }),
        ],
      }),
    );
    const newExplore = res.ranked.find((r) => r.candidate.skillName === "New")!.factors.find((f) => f.key === "exploration")!;
    const seenExplore = res.ranked.find((r) => r.candidate.skillName === "Seen")!.factors.find((f) => f.key === "exploration")!;
    expect(newExplore.weighted).toBeGreaterThan(seenExplore.weighted);
  });

  it("(9) spaced review: a mastered-but-decaying skill earns review pressure", () => {
    const res = selectNextItemV2(
      baseInput({
        learner: learner([
          skill({ skillId: 1, skillName: "Decayed", mastery: 0.82, retention: 0.5, daysSincePractice: 30, confidence: 0.8 }),
        ]),
        candidates: [candidate({ questionId: 1, skillId: 1, skillName: "Decayed", item: { difficulty: 0.4, bloom: 3 } })],
      }),
    );
    const review = res.chosen!.factors.find((f) => f.key === "spacedReview")!;
    expect(review.value).toBeGreaterThan(0);
  });

  it("(10) uncertainty factor grows with skill uncertainty", () => {
    const res = selectNextItemV2(
      baseInput({
        learner: learner([skill({ skillId: 1, skillName: "Uncertain", uncertainty: 0.9, confidence: 0.1 })]),
        candidates: [candidate({ questionId: 1, skillId: 1 })],
      }),
    );
    const unc = res.chosen!.factors.find((f) => f.key === "uncertainty")!;
    expect(unc.value).toBeCloseTo(0.9, 5);
  });

  it("(2,3) exposes expected learning gain and information on every scored item", () => {
    const res = selectNextItemV2(baseInput());
    expect(res.chosen!.expectedLearningGain).toBeGreaterThanOrEqual(0);
    expect(res.chosen!.information).toBeGreaterThan(0);
    expect(res.chosen!.information).toBeLessThanOrEqual(1);
  });

  it("is deterministic and breaks ties by question id", () => {
    const first = selectNextItemV2(baseInput({ candidates: [candidate({ questionId: 7, skillId: 1 }), candidate({ questionId: 3, skillId: 1 })] }));
    const second = selectNextItemV2(baseInput({ candidates: [candidate({ questionId: 7, skillId: 1 }), candidate({ questionId: 3, skillId: 1 })] }));
    expect(first.chosen?.candidate.questionId).toBe(second.chosen?.candidate.questionId);
    expect(first.ranked.map((r) => r.score)).toEqual(second.ranked.map((r) => r.score));
  });

  it("respects weight overrides", () => {
    const res = selectNextItemV2(baseInput({ weights: { ...DEFAULT_SELECTION_WEIGHTS, informationGain: 0 } }));
    const info = res.chosen!.factors.find((f) => f.key === "informationGain")!;
    expect(info.weighted).toBe(0);
  });
});
