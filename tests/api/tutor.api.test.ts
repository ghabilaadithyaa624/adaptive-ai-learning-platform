import { vi, afterAll, beforeEach, expect, it } from "vitest";

vi.mock("next/headers", () => import("../helpers/next-headers-mock"));
vi.mock("next/navigation", () => import("../helpers/next-navigation-mock"));

import { db, describeDb, closePool } from "../helpers/db";
import { seedFixtures, type Fixtures } from "../helpers/fixtures";
import { loginAs, logout } from "../helpers/session";
import { GET, POST, readJson } from "../helpers/http";
import { GET as tutorGET, POST as tutorPOST } from "@/app/api/tutor/route";
import { assessmentItems, assessments } from "@/db/schema";

type TutorResp = {
  interactionId: number;
  intent: string;
  skillId: number | null;
  message: string;
  withheldAnswer: boolean;
  provider: string;
  error?: string;
};

describeDb("API · AI tutor", () => {
  let fx: Fixtures;
  beforeEach(async () => {
    fx = await seedFixtures();
    await logout();
  });
  afterAll(async () => {
    await closePool();
  });

  it("lets a learner ask the tutor about themselves", async () => {
    await loginAs(fx.users.bob);
    const res = await tutorPOST(POST("/api/tutor", { body: { intent: "explain" } }));
    expect(res.status).toBe(201);
    const data = await readJson<TutorResp>(res);
    expect(data.message.length).toBeGreaterThan(0);
    expect(data.skillId).toBe(fx.skills.fractions);
    expect(data.provider).toBe("deterministic");
  });

  it("requires authentication", async () => {
    const res = await tutorPOST(POST("/api/tutor", { body: { intent: "explain" } }));
    expect(res.status).toBe(401);
  });

  it("rejects an invalid intent", async () => {
    await loginAs(fx.users.bob);
    const res = await tutorPOST(POST("/api/tutor", { body: { intent: "hack" } }));
    expect(res.status).toBe(400);
  });

  it("lets same-tenant staff tutor a learner but blocks cross-tenant access", async () => {
    await loginAs(fx.users.teacherA);
    const ok = await tutorPOST(POST("/api/tutor", { body: { studentId: fx.users.bob, intent: "hint" } }));
    expect(ok.status).toBe(201);

    await loginAs(fx.users.teacherB); // Eastvale teacher, bob is Northwind
    const denied = await tutorPOST(POST("/api/tutor", { body: { studentId: fx.users.bob, intent: "hint" } }));
    expect(denied.status).toBe(403);
  });

  it("withholds answers when tutoring during an in-progress assessment", async () => {
    const [a] = await db
      .insert(assessments)
      .values({
        studentId: fx.users.bob,
        title: "Live quiz",
        mode: "adaptive_quiz",
        status: "in_progress",
        targetSkillIds: [fx.skills.fractions],
        itemTarget: 8,
      })
      .returning({ id: assessments.id });
    await db.insert(assessmentItems).values({
      assessmentId: a.id,
      questionId: fx.questions.fractions[0],
      skillId: fx.skills.fractions,
      sequence: 1,
      studentAnswer: null,
    });

    await loginAs(fx.users.bob);
    const res = await tutorPOST(POST("/api/tutor", { body: { intent: "hint", assessmentId: a.id } }));
    expect(res.status).toBe(201);
    const data = await readJson<TutorResp>(res);
    expect(data.withheldAnswer).toBe(true);
  });

  it("records learner feedback on an interaction and blocks rating others'", async () => {
    await loginAs(fx.users.bob);
    const asked = await readJson<TutorResp>(await tutorPOST(POST("/api/tutor", { body: { intent: "explain" } })));

    const rated = await tutorPOST(
      POST("/api/tutor", { body: { action: "feedback", interactionId: asked.interactionId, helpful: true } }),
    );
    expect(rated.status).toBe(200);

    // Carol (a different learner) must not be able to rate bob's interaction.
    await loginAs(fx.users.carol);
    const forbidden = await tutorPOST(
      POST("/api/tutor", { body: { action: "feedback", interactionId: asked.interactionId, helpful: false } }),
    );
    expect(forbidden.status).toBe(404);
  });

  it("returns the learner's own interaction history", async () => {
    await loginAs(fx.users.bob);
    await tutorPOST(POST("/api/tutor", { body: { intent: "explain" } }));
    await tutorPOST(POST("/api/tutor", { body: { intent: "hint" } }));

    const res = await tutorGET(GET("/api/tutor"));
    expect(res.status).toBe(200);
    const data = await readJson<{ interactions: { intent: string }[] }>(res);
    expect(data.interactions.length).toBeGreaterThanOrEqual(2);
  });
});
