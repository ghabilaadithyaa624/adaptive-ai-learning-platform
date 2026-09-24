import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { ok, toNumber, withAuth } from "@/lib/api";
import { hashPassword } from "@/lib/auth";
import { getUserDirectory } from "@/lib/queries";
import { conflict, forbidden } from "@/lib/http";
import { oneOf, optString, readJsonBody, reqEmail, reqString, validatePassword } from "@/lib/validation";
import { ROLES, isPlatformAdmin, requireCapability } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withAuth(request, async ({ user }) => {
    // The user directory exposes every account's email/role — restrict to
    // account admins and scope institution admins to their own tenant.
    requireCapability(user, "manageStaff", "You do not have permission to view the user directory.", "users.list");
    const url = new URL(request.url);
    const search = url.searchParams.get("q") ?? undefined;
    const institutionId = isPlatformAdmin(user) ? undefined : user.institutionId ?? -1;
    const directory = await getUserDirectory(search, institutionId ?? undefined);
    return ok({ users: directory });
  });
}

export async function POST(request: Request) {
  return withAuth(request, async ({ user, ip }) => {
    requireCapability(user, "manageStaff", "Only administrators can invite new accounts.", "users.create");
    const body = await readJsonBody(request);
    const name = reqString(body.name, "Name", { max: 120 });
    const email = reqEmail(body.email);
    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (existing.length) throw conflict("That email is already registered.");

    const role = oneOf(body.role, ROLES, "role", "student");
    // Privilege-escalation guard: institution admins cannot mint platform admins.
    if (role === "admin" && !isPlatformAdmin(user)) {
      throw forbidden("Only a platform administrator can create administrator accounts.", "users.create");
    }

    // Tenant isolation: institution admins can only create accounts inside their
    // own institution. Platform admins may target any institution.
    let institutionId: number | null;
    if (isPlatformAdmin(user)) {
      institutionId = body.institutionId ? toNumber(body.institutionId, 0) || null : null;
    } else {
      const requested = body.institutionId ? toNumber(body.institutionId, 0) || null : null;
      if (requested != null && requested !== user.institutionId) {
        throw forbidden("You can only create accounts within your own institution.", "users.create");
      }
      institutionId = user.institutionId ?? null;
    }

    const password = body.password === undefined ? "Password123" : validatePassword(body.password);
    const [created] = await db
      .insert(users)
      .values({
        name,
        email,
        passwordHash: hashPassword(password),
        role,
        status: oneOf(body.status, ["active", "invited", "suspended"] as const, "status", "active"),
        cohort: optString(body.cohort, "cohort", { max: 120 }) ?? null,
        gradeLevel: optString(body.gradeLevel, "gradeLevel", { max: 60 }) ?? null,
        institutionId,
        avatarColor: optString(body.avatarColor, "avatarColor", { max: 16 }) ?? "#6366f1",
      })
      .returning();
    await recordAudit({
      actor: user,
      action: "users.create",
      resource: "users",
      resourceId: created.id,
      institutionId,
      ip,
      detail: `role=${role}`,
    });
    const { passwordHash: _hash, ...safe } = created;
    void _hash;
    return ok({ user: safe }, 201);
  });
}
