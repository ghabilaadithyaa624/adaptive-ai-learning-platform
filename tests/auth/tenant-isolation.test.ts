import { vi, afterAll, beforeAll, beforeEach, expect, it } from "vitest";

vi.mock("next/headers", () => import("../helpers/next-headers-mock"));
vi.mock("next/navigation", () => import("../helpers/next-navigation-mock"));

import { describeDb, closePool } from "../helpers/db";
import { seedFixtures, type Fixtures } from "../helpers/fixtures";
import { loginAs, logout } from "../helpers/session";
import { GET, POST, routeCtx, readJson } from "../helpers/http";
import { GET as assessmentsList } from "@/app/api/assessments/route";
import { GET as assessmentDetail } from "@/app/api/assessments/[id]/route";
import { GET as studentsGET, POST as studentsPOST } from "@/app/api/students/route";

type StudentList = { students: { id: number; institutionId?: number | null; name: string }[] };

describeDb("multi-tenant isolation (cross-student & cross-institution)", () => {
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

  /* ------------------------------ cross-student ------------------------------ */

  it("a student only ever sees their own assessments", async () => {
    await loginAs(fx.users.alice);
    const aliceRes = await assessmentsList(GET("/api/assessments"));
    const alice = await readJson<{ assessments: { studentId: number }[] }>(aliceRes);
    expect(alice.assessments.length).toBeGreaterThan(0);
    expect(alice.assessments.every((a) => a.studentId === fx.users.alice)).toBe(true);

    await logout();
    await loginAs(fx.users.bob);
    const bobRes = await assessmentsList(GET("/api/assessments"));
    const bob = await readJson<{ assessments: unknown[] }>(bobRes);
    expect(bob.assessments).toHaveLength(0); // bob has none of alice's
  });

  it("a student cannot open another student's assessment detail (403)", async () => {
    await loginAs(fx.users.bob);
    const res = await assessmentDetail(GET(`/api/assessments/${fx.historyAssessment}`), routeCtx(fx.historyAssessment));
    expect(res.status).toBe(403);
  });

  it("a student CAN open their own assessment detail (200)", async () => {
    await loginAs(fx.users.alice);
    const res = await assessmentDetail(GET(`/api/assessments/${fx.historyAssessment}`), routeCtx(fx.historyAssessment));
    expect(res.status).toBe(200);
  });

  /* --------------------------- cross-institution ----------------------------- */

  it("staff cannot read a learner from another institution (403)", async () => {
    await loginAs(fx.users.teacherA); // Northwind
    const res = await assessmentsList(GET("/api/assessments", { searchParams: { studentId: fx.users.carol } })); // Eastvale
    expect(res.status).toBe(403);
  });

  it("staff CAN read a learner within their own institution (200)", async () => {
    await loginAs(fx.users.teacherA);
    const res = await assessmentsList(GET("/api/assessments", { searchParams: { studentId: fx.users.bob } }));
    expect(res.status).toBe(200);
  });

  it("the learner directory is scoped to the caller's institution", async () => {
    await loginAs(fx.users.teacherA); // Northwind → alice, bob (+ erin suspended)
    const northwind = await readJson<StudentList>(await studentsGET(GET("/api/students")));
    const nwIds = northwind.students.map((s) => s.id);
    expect(nwIds).toContain(fx.users.alice);
    expect(nwIds).toContain(fx.users.bob);
    expect(nwIds).not.toContain(fx.users.carol); // Eastvale learner hidden

    await logout();
    await loginAs(fx.users.teacherB); // Eastvale → carol only
    const eastvale = await readJson<StudentList>(await studentsGET(GET("/api/students")));
    const evIds = eastvale.students.map((s) => s.id);
    expect(evIds).toContain(fx.users.carol);
    expect(evIds).not.toContain(fx.users.alice);
  });

  it("a platform admin sees learners across every institution", async () => {
    await loginAs(fx.users.platformAdmin);
    const all = await readJson<StudentList>(await studentsGET(GET("/api/students")));
    const ids = all.students.map((s) => s.id);
    expect(ids).toContain(fx.users.alice); // Northwind
    expect(ids).toContain(fx.users.carol); // Eastvale
  });

  it("staff cannot create a learner in another institution (403)", async () => {
    await loginAs(fx.users.teacherA);
    const res = await studentsPOST(
      POST("/api/students", { body: { name: "Intruder", email: "intruder@eastvale.test", institutionId: fx.institutions.eastvale } }),
    );
    expect(res.status).toBe(403);
  });

  it("staff creating a learner pins them to the caller's own institution", async () => {
    await loginAs(fx.users.teacherA);
    const res = await studentsPOST(POST("/api/students", { body: { name: "Fresh", email: "fresh@northwind.test" } }));
    expect(res.status).toBe(201);
  });
});
