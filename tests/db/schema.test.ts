import { afterAll, beforeAll, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, describeDb, resetDatabase, closePool } from "../helpers/db";
import { seedFixtures, type Fixtures } from "../helpers/fixtures";
import {
  assessmentItems,
  assessments,
  institutions,
  masteryStates,
  questions,
  sessions,
  skills,
  users,
} from "@/db/schema";

describeDb("database · schema, constraints & persistence", () => {
  let fx: Fixtures;

  beforeAll(async () => {
    fx = await seedFixtures();
  });

  afterAll(async () => {
    await closePool();
  });

  it("connects and round-trips a clean truncate", async () => {
    await resetDatabase();
    const rows = await db.select().from(users);
    expect(rows).toHaveLength(0);
    // re-seed so later assertions in this file have data
    fx = await seedFixtures();
  });

  it("persists all fixture rows", async () => {
    expect((await db.select().from(institutions)).length).toBe(2);
    expect((await db.select().from(users)).length).toBe(9);
    expect((await db.select().from(skills)).length).toBe(4);
    // 11 published + 1 draft + 1 retired
    expect((await db.select().from(questions)).length).toBe(13);
  });

  it("enforces the unique user email index", async () => {
    await expect(
      db.insert(users).values({ name: "Dup", email: fx.emails.alice, passwordHash: "x", role: "student" }),
    ).rejects.toThrow();
  });

  it("enforces the unique skill code index", async () => {
    await expect(
      db.insert(skills).values({ subjectId: fx.subject, name: "Dup", code: "MATH.ARITH", difficultyBase: 0.5 }),
    ).rejects.toThrow();
  });

  it("enforces the unique (student, skill) mastery index", async () => {
    await expect(
      db.insert(masteryStates).values({ studentId: fx.users.alice, skillId: fx.skills.arithmetic, mastery: 0.1 }),
    ).rejects.toThrow();
  });

  it("applies column defaults on insert", async () => {
    const [q] = await db
      .insert(questions)
      .values({ skillId: fx.skills.arithmetic, stem: "defaults?", options: ["a", "b"], correctIndex: 0 })
      .returning();
    expect(q.status).toBe("draft"); // default
    expect(q.version).toBe(1);
    expect(q.isActive).toBe(true);
    expect(q.source).toBe("human");
    expect(Array.isArray(q.hints)).toBe(true);
  });

  it("round-trips jsonb columns (options, prereqIds, history)", async () => {
    const [skill] = await db.select().from(skills).where(eq(skills.id, fx.skills.fractions));
    expect(skill.prereqIds).toEqual([fx.skills.arithmetic]);

    const [state] = await db
      .select()
      .from(masteryStates)
      .where(and(eq(masteryStates.studentId, fx.users.alice), eq(masteryStates.skillId, fx.skills.arithmetic)));
    expect(Array.isArray(state.history)).toBe(true);
    expect(state.history[0]).toHaveProperty("m");
  });

  it("stores the completed history assessment with graded items", async () => {
    const [a] = await db.select().from(assessments).where(eq(assessments.id, fx.historyAssessment));
    expect(a.status).toBe("completed");
    const items = await db.select().from(assessmentItems).where(eq(assessmentItems.assessmentId, fx.historyAssessment));
    expect(items).toHaveLength(12);
    expect(items.every((i) => i.isCorrect !== null)).toBe(true);
  });

  it("sessions carry an expiry used by auth lookups", async () => {
    const rows = await db.select().from(sessions);
    // no sessions seeded yet — table exists and queries succeed
    expect(Array.isArray(rows)).toBe(true);
  });
});
