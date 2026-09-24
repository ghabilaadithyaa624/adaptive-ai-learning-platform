import { vi, afterAll, beforeAll, beforeEach, expect, it } from "vitest";

// Auth routes read/write cookies via next/headers and import next/navigation.
vi.mock("next/headers", () => import("../helpers/next-headers-mock"));
vi.mock("next/navigation", () => import("../helpers/next-navigation-mock"));

import { and, eq, lt } from "drizzle-orm";
import { db, describeDb, closePool } from "../helpers/db";
import { seedFixtures, FIXTURE_PASSWORD, type Fixtures } from "../helpers/fixtures";
import { POST as authRoute } from "@/app/api/auth/route";
import { GET as studentsRoute } from "@/app/api/students/route";
import { POST, GET, readJson } from "../helpers/http";
import { __resetCookies } from "../helpers/next-headers-mock";
import { getCurrentUser, hashPassword, verifyPassword } from "@/lib/auth";
import { sessions, users } from "@/db/schema";

function resetRateLimits() {
  (globalThis as { __adaptiqRateBuckets?: Map<string, unknown> }).__adaptiqRateBuckets?.clear();
}

describeDb("authentication", () => {
  let fx: Fixtures;

  beforeAll(async () => {
    fx = await seedFixtures();
    // Neutralize the application's random seed so auth routes never insert it.
    (globalThis as { __adaptiqSeedPromise?: Promise<void> }).__adaptiqSeedPromise = Promise.resolve();
  });

  beforeEach(async () => {
    fx = await seedFixtures();
    (globalThis as { __adaptiqSeedPromise?: Promise<void> }).__adaptiqSeedPromise = Promise.resolve();
    __resetCookies();
    resetRateLimits();
  });

  afterAll(async () => {
    await closePool();
  });

  it("password hashing verifies correctly and rejects wrong/tampered inputs", () => {
    const stored = hashPassword("Correct-horse-1");
    expect(verifyPassword("Correct-horse-1", stored)).toBe(true);
    expect(verifyPassword("wrong", stored)).toBe(false);
    expect(verifyPassword("Correct-horse-1", "malformed")).toBe(false);
  });

  it("student registration creates a self-service account and a session", async () => {
    const res = await authRoute(
      POST("/api/auth", { body: { action: "register", name: "New Learner", email: "newbie@student.test", password: "Str0ngPass!" } }),
    );
    expect(res.status).toBe(201);
    const data = await readJson<{ user: { id: number; role: string } }>(res);
    expect(data.user.role).toBe("student");

    const [row] = await db.select().from(users).where(eq(users.email, "newbie@student.test"));
    expect(row).toBeTruthy();
    expect(row.institutionId).toBeNull();

    // A session was established (cookie + DB row), so getCurrentUser resolves.
    const current = await getCurrentUser();
    expect(current?.id).toBe(data.user.id);
  });

  it("registration ignores client-supplied role/institution (no privilege escalation)", async () => {
    const res = await authRoute(
      POST("/api/auth", {
        body: {
          action: "register",
          name: "Sneaky",
          email: "sneaky@student.test",
          password: "Str0ngPass!",
          role: "admin",
          institutionId: fx.institutions.northwind,
        },
      }),
    );
    expect(res.status).toBe(201);
    const [row] = await db.select().from(users).where(eq(users.email, "sneaky@student.test"));
    expect(row.role).toBe("student");
    expect(row.institutionId).toBeNull();
  });

  it("registration rejects a weak password", async () => {
    const res = await authRoute(POST("/api/auth", { body: { action: "register", name: "Weak", email: "weak@student.test", password: "123" } }));
    expect(res.status).toBe(400);
  });

  it("registration rejects a duplicate email with 409", async () => {
    const res = await authRoute(
      POST("/api/auth", { body: { action: "register", name: "Dup", email: fx.emails.alice, password: "Str0ngPass!" } }),
    );
    expect(res.status).toBe(409);
  });

  it("login succeeds with correct credentials and establishes a session", async () => {
    const res = await authRoute(POST("/api/auth", { body: { action: "login", email: fx.emails.alice, password: FIXTURE_PASSWORD } }));
    expect(res.status).toBe(200);
    const data = await readJson<{ user: { id: number } }>(res);
    expect(data.user.id).toBe(fx.users.alice);
    const current = await getCurrentUser();
    expect(current?.id).toBe(fx.users.alice);
  });

  it("login fails with a wrong password (401) and does not leak account existence", async () => {
    const res = await authRoute(POST("/api/auth", { body: { action: "login", email: fx.emails.alice, password: "totally-wrong" } }));
    expect(res.status).toBe(401);
    expect(await getCurrentUser()).toBeNull();
  });

  it("login fails with an unknown email (401)", async () => {
    const res = await authRoute(POST("/api/auth", { body: { action: "login", email: "ghost@nowhere.test", password: FIXTURE_PASSWORD } }));
    expect(res.status).toBe(401);
  });

  it("login is refused for a suspended account (403)", async () => {
    const res = await authRoute(POST("/api/auth", { body: { action: "login", email: fx.emails.erin, password: FIXTURE_PASSWORD } }));
    expect(res.status).toBe(403);
  });

  it("logout destroys the session so protected endpoints reject the caller", async () => {
    await authRoute(POST("/api/auth", { body: { action: "login", email: fx.emails.teacherA, password: FIXTURE_PASSWORD } }));
    expect(await getCurrentUser()).not.toBeNull();

    const out = await authRoute(POST("/api/auth", { body: { action: "logout" } }));
    expect(out.status).toBe(200);
    expect(await getCurrentUser()).toBeNull();

    // A protected endpoint now returns 401.
    const protectedRes = await studentsRoute(GET("/api/students"));
    expect(protectedRes.status).toBe(401);
  });

  it("an expired session token is not accepted", async () => {
    await db.insert(sessions).values({
      token: "expired-token-xyz",
      userId: fx.users.alice,
      expiresAt: new Date(Date.now() - 1000),
    });
    __resetCookies();
    // Manually place the expired cookie.
    const { cookies } = await import("../helpers/next-headers-mock");
    (await cookies()).set("adaptiq_session", "expired-token-xyz");
    expect(await getCurrentUser()).toBeNull();
    // sanity: the expired row exists but is filtered out
    const rows = await db.select().from(sessions).where(and(lt(sessions.expiresAt, new Date())));
    expect(rows.some((r) => r.token === "expired-token-xyz")).toBe(true);
  });
});
