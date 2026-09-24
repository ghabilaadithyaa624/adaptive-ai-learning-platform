import { describe, expect, it } from "vitest";
import {
  buildLearningPath,
  rankSkills,
  recommendReviewSkill,
  scoreSkill,
  type SkillSignal,
} from "@/lib/ml/recommender";

function signal(partial: Partial<SkillSignal> & { skillId: number }): SkillSignal {
  return {
    skillName: `Skill ${partial.skillId}`,
    subjectName: "Math",
    subjectColor: "#000",
    mastery: 0.5,
    attempts: 6,
    correct: 3,
    daysSincePractice: 3,
    prereqReadiness: 1,
    pathAlignment: 0.2,
    questionCount: 5,
    difficultyBase: 0.5,
    ...partial,
  };
}

describe("recommender · scoreSkill (pure, deterministic)", () => {
  it("is a pure function — identical inputs give identical output", () => {
    const s = signal({ skillId: 1, mastery: 0.3 });
    expect(scoreSkill(s)).toEqual(scoreSkill(s));
  });

  it("a larger mastery gap yields a higher priority", () => {
    const weak = scoreSkill(signal({ skillId: 1, mastery: 0.2 }));
    const strong = scoreSkill(signal({ skillId: 2, mastery: 0.8 }));
    expect(weak.priority).toBeGreaterThan(strong.priority);
  });

  it("thin evidence recommends a diagnostic checkpoint", () => {
    const cold = scoreSkill(signal({ skillId: 1, attempts: 1, mastery: 0.5 }));
    expect(cold.action).toMatch(/checkpoint/i);
  });

  it("priority is bounded to (0,1] and never zero", () => {
    const s = scoreSkill(signal({ skillId: 1, mastery: 0.99, attempts: 0, daysSincePractice: 0, prereqReadiness: 0, pathAlignment: 0 }));
    expect(s.priority).toBeGreaterThan(0);
    expect(s.priority).toBeLessThanOrEqual(1);
  });
});

describe("recommender · rankSkills", () => {
  it("orders skills by descending priority", () => {
    const ranked = rankSkills([
      signal({ skillId: 1, mastery: 0.8 }),
      signal({ skillId: 2, mastery: 0.2 }),
      signal({ skillId: 3, mastery: 0.5 }),
    ]);
    const priorities = ranked.map((r) => r.priority);
    expect([...priorities].sort((a, b) => b - a)).toEqual(priorities);
    expect(ranked[0].signal.skillId).toBe(2); // weakest skill first
  });
});

describe("recommender · recommendReviewSkill (spaced repetition)", () => {
  it("suggests a refresher for a strong-but-stale skill", () => {
    const review = recommendReviewSkill([
      signal({ skillId: 1, mastery: 0.9, daysSincePractice: 30 }),
      signal({ skillId: 2, mastery: 0.4, daysSincePractice: 1 }),
    ]);
    expect(review).not.toBeNull();
    expect(review!.signal.skillId).toBe(1);
    expect(review!.action).toMatch(/refresher/i);
  });

  it("returns null when the strongest skill was practiced recently", () => {
    const review = recommendReviewSkill([signal({ skillId: 1, mastery: 0.9, daysSincePractice: 2 })]);
    expect(review).toBeNull();
  });
});

describe("recommender · buildLearningPath (prerequisite ordering)", () => {
  const skills = [
    { id: 1, name: "Arithmetic", subjectName: "Math", mastery: 0.3, prereqIds: [] as number[], difficultyBase: 0.3, attempts: 5 },
    { id: 2, name: "Fractions", subjectName: "Math", mastery: 0.25, prereqIds: [1], difficultyBase: 0.5, attempts: 3 },
    { id: 3, name: "Linear", subjectName: "Math", mastery: 0.2, prereqIds: [2], difficultyBase: 0.7, attempts: 2 },
  ];

  it("orders milestones so prerequisites always precede dependents", () => {
    const { milestones } = buildLearningPath({ skills });
    const positionOf = (id: number) => milestones.find((m) => m.skillId === id)!.position;
    expect(positionOf(1)).toBeLessThan(positionOf(2));
    expect(positionOf(2)).toBeLessThan(positionOf(3));
  });

  it("only the first milestone is available; the rest are locked", () => {
    const { milestones } = buildLearningPath({ skills });
    expect(milestones[0].status).toBe("available");
    expect(milestones.slice(1).every((m) => m.status === "locked")).toBe(true);
  });

  it("excludes already-mastered skills from the path", () => {
    const { milestones } = buildLearningPath({
      skills: [
        { id: 1, name: "Arithmetic", subjectName: "Math", mastery: 0.95, prereqIds: [], difficultyBase: 0.3, attempts: 10 },
        { id: 2, name: "Fractions", subjectName: "Math", mastery: 0.2, prereqIds: [1], difficultyBase: 0.5, attempts: 2 },
      ],
    });
    // Arithmetic is above target and not a blocking prereq → not in the path.
    expect(milestones.some((m) => m.skillId === 1)).toBe(false);
    expect(milestones.some((m) => m.skillId === 2)).toBe(true);
  });

  it("is deterministic for identical input", () => {
    expect(buildLearningPath({ skills })).toEqual(buildLearningPath({ skills }));
  });
});
