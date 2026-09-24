import { describe, expect, it } from "vitest";
import { decidePolicy, mustWithholdAnswers } from "@/lib/tutor/policy";
import type { LearnerTutorContext, TutorRequest } from "@/lib/tutor/types";

/* A deterministic learner-context factory (no DB) for testing the PURE policy. */
function makeLearner(overrides: Partial<LearnerTutorContext> = {}): LearnerTutorContext {
  return {
    studentId: 1,
    studentName: "Test Learner",
    gradeLevel: "Grade 10",
    goal: "Pass algebra",
    focusSkill: {
      skillId: 10,
      skillName: "Fractions",
      subjectName: "Mathematics",
      description: "Operate on fractions",
      difficultyBase: 0.5,
      mastery: 0.6,
      confidence: 0.7,
      attempts: 8,
      accuracy: 0.6,
      recentAccuracy: 0.6,
      errorType: "none",
      errorLabel: "no dominant pattern",
      prereqReadiness: 0.9,
      prereqs: [{ skillId: 9, skillName: "Arithmetic", mastery: 0.9, met: true }],
    },
    ability: 0.6,
    recentMistakes: [],
    currentMilestone: null,
    recommendedActivity: null,
    assessment: null,
    coldStart: false,
    ...overrides,
  };
}

const ask = (intent: TutorRequest["intent"], extra: Partial<TutorRequest> = {}): TutorRequest => ({
  studentId: 1,
  intent,
  ...extra,
});

describe("tutor policy · determinism", () => {
  it("is a pure function — identical inputs yield identical decisions", () => {
    const learner = makeLearner();
    const a = decidePolicy(learner, ask("explain"));
    const b = decidePolicy(learner, ask("explain"));
    expect(a).toEqual(b);
  });
});

describe("tutor policy · difficulty (capability 8)", () => {
  it("pitches foundational for low mastery / weak prerequisites", () => {
    const learner = makeLearner({
      focusSkill: { ...makeLearner().focusSkill!, mastery: 0.25 },
    });
    expect(decidePolicy(learner, ask("explain")).difficulty).toBe("foundational");
  });

  it("pitches stretch when the learner has mastered the skill", () => {
    const learner = makeLearner({ focusSkill: { ...makeLearner().focusSkill!, mastery: 0.9 } });
    expect(decidePolicy(learner, ask("explain")).difficulty).toBe("stretch");
  });

  it("pitches core in the middle band", () => {
    expect(decidePolicy(makeLearner(), ask("explain")).difficulty).toBe("core");
  });

  it("honours explicit easier/harder adjustments", () => {
    const learner = makeLearner(); // base = core
    expect(decidePolicy(learner, ask("explain", { difficulty: "easier" })).difficulty).toBe("foundational");
    expect(decidePolicy(learner, ask("explain", { difficulty: "harder" })).difficulty).toBe("stretch");
    expect(decidePolicy(learner, ask("explain", { difficulty: "same" })).difficulty).toBe("core");
  });

  it("does not push past the extremes", () => {
    const strong = makeLearner({ focusSkill: { ...makeLearner().focusSkill!, mastery: 0.95 } });
    expect(decidePolicy(strong, ask("explain", { difficulty: "harder" })).difficulty).toBe("stretch");
    const weak = makeLearner({ focusSkill: { ...makeLearner().focusSkill!, mastery: 0.1 } });
    expect(decidePolicy(weak, ask("explain", { difficulty: "easier" })).difficulty).toBe("foundational");
  });
});

describe("tutor policy · answer safety (capability 9)", () => {
  const withPending = (skillId: number): LearnerTutorContext =>
    makeLearner({
      assessment: {
        assessmentId: 5,
        title: "Adaptive quiz",
        mode: "adaptive_quiz",
        status: "in_progress",
        itemsAnswered: 2,
        itemTarget: 8,
        pendingItem: { itemId: 55, questionId: 500, skillId, skillName: "Fractions", stem: "1/2 + 1/4 = ?" },
      },
    });

  it("withholds answers when a pending item on the focus skill is live", () => {
    const learner = withPending(10); // focus skill id = 10
    expect(mustWithholdAnswers(learner, ask("hint"))).toBe(true);
    expect(decidePolicy(learner, ask("hint")).withholdAnswers).toBe(true);
  });

  it("does not withhold when there is no active assessment", () => {
    expect(decidePolicy(makeLearner(), ask("explain")).withholdAnswers).toBe(false);
  });

  it("does not withhold when the pending item is on a DIFFERENT skill than the focus", () => {
    const learner = withPending(999); // pending item skill != focus (10)
    // Focus was explicitly requested as skill 10, pending is 999 → safe to reveal 10.
    expect(mustWithholdAnswers({ ...learner }, ask("explain", { skillId: 10 }))).toBe(false);
  });

  it("forces analogous worked examples while withholding", () => {
    const decision = decidePolicy(withPending(10), ask("worked_example"));
    expect(decision.withholdAnswers).toBe(true);
    expect(decision.requireAnalogousExample).toBe(true);
    expect(decision.guardrails.join(" ")).toMatch(/analogous|fresh/i);
  });

  it("adds a do-not-reveal guardrail whenever answers are withheld", () => {
    const decision = decidePolicy(withPending(10), ask("explain"));
    expect(decision.guardrails.some((g) => /do not reveal/i.test(g))).toBe(true);
  });
});

describe("tutor policy · remediation shaping (capabilities 5 & 6)", () => {
  const withError = (errorType: string, mastery = 0.5, attempts = 8) =>
    makeLearner({ focusSkill: { ...makeLearner().focusSkill!, errorType, mastery, attempts } });

  it("maps careless errors to accuracy checks", () => {
    expect(decidePolicy(withError("careless"), ask("remediate")).remediationStyle).toBe("accuracy-checks");
  });

  it("maps struggling errors to scaffolding", () => {
    expect(decidePolicy(withError("struggling"), ask("remediate")).remediationStyle).toBe("scaffold");
  });

  it("maps guessing to conceptual work", () => {
    expect(decidePolicy(withError("guessing"), ask("remediate")).remediationStyle).toBe("conceptual");
  });

  it("scaffolds down when prerequisite readiness is low, and targets the weakest unmet prereq", () => {
    const learner = makeLearner({
      focusSkill: {
        ...makeLearner().focusSkill!,
        prereqReadiness: 0.3,
        prereqs: [
          { skillId: 8, skillName: "Counting", mastery: 0.2, met: false },
          { skillId: 9, skillName: "Arithmetic", mastery: 0.5, met: false },
        ],
      },
    });
    const decision = decidePolicy(learner, ask("remediate"));
    expect(decision.remediationStyle).toBe("scaffold");
    expect(decision.focusPrereqSkillId).toBe(8); // weakest unmet
  });

  it("treats thin evidence as foundational", () => {
    expect(decidePolicy(withError("none", 0.5, 1), ask("remediate")).remediationStyle).toBe("foundational");
  });
});

describe("tutor policy · cold start", () => {
  it("guards against over-claiming and suggests a diagnostic", () => {
    const learner = makeLearner({ coldStart: true, focusSkill: { ...makeLearner().focusSkill!, attempts: 0 } });
    const decision = decidePolicy(learner, ask("diagnose"));
    expect(decision.difficulty).toBe("foundational");
    expect(decision.guardrails.join(" ")).toMatch(/diagnostic|provisional|evidence/i);
  });
});
