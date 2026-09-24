import { describe, expect, it } from "vitest";
import {
  sortChronologically,
  chronologicalSplit,
  expandingWindowFolds,
  isLeakageFree,
} from "@/lib/ml/splits";

interface Row {
  id: number;
  createdAt: string;
}

const rows: Row[] = Array.from({ length: 10 }, (_, i) => ({
  id: i,
  createdAt: new Date(2026, 0, i + 1).toISOString(),
}));

const getTime = (r: Row) => r.createdAt;

describe("chronological splitting", () => {
  it("sorts by time with a stable tie-break", () => {
    const shuffled = [rows[3], rows[0], rows[1], rows[2]];
    const sorted = sortChronologically(shuffled, getTime);
    expect(sorted.map((r) => r.id)).toEqual([0, 1, 2, 3]);
  });

  it("splits 70/15/15 by time so test is the most recent block", () => {
    const split = chronologicalSplit(rows, getTime, { trainRatio: 0.7, valRatio: 0.15 });
    // n=10: trainEnd=floor(7)=7, valEnd=floor(8.5)=8
    expect(split.train.map((r) => r.id)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(split.validation.map((r) => r.id)).toEqual([7]);
    expect(split.test.map((r) => r.id)).toEqual([8, 9]);
  });

  it("produces a leakage-free split (max train time <= min test time)", () => {
    const split = chronologicalSplit(rows, getTime);
    expect(isLeakageFree(split.train, split.test, getTime)).toBe(true);
    expect(isLeakageFree(split.validation, split.test, getTime)).toBe(true);
  });

  it("detects a leaky (shuffled) split as unsafe", () => {
    const leakyTrain = [rows[9], rows[0]]; // includes the newest row
    const leakyTest = [rows[5]];
    expect(isLeakageFree(leakyTrain, leakyTest, getTime)).toBe(false);
  });
});

describe("expanding-window folds", () => {
  it("each fold trains on the past and tests on the future only", () => {
    const folds = expandingWindowFolds(rows, getTime, 3);
    expect(folds.length).toBe(3);
    for (const fold of folds) {
      expect(isLeakageFree(fold.train, fold.test, getTime)).toBe(true);
      expect(fold.train.length).toBeGreaterThan(0);
      expect(fold.test.length).toBeGreaterThan(0);
    }
    // training window grows each fold
    expect(folds[1].train.length).toBeGreaterThan(folds[0].train.length);
    expect(folds[2].train.length).toBeGreaterThan(folds[1].train.length);
  });

  it("returns no folds when there is too little data", () => {
    expect(expandingWindowFolds(rows.slice(0, 2), getTime, 3)).toEqual([]);
  });
});
