import { describe, expect, it } from "vitest";
import { composeExplanation, prereqClause } from "@/lib/ml/explain";
import type { DecisionFactor, LearnerSkillState } from "@/lib/ml/interfaces";

function skill(partial: Partial<LearnerSkillState> = {}): LearnerSkillState {
  return {
    skillId: 1,
    skillName: "Algebra",
    subjectName: "Math",
    mastery: 0.61,
    rawMastery: 0.61,
    confidence: 0.6,
    uncertainty: 0.4,
    attempts: 6,
    correct: 4,
    streak: 1,
    accuracy: 0.66,
    recentAccuracy: 0.66,
    responseRatio: 1,
    retention: 1,
    daysSincePractice: 1,
    velocity: 0.1,
    prereqReadiness: 0.9,
    prereqMastery: [{ skillId: 2, name: "Geometry", mastery: 0.88 }],
    errorProfile: { type: "none", carelessRate: 0, strugglingRate: 0, guessRate: 0, label: "" },
    hintReliance: 0,
    hasHintData: false,
    avgDifficulty: 0.5,
    avgBloom: 3,
    difficultyBase: 0.5,
    pathAlignment: 0.5,
    prereqIds: [2],
    ...partial,
  };
}

const factors: DecisionFactor[] = [
  { key: "informationGain", value: 0.9, weighted: 0.144, detail: "" },
  { key: "masteryGap", value: 0.24, weighted: 0.05, detail: "" },
];

describe("composeExplanation", () => {
  it("matches the required house style", () => {
    const text = composeExplanation({ skill: skill(), target: 0.85, predictedCorrect: 0.7, factors });
    // e.g. "Selected because Algebra mastery is 0.61, target is 0.85, prerequisite
    // Geometry is sufficiently mastered (0.88), this item provides high expected
    // information gain, and predicted success is 70%."
    expect(text.startsWith("Selected because Algebra mastery is 0.61, target is 0.85")).toBe(true);
    expect(text).toContain("prerequisite Geometry is sufficiently mastered");
    expect(text).toContain("expected information gain");
    expect(text).toContain("and predicted success is 70%.");
    // exactly one final ", and " connective
    expect((text.match(/, and /g) ?? []).length).toBe(1);
  });

  it("notes when a prerequisite is still weak", () => {
    const weak = skill({ prereqReadiness: 0.2, prereqMastery: [{ skillId: 2, name: "Geometry", mastery: 0.2 }] });
    expect(prereqClause(weak)).toContain("still weak");
    const text = composeExplanation({ skill: weak, target: 0.85, predictedCorrect: 0.5, factors });
    expect(text).toContain("Geometry is still weak");
  });

  it("omits the prerequisite clause when there are none", () => {
    const noPrereq = skill({ prereqMastery: [], prereqIds: [] });
    expect(prereqClause(noPrereq)).toBeNull();
    const text = composeExplanation({ skill: noPrereq, target: 0.85, predictedCorrect: 0.6, factors });
    expect(text).not.toContain("prerequisite");
  });

  it("is deterministic", () => {
    const a = composeExplanation({ skill: skill(), target: 0.85, predictedCorrect: 0.7, factors });
    const b = composeExplanation({ skill: skill(), target: 0.85, predictedCorrect: 0.7, factors });
    expect(a).toBe(b);
  });
});
