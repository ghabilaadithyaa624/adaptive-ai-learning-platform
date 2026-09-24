import { describe, expect, it } from "vitest";
import {
  pearson,
  pointBiserial,
  discriminationIndex,
  raschDifficulty,
  analyzeItem,
  computeQualityScore,
  calibrationFromAnalysis,
  kr20,
  type ItemResponse,
} from "@/lib/ml/item-analysis";

const approx = (value: number | null, expected: number, tol = 1e-3) => {
  expect(value).not.toBeNull();
  expect(Math.abs((value as number) - expected)).toBeLessThan(tol);
};

describe("correlation helpers", () => {
  it("computes Pearson correlation by hand", () => {
    approx(pearson([0, 0, 1, 1], [1, 2, 3, 4]), 2 / Math.sqrt(5));
  });
  it("returns null with zero variance", () => {
    expect(pearson([1, 1, 1], [1, 2, 3])).toBeNull();
  });
  it("point-biserial equals Pearson for dichotomous scores", () => {
    approx(pointBiserial([1, 1, 0, 0], [0.9, 0.8, 0.3, 0.2]), 0.9863939, 1e-3);
  });
});

describe("raschDifficulty", () => {
  it("is 0 at facility 0.5", () => {
    approx(raschDifficulty(0.5), 0);
  });
  it("is positive (harder) for low facility", () => {
    expect(raschDifficulty(0.2)!).toBeGreaterThan(0);
  });
  it("clamps extremes", () => {
    expect(raschDifficulty(0)).toBe(4);
    expect(raschDifficulty(1)).toBe(-4);
  });
});

describe("discriminationIndex", () => {
  it("computes upper-minus-lower 27% index", () => {
    const responses: ItemResponse[] = [
      { correct: false, ability: 0.2, chosenOption: 1 },
      { correct: false, ability: 0.3, chosenOption: 1 },
      { correct: true, ability: 0.8, chosenOption: 0 },
      { correct: true, ability: 0.9, chosenOption: 0 },
    ];
    approx(discriminationIndex(responses), 1);
  });
});

describe("analyzeItem", () => {
  const responses: ItemResponse[] = [
    { correct: true, ability: 0.9, chosenOption: 0 },
    { correct: true, ability: 0.8, chosenOption: 0 },
    { correct: false, ability: 0.3, chosenOption: 1 },
    { correct: false, ability: 0.2, chosenOption: 1 },
  ];

  it("computes facility, discrimination and rasch b", () => {
    const a = analyzeItem(responses, { optionCount: 2, correctIndex: 0 });
    approx(a.facility, 0.5);
    approx(a.discrimination, 0.986, 1e-3);
    approx(a.raschDifficulty, 0);
    expect(a.reliable).toBe(false); // n < 20
    expect(a.flags).toContain("insufficient_sample");
  });

  it("marks a working distractor as functioning and key as positive", () => {
    const a = analyzeItem(responses, { optionCount: 2, correctIndex: 0 });
    const key = a.options[0];
    const distractor = a.options[1];
    expect(key.isKey).toBe(true);
    expect(key.functioning).toBe(true);
    expect(distractor.functioning).toBe(true);
    expect(distractor.discrimination!).toBeLessThan(0);
  });

  it("flags negative discrimination and a possible mis-key", () => {
    // high-ability respondents pick the distractor (option 1); key is option 0
    const miskey: ItemResponse[] = [
      { correct: false, ability: 0.9, chosenOption: 1 },
      { correct: false, ability: 0.85, chosenOption: 1 },
      { correct: true, ability: 0.3, chosenOption: 0 },
      { correct: true, ability: 0.25, chosenOption: 0 },
    ];
    const a = analyzeItem(miskey, { optionCount: 2, correctIndex: 0 });
    expect(a.flags).toContain("negative_discrimination");
    expect(a.flags).toContain("possible_miskey");
  });

  it("flags too-easy items", () => {
    const easy: ItemResponse[] = Array.from({ length: 25 }, (_, i) => ({
      correct: true,
      ability: 0.5 + (i % 5) * 0.05,
      chosenOption: 0,
    }));
    const a = analyzeItem(easy, { optionCount: 4, correctIndex: 0 });
    expect(a.flags).toContain("too_easy");
    expect(a.reliable).toBe(true);
  });

  it("returns an empty analysis for no responses", () => {
    const a = analyzeItem([], { optionCount: 4, correctIndex: 0 });
    expect(a.sampleSize).toBe(0);
    expect(a.qualityScore).toBe(0);
    expect(a.flags).toContain("no_responses");
  });
});

describe("computeQualityScore", () => {
  it("rewards strong discrimination + central facility", () => {
    const options = [
      { optionIndex: 0, isKey: true, count: 10, selectionRate: 0.5, meanAbility: 0.8, discrimination: 0.5, functioning: true },
      { optionIndex: 1, isKey: false, count: 10, selectionRate: 0.5, meanAbility: 0.3, discrimination: -0.5, functioning: true },
    ];
    const score = computeQualityScore({ facility: 0.6, discrimination: 0.5, options, sampleSize: 40 });
    // disc 1.0*0.35 + facility 1.0*0.25 + distractor 1.0*0.20 + sample 1.0*0.10 + calib 0.75*0.10
    approx(score, 0.35 + 0.25 + 0.2 + 0.1 + 0.075, 1e-3);
  });

  it("penalises poor discrimination", () => {
    const options = [
      { optionIndex: 0, isKey: true, count: 10, selectionRate: 0.5, meanAbility: 0.5, discrimination: 0.05, functioning: true },
      { optionIndex: 1, isKey: false, count: 10, selectionRate: 0.5, meanAbility: 0.5, discrimination: 0, functioning: false },
    ];
    const strong = computeQualityScore(
      { facility: 0.6, discrimination: 0.5, options: options.map((o) => ({ ...o })), sampleSize: 40 },
    );
    const weak = computeQualityScore({ facility: 0.6, discrimination: 0.05, options, sampleSize: 40 });
    expect(weak).toBeLessThan(strong);
  });
});

describe("calibrationFromAnalysis", () => {
  it("produces a rasch-approx container for reliable samples", () => {
    const responses: ItemResponse[] = Array.from({ length: 30 }, (_, i) => ({
      correct: i % 2 === 0,
      ability: i / 30,
      chosenOption: i % 2 === 0 ? 0 : 1,
    }));
    const a = analyzeItem(responses, { optionCount: 2, correctIndex: 0 });
    const cal = calibrationFromAnalysis(a);
    expect(cal.model).toBe("rasch-approx");
    expect(cal.b).not.toBeNull();
    expect(cal.seB).not.toBeNull();
    expect(cal.sampleSize).toBe(30);
    expect(cal.calibratedAt).not.toBeNull();
  });

  it("marks small samples as provisional CTT", () => {
    const a = analyzeItem(
      [
        { correct: true, ability: 0.8, chosenOption: 0 },
        { correct: false, ability: 0.2, chosenOption: 1 },
      ],
      { optionCount: 2, correctIndex: 0 },
    );
    const cal = calibrationFromAnalysis(a);
    expect(cal.model).toBe("ctt");
  });
});

describe("kr20", () => {
  it("computes reliability for a small matrix", () => {
    const matrix = [
      [1, 1],
      [1, 0],
      [0, 0],
    ];
    approx(kr20(matrix), 0.6667, 1e-3);
  });
  it("returns null for degenerate matrices", () => {
    expect(kr20([[1]])).toBeNull();
  });
});
