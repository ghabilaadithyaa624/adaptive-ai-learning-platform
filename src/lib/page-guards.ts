/**
 * Server-side authorization guards for React Server Component pages.
 *
 * Pages must enforce access server-side (never rely on hidden UI). These share
 * the same policy source of truth as the API layer (`lib/authz`).
 */
import { notFound, redirect } from "next/navigation";
import type { User } from "@/db/schema";
import {
  canAccessStudent,
  isAccountAdmin,
  isPlatformAdmin,
  isStaff,
  isStudent,
  studentScope,
} from "@/lib/authz";
import { getInstitutionList, listStudents } from "@/lib/queries";

/** Redirect non-staff away from staff-only pages. */
export function requireStaffPage(user: User) {
  if (!isStaff(user)) redirect("/dashboard");
}

/** Redirect non-account-admins away from administration pages. */
export function requireAccountAdminPage(user: User) {
  if (!isAccountAdmin(user)) redirect("/dashboard");
}

/** 404 if the caller may not view the given student's data. */
export async function requireStudentPageAccess(user: User, studentId: number) {
  if (!Number.isInteger(studentId) || studentId < 1) notFound();
  const allowed = await canAccessStudent(user, studentId);
  if (!allowed) notFound();
}

/**
 * The learner directory a page may show, scoped to the caller's tenant.
 * Students get an empty list (they use their own profile page).
 */
export async function scopedLearners(user: User, search?: string) {
  if (isStudent(user)) return [];
  const scope = studentScope(user);
  if (scope.kind === "all") return listStudents(search);
  if (scope.kind === "institution") return listStudents(search, scope.institutionId);
  return [];
}

/**
 * Resolve which student a page should focus on. Students are pinned to
 * themselves; staff must have access to any requested learner (else 404).
 */
export async function resolveFocusStudent(user: User, requested?: number): Promise<number | undefined> {
  if (isStudent(user)) return user.id;
  if (!requested) return undefined;
  const allowed = await canAccessStudent(user, requested);
  if (!allowed) notFound();
  return requested;
}

/** Institution list scoped to the caller (platform admin => all). */
export async function scopedInstitutions(user: User) {
  if (isPlatformAdmin(user)) return getInstitutionList();
  if (isAccountAdmin(user) && user.institutionId != null) return getInstitutionList(user.institutionId);
  if (isStaff(user) && user.institutionId != null) return getInstitutionList(user.institutionId);
  return [];
}

export function institutionScopeId(user: User) {
  return isPlatformAdmin(user) ? undefined : user.institutionId ?? -1;
}
