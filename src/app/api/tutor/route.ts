import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { tutorInteractions } from "@/db/schema";
import { ok, toNumber, withAuth } from "@/lib/api";
import { runTutor } from "@/lib/tutor";
import { TUTOR_INTENTS, DIFFICULTY_REQUESTS, type DifficultyRequest, type TutorIntent } from "@/lib/tutor/types";
import { badRequest, notFound, tooManyRequests } from "@/lib/http";
import { oneOf, optString, parseId, readJsonBody } from "@/lib/validation";
import { assertStudentAccess, isStudent, resolveWritableStudentId } from "@/lib/authz";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** Tutor is a live LLM path — cap per-learner request rate. */
const TUTOR_RATE = { limit: 40, windowMs: 60_000 };

/**
 * GET /api/tutor?studentId=&limit= — recent tutor interactions for a learner
 * (the evaluable learning-event history). Students see only their own.
 */
export async function GET(request: Request) {
  return withAuth(request, async ({ user }) => {
    const url = new URL(request.url);
    const limit = Math.min(50, Math.max(1, toNumber(url.searchParams.get("limit"), 20)));
    const studentId = isStudent(user)
      ? user.id
      : (() => {
          const raw = url.searchParams.get("studentId");
          return raw ? Number(raw) : NaN;
        })();
    if (!Number.isInteger(studentId)) throw badRequest("A learner must be specified.");
    if (!isStudent(user)) await assertStudentAccess(user, studentId, "tutor.history");

    const rows = await db
      .select()
      .from(tutorInteractions)
      .where(eq(tutorInteractions.studentId, studentId))
      .orderBy(desc(tutorInteractions.createdAt))
      .limit(limit);
    return ok({
      interactions: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
    });
  });
}

/**
 * POST /api/tutor
 *   action=ask (default): run the tutor pipeline for one exchange.
 *   action=feedback:       record whether an interaction was helpful.
 */
export async function POST(request: Request) {
  return withAuth(request, async ({ user }) => {
    const body = await readJsonBody(request);
    const action = oneOf(body.action, ["ask", "feedback"] as const, "action", "ask");

    if (action === "feedback") {
      const interactionId = parseId(body.interactionId, "interactionId");
      if (typeof body.helpful !== "boolean") throw badRequest("helpful must be a boolean.");
      const rows = await db
        .select({ id: tutorInteractions.id, studentId: tutorInteractions.studentId })
        .from(tutorInteractions)
        .where(eq(tutorInteractions.id, interactionId))
        .limit(1);
      const row = rows[0];
      if (!row) throw notFound("Interaction not found.");
      // Only the learner (or authorized staff) may rate their own interaction.
      if (isStudent(user)) {
        if (row.studentId !== user.id) throw notFound("Interaction not found.");
      } else {
        await assertStudentAccess(user, row.studentId, "tutor.feedback");
      }
      await db
        .update(tutorInteractions)
        .set({ helpful: body.helpful })
        .where(and(eq(tutorInteractions.id, interactionId), eq(tutorInteractions.studentId, row.studentId)));
      return ok({ ok: true });
    }

    // ---- action=ask ----
    const studentId = await resolveWritableStudentId(
      user,
      body.studentId ? toNumber(body.studentId, 0) : undefined,
      "tutor.ask",
    );

    const rl = rateLimit(`tutor:${studentId}`, TUTOR_RATE.limit, TUTOR_RATE.windowMs);
    if (!rl.ok) throw tooManyRequests(`Tutor is busy — try again in ${rl.retryAfterSec}s.`);

    const intent = oneOf<TutorIntent>(body.intent, TUTOR_INTENTS, "intent");
    const difficulty = oneOf<DifficultyRequest>(body.difficulty, DIFFICULTY_REQUESTS, "difficulty", "auto");
    const message = optString(body.message, "message", { max: 2000 });
    const skillId = body.skillId !== undefined ? toNumber(body.skillId, 0) || undefined : undefined;
    const assessmentId = body.assessmentId !== undefined ? toNumber(body.assessmentId, 0) || undefined : undefined;
    const itemId = body.itemId !== undefined ? toNumber(body.itemId, 0) || undefined : undefined;

    // If tutoring is tied to an assessment, the caller must be able to access it.
    if (assessmentId) {
      const { assertAssessmentAccess } = await import("@/lib/authz");
      await assertAssessmentAccess(user, assessmentId, "tutor.ask");
    }

    const result = await runTutor({ studentId, intent, difficulty, message, skillId, assessmentId, itemId });
    if ("error" in result) throw badRequest(result.error);
    return ok(result, 201);
  });
}
