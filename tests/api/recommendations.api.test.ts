import { vi, afterAll, beforeAll, beforeEach, expect, it } from "vitest";

vi.mock("next/headers", () => import("../helpers/next-headers-mock"));
vi.mock("next/navigation", () => import("../helpers/next-navigation-mock"));

import { db, describeDb, closePool } from "../helpers/db";
import { seedFixtures, type Fixtures } from "../helpers/fixtures";
import { loginAs, logout } from "../helpers/session";
import { POST, readJson } from "../helpers/http";
import { POST as generateRecs } from "@/app/api/recommendations/route";
import { recommendations } from "@/db/schema";

type Rec = { skillId: number | null; priority: number; title: string; status: string };
type RecResp = { recommendations: Rec[]; generated: number };

describeDb("API · recommendations (generation)", () => {
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

  it("generates prioritised recommendations for a learner with mastery evidence", async () => {
    await loginAs(fx.users.teacherA);
    const res = await generateRecs(POST("/api/recommendations", { body: { studentId: fx.users.bob } }));
    expect(res.status).toBe(201);
    const data = await readJson<RecResp>(res);
    expect(data.generated).toBeGreaterThan(0);
    expect(data.recommendations.length).toBeGreaterThan(0);

    // Deterministic ordering: descending priority.
    const priorities = data.recommendations.map((r) => r.priority);
    expect([...priorities].sort((a, b) => b - a)).toEqual(priorities);

    // Bob's weakest foundations should surface.
    const recSkills = data.recommendations.map((r) => r.skillId);
    expect(recSkills.some((id) => id === fx.skills.arithmetic || id === fx.skills.fractions)).toBe(true);
  });

  it("refuses to fabricate recommendations for a cold-start learner (409)", async () => {
    await loginAs(fx.users.teacherA);
    const res = await generateRecs(POST("/api/recommendations", { body: { studentId: fx.users.dave } }));
    expect(res.status).toBe(409); // "No mastery evidence yet"
  });

  it("excludes skills the learner previously dismissed", async () => {
    // Pre-record a dismissed recommendation for bob's fractions skill.
    await db.insert(recommendations).values({
      studentId: fx.users.bob,
      kind: "skill",
      skillId: fx.skills.fractions,
      title: "Dismissed fractions",
      status: "dismissed",
    });

    await loginAs(fx.users.teacherA);
    const data = await readJson<RecResp>(await generateRecs(POST("/api/recommendations", { body: { studentId: fx.users.bob } })));
    // Newly-generated recommendations must not re-surface the dismissed skill
    // (the dismissed row itself remains in the full history list).
    const generated = data.recommendations.filter((r) => r.status === "new");
    expect(generated.length).toBeGreaterThan(0);
    expect(generated.every((r) => r.skillId !== fx.skills.fractions)).toBe(true);
  });

  it("a student can generate their own recommendations (self-service)", async () => {
    await loginAs(fx.users.bob);
    const res = await generateRecs(POST("/api/recommendations", { body: {} })); // pinned to self
    expect(res.status).toBe(201);
  });
});
