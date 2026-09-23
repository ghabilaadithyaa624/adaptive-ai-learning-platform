import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { fail, ok, toNumber, withUser } from "@/lib/api";
import { hashPassword } from "@/lib/auth";
import { getUserDirectory } from "@/lib/queries";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withUser(async () => {
    const url = new URL(request.url);
    const search = url.searchParams.get("q") ?? undefined;
    const directory = await getUserDirectory(search);
    return ok({ users: directory });
  });
}

export async function POST(request: Request) {
  return withUser(async (user) => {
    if (user.role !== "admin" && user.role !== "institution") {
      return fail("Only administrators can invite new accounts.", 403);
    }
    const body = (await request.json()) as Record<string, unknown>;
    const name = String(body.name ?? "").trim();
    const email = String(body.email ?? "").trim().toLowerCase();
    if (!name || !email) return fail("Name and email are required.");
    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (existing.length) return fail("That email is already registered.", 409);

    const role = ["student", "teacher", "trainer", "institution", "admin"].includes(String(body.role))
      ? String(body.role)
      : "student";

    const [created] = await db
      .insert(users)
      .values({
        name,
        email,
        passwordHash: hashPassword(String(body.password ?? "password123")),
        role,
        status: String(body.status ?? "active"),
        cohort: body.cohort ? String(body.cohort) : null,
        gradeLevel: body.gradeLevel ? String(body.gradeLevel) : null,
        institutionId: body.institutionId ? toNumber(body.institutionId, 0) || null : user.institutionId,
        avatarColor: String(body.avatarColor ?? "#6366f1"),
      })
      .returning();
    return ok({ user: created }, 201);
  });
}
