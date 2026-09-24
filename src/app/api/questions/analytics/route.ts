import { db } from "@/db";
import { assessmentItems } from "@/db/schema";
import { sql } from "drizzle-orm";
import { ok, toNumber, withAuth } from "@/lib/api";
import { readJsonBody } from "@/lib/validation";
import { requireCapability } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";
import { computeAndPersistItemStatistics } from "@/lib/questions/analytics";
import { getQuestionBank, getQuestionBankAnalytics } from "@/lib/queries";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withAuth(request, async ({ user }) => {
    requireCapability(user, "manageContent", "You do not have permission to view item analytics.", "questions.analytics");
    const analytics = await getQuestionBankAnalytics();
    return ok({ analytics });
  });
}

export async function POST(request: Request) {
  return withAuth(request, async ({ user, ip }) => {
    requireCapability(user, "manageContent", "Learners cannot run item analytics.", "questions.analytics");
    const body = await readJsonBody(request);
    const questionId = toNumber(body.questionId, 0) || undefined;

    const [{ total } = { total: 0 }] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(assessmentItems);

    const report = await computeAndPersistItemStatistics({ questionId });
    const [questions, analytics] = await Promise.all([getQuestionBank(), getQuestionBankAnalytics()]);

    await recordAudit({
      actor: user,
      action: "questions.analytics",
      resource: "questions",
      resourceId: questionId,
      ip,
      detail: `${report.itemsUpdated} items · ${Number(total)} responses`,
    });

    return ok({ report, analytics, questions });
  });
}
