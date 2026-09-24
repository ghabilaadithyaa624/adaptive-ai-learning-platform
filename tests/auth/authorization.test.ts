import { vi, afterAll, beforeAll, beforeEach, expect, it } from "vitest";

vi.mock("next/headers", () => import("../helpers/next-headers-mock"));
vi.mock("next/navigation", () => import("../helpers/next-navigation-mock"));

import { describeDb, closePool } from "../helpers/db";
import { seedFixtures, type Fixtures } from "../helpers/fixtures";
import { loginAs, logout } from "../helpers/session";
import { GET, POST, readJson } from "../helpers/http";
import { GET as studentsGET, POST as studentsPOST } from "@/app/api/students/route";
import { GET as usersGET, POST as usersPOST } from "@/app/api/users/route";
import { POST as mlPOST } from "@/app/api/ml/route";

describeDb("authorization (RBAC + capabilities)", () => {
  let fx: Fixtures;

  beforeAll(async () => {
    (globalThis as { __adaptiqSeedPromise?: Promise<void> }).__adaptiqSeedPromise = Promise.resolve();
  });
  beforeEach(async () => {
    fx = await seedFixtures();
    await logout();
  });
  afterAll(async () => {
    await closePool();
  });

  it("rejects unauthenticated access to a protected endpoint (401)", async () => {
    const res = await studentsGET(GET("/api/students"));
    expect(res.status).toBe(401);
  });

  it("a student cannot list learners (403 — lacks manageStudents)", async () => {
    await loginAs(fx.users.alice);
    const res = await studentsGET(GET("/api/students"));
    expect(res.status).toBe(403);
  });

  it("a teacher can list learners (200)", async () => {
    await loginAs(fx.users.teacherA);
    const res = await studentsGET(GET("/api/students"));
    expect(res.status).toBe(200);
    const data = await readJson<{ students: unknown[] }>(res);
    expect(Array.isArray(data.students)).toBe(true);
  });

  it("a student cannot create learners (403)", async () => {
    await loginAs(fx.users.alice);
    const res = await studentsPOST(POST("/api/students", { body: { name: "X", email: "x@student.test" } }));
    expect(res.status).toBe(403);
  });

  it("a teacher cannot view the user directory (403 — needs account admin)", async () => {
    await loginAs(fx.users.teacherA);
    const res = await usersGET(GET("/api/users"));
    expect(res.status).toBe(403);
  });

  it("an institution admin can view the user directory (200)", async () => {
    await loginAs(fx.users.instAdminA);
    const res = await usersGET(GET("/api/users"));
    expect(res.status).toBe(200);
  });

  it("a student cannot operate the model registry (403 — needs trainModels)", async () => {
    await loginAs(fx.users.alice);
    const res = await mlPOST(POST("/api/ml", { body: { action: "train" } }));
    expect(res.status).toBe(403);
  });

  it("blocks privilege escalation: an institution admin cannot mint a platform admin (403)", async () => {
    await loginAs(fx.users.instAdminA);
    const res = await usersPOST(
      POST("/api/users", { body: { name: "Root", email: "root@northwind.test", role: "admin", password: "Str0ngPass!" } }),
    );
    expect(res.status).toBe(403);
  });

  it("enforces CSRF/same-origin on state-changing requests (403 cross-site)", async () => {
    await loginAs(fx.users.teacherA);
    const res = await studentsPOST(
      POST("/api/students", { body: { name: "Y", email: "y@northwind.test" }, crossSite: true }),
    );
    expect(res.status).toBe(403);
  });
});
