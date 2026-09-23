import { ModelsWorkbench } from "@/components/models-client";
import { Card, CardHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { getModelRegistry, getQuestionBank, getStudentOptions } from "@/lib/queries";
import { db } from "@/db";
import { assessmentItems } from "@/db/schema";
import { sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

export default async function ModelsPage() {
  const [, models, learners, questions, sampleRows] = await Promise.all([
    requireUser(),
    getModelRegistry(),
    getStudentOptions(),
    getQuestionBank(),
    db.select({ total: sql<number>`count(*)::int` }).from(assessmentItems),
  ]);

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="AI models & continuous learning"
          subtitle="Knowledge tracing state, the difficulty classifier (logistic regression) and the recommendation scorer — inspect metrics, retrain on live telemetry and score what-if scenarios"
        />
      </Card>
      <ModelsWorkbench
        models={models}
        learners={learners}
        questions={questions.map((question) => ({ id: question.id, stem: question.stem, skillName: question.skillName }))}
        trainingSamples={Number(sampleRows[0]?.total ?? 0)}
      />
    </div>
  );
}
