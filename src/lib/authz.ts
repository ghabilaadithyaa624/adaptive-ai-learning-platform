/**
 * Centralized authorization layer.
 *
 * This is the single source of truth for "who can do / see what". API routes
 * MUST NOT hand-roll role checks anymore — they call the predicates and
 * `assert*` helpers here. The `assert*` functions throw typed `HttpError`s
 * (403/404) that `withAuth` turns into safe responses + audit entries.
 *
 * Tenancy model
 * -------------
 *   - "admin"        = platform admin, GLOBAL scope (all institutions).
 *   - "institution"  = institution/tenant admin, scoped to their institutionId.
 *   - "teacher"/"trainer" = staff educators, scoped to their institutionId.
 *   - "student"      = can only ever access their own resources.
 *
 * A staff member with a null institutionId (other than the platform admin) has
 * NO tenant and therefore cannot access any student — fail closed.
 */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  assessments,
  learningPaths,
  masteryStates,
  pathMilestones,
  recommendations,
  users,
  type User,
} from "@/db/schema";
import { forbidden, notFound } from "@/lib/http";

export type Role = "student" | "teacher" | "trainer" | "institution" | "admin";

export const ROLES: Role[] = ["student", "teacher", "trainer", "institution", "admin"];
export const STAFF_ROLES: Role[] = ["teacher", "trainer", "institution", "admin"];
/** Roles that public self-registration is FORBIDDEN from creating. */
export const PRIVILEGED_ROLES: Role[] = ["teacher", "trainer", "institution", "admin"];
export const PUBLIC_SIGNUP_ROLE: Role = "student";

/* ----------------------------- role predicates ---------------------------- */

export function isStudent(user: Pick<User, "role">) {
  return user.role === "student";
}
export function isPlatformAdmin(user: Pick<User, "role">) {
  return user.role === "admin";
}
export function isInstitutionAdmin(user: Pick<User, "role">) {
  return user.role === "institution";
}
export function isEducator(user: Pick<User, "role">) {
  return user.role === "teacher" || user.role === "trainer";
}
export function isStaff(user: Pick<User, "role">) {
  return STAFF_ROLES.includes(user.role as Role);
}
/** Account/tenant administrators (can manage users, staff, institution config). */
export function isAccountAdmin(user: Pick<User, "role">) {
  return user.role === "admin" || user.role === "institution";
}

/* ------------------------------ capabilities ------------------------------ */

export const can = {
  manageStudents: (u: Pick<User, "role">) => isStaff(u),
  manageContent: (u: Pick<User, "role">) => isStaff(u), // questions + skills taxonomy
  reviewContent: (u: Pick<User, "role">) => isStaff(u), // review/validate/publish items in the workflow
  manageStaff: (u: Pick<User, "role">) => isAccountAdmin(u),
  manageInstitutions: (u: Pick<User, "role">) => isAccountAdmin(u),
  createInstitution: (u: Pick<User, "role">) => isPlatformAdmin(u),
  trainModels: (u: Pick<User, "role">) => isStaff(u),
  viewModels: (u: Pick<User, "role">) => isStaff(u),
  managePaths: (u: Pick<User, "role">) => isStaff(u),
  manageRecommendations: (u: Pick<User, "role">) => isStaff(u),
};

/** Assert a capability, throwing 403 (and recording an audit action) if absent. */
export function requireCapability(
  user: Pick<User, "role">,
  capability: keyof typeof can,
  message: string,
  auditAction?: string,
): void {
  if (!can[capability](user)) throw forbidden(message, auditAction);
}

/* --------------------------- tenant scope helpers ------------------------- */

export type StudentScope =
  | { kind: "all" } // platform admin
  | { kind: "self"; studentId: number } // student
  | { kind: "institution"; institutionId: number } // staff with a tenant
  | { kind: "none" }; // staff without a tenant -> sees nothing

export function studentScope(user: User): StudentScope {
  if (isPlatformAdmin(user)) return { kind: "all" };
  if (isStudent(user)) return { kind: "self", studentId: user.id };
  if (user.institutionId != null) return { kind: "institution", institutionId: user.institutionId };
  return { kind: "none" };
}

/**
 * Resolve the concrete set of student ids the user may access, or `null` when
 * the user has unrestricted (platform-admin) access. Used to scope list
 * endpoints server-side.
 */
export async function accessibleStudentIds(user: User): Promise<number[] | null> {
  const scope = studentScope(user);
  switch (scope.kind) {
    case "all":
      return null;
    case "self":
      return [scope.studentId];
    case "none":
      return [];
    case "institution": {
      const rows = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.role, "student"), eq(users.institutionId, scope.institutionId)));
      return rows.map((r) => r.id);
    }
  }
}

/* ------------------------- resource authorization ------------------------- */

type MinimalUser = { id: number; role: string; institutionId: number | null };

async function loadUser(userId: number): Promise<MinimalUser | null> {
  const rows = await db
    .select({ id: users.id, role: users.role, institutionId: users.institutionId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return rows[0] ?? null;
}

function shareTenant(actor: User, target: MinimalUser): boolean {
  return actor.institutionId != null && actor.institutionId === target.institutionId;
}

/**
 * Assert the caller may access the given STUDENT resource. Throws 404 if the
 * student does not exist and 403 on a cross-student / cross-tenant attempt.
 * Returns the resolved student row for convenience.
 */
export async function assertStudentAccess(
  actor: User,
  studentId: number,
  auditAction = "student.access",
): Promise<MinimalUser> {
  const target = await loadUser(studentId);
  if (!target || target.role !== "student") throw notFound("Learner not found.");

  if (isStudent(actor)) {
    if (actor.id !== studentId) throw forbidden("You can only access your own data.", auditAction);
    return target;
  }
  if (isPlatformAdmin(actor)) return target;
  if (isStaff(actor) && shareTenant(actor, target)) return target;

  throw forbidden("This learner is outside your institution.", auditAction);
}

/**
 * Assert the caller may access an arbitrary USER account (staff or student).
 * `write` requires account-admin privileges scoped to the same tenant (or
 * platform admin). Students may only read/update themselves.
 */
export async function assertUserAccess(
  actor: User,
  targetUserId: number,
  opts: { write?: boolean } = {},
  auditAction = "user.access",
): Promise<MinimalUser> {
  const target = await loadUser(targetUserId);
  if (!target) throw notFound("Account not found.");

  // Users may always read/update their own account (field-level limits enforced
  // by the route, e.g. self cannot change own role).
  if (actor.id === targetUserId) return target;

  if (isPlatformAdmin(actor)) return target;

  if (opts.write ? can.manageStaff(actor) : isStaff(actor)) {
    // Institution admins/staff are confined to their own tenant and can never
    // act on a platform admin account.
    if (target.role === "admin") throw forbidden("You cannot manage a platform administrator.", auditAction);
    if (shareTenant(actor, target)) return target;
  }

  throw forbidden("You do not have permission to access this account.", auditAction);
}

/** Assert the caller owns / administers the given institution. */
export async function assertInstitutionAccess(
  actor: User,
  institutionId: number,
  auditAction = "institution.access",
): Promise<void> {
  if (isPlatformAdmin(actor)) return;
  if (isInstitutionAdmin(actor) && actor.institutionId === institutionId) return;
  throw forbidden("This institution is outside your administration scope.", auditAction);
}

/**
 * Resolve + authorize a studentId supplied by the caller for a write/create.
 * Students are pinned to themselves regardless of the requested id; staff must
 * pass a student inside their tenant.
 */
export async function resolveWritableStudentId(
  actor: User,
  requestedStudentId: number | undefined,
  auditAction = "student.write",
): Promise<number> {
  if (isStudent(actor)) return actor.id;
  if (!requestedStudentId) throw forbidden("A learner must be specified.", auditAction);
  await assertStudentAccess(actor, requestedStudentId, auditAction);
  return requestedStudentId;
}

/* ----- ownership resolvers for nested resources (assessment/path/etc.) ----- */

export async function assertAssessmentAccess(actor: User, assessmentId: number, auditAction = "assessment.access") {
  const rows = await db
    .select({ id: assessments.id, studentId: assessments.studentId })
    .from(assessments)
    .where(eq(assessments.id, assessmentId))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound("Assessment not found.");
  await assertStudentAccess(actor, row.studentId, auditAction);
  return row;
}

export async function assertPathAccess(actor: User, pathId: number, auditAction = "path.access") {
  const rows = await db
    .select({ id: learningPaths.id, studentId: learningPaths.studentId })
    .from(learningPaths)
    .where(eq(learningPaths.id, pathId))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound("Path not found.");
  await assertStudentAccess(actor, row.studentId, auditAction);
  return row;
}

export async function assertMilestoneAccess(actor: User, milestoneId: number, auditAction = "milestone.access") {
  const rows = await db
    .select({ id: pathMilestones.id, pathId: pathMilestones.pathId })
    .from(pathMilestones)
    .where(eq(pathMilestones.id, milestoneId))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound("Milestone not found.");
  await assertPathAccess(actor, row.pathId, auditAction);
  return row;
}

export async function assertRecommendationAccess(
  actor: User,
  recommendationId: number,
  auditAction = "recommendation.access",
) {
  const rows = await db
    .select({ id: recommendations.id, studentId: recommendations.studentId })
    .from(recommendations)
    .where(eq(recommendations.id, recommendationId))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound("Recommendation not found.");
  await assertStudentAccess(actor, row.studentId, auditAction);
  return row;
}

/** True when `studentId` is within the caller's accessible set (no throw). */
export async function canAccessStudent(actor: User, studentId: number): Promise<boolean> {
  const ids = await accessibleStudentIds(actor);
  if (ids === null) return true;
  return ids.includes(studentId);
}

/** Utility for masteryStates ownership (used by ML predict). */
export async function assertMasteryOwner(actor: User, studentId: number) {
  await assertStudentAccess(actor, studentId, "ml.predict");
  // ensure the pairing exists is left to the caller
  void masteryStates;
  void inArray;
}
