/**
 * Security matrix — executed against the real authentication/authorization
 * code paths, with the database faked so it runs without Postgres.
 *
 * Why this file exists: the edge layer (`middleware.ts` → `proxy.ts`) never
 * made an authorization decision — it only emits CSP. Auth gating lives in
 * `lib/auth` (sessions), `lib/api` (`withAuth` / `guardPublic`), `lib/authz`
 * (roles, capabilities, tenancy) and `lib/page-guards` (RSC pages). This matrix
 * pins that behaviour so the convention migration can be shown to have changed
 * none of it, and so it keeps being checked in environments where the
 * DB-backed suites (`tests/auth`, `tests/api`, `tests/db`) skip.
 *
 * Fidelity note: the fake database serves rows; it does not execute SQL. Where
 * a rule is enforced *inside* the query (the session-expiry predicate), the
 * test asserts the predicate is present in the emitted condition rather than
 * pretending to have evaluated it — see "expired session".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, columnsInCondition } from "../helpers/fake-db";

const fake = vi.hoisted(() => ({
  instance: null as ReturnType<typeof import("../helpers/fake-db").createFakeDb> | null,
}));

vi.mock("next/headers", () => import("../helpers/next-headers-mock"));
vi.mock("next/navigation", () => import("../helpers/next-navigation-mock"));
vi.mock("@/db", async () => {
  const { createFakeDb: create } = await import("../helpers/fake-db");
  const built = create();
  fake.instance = built;
  return { db: built.db, pool: { totalCount: 0, idleCount: 0, waitingCount: 0, end: async () => {} } };
});
// Seeding is a database concern and is exercised by the DB suites.
vi.mock("@/lib/seed", () => ({ ensureSeededSafe: async () => {}, ensureSeeded: async () => {} }));

import { sessions, users, type User } from "@/db/schema";
import { getCurrentUser, hashPassword } from "@/lib/auth";
import { withAuth, guardPublic } from "@/lib/api";
import {
  assertInstitutionAccess,
  assertStudentAccess,
  assertUserAccess,
  can,
  isStaff,
  requireCapability,
  studentScope,
  PRIVILEGED_ROLES,
  PUBLIC_SIGNUP_ROLE,
} from "@/lib/authz";
import { isHttpError } from "@/lib/http";
import { POST as authPOST } from "@/app/api/auth/route";
import { __resetCookies, __getCookie } from "../helpers/next-headers-mock";
import { GET, POST, readJson } from "../helpers/http";

/* ------------------------------------------------------------------ */
/* World                                                               */
/* ------------------------------------------------------------------ */

const PASSWORD = "Sup3rSecret1";
let passwordHash = "";

type Row = Partial<User> & { id: number; role: string; institutionId: number | null };

const TENANT_A = 1;
const TENANT_B = 2;

function person(id: number, role: string, institutionId: number | null, extra: Partial<Row> = {}): Row {
  return {
    id,
    role,
    institutionId,
    name: `user-${id}`,
    email: `user-${id}@example.test`,
    status: "active",
    ...extra,
  } as Row;
}

const WORLD: Record<string, Row> = {
  anonymous: person(0, "none", null),
  studentA: person(10, "student", TENANT_A),
  studentA2: person(11, "student", TENANT_A),
  studentB: person(20, "student", TENANT_B),
  teacherA: person(30, "teacher", TENANT_A),
  trainerA: person(31, "trainer", TENANT_A),
  instAdminA: person(40, "institution", TENANT_A),
  instAdminB: person(41, "institution", TENANT_B),
  admin: person(50, "admin", null),
  suspended: person(60, "student", TENANT_A, { status: "suspended" }),
  orphanStaff: person(70, "teacher", null),
};

/** Session state the fake session lookup will honour. */
let currentToken: string | null = null;
const sessionTable = new Map<string, { userId: number; expiresAt: Date }>();

function signIn(row: Row, { expiresAt }: { expiresAt?: Date } = {}) {
  const token = `token-${row.id}-${Math.random().toString(16).slice(2)}`;
  sessionTable.set(token, { userId: row.id, expiresAt: expiresAt ?? new Date(Date.now() + 86_400_000) });
  currentToken = token;
  __resetCookies();
  // Drive the real cookie jar the production code reads.
  return import("../helpers/next-headers-mock").then(async (mock) => {
    const jar = await mock.cookies();
    jar.set("adaptiq_session", token);
    return token;
  });
}

function signOut() {
  currentToken = null;
  __resetCookies();
}

function byId(id: number): Row | undefined {
  return Object.values(WORLD).find((p) => p.id === id);
}

beforeEach(() => {
  passwordHash ||= hashPassword(PASSWORD);
  sessionTable.clear();
  signOut();
  fake.instance?.reset();
  fake.instance?.setHandler((query) => {
    // --- session lookup (getCurrentUser): sessions ⨝ users -----------------
    if (query.table === sessions && query.joined) {
      const token = __getCookie("adaptiq_session");
      const session = token ? sessionTable.get(token) : undefined;
      if (!session) return [];
      // The production query filters `expires_at > now()` in SQL; the fake
      // applies the same filter so the row it returns is the row Postgres
      // would return. The predicate's *presence* is asserted separately.
      if (session.expiresAt.getTime() <= Date.now()) return [];
      const user = byId(session.userId);
      return user ? [{ user }] : [];
    }
    // --- single-user lookups (authz.loadUser, login by email) --------------
    if (query.table === users && query.limit === 1) {
      const target = pendingUserLookup;
      return target ? [target] : [];
    }
    // --- tenant student list (accessibleStudentIds) ------------------------
    if (query.table === users) {
      return Object.values(WORLD).filter((p) => p.role === "student");
    }
    // Writes (sessions, audit log, user creation) succeed without assertion.
    if (query.kind !== "select") return [{ ...(query.values as object), id: 999 }];
    return [];
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The row the next `.limit(1)` user lookup should return. */
let pendingUserLookup: Row | undefined;
function expectUserLookup(row: Row | undefined) {
  pendingUserLookup = row;
}

/* ------------------------------------------------------------------ */
/* 1. Anonymous                                                        */
/* ------------------------------------------------------------------ */

describe("matrix · anonymous user", () => {
  it("has no session", async () => {
    expect(await getCurrentUser()).toBeNull();
  });

  it("is rejected from a protected API with 401 and a non-leaky message", async () => {
    const handler = vi.fn();
    const res = await withAuth(GET("/api/students"), handler);
    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
    expect(await readJson<{ error: string }>(res)).toEqual({ error: "You must sign in to continue." });
  });

  it("is not redirected by the API layer (APIs answer 401, pages redirect)", async () => {
    const res = await withAuth(GET("/api/students"), async () => new Response("ok"));
    expect(res.headers.get("location")).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 2-6. Roles                                                          */
/* ------------------------------------------------------------------ */

describe("matrix · roles", () => {
  const cases: Array<{
    name: string;
    row: Row;
    staff: boolean;
    manageStudents: boolean;
    manageStaff: boolean;
    createInstitution: boolean;
    scope: string;
  }> = [
    { name: "student", row: WORLD.studentA, staff: false, manageStudents: false, manageStaff: false, createInstitution: false, scope: "self" },
    { name: "teacher", row: WORLD.teacherA, staff: true, manageStudents: true, manageStaff: false, createInstitution: false, scope: "institution" },
    { name: "trainer", row: WORLD.trainerA, staff: true, manageStudents: true, manageStaff: false, createInstitution: false, scope: "institution" },
    { name: "institution", row: WORLD.instAdminA, staff: true, manageStudents: true, manageStaff: true, createInstitution: false, scope: "institution" },
    { name: "admin", row: WORLD.admin, staff: true, manageStudents: true, manageStaff: true, createInstitution: true, scope: "all" },
  ];

  for (const c of cases) {
    it(`${c.name}: capabilities and tenant scope are unchanged`, () => {
      const user = c.row as User;
      expect(isStaff(user)).toBe(c.staff);
      expect(can.manageStudents(user)).toBe(c.manageStudents);
      expect(can.manageContent(user)).toBe(c.manageStudents);
      expect(can.manageStaff(user)).toBe(c.manageStaff);
      expect(can.createInstitution(user)).toBe(c.createInstitution);
      expect(studentScope(user).kind).toBe(c.scope);
    });
  }

  it("a student is refused a staff capability with 403", () => {
    try {
      requireCapability(WORLD.studentA as User, "manageStudents", "nope", "students.list");
      throw new Error("expected a throw");
    } catch (error) {
      expect(isHttpError(error)).toBe(true);
      if (isHttpError(error)) {
        expect(error.status).toBe(403);
        expect(error.auditAction).toBe("students.list");
        expect(error.auditOutcome).toBe("denied");
      }
    }
  });

  it("staff without a tenant can reach nobody (fail closed)", () => {
    expect(studentScope(WORLD.orphanStaff as User)).toEqual({ kind: "none" });
  });

  it("an authenticated staff user passes through withAuth to the handler", async () => {
    await signIn(WORLD.teacherA);
    const res = await withAuth(GET("/api/students"), async ({ user }) =>
      Response.json({ id: user.id, role: user.role }),
    );
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({ id: WORLD.teacherA.id, role: "teacher" });
  });
});

/* ------------------------------------------------------------------ */
/* 7-9. Session states                                                 */
/* ------------------------------------------------------------------ */

describe("matrix · session handling", () => {
  it("suspended user: a valid token does not authenticate", async () => {
    await signIn(WORLD.suspended);
    expect(await getCurrentUser()).toBeNull();
    const res = await withAuth(GET("/api/students"), async () => new Response("ok"));
    expect(res.status).toBe(401);
  });

  it("expired session: no user, and the expiry filter is in the SQL predicate", async () => {
    await signIn(WORLD.studentA, { expiresAt: new Date(Date.now() - 1000) });
    expect(await getCurrentUser()).toBeNull();

    // The fake cannot execute SQL, so prove the production query still carries
    // the expiry constraint rather than trusting the fake's own filtering.
    const sessionQuery = fake.instance?.log.find((q) => q.table === sessions && q.joined);
    expect(sessionQuery).toBeDefined();
    const columns = columnsInCondition(sessionQuery?.where);
    expect(columns).toContain("token");
    expect(columns).toContain("expires_at");
  });

  it("invalid session: an unknown token authenticates nobody", async () => {
    __resetCookies();
    const jar = await (await import("../helpers/next-headers-mock")).cookies();
    jar.set("adaptiq_session", "not-a-real-token");
    expect(await getCurrentUser()).toBeNull();
    const res = await withAuth(GET("/api/students"), async () => new Response("ok"));
    expect(res.status).toBe(401);
  });

  it("a database failure during session lookup denies rather than admits", async () => {
    await signIn(WORLD.teacherA);
    fake.instance?.setHandler(() => {
      throw new Error("connection lost");
    });
    // getCurrentUser swallows and returns null => 401, never an authenticated
    // fallback. Fail closed.
    expect(await getCurrentUser()).toBeNull();
    const res = await withAuth(GET("/api/students"), async () => new Response("ok"));
    expect(res.status).toBe(401);
  });
});

/* ------------------------------------------------------------------ */
/* 10. Cross-tenant                                                    */
/* ------------------------------------------------------------------ */

describe("matrix · tenant boundaries", () => {
  it("a teacher cannot reach a learner in another institution (403)", async () => {
    expectUserLookup(WORLD.studentB);
    await expect(assertStudentAccess(WORLD.teacherA as User, WORLD.studentB.id)).rejects.toMatchObject({
      status: 403,
    });
  });

  it("a teacher can reach a learner in their own institution", async () => {
    expectUserLookup(WORLD.studentA);
    await expect(assertStudentAccess(WORLD.teacherA as User, WORLD.studentA.id)).resolves.toMatchObject({
      id: WORLD.studentA.id,
    });
  });

  it("a student cannot reach another student, even in the same tenant (403)", async () => {
    expectUserLookup(WORLD.studentA2);
    await expect(assertStudentAccess(WORLD.studentA as User, WORLD.studentA2.id)).rejects.toMatchObject({
      status: 403,
    });
  });

  it("a platform admin crosses tenants by design", async () => {
    expectUserLookup(WORLD.studentB);
    await expect(assertStudentAccess(WORLD.admin as User, WORLD.studentB.id)).resolves.toBeTruthy();
  });

  it("a missing learner is 404, not 403 (no existence oracle inversion)", async () => {
    expectUserLookup(undefined);
    await expect(assertStudentAccess(WORLD.teacherA as User, 12345)).rejects.toMatchObject({ status: 404 });
  });

  it("an institution admin cannot administer another institution (403)", async () => {
    await expect(assertInstitutionAccess(WORLD.instAdminA as User, TENANT_B)).rejects.toMatchObject({
      status: 403,
    });
    await expect(assertInstitutionAccess(WORLD.instAdminA as User, TENANT_A)).resolves.toBeUndefined();
    await expect(assertInstitutionAccess(WORLD.admin as User, TENANT_B)).resolves.toBeUndefined();
  });

  it("an institution admin cannot act on a platform administrator", async () => {
    expectUserLookup(WORLD.admin);
    await expect(
      assertUserAccess(WORLD.instAdminA as User, WORLD.admin.id, { write: true }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("a cross-tenant institution admin cannot manage another tenant's staff", async () => {
    expectUserLookup(WORLD.teacherA);
    await expect(
      assertUserAccess(WORLD.instAdminB as User, WORLD.teacherA.id, { write: true }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("anyone may read their own account", async () => {
    expectUserLookup(WORLD.studentA);
    await expect(assertUserAccess(WORLD.studentA as User, WORLD.studentA.id)).resolves.toBeTruthy();
  });
});

/* ------------------------------------------------------------------ */
/* 11-12. Protected vs public API                                      */
/* ------------------------------------------------------------------ */

describe("matrix · API behaviour", () => {
  it("protected API: authenticated request runs, CSRF is enforced on mutations", async () => {
    await signIn(WORLD.teacherA);
    const allowed = await withAuth(POST("/api/students", { body: { name: "x" } }), async () =>
      Response.json({ created: true }),
    );
    expect(allowed.status).toBe(200);

    const blocked = await withAuth(
      POST("/api/students", { body: { name: "x" }, crossSite: true }),
      async () => Response.json({ created: true }),
    );
    expect(blocked.status).toBe(403);
    expect(await readJson<{ error: string }>(blocked)).toEqual({ error: "Cross-origin request blocked." });
  });

  it("protected API: a cross-site GET is still allowed (no state change)", async () => {
    await signIn(WORLD.teacherA);
    const res = await withAuth(GET("/api/students", { crossSite: true }), async () => Response.json({ ok: true }));
    expect(res.status).toBe(200);
  });

  it("public API: reachable without a session, still CSRF-guarded", async () => {
    const res = await guardPublic(POST("/api/auth", { body: {} }), async () => Response.json({ ok: true }));
    expect(res.status).toBe(200);

    const blocked = await guardPublic(POST("/api/auth", { body: {}, crossSite: true }), async () =>
      Response.json({ ok: true }),
    );
    expect(blocked.status).toBe(403);
  });

  it("internal errors never leak details to the client", async () => {
    await signIn(WORLD.teacherA);
    const res = await withAuth(GET("/api/students"), async () => {
      throw new Error("SELECT * FROM users WHERE secret='hunter2'");
    });
    expect(res.status).toBe(500);
    const body = await readJson<{ error: string }>(res);
    expect(body.error).toBe("Something went wrong. Please try again.");
    expect(JSON.stringify(body)).not.toContain("hunter2");
  });

  it("every response carries a correlation id", async () => {
    const res = await withAuth(GET("/api/students"), async () => new Response("ok"));
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ */
/* 13-14. Login & registration                                         */
/* ------------------------------------------------------------------ */

describe("matrix · login", () => {
  it("valid credentials establish a session", async () => {
    expectUserLookup({ ...WORLD.studentA, passwordHash } as Row);
    const res = await authPOST(
      POST("/api/auth", { body: { action: "login", email: "user-10@example.test", password: PASSWORD } }),
    );
    expect(res.status).toBe(200);
    expect(await readJson<{ user: { role: string } }>(res)).toMatchObject({ user: { role: "student" } });
    expect(__getCookie("adaptiq_session")).toBeTruthy();
  });

  it("wrong password is refused with a generic message and no session", async () => {
    expectUserLookup({ ...WORLD.studentA, passwordHash } as Row);
    const res = await authPOST(
      POST("/api/auth", { body: { action: "login", email: "user-10@example.test", password: "wrong-password" } }),
    );
    expect(res.status).toBe(401);
    expect(await readJson<{ error: string }>(res)).toEqual({
      error: "Those credentials did not match our records.",
    });
    expect(__getCookie("adaptiq_session")).toBeUndefined();
  });

  it("an unknown email is indistinguishable from a wrong password", async () => {
    expectUserLookup(undefined);
    const res = await authPOST(
      POST("/api/auth", { body: { action: "login", email: "nobody@example.test", password: PASSWORD } }),
    );
    expect(res.status).toBe(401);
    expect(await readJson<{ error: string }>(res)).toEqual({
      error: "Those credentials did not match our records.",
    });
  });

  it("a suspended account cannot sign in even with correct credentials", async () => {
    expectUserLookup({ ...WORLD.suspended, passwordHash } as Row);
    const res = await authPOST(
      POST("/api/auth", { body: { action: "login", email: "user-60@example.test", password: PASSWORD } }),
    );
    expect(res.status).toBe(403);
    expect((await readJson<{ error: string }>(res)).error).toMatch(/suspended/i);
    expect(__getCookie("adaptiq_session")).toBeUndefined();
  });

  it("login is CSRF-guarded like any other mutation", async () => {
    const res = await authPOST(
      POST("/api/auth", {
        body: { action: "login", email: "user-10@example.test", password: PASSWORD },
        crossSite: true,
      }),
    );
    expect(res.status).toBe(403);
  });
});

describe("matrix · registration", () => {
  it("self-registration creates a student and ignores a requested privileged role", async () => {
    expectUserLookup(undefined); // email not taken
    const res = await authPOST(
      POST("/api/auth", {
        body: {
          action: "register",
          name: "New Learner",
          email: "fresh@example.test",
          password: PASSWORD,
          role: "admin",
          institutionId: 1,
        },
      }),
    );
    expect(res.status).toBe(201);

    const insert = fake.instance?.log.find((q) => q.kind === "insert" && q.table === users);
    const values = insert?.values as { role: string; institutionId: number | null };
    expect(values.role).toBe(PUBLIC_SIGNUP_ROLE);
    expect(values.role).toBe("student");
    expect(PRIVILEGED_ROLES).not.toContain(values.role);
    // Self-registered learners are unaffiliated; a client cannot join a tenant.
    expect(values.institutionId).toBeNull();
  });

  it("a duplicate email is refused with 409", async () => {
    expectUserLookup(WORLD.studentA);
    const res = await authPOST(
      POST("/api/auth", {
        body: { action: "register", name: "Dup", email: "user-10@example.test", password: PASSWORD },
      }),
    );
    expect(res.status).toBe(409);
  });

  it("a weak password is rejected before any account is created", async () => {
    expectUserLookup(undefined);
    fake.instance?.reset();
    const res = await authPOST(
      POST("/api/auth", {
        body: { action: "register", name: "Weak", email: "weak@example.test", password: "short" },
      }),
    );
    expect(res.status).toBe(400);
    expect(fake.instance?.log.some((q) => q.kind === "insert" && q.table === users)).toBe(false);
  });
});
