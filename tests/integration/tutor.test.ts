import { afterAll, beforeEach, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, describeDb, closePool } from "../helpers/db";
import { seedFixtures, type Fixtures } from "../helpers/fixtures";
import { assessmentItems, assessments, masteryStates, activityEvents, tutorInteractions } from "@/db/schema";
import { runTutor } from "@/lib/tutor";
import { assembleLearnerContext } from "@/lib/tutor/context";
import { assembleCurriculumContext } from "@/lib/tutor/retrieval";
import type { TutorLlm } from "@/lib/tutor/types";

describeDb("integration · AI tutor pipeline", () => {
  let fx: Fixtures;
  beforeEach(async () => {
    fx = await seedFixtures();
  });
  afterAll(async () => {
    await closePool();
  });

  /* ------------------------------------------------------------------ */
  /* Stage 1 — learner context                                          */
  /* ------------------------------------------------------------------ */

  it("assembles a read-only learner context grounded in the model", async () => {
    const ctx = await assembleLearnerContext(fx.users.bob);
    expect(ctx).not.toBeNull();
    // Bob's weakest practised skill (fractions @ 0.2) should be the focus.
    expect(ctx!.focusSkill?.skillId).toBe(fx.skills.fractions);
    expect(ctx!.focusSkill!.mastery).toBeLessThan(0.4);
    // Fractions' prerequisite (arithmetic) must be present.
    expect(ctx!.focusSkill!.prereqs.map((p) => p.skillId)).toContain(fx.skills.arithmetic);
    expect(ctx!.coldStart).toBe(false);
  });

  it("marks a cold-start learner and still produces a safe context", async () => {
    const ctx = await assembleLearnerContext(fx.users.dave);
    expect(ctx).not.toBeNull();
    expect(ctx!.coldStart).toBe(true);
    // Falls back to the most foundational skill in the taxonomy.
    expect(ctx!.focusSkill?.skillId).toBe(fx.skills.arithmetic);
  });

  /* ------------------------------------------------------------------ */
  /* Response + learning event (no mastery mutation)                    */
  /* ------------------------------------------------------------------ */

  it("produces a grounded response and records it as a learning event WITHOUT touching mastery", async () => {
    const before = await db
      .select()
      .from(masteryStates)
      .where(and(eq(masteryStates.studentId, fx.users.bob), eq(masteryStates.skillId, fx.skills.fractions)));
    const itemsBefore = await db.select().from(assessmentItems);

    const result = await runTutor({ studentId: fx.users.bob, intent: "explain" });
    expect("error" in result).toBe(false);
    if ("error" in result) return;

    expect(result.message.length).toBeGreaterThan(0);
    expect(result.skillId).toBe(fx.skills.fractions);
    expect(result.provider).toBe("deterministic");
    expect(result.interactionId).toBeGreaterThan(0);

    // The interaction is persisted for later impact evaluation.
    const rows = await db.select().from(tutorInteractions).where(eq(tutorInteractions.id, result.interactionId));
    expect(rows).toHaveLength(1);
    expect(rows[0].studentId).toBe(fx.users.bob);
    expect(rows[0].skillId).toBe(fx.skills.fractions);
    expect(rows[0].intent).toBe("explain");
    expect(rows[0].masteryAtTime).not.toBeNull();

    // A mirrored activity event exists.
    const activity = await db
      .select()
      .from(activityEvents)
      .where(and(eq(activityEvents.studentId, fx.users.bob), eq(activityEvents.type, "tutor")));
    expect(activity.length).toBeGreaterThanOrEqual(1);

    // CRITICAL INVARIANT: mastery + assessment items are unchanged by tutoring.
    const after = await db
      .select()
      .from(masteryStates)
      .where(and(eq(masteryStates.studentId, fx.users.bob), eq(masteryStates.skillId, fx.skills.fractions)));
    expect(after[0].mastery).toBe(before[0].mastery);
    expect(after[0].attempts).toBe(before[0].attempts);
    const itemsAfter = await db.select().from(assessmentItems);
    expect(itemsAfter.length).toBe(itemsBefore.length);
  });

  it("serves every capability deterministically", async () => {
    const intents = ["explain", "hint", "socratic", "worked_example", "diagnose", "remediate", "next_activity"] as const;
    for (const intent of intents) {
      const a = await runTutor({ studentId: fx.users.bob, intent });
      const b = await runTutor({ studentId: fx.users.bob, intent });
      if ("error" in a || "error" in b) throw new Error("unexpected tutor error");
      expect(a.message).toBe(b.message); // deterministic composer
      expect(a.intent).toBe(intent);
    }
  });

  /* ------------------------------------------------------------------ */
  /* Answer safety (capability 9)                                        */
  /* ------------------------------------------------------------------ */

  async function startPendingAssessment(studentId: number) {
    const [a] = await db
      .insert(assessments)
      .values({
        studentId,
        title: "Live quiz",
        mode: "adaptive_quiz",
        status: "in_progress",
        targetSkillIds: [fx.skills.quadratics],
        itemTarget: 8,
      })
      .returning({ id: assessments.id });
    const qid = fx.questions.quadratics[0]; // "Roots of x^2 = 9" → correct "±3"
    const [item] = await db
      .insert(assessmentItems)
      .values({
        assessmentId: a.id,
        questionId: qid,
        skillId: fx.skills.quadratics,
        sequence: 1,
        studentAnswer: null, // PENDING
      })
      .returning({ id: assessmentItems.id });
    return { assessmentId: a.id, itemId: item.id };
  }

  it("withholds answers while an assessment item is pending, and redacts curriculum explanations", async () => {
    const { assessmentId } = await startPendingAssessment(fx.users.alice);

    // Retrieval must redact answer explanations for the live skill.
    const ctx = await assembleLearnerContext(fx.users.alice, { assessmentId });
    const curriculum = await assembleCurriculumContext(ctx!, { withholdAnswers: true, pendingQuestionId: null });
    expect(curriculum.examples.length).toBeGreaterThan(0);
    expect(curriculum.examples.every((e) => e.redacted && e.explanation === null)).toBe(true);

    for (const intent of ["hint", "explain", "worked_example"] as const) {
      const result = await runTutor({ studentId: fx.users.alice, intent, assessmentId });
      if ("error" in result) throw new Error("unexpected tutor error");
      expect(result.withheldAnswer).toBe(true);
      // The correct option "±3" must never appear in the message.
      expect(result.message).not.toContain("±3");
      expect(result.disclaimers.join(" ")).toMatch(/hidden|withheld|progress/i);
    }
  });

  it("blocks an external model that tries to leak the answer (defense in depth)", async () => {
    const { assessmentId } = await startPendingAssessment(fx.users.alice);

    const leakyLlm: TutorLlm = {
      id: "test-leaky",
      async generate() {
        return {
          message: "Easy — the answer is ±3, just take the square root of 9.",
          followUps: [],
          suggestedActivity: null,
          provider: "test-leaky",
          model: "leaky-1",
          usedFallback: false,
        };
      },
    };

    const result = await runTutor({ studentId: fx.users.alice, intent: "hint", assessmentId }, { llm: leakyLlm });
    if ("error" in result) throw new Error("unexpected tutor error");
    expect(result.withheldAnswer).toBe(true);
    expect(result.safetyFlags).toContain("withheld_answer_leak_blocked");
    expect(result.message).not.toContain("±3");
    expect(result.message).not.toMatch(/the answer is/i);

    // The block is recorded on the persisted event too.
    const rows = await db.select().from(tutorInteractions).where(eq(tutorInteractions.id, result.interactionId));
    expect(rows[0].safetyFlags).toContain("withheld_answer_leak_blocked");
    expect(rows[0].withheldAnswer).toBe(true);
  });

  it("returns an error for an unknown learner", async () => {
    const result = await runTutor({ studentId: 999999, intent: "explain" });
    expect("error" in result).toBe(true);
  });
});
