import { vi, afterAll, beforeEach, expect, it } from "vitest";

vi.mock("next/headers", () => import("../helpers/next-headers-mock"));
vi.mock("next/navigation", () => import("../helpers/next-navigation-mock"));

import { describeDb, closePool } from "../helpers/db";
import { seedFixtures, type Fixtures } from "../helpers/fixtures";
import { loginAs, logout } from "../helpers/session";
import { POST, PATCH, routeCtx, readJson } from "../helpers/http";
import { POST as createPath } from "@/app/api/paths/route";
import { PATCH as patchMilestone } from "@/app/api/milestones/[id]/route";

type Milestone = { id: number; skillId: number; position: number; status: string };
type Path = { id: number; progress: number; milestones: Milestone[] };
type PathResp = { path: Path };

describeDb("integration · learning-path generation & progression", () => {
  let fx: Fixtures;

  beforeEach(async () => {
    fx = await seedFixtures();
    (globalThis as { __adaptiqSeedPromise?: Promise<void> }).__adaptiqSeedPromise = Promise.resolve();
    await logout();
  });
  afterAll(async () => {
    await closePool();
  });

  it("auto-generates a prerequisite-ordered path for a learner with gaps", async () => {
    await loginAs(fx.users.teacherA);
    const res = await createPath(POST("/api/paths", { body: { studentId: fx.users.bob, autoGenerate: true } }));
    expect(res.status).toBe(201);
    const { path } = await readJson<PathResp>(res);

    expect(path.milestones.length).toBeGreaterThanOrEqual(2);
    const posOf = (skillId: number) => path.milestones.find((m) => m.skillId === skillId)?.position ?? 999;
    // Arithmetic (prereq) precedes fractions (dependent).
    expect(posOf(fx.skills.arithmetic)).toBeLessThan(posOf(fx.skills.fractions));

    // Exactly the first milestone is available; the rest locked.
    const ordered = [...path.milestones].sort((a, b) => a.position - b.position);
    expect(ordered[0].status).toBe("available");
    expect(ordered.slice(1).every((m) => m.status === "locked")).toBe(true);
  });

  it("progresses the path when a milestone is completed", async () => {
    await loginAs(fx.users.teacherA);
    const { path } = await readJson<PathResp>(await createPath(POST("/api/paths", { body: { studentId: fx.users.bob, autoGenerate: true } })));
    const first = [...path.milestones].sort((a, b) => a.position - b.position)[0];
    const progressBefore = path.progress;

    const res = await patchMilestone(
      PATCH(`/api/milestones/${first.id}`, { body: { status: "completed" } }),
      routeCtx(first.id),
    );
    expect(res.status).toBe(200);
    const data = await readJson<{ milestone: Milestone; progress: number }>(res);
    expect(data.milestone.status).toBe("completed");
    expect(data.progress).toBeGreaterThanOrEqual(progressBefore);
  });

  it("refuses to auto-generate for a cold-start learner (409)", async () => {
    await loginAs(fx.users.teacherA);
    const res = await createPath(POST("/api/paths", { body: { studentId: fx.users.dave, autoGenerate: true } }));
    expect(res.status).toBe(409);
  });

  it("a learner cannot edit milestones (403 — needs managePaths)", async () => {
    await loginAs(fx.users.teacherA);
    const { path } = await readJson<PathResp>(await createPath(POST("/api/paths", { body: { studentId: fx.users.bob, autoGenerate: true } })));
    const first = path.milestones[0];

    await logout();
    await loginAs(fx.users.bob);
    const res = await patchMilestone(PATCH(`/api/milestones/${first.id}`, { body: { status: "completed" } }), routeCtx(first.id));
    expect(res.status).toBe(403);
  });
});
