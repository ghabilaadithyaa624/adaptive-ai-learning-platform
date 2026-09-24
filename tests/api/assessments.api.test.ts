import { vi, afterAll, beforeAll, beforeEach, expect, it } from "vitest";

vi.mock("next/headers", () => import("../helpers/next-headers-mock"));
vi.mock("next/navigation", () => import("../helpers/next-navigation-mock"));

import { and, eq } from "drizzle-orm";
import { db, describeDb, closePool } from "../helpers/db";
import { seedFixtures, type Fixtures } from "../helpers/fixtures";
import { loginAs, logout } from "../helpers/session";
import { POST, routeCtx, readJson } from "../helpers/http";
import { POST as createAssessment } from "@/app/api/assessments/route";
import { POST as answerAssessment } from "@/app/api/assessments/[id]/answer/route";
import { assessments, masteryStates, questions } from "@/db/schema";

type Session = { itemId: number; questionId: number; skillId: number } | null;
type CreateResp = { assessmentId: number; session: Session };
type GradeResp = {
  isCorrect: boolean;
  completed: boolean;
  masteryBefore: number;
  masteryAfter: number;
  delta: number;
  next: Session;
  summary: { score: number; correct: number; total: number } | null;
};

async function correctIndexFor(questionId: number): Promise<number> {
  const [q] = await db.select({ ci: questions.correctIndex }).from(questions).where(eq(questions.id, questionId));
  return q.ci;
}

describeDb("API · assessments (adaptive session lifecycle)", () => {
  let fx: Fixtures;

  beforeAll(() => {
    (globalThis as { __adaptiqSeedPromise?: Promise<void> }).__adaptiqSeedPromise = Promise.resolve();
  });
  beforeEach(async () => {
    fx = await seedFixtures();
    await logout();
  });
  afterAll(async () => {
    await closePool();
  });

  it("creates an assessment and returns a servable first item (never draft/retired)", async () => {
    await loginAs(fx.users.teacherA);
    const res = await createAssessment(
      POST("/api/assessments", { body: { studentId: fx.users.bob, targetSkillIds: [fx.skills.arithmetic], itemTarget: 3, mode: "practice" } }),
    );
    expect(res.status).toBe(201);
    const data = await readJson<CreateResp>(res);
    expect(data.session).not.toBeNull();
    expect(fx.questions.arithmetic).toContain(data.session!.questionId);
    expect(data.session!.questionId).not.toBe(fx.draftQuestion);
    expect(data.session!.questionId).not.toBe(fx.retiredQuestion);
  });

  it("runs a full adaptive session: distinct items, mastery update, completion summary", async () => {
    await loginAs(fx.users.teacherA);
    const created = await readJson<CreateResp>(
      await createAssessment(
        POST("/api/assessments", { body: { studentId: fx.users.bob, targetSkillIds: [fx.skills.arithmetic], itemTarget: 3, mode: "practice" } }),
      ),
    );
    const assessmentId = created.assessmentId;

    const before = (
      await db
        .select()
        .from(masteryStates)
        .where(and(eq(masteryStates.studentId, fx.users.bob), eq(masteryStates.skillId, fx.skills.arithmetic)))
    )[0];

    const seenQuestionIds: number[] = [];
    let session = created.session;
    let last: GradeResp | null = null;

    for (let i = 0; i < 3 && session; i += 1) {
      seenQuestionIds.push(session.questionId);
      const answer = await correctIndexFor(session.questionId);
      const res = await answerAssessment(
        POST(`/api/assessments/${assessmentId}/answer`, { body: { action: "answer", itemId: session.itemId, studentAnswer: answer, responseTimeMs: 4000 } }),
        routeCtx(assessmentId),
      );
      expect(res.status).toBe(200);
      last = await readJson<GradeResp>(res);
      expect(last.isCorrect).toBe(true); // answered with the real key
      session = last.next;
    }

    // No repeated questions within the session.
    expect(new Set(seenQuestionIds).size).toBe(seenQuestionIds.length);

    // Completed with a summary.
    expect(last!.completed).toBe(true);
    expect(last!.summary).not.toBeNull();
    expect(last!.summary!.total).toBe(3);
    expect(last!.summary!.correct).toBe(3);
    expect(last!.summary!.score).toBeCloseTo(1, 5);

    // Assessment row marked completed.
    const [a] = await db.select().from(assessments).where(eq(assessments.id, assessmentId));
    expect(a.status).toBe("completed");

    // Mastery for the practiced skill advanced and evidence grew.
    const after = (
      await db
        .select()
        .from(masteryStates)
        .where(and(eq(masteryStates.studentId, fx.users.bob), eq(masteryStates.skillId, fx.skills.arithmetic)))
    )[0];
    expect(after.attempts).toBe(before.attempts + 3);
    expect(after.correct).toBe(before.correct + 3);
    expect(after.mastery).toBeGreaterThan(before.mastery);
  });

  it("a correct answer raises mastery more than an incorrect one (BKT direction)", async () => {
    // Use bob (established mastery ~0.35) so the BKT posterior dominates — from a
    // *zero* base the learn-transition would raise mastery even on a wrong answer.
    const runOne = async (answerCorrectly: boolean) => {
      await loginAs(fx.users.teacherA);
      const created = await readJson<CreateResp>(
        await createAssessment(
          POST("/api/assessments", { body: { studentId: fx.users.bob, targetSkillIds: [fx.skills.arithmetic], itemTarget: 3, mode: "practice" } }),
        ),
      );
      const key = await correctIndexFor(created.session!.questionId);
      const answer = answerCorrectly ? key : (key + 1) % 4;
      const res = await answerAssessment(
        POST(`/api/assessments/${created.assessmentId}/answer`, { body: { action: "answer", itemId: created.session!.itemId, studentAnswer: answer, responseTimeMs: 4000 } }),
        routeCtx(created.assessmentId),
      );
      return readJson<GradeResp>(res);
    };

    const correct = await runOne(true);
    fx = await seedFixtures(); // reset to the identical baseline before the second run
    const wrong = await runOne(false);

    expect(correct.delta).toBeGreaterThan(0);
    expect(wrong.delta).toBeLessThan(0);
    expect(correct.delta).toBeGreaterThan(wrong.delta);
  });

  it("rejects an answer to a closed session (400)", async () => {
    await loginAs(fx.users.teacherA);
    const created = await readJson<CreateResp>(
      await createAssessment(
        POST("/api/assessments", { body: { studentId: fx.users.bob, targetSkillIds: [fx.skills.arithmetic], itemTarget: 3, mode: "practice" } }),
      ),
    );
    // Complete the session early.
    await answerAssessment(
      POST(`/api/assessments/${created.assessmentId}/answer`, { body: { action: "complete" } }),
      routeCtx(created.assessmentId),
    );
    // Any further answer must be rejected.
    const res = await answerAssessment(
      POST(`/api/assessments/${created.assessmentId}/answer`, { body: { action: "answer", itemId: created.session!.itemId, studentAnswer: 0, responseTimeMs: 1000 } }),
      routeCtx(created.assessmentId),
    );
    expect(res.status).toBe(400);
  });
});
