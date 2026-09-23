import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { createSession, destroySession, hashPassword, verifyPassword } from "@/lib/auth";
import { fail, ok } from "@/lib/api";
import { ensureSeededSafe } from "@/lib/seed";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const AVATAR_COLORS = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ec4899", "#8b5cf6"];

export async function POST(request: Request) {
  await ensureSeededSafe();
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return fail("Invalid JSON payload");
  }

  const action = String(body.action ?? "login");

  if (action === "logout") {
    await destroySession();
    return ok({ signedOut: true });
  }

  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");

  if (action === "register") {
    const name = String(body.name ?? "").trim();
    if (!name || !email || password.length < 6) {
      return fail("Name, email and a password of at least 6 characters are required.");
    }
    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (existing.length) return fail("An account with that email already exists.", 409);

    const role = ["student", "teacher", "trainer", "institution", "admin"].includes(String(body.role))
      ? String(body.role)
      : "student";

    const [created] = await db
      .insert(users)
      .values({
        name,
        email,
        passwordHash: hashPassword(password),
        role,
        gradeLevel: body.gradeLevel ? String(body.gradeLevel) : role === "student" ? "Grade 10" : null,
        cohort: body.cohort ? String(body.cohort) : "New Cohort",
        goal: body.goal ? String(body.goal) : "Build a personalised mastery plan",
        institutionId: body.institutionId ? Number(body.institutionId) : null,
        avatarColor: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)],
      })
      .returning();

    await createSession(created.id);
    return ok({ user: { id: created.id, name: created.name, role: created.role } }, 201);
  }

  if (!email || !password) return fail("Email and password are required.");
  const rows = await db.select().from(users).where(eq(users.email, email)).limit(1);
  const user = rows[0];
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return fail("Those credentials did not match our records.", 401);
  }
  if (user.status === "suspended") return fail("This account is suspended. Contact your administrator.", 403);

  await createSession(user.id);
  return ok({ user: { id: user.id, name: user.name, role: user.role } });
}
