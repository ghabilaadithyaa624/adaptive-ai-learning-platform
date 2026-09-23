import { eq } from "drizzle-orm";
import { db } from "@/db";
import { recommendations } from "@/db/schema";
import { fail, ok, withUser } from "@/lib/api";
import { logActivity } from "@/lib/queries";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  return withUser(async (user) => {
    if (user.role === "student") return fail("Learners cannot change the queue directly.", 403);
    const { id } = await params;
    const body = (await request.json()) as Record<string, unknown>;
    const status = String(body.status ?? "");
    if (!["new", "accepted", "dismissed", "completed"].includes(status)) return fail("Unsupported status.");

    const [updated] = await db
      .update(recommendations)
      .set({ status, actedAt: status === "new" ? null : new Date() })
      .where(eq(recommendations.id, Number(id)))
      .returning();
    if (!updated) return fail("Recommendation not found", 404);
    await logActivity({
      studentId: updated.studentId,
      type: "recommendation",
      skillId: updated.skillId,
      summary: `Priority “${updated.title}” marked ${status}`,
      value: updated.priority,
    });
    return ok({ recommendation: updated });
  });
}

export async function DELETE(_request: Request, { params }: Params) {
  return withUser(async (user) => {
    if (user.role === "student") return fail("Learners cannot delete priorities.", 403);
    const { id } = await params;
    await db.delete(recommendations).where(eq(recommendations.id, Number(id)));
    return ok({ deleted: true });
  });
}
