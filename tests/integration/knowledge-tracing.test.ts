import { afterAll, beforeEach, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, describeDb, closePool } from "../helpers/db";
import { seedFixtures, type Fixtures } from "../helpers/fixtures";
import { computeNextSessionQuestion, gradeItem, startAssessment } from "@/lib/engine";
import { masteryStates, questions } from "@/db/schema";

async function keyFor(questionId: number): Promise<number> {
  const [q] = await db.select({ ci: questions.correctIndex }).from(questions).where(eq(questions.id, questionId));
  return q.ci;
}

describeDb("integration · knowledge tracing (BKT persistence)", () => {
  let fx: Fixtures;

  beforeEach(async () => {
    fx = await seedFixtures();
  });
  afterAll(async () => {
    await closePool();
  });

  it("creates and grows mastery state for a cold-start learner across correct responses", async () => {
    // dave has NO prior mastery state — this is a genuine cold start.
    const a = await startAssessment({
      studentId: fx.users.dave,
      title: "Diagnostic",
      mode: "diagnostic",
      targetSkillIds: [fx.skills.arithmetic],
      itemTarget: 3,
    });

    const masterySeries: number[] = [];
    let next = await computeNextSessionQuestion(a.id);
    let guard = 0;
    while (next && guard < 10) {
      guard += 1;
      const key = await keyFor(next.questionId);
      const graded = await gradeItem({ assessmentId: a.id, itemId: next.itemId, studentAnswer: key, responseTimeMs: 3000 });
      if ("error" in graded) throw new Error(graded.error);
      masterySeries.push(graded.masteryAfter);
      if (graded.completed) break;
      next = graded.next;
    }

    // Monotonic non-decreasing mastery under a streak of correct answers.
    for (let i = 1; i < masterySeries.length; i += 1) {
      expect(masterySeries[i]).toBeGreaterThanOrEqual(masterySeries[i - 1]);
    }

    const [state] = await db
      .select()
      .from(masteryStates)
      .where(and(eq(masteryStates.studentId, fx.users.dave), eq(masteryStates.skillId, fx.skills.arithmetic)));
    expect(state).toBeTruthy();
    expect(state.attempts).toBe(masterySeries.length);
    expect(state.correct).toBe(masterySeries.length);
    expect(state.streak).toBe(masterySeries.length);
    expect(state.history.length).toBe(masterySeries.length);
    // Persisted mastery matches the last observed posterior.
    expect(state.mastery).toBeCloseTo(masterySeries.at(-1)!, 5);
  });

  it("an incorrect answer resets the streak and reduces mastery", async () => {
    // bob has established evidence; one correct answer builds a real posterior so
    // the following wrong answer measurably reduces mastery and clears the streak.
    const a = await startAssessment({
      studentId: fx.users.bob,
      title: "Practice",
      mode: "practice",
      targetSkillIds: [fx.skills.arithmetic],
      itemTarget: 3,
    });

    // First: one correct answer to build a streak.
    let next = await computeNextSessionQuestion(a.id);
    const key1 = await keyFor(next!.questionId);
    let graded = await gradeItem({ assessmentId: a.id, itemId: next!.itemId, studentAnswer: key1, responseTimeMs: 3000 });
    if ("error" in graded) throw new Error(graded.error);
    const afterCorrect = graded.masteryAfter;
    expect(graded.streak).toBe(1);

    // Then: an incorrect answer.
    next = graded.next;
    const key2 = await keyFor(next!.questionId);
    graded = await gradeItem({ assessmentId: a.id, itemId: next!.itemId, studentAnswer: (key2 + 1) % 4, responseTimeMs: 3000 });
    if ("error" in graded) throw new Error(graded.error);
    expect(graded.streak).toBe(0);
    expect(graded.masteryAfter).toBeLessThan(afterCorrect);

    // bob started with attempts=10, correct=4 (from fixtures); +2 attempts, +1 correct.
    const [state] = await db
      .select()
      .from(masteryStates)
      .where(and(eq(masteryStates.studentId, fx.users.bob), eq(masteryStates.skillId, fx.skills.arithmetic)));
    expect(state.attempts).toBe(12);
    expect(state.correct).toBe(5);
    expect(state.streak).toBe(0);
  });
});
