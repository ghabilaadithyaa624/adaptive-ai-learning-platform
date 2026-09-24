import { eq } from "drizzle-orm";
import { db } from "@/db";
import { recommendations } from "@/db/schema";
import { ok, withAuth } from "@/lib/api";
import { logActivity } from "@/lib/queries";
import { badRequest } from "@/lib/http";
import { oneOf, parseId, readJsonBody } from "@/lib/validation";
import { assertRecommendationAccess, requireCapability } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  return withAuth(request, async ({ user, ip }) => {
    requireCapability(user, "manageRecommendations", "Learners cannot change the queue directly.", "recommendations.update");
    const { id } = await params;
    const recId = parseId(id);
    await assertRecommendationAccess(user, recId, "recommendations.update");

    const body = await readJsonBody(request);
    const status = oneOf(body.status, ["new", "accepted", "dismissed", "completed"] as const, "status");

    const [updated] = await db
      .update(recommendations)
      .set({ status, actedAt: status === "new" ? null : new Date() })
      .where(eq(recommendations.id, recId))
      .returning();
    if (!updated) throw badRequest("Recommendation not found.");
    await logActivity({
      studentId: updated.studentId,
      type: "recommendation",
      skillId: updated.skillId,
      summary: `Priority “${updated.title}” marked ${status}`,
      value: updated.priority,
    });
    await recordAudit({ actor: user, action: "recommendations.update", resource: "recommendations", resourceId: recId, ip });
    return ok({ recommendation: updated });
  });
}

export async function DELETE(request: Request, { params }: Params) {
  return withAuth(request, async ({ user, ip }) => {
    requireCapability(user, "manageRecommendations", "Learners cannot delete priorities.", "recommendations.delete");
    const { id } = await params;
    const recId = parseId(id);
    await assertRecommendationAccess(user, recId, "recommendations.delete");
    await db.delete(recommendations).where(eq(recommendations.id, recId));
    await recordAudit({ actor: user, action: "recommendations.delete", resource: "recommendations", resourceId: recId, ip });
    return ok({ deleted: true });
  });
}
