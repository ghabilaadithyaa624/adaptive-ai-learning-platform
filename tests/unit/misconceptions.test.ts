import { describe, expect, it } from "vitest";
import { detectMisconceptions, type MisconceptionEvidence } from "@/lib/ml/misconceptions";

const evidence = (questionId: number, partial: Partial<MisconceptionEvidence> = {}): MisconceptionEvidence => ({
  questionId, skillId: 7, subskill: "unlike denominators", selectedOption: 1,
  distractor: "5/9", misconception: "Adds numerator and denominator independently",
  isCorrect: false, responseTimeRatio: 1, observedAt: new Date(Date.UTC(2026, 0, questionId)), ...partial,
});

describe("structured misconception detection", () => {
  it("keeps a single distractor choice LOW as an isolated mistake", () => {
    const [h] = detectMisconceptions([evidence(1)]);
    expect(h.confidence).toBe("LOW");
    expect(h.errorPattern).toBe("isolated_mistake");
    expect(h.evidenceCount).toBe(1);
  });
  it("requires three distinct items for HIGH confidence", () => {
    expect(detectMisconceptions([evidence(1), evidence(2)])[0].confidence).toBe("MEDIUM");
    const h = detectMisconceptions([evidence(1), evidence(2), evidence(3)])[0];
    expect(h.confidence).toBe("HIGH");
    expect(h.errorPattern).toBe("repeated_misconception");
    expect(h.evidenceQuestionIds).toEqual([1, 2, 3]);
  });
  it("does not count retries on one question as independent evidence", () => {
    const h = detectMisconceptions([evidence(1), evidence(1), evidence(1)])[0];
    expect(h.evidenceCount).toBe(1);
    expect(h.confidence).toBe("LOW");
  });
  it("does not invent a hypothesis without authored distractor metadata", () => {
    expect(detectMisconceptions([evidence(1, { misconception: null })])).toEqual([]);
  });
  it("distinguishes fast careless errors from repeated content misconceptions", () => {
    const h = detectMisconceptions([evidence(1, { responseTimeRatio: .2 }), evidence(2, { responseTimeRatio: .3 }), evidence(3, { responseTimeRatio: .4 })])[0];
    expect(h.errorPattern).toBe("careless_error");
    expect(h.confidence).toBe("MEDIUM");
  });
  it("distinguishes linked prerequisite weakness", () => {
    const h = detectMisconceptions([evidence(1, { prerequisiteSkillId: 2 }), evidence(2, { prerequisiteSkillId: 2 })])[0];
    expect(h.errorPattern).toBe("prerequisite_weakness");
    expect(h.prerequisiteSkillId).toBe(2);
  });
  it("separates knowledge decay from a stable misconception", () => {
    const h = detectMisconceptions([evidence(1, { masteryAtObservation: .85 }), evidence(2, { masteryAtObservation: .6 })])[0];
    expect(h.errorPattern).toBe("knowledge_decay");
  });
});
