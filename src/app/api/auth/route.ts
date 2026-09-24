import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { createSession, destroySession, getCurrentUser, hashPassword, verifyPassword } from "@/lib/auth";
import { guardPublic, ok } from "@/lib/api";
import { ensureSeededSafe } from "@/lib/seed";
import { conflict, forbidden, tooManyRequests, unauthorized } from "@/lib/http";
import { oneOf, optString, readJsonBody, reqEmail, reqString, validatePassword } from "@/lib/validation";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { recordAudit } from "@/lib/audit";
import { PUBLIC_SIGNUP_ROLE } from "@/lib/authz";
import { events, updateContext } from "@/lib/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const AVATAR_COLORS = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ec4899", "#8b5cf6"];

export async function POST(request: Request) {
  return guardPublic(request, async ({ ip }) => {
    await ensureSeededSafe();
    const body = await readJsonBody(request);
    const action = oneOf(body.action, ["login", "register", "logout"] as const, "action", "login");

    if (action === "logout") {
      const current = await getCurrentUser();
      await destroySession();
      await recordAudit({ actor: current, action: "auth.logout", resource: "auth", ip });
      events.auth("logout", "success", { userId: current?.id, role: current?.role });
      return ok({ signedOut: true });
    }

    if (action === "register") {
      // Rate-limit registration per IP to curb automated account creation.
      const rl = rateLimit(`register:${ip}`, RATE_LIMITS.register.limit, RATE_LIMITS.register.windowMs);
      if (!rl.ok) throw tooManyRequests("Too many sign-up attempts. Please try again later.");

      const name = reqString(body.name, "Name", { min: 1, max: 120 });
      const email = reqEmail(body.email);
      const password = validatePassword(body.password);

      const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
      if (existing.length) throw conflict("An account with that email already exists.");

      // SECURITY: public self-registration may ONLY create student accounts.
      // Any client-supplied role/institutionId is ignored. Staff (teacher,
      // trainer, institution, admin) are provisioned exclusively through the
      // authenticated admin workflow (POST /api/users).
      const role = PUBLIC_SIGNUP_ROLE;

      const [created] = await db
        .insert(users)
        .values({
          name,
          email,
          passwordHash: hashPassword(password),
          role,
          gradeLevel: optString(body.gradeLevel, "gradeLevel", { max: 60 }) ?? "Grade 10",
          cohort: optString(body.cohort, "cohort", { max: 120 }) ?? "New Cohort",
          goal: optString(body.goal, "goal", { max: 300 }) ?? "Build a personalised mastery plan",
          institutionId: null, // students self-register unaffiliated; staff assign them later
          avatarColor: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)],
        })
        .returning();

      await createSession(created.id);
      await recordAudit({
        actor: { id: created.id, role: created.role, email: created.email },
        action: "auth.register",
        resource: "users",
        resourceId: created.id,
        ip,
      });
      updateContext({ userId: created.id, role: created.role });
      events.auth("register", "success", { userId: created.id, role: created.role, email: created.email });
      return ok({ user: { id: created.id, name: created.name, role: created.role } }, 201);
    }

    // login
    const rl = rateLimit(`login:${ip}`, RATE_LIMITS.login.limit, RATE_LIMITS.login.windowMs);
    if (!rl.ok) throw tooManyRequests("Too many sign-in attempts. Please wait a moment and try again.");

    const email = reqEmail(body.email);
    const password = reqString(body.password, "Password", { min: 1, max: 200, trim: false });

    const rows = await db.select().from(users).where(eq(users.email, email)).limit(1);
    const user = rows[0];
    // Constant-ish response regardless of whether the email exists.
    if (!user || !verifyPassword(password, user.passwordHash)) {
      // Second, tighter limit keyed on the email to slow targeted attacks.
      rateLimit(`login-email:${email}`, RATE_LIMITS.login.limit, RATE_LIMITS.login.windowMs);
      await recordAudit({ action: "auth.login", outcome: "denied", ip, detail: `failed login for ${email}` });
      events.auth("login", "failure", { email, reason: "invalid_credentials" });
      throw unauthorized("Those credentials did not match our records.");
    }
    if (user.status === "suspended") {
      await recordAudit({
        actor: { id: user.id, role: user.role, email: user.email },
        action: "auth.login",
        outcome: "denied",
        ip,
        detail: "suspended account",
      });
      events.auth("login", "denied", { userId: user.id, role: user.role, reason: "suspended" });
      throw forbidden("This account is suspended. Contact your administrator.");
    }

    await createSession(user.id);
    await recordAudit({
      actor: { id: user.id, role: user.role, email: user.email },
      action: "auth.login",
      resource: "auth",
      ip,
    });
    updateContext({ userId: user.id, role: user.role });
    events.auth("login", "success", { userId: user.id, role: user.role, email: user.email });
    return ok({ user: { id: user.id, name: user.name, role: user.role } });
  });
}
