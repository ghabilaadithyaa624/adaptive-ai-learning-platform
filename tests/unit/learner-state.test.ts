import { describe, expect, it } from "vitest";
import { buildLearnerState, type BuildLearnerStateInput, type RawResponse, type RawSkillState } from "@/lib/ml/learner-state";

const NOW = new Date("2026-03-01T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

function response(partial: Partial<RawResponse> & { skillId: number; isCorrect: boolean }): RawResponse {
  return {
    responseTimeMs: 30_000,
    estimatedSeconds: 60,
    difficulty: 0.5,
    bloom: 3,
    createdAt: daysAgo(1),
    ...partial,
  };
}

function baseInput(): BuildLearnerStateInput {
  const skillA: RawSkillState = {
    skillId: 1,
    skillName: "Algebra",
    subjectName: "Math",
    mastery: 0.9,
    attempts: 12,
    correct: 11,
    streak: 4,
    history: [
      { t: daysAgo(5).toISOString(), m: 0.6 },
      { t: daysAgo(4).toISOString(), m: 0.7 },
      { t: daysAgo(3).toISOString(), m: 0.8 },
      { t: daysAgo(2).toISOString(), m: 0.9 },
    ],
    lastPracticedAt: daysAgo(1),
    prereqIds: [],
    difficultyBase: 0.5,
  };
  const skillB: RawSkillState = {
    skillId: 2,
    skillName: "Quadratics",
    subjectName: "Math",
    mastery: 0.4,
    attempts: 4,
    correct: 2,
    streak: 0,
    history: [
      { t: daysAgo(3).toISOString(), m: 0.5 },
      { t: daysAgo(2).toISOString(), m: 0.45 },
      { t: daysAgo(1).toISOString(), m: 0.4 },
    ],
    lastPracticedAt: daysAgo(2),
    prereqIds: [1],
    difficultyBase: 0.7,
  };
  return {
    studentId: 42,
    now: NOW,
    skillStates: [skillA, skillB],
    responses: [
      response({ skillId: 1, isCorrect: true }),
      response({ skillId: 1, isCorrect: true }),
      response({ skillId: 2, isCorrect: false, responseTimeMs: 90_000 }),
      response({ skillId: 2, isCorrect: false, responseTimeMs: 80_000 }),
      response({ skillId: 2, isCorrect: false, responseTimeMs: 100_000 }),
    ],
    context: { mode: "adaptive_quiz", itemsAnswered: 4, itemTarget: 8 },
  };
}

describe("buildLearnerState composite (15 signals)", () => {
  it("builds a state per skill with global aggregates", () => {
    const state = buildLearnerState(baseInput());
    expect(state.skills.size).toBe(2);
    expect(state.ability).toBeGreaterThan(0);
    expect(state.ability).toBeLessThanOrEqual(1);
    expect(state.studentId).toBe(42);
  });

  it("(1,3,7) mastery, accuracy and attempts reflect inputs", () => {
    const a = buildLearnerState(baseInput()).skills.get(1)!;
    expect(a.mastery).toBeGreaterThan(0.8);
    expect(a.attempts).toBe(12);
    expect(a.accuracy).toBeCloseTo(11 / 12, 2);
  });

  it("(8) confidence is higher for the well-evidenced skill", () => {
    const s = buildLearnerState(baseInput());
    expect(s.skills.get(1)!.confidence).toBeGreaterThan(s.skills.get(2)!.confidence);
    expect(s.skills.get(2)!.uncertainty).toBeGreaterThan(s.skills.get(1)!.uncertainty);
  });

  it("(9) forgetting: an old skill decays and retention < 1", () => {
    const input = baseInput();
    input.skillStates[0].lastPracticedAt = daysAgo(40);
    const a = buildLearnerState(input).skills.get(1)!;
    expect(a.mastery).toBeLessThan(a.rawMastery);
    expect(a.retention).toBeLessThan(1);
    expect(a.daysSincePractice).toBeGreaterThan(35);
  });

  it("(10) prerequisite readiness reflects prereq mastery", () => {
    const s = buildLearnerState(baseInput());
    const b = s.skills.get(2)!;
    expect(b.prereqMastery).toHaveLength(1);
    expect(b.prereqMastery[0].skillId).toBe(1);
    expect(b.prereqReadiness).toBeGreaterThan(0.6); // prereq (Algebra) is strong
  });

  it("(12) learning velocity is positive for a rising history, negative for a falling one", () => {
    const s = buildLearnerState(baseInput());
    expect(s.skills.get(1)!.velocity).toBeGreaterThan(0);
    expect(s.skills.get(2)!.velocity).toBeLessThan(0);
  });

  it("(13) error patterns: slow wrong answers classify as struggling", () => {
    const b = buildLearnerState(baseInput()).skills.get(2)!;
    expect(b.errorProfile.type).toBe("struggling");
  });

  it("(13) fast wrong answers classify as careless", () => {
    const input = baseInput();
    input.responses = [
      response({ skillId: 2, isCorrect: false, responseTimeMs: 5_000 }),
      response({ skillId: 2, isCorrect: false, responseTimeMs: 6_000 }),
      response({ skillId: 2, isCorrect: true, responseTimeMs: 40_000 }),
    ];
    const b = buildLearnerState(input).skills.get(2)!;
    expect(b.errorProfile.type).toBe("careless");
  });

  it("(4) response-time ratio: slow responses give ratio > 1", () => {
    const b = buildLearnerState(baseInput()).skills.get(2)!;
    expect(b.responseRatio).toBeGreaterThan(1);
  });

  it("(14) hint usage is captured only when data is available", () => {
    const input = baseInput();
    input.responses = [
      response({ skillId: 1, isCorrect: true, hintUsed: true }),
      response({ skillId: 1, isCorrect: true, hintUsed: false }),
    ];
    const withHints = buildLearnerState(input).skills.get(1)!;
    expect(withHints.hasHintData).toBe(true);
    expect(withHints.hintReliance).toBeCloseTo(0.5, 5);
    // default scenario has no hint data
    expect(buildLearnerState(baseInput()).skills.get(1)!.hasHintData).toBe(false);
  });

  it("(11) assessment context computes fatigue from progress", () => {
    const ctx = buildLearnerState(baseInput()).context;
    expect(ctx.itemsAnswered).toBe(4);
    expect(ctx.fatigue).toBeGreaterThan(0);
    expect(ctx.fatigue).toBeLessThanOrEqual(1);
  });

  it("(15) engagement is within [0,1]", () => {
    const s = buildLearnerState(baseInput());
    expect(s.engagement).toBeGreaterThanOrEqual(0);
    expect(s.engagement).toBeLessThanOrEqual(1);
  });

  it("is fully deterministic", () => {
    expect(buildLearnerState(baseInput())).toEqual(buildLearnerState(baseInput()));
  });
});
