/**
 * Regression guards for the pre-existing engine modules. These prove the upgrade
 * did not degrade the original knowledge-gap, recommender, classifier, forecast
 * or legacy adaptive-selection behaviour.
 */
import { describe, expect, it } from "vitest";
import { classifyGap, wilsonLowerBound } from "@/lib/ml/gaps";
import { rankSkills, buildLearningPath, scoreSkill, type SkillSignal } from "@/lib/ml/recommender";
import { HEURISTIC_MODEL, predictProbability, labelPrediction } from "@/lib/ml/classifier";
import { forecastPerformance } from "@/lib/ml/forecast";
import { scoreCandidates, selectNextItem } from "@/lib/ml/adaptive";

describe("gap detection (unchanged behaviour)", () => {
  it("wilson lower bound is conservative and bounded", () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
    const lb = wilsonLowerBound(8, 10);
    expect(lb).toBeGreaterThan(0);
    expect(lb).toBeLessThan(0.8);
  });

  it("flags a large shortfall with recent decay as high/critical", () => {
    const readout = classifyGap({
      skillId: 1,
      skillName: "Algebra",
      subjectName: "Math",
      mastery: 0.2,
      attempts: 10,
      correct: 2,
      daysSincePractice: 40,
      prereqGaps: 2,
    });
    expect(["critical", "high"]).toContain(readout.severity);
    expect(readout.drivers.length).toBeGreaterThan(0);
  });

  it("treats a mastered, well-practised skill as healthy", () => {
    const readout = classifyGap({
      skillId: 2,
      skillName: "Counting",
      subjectName: "Math",
      mastery: 0.95,
      attempts: 20,
      correct: 19,
      daysSincePractice: 2,
      prereqGaps: 0,
    });
    expect(["healthy", "watch"]).toContain(readout.severity);
  });
});

describe("recommender (unchanged behaviour)", () => {
  const signal = (over: Partial<SkillSignal>): SkillSignal => ({
    skillId: 1,
    skillName: "Algebra",
    subjectName: "Math",
    subjectColor: "#000",
    mastery: 0.5,
    attempts: 5,
    correct: 3,
    daysSincePractice: 5,
    prereqReadiness: 0.8,
    pathAlignment: 0.5,
    questionCount: 10,
    difficultyBase: 0.5,
    ...over,
  });

  it("ranks larger gaps higher", () => {
    const ranked = rankSkills([
      signal({ skillId: 1, mastery: 0.8 }),
      signal({ skillId: 2, mastery: 0.3 }),
    ]);
    expect(ranked[0].signal.skillId).toBe(2);
  });

  it("scoreSkill exposes factor decomposition and a reason", () => {
    const scored = scoreSkill(signal({ mastery: 0.4 }));
    expect(scored.factors).toHaveProperty("gap");
    expect(scored.reason.length).toBeGreaterThan(0);
    expect(scored.priority).toBeGreaterThan(0);
  });

  it("builds a prerequisite-ordered learning path", () => {
    const path = buildLearningPath({
      skills: [
        { id: 1, name: "Basics", subjectName: "Math", mastery: 0.3, prereqIds: [], difficultyBase: 0.3, attempts: 2 },
        { id: 2, name: "Advanced", subjectName: "Math", mastery: 0.2, prereqIds: [1], difficultyBase: 0.7, attempts: 1 },
      ],
    });
    const basics = path.milestones.findIndex((m) => m.skillId === 1);
    const advanced = path.milestones.findIndex((m) => m.skillId === 2);
    expect(basics).toBeGreaterThanOrEqual(0);
    expect(advanced).toBeGreaterThan(basics); // prereq comes first
    expect(path.milestones[0].status).toBe("available");
  });
});

describe("classifier + forecast (unchanged behaviour)", () => {
  it("predictProbability rises with ability and stays in (0,1)", () => {
    const low = predictProbability(HEURISTIC_MODEL, {
      ability: 0.2, masteryBefore: 0.2, difficultyBase: 0.6, bloom: 3, responseTimeMs: 30000, skillAccuracy: 0.4, evidence: 0.3,
    });
    const high = predictProbability(HEURISTIC_MODEL, {
      ability: 0.9, masteryBefore: 0.9, difficultyBase: 0.6, bloom: 3, responseTimeMs: 30000, skillAccuracy: 0.9, evidence: 0.8,
    });
    expect(high).toBeGreaterThan(low);
    expect(low).toBeGreaterThan(0);
    expect(high).toBeLessThan(1);
  });

  it("labelPrediction bands the probability", () => {
    expect(labelPrediction(0.95).key).toBe("mastered");
    expect(labelPrediction(0.2).key).toBe("at_risk");
  });

  it("forecast detects an improving trend", () => {
    const f = forecastPerformance([
      { label: "S1", value: 0.4 },
      { label: "S2", value: 0.55 },
      { label: "S3", value: 0.7 },
    ]);
    expect(f.trendLabel).toBe("improving");
    expect(f.nextValue).toBeGreaterThan(0.7);
  });
});

describe("legacy adaptive selector (still functional)", () => {
  it("scoreCandidates ranks and excludes seen items", () => {
    const scored = scoreCandidates({
      candidates: [
        { questionId: 1, skillId: 1, skillName: "A", difficultyBase: 0.4, bloom: 3, estimatedSeconds: 60, text: "q1" },
        { questionId: 2, skillId: 1, skillName: "A", difficultyBase: 0.9, bloom: 5, estimatedSeconds: 60, text: "q2" },
      ],
      skillPriorities: new Map([[1, 0.8]]),
      askedCounts: new Map(),
      model: HEURISTIC_MODEL,
      ability: 0.5,
      baseSample: { ability: 0.5, masteryBefore: 0.5, skillAccuracy: 0.5, evidence: 0.4, responseTimeMs: 30000 },
      seen: new Set([1]),
    });
    expect(scored.every((s) => s.candidate.questionId !== 1)).toBe(true);
    const best = selectNextItem({
      candidates: [
        { questionId: 3, skillId: 1, skillName: "A", difficultyBase: 0.5, bloom: 3, estimatedSeconds: 60, text: "q3" },
      ],
      skillPriorities: new Map([[1, 0.8]]),
      askedCounts: new Map(),
      model: HEURISTIC_MODEL,
      ability: 0.5,
      baseSample: { ability: 0.5, masteryBefore: 0.5, skillAccuracy: 0.5, evidence: 0.4, responseTimeMs: 30000 },
      seen: new Set(),
    });
    expect(best?.candidate.questionId).toBe(3);
  });
});
