import { afterAll, beforeEach, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, describeDb, closePool } from "../helpers/db";
import { seedFixtures, type Fixtures } from "../helpers/fixtures";
import { computeNextSessionQuestion, gradeItem, startAssessment } from "@/lib/engine";
import { assessments, questions } from "@/db/schema";

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

  it("guards against grading an already-answered item", async () => {
    const a = await startAssessment({ studentId: fx.users.bob, title: "T", mode: "practice", targetSkillIds: [fx.skills.arithmetic], itemTarget: 3 });
    const item = await computeNextSessionQuestion(a.id);
    const key = await keyFor(item!.questionId);
    await gradeItem({ assessmentId: a.id, itemId: item!.itemId, studentAnswer: key, responseTimeMs: 3000 });
    const again = await gradeItem({ assessmentId: a.id, itemId: item!.itemId, studentAnswer: key, responseTimeMs: 3000 });
    expect("error" in again).toBe(true);
  });
});
