import { describe, expect, it } from "vitest";
import {
  validateQuestion,
  normalizeStem,
  stemSimilarity,
  wouldCreateCycle,
  type QuestionInput,
  type ValidationContext,
} from "@/lib/questions/validation";

const baseCtx: ValidationContext = { skillIds: new Set([1, 2, 3]) };

const validQuestion: QuestionInput = {
  stem: "What is 2 + 2?",
  options: ["4", "3", "5", "6"],
  correctIndex: 0,
  skillId: 1,
  difficultyLabel: "easy",
  bloomLevel: "remember",
};

const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

describe("validateQuestion — happy path", () => {
  it("accepts a well-formed item", () => {
    const report = validateQuestion(validQuestion, baseCtx);
    expect(report.valid).toBe(true);
    expect(report.errors).toHaveLength(0);
  });
});

describe("option count", () => {
  it("rejects fewer than two options", () => {
    const report = validateQuestion({ ...validQuestion, options: ["4"], correctIndex: 0 }, baseCtx);
    expect(codes(report.errors)).toContain("too_few_options");
  });
  it("warns on atypical option counts", () => {
    const report = validateQuestion({ ...validQuestion, options: ["4", "3"], correctIndex: 0 }, baseCtx);
    expect(codes(report.warnings)).toContain("option_count_atypical");
  });
  it("rejects duplicate options", () => {
    const report = validateQuestion({ ...validQuestion, options: ["4", "4", "5"], correctIndex: 0 }, baseCtx);
    expect(codes(report.errors)).toContain("duplicate_options");
  });
});

describe("correct answer", () => {
  it("rejects an out-of-range index", () => {
    const report = validateQuestion({ ...validQuestion, correctIndex: 9 }, baseCtx);
    expect(codes(report.errors)).toContain("correct_index_out_of_range");
  });
  it("rejects a correct answer that points to an empty option", () => {
    const report = validateQuestion({ ...validQuestion, options: ["4", "", "5"], correctIndex: 1 }, baseCtx);
    expect(codes(report.errors)).toContain("correct_answer_empty");
  });
});

describe("difficulty values", () => {
  it("rejects an unknown difficulty band", () => {
    const report = validateQuestion({ ...validQuestion, difficultyLabel: "trivial" }, baseCtx);
    expect(codes(report.errors)).toContain("invalid_difficulty_label");
  });
  it("rejects an out-of-range difficulty value", () => {
    const report = validateQuestion({ ...validQuestion, difficultyValue: 1.5 }, baseCtx);
    expect(codes(report.errors)).toContain("invalid_difficulty_value");
  });
  it("warns when the numeric value contradicts the band", () => {
    const report = validateQuestion({ ...validQuestion, difficultyLabel: "easy", difficultyValue: 0.9 }, baseCtx);
    expect(codes(report.warnings)).toContain("difficulty_mismatch");
  });
});

describe("Bloom & cognitive complexity", () => {
  it("rejects an unknown Bloom level", () => {
    const report = validateQuestion({ ...validQuestion, bloomLevel: "memorize" }, baseCtx);
    expect(codes(report.errors)).toContain("invalid_bloom_level");
  });
  it("rejects an unknown cognitive complexity", () => {
    const report = validateQuestion({ ...validQuestion, cognitiveComplexity: "deep" }, baseCtx);
    expect(codes(report.errors)).toContain("invalid_cognitive_complexity");
  });
});

describe("skill relationships", () => {
  it("rejects an unknown skill", () => {
    const report = validateQuestion({ ...validQuestion, skillId: 99 }, baseCtx);
    expect(codes(report.errors)).toContain("unknown_skill");
  });
  it("rejects an unknown prerequisite", () => {
    const report = validateQuestion({ ...validQuestion, prerequisiteSkillIds: [99] }, baseCtx);
    expect(codes(report.errors)).toContain("unknown_prerequisite");
  });
  it("rejects a self-prerequisite", () => {
    const report = validateQuestion({ ...validQuestion, prerequisiteSkillIds: [1] }, baseCtx);
    expect(codes(report.errors)).toContain("self_prerequisite");
  });
  it("warns about prerequisite cycles", () => {
    const graph = new Map<number, number[]>([
      [1, []],
      [2, [1]],
      [3, [2]],
    ]);
    // skill 1 depending on 3 would cycle (3→2→1)
    const report = validateQuestion(
      { ...validQuestion, skillId: 1, prerequisiteSkillIds: [3] },
      { ...baseCtx, skillPrereqs: graph },
    );
    expect(codes(report.warnings)).toContain("prerequisite_cycle");
  });
});

describe("duplicate detection", () => {
  it("blocks exact duplicates (normalised)", () => {
    const report = validateQuestion(
      { ...validQuestion, stem: "what is 2+2 ???" },
      { ...baseCtx, existing: [{ id: 5, skillId: 1, stem: "What is 2 + 2?" }] },
    );
    expect(codes(report.errors)).toContain("duplicate_question");
  });
  it("warns on near-duplicates in the same skill", () => {
    const report = validateQuestion(
      { ...validQuestion, stem: "What is the capital of France?" },
      { ...baseCtx, existing: [{ id: 7, skillId: 1, stem: "What is the capital of France today?" }] },
    );
    expect(codes(report.warnings)).toContain("near_duplicate_question");
  });
  it("does not flag different stems", () => {
    const report = validateQuestion(
      { ...validQuestion, stem: "Define a prime number." },
      { ...baseCtx, existing: [{ id: 9, skillId: 1, stem: "What is 2 + 2?" }] },
    );
    expect(codes(report.errors)).not.toContain("duplicate_question");
  });
});

describe("distractor metadata", () => {
  it("rejects out-of-range distractor indices", () => {
    const report = validateQuestion({ ...validQuestion, distractorMeta: [{ optionIndex: 9, misconception: "x" }] }, baseCtx);
    expect(codes(report.errors)).toContain("distractor_index_out_of_range");
  });
  it("warns when metadata describes the key", () => {
    const report = validateQuestion({ ...validQuestion, distractorMeta: [{ optionIndex: 0, misconception: "x" }] }, baseCtx);
    expect(codes(report.warnings)).toContain("distractor_meta_on_key");
  });
});

describe("helpers", () => {
  it("normalises stems for comparison", () => {
    expect(normalizeStem("What is 2 + 2?")).toBe("what is 2 2");
  });
  it("scores stem similarity", () => {
    expect(stemSimilarity("the cat sat", "the cat sat")).toBe(1);
    expect(stemSimilarity("abc", "xyz")).toBe(0);
  });
  it("detects prerequisite cycles", () => {
    const graph = new Map<number, number[]>([
      [1, []],
      [2, [1]],
      [3, [2]],
    ]);
    expect(wouldCreateCycle(1, [3], graph)).toBe(true);
    expect(wouldCreateCycle(3, [1], graph)).toBe(false);
  });
});
