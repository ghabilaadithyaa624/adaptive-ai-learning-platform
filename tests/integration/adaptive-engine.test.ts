import { afterAll, beforeEach, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, describeDb, closePool } from "../helpers/db";
import { seedFixtures, type Fixtures } from "../helpers/fixtures";
import { computeNextSessionQuestion, gradeItem, startAssessment } from "@/lib/engine";
import { assessmentItems, assessments, masteryStates, questions } from "@/db/schema";

async function keyFor(questionId: number): Promise<number> {
  const [q] = await db.select({ ci: questions.correctIndex }).from(questions).where(eq(questions.id, questionId));
  return q.ci;
}

describeDb("integration · adaptive engine", () => {
  let fx: Fixtures;

  beforeEach(async () => {
    fx = await seedFixtures();
  });
  afterAll(async () => {
    await closePool();
  });

  it("selects only servable items and never serves draft/retired questions", async () => {
    const a = await startAssessment({
      studentId: fx.users.bob,
      title: "T",
      mode: "practice",
      targetSkillIds: [fx.skills.arithmetic],
      itemTarget: 3,
    });

    const delivered: number[] = [];
    let next = await computeNextSessionQuestion(a.id);
    while (next) {
      delivered.push(next.questionId);
      const key = await keyFor(next.questionId);
      const graded = await gradeItem({ assessmentId: a.id, itemId: next.itemId, studentAnswer: key, responseTimeMs: 3000 });
      if ("error" in graded) throw new Error(graded.error);
      if (graded.completed) break;
      next = graded.next;
    }

    expect(delivered.length).toBe(3);
    expect(new Set(delivered).size).toBe(3); // no repeats
    expect(delivered).not.toContain(fx.draftQuestion);
    expect(delivered).not.toContain(fx.retiredQuestion);
    for (const id of delivered) expect(fx.questions.arithmetic).toContain(id);
  });

  it("focuses selection on the assessment's target skills", async () => {
    const a = await startAssessment({
      studentId: fx.users.bob,
      title: "T",
      mode: "practice",
      targetSkillIds: [fx.skills.arithmetic, fx.skills.fractions],
      itemTarget: 4,
    });
    const first = await computeNextSessionQuestion(a.id);
    expect(first).not.toBeNull();
    expect([fx.skills.arithmetic, fx.skills.fractions]).toContain(first!.skillId);
  });

  it("grades against the real key and reports an explainable rationale", async () => {
    // bob has an established mastery (~0.35); a wrong answer must lower it (from a
    // zero base the BKT learn-transition would raise mastery even when wrong).
    const a = await startAssessment({
      studentId: fx.users.bob,
      title: "T",
      mode: "practice",
      targetSkillIds: [fx.skills.arithmetic],
      itemTarget: 3,
    });
    const item = await computeNextSessionQuestion(a.id);
    expect(item!.rationale).toBeTruthy();
    expect(item!.predictedSuccess).toBeGreaterThanOrEqual(0);
    expect(item!.predictedSuccess).toBeLessThanOrEqual(1);

    const key = await keyFor(item!.questionId);
    const graded = await gradeItem({ assessmentId: a.id, itemId: item!.itemId, studentAnswer: (key + 1) % 4, responseTimeMs: 3000 });
    if ("error" in graded) throw new Error(graded.error);
    expect(graded.isCorrect).toBe(false);
    expect(graded.delta).toBeLessThan(0); // wrong answer lowers established mastery
  });

  it("completes the assessment once the item target is met and records a score", async () => {
    const a = await startAssessment({
      studentId: fx.users.bob,
      title: "T",
      mode: "practice",
      targetSkillIds: [fx.skills.arithmetic],
      itemTarget: 2,
    });

    let next = await computeNextSessionQuestion(a.id);
    let completed = false;
    let guard = 0;
    while (next && guard < 10) {
      guard += 1;
      const key = await keyFor(next.questionId);
      const graded = await gradeItem({ assessmentId: a.id, itemId: next.itemId, studentAnswer: key, responseTimeMs: 3000 });
      if ("error" in graded) throw new Error(graded.error);
      if (graded.completed) {
        completed = true;
        expect(graded.summary).not.toBeNull();
        break;
      }
      next = graded.next;
    }
    expect(completed).toBe(true);

    const [row] = await db.select().from(assessments).where(eq(assessments.id, a.id));
    expect(row.status).toBe("completed");
    expect(row.score).not.toBeNull();
  });

  it("routes a zero-history learner through a broad, bounded diagnostic before normal adaptation", async () => {
    const a = await startAssessment({ studentId: fx.users.dave, title: "Practice", mode: "practice", targetSkillIds: [], itemTarget: 20 });
    expect(a.mode).toBe("diagnostic");
    expect(a.itemTarget).toBeGreaterThanOrEqual(6);
    expect(a.itemTarget).toBeLessThanOrEqual(12);
    expect(a.targetSkillIds).toHaveLength(4);

    const servedSkills = new Set<number>();
    let next = await computeNextSessionQuestion(a.id);
    let guard = 0;
    while (next && guard++ < 12) {
      servedSkills.add(next.skillId);
      // The delivery contract contains options but never the answer key.
      expect(next).not.toHaveProperty("correctIndex");
      const key = await keyFor(next.questionId);
      const graded = await gradeItem({ assessmentId: a.id, itemId: next.itemId, studentAnswer: key, responseTimeMs: 3000 });
      if ("error" in graded) throw new Error(graded.error);
      next = graded.next;
    }
    expect(servedSkills.size).toBeGreaterThanOrEqual(3);
    const items = await db.select().from(assessmentItems).where(eq(assessmentItems.assessmentId, a.id));
    expect(items.length).toBeLessThanOrEqual(12);
    const states = await db.select().from(masteryStates).where(eq(masteryStates.studentId, fx.users.dave));
    expect(states.length).toBeGreaterThanOrEqual(3);
    expect(states.every(s => s.attempts > 0)).toBe(true);
  });

  it("guards against grading an already-answered item", async () => {
    const a = await startAssessment({ studentId: fx.users.bob, title: "T", mode: "practice", targetSkillIds: [fx.skills.arithmetic], itemTarget: 3 });
    const item = await computeNextSessionQuestion(a.id);
    const key = await keyFor(item!.questionId);
    await gradeItem({ assessmentId: a.id, itemId: item!.itemId, studentAnswer: key, responseTimeMs: 3000 });
    const again = await gradeItem({ assessmentId: a.id, itemId: item!.itemId, studentAnswer: key, responseTimeMs: 3000 });
    expect("error" in again).toBe(true);
  });
});
