import { ActionButton } from "@/components/action-button";
import { QuestionBank } from "@/components/questions-client";
import { Card, CardHeader, StatCard } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { getModelRegistry, getQuestionBank, getSkillCatalog, getStudentOptions } from "@/lib/queries";
import { pct } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function QuestionsPage() {
  const [user, questions, skills, learners, models] = await Promise.all([
    requireUser(),
    getQuestionBank(),
    getSkillCatalog(),
    getStudentOptions(),
    getModelRegistry(),
  ]);

  const classifier = models.find((model) => model.kind === "classifier");
  const attempted = questions.filter((question) => question.attempts > 0);
  const meanAccuracy = attempted.length ? attempted.reduce((acc, question) => acc + question.pCorrect, 0) / attempted.length : 0;
  const coverage = skills.length ? skills.filter((skill) => skill.questionCount > 0).length / skills.length : 0;

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Items in bank" value={questions.length} delta={`${skills.length} skills`} tone="violet" icon="?" />
        <StatCard label="Skill coverage" value={pct(coverage)} delta={`${skills.filter((s) => s.questionCount === 0).length} uncovered`} tone="sky" icon="▤" />
        <StatCard label="Mean item accuracy" value={pct(meanAccuracy)} delta={`${attempted.length} items with responses`} tone="emerald" icon="✓" />
        <StatCard
          label="Classifier accuracy"
          value={classifier ? pct(classifier.metrics.accuracy ?? 0) : "untrained"}
          delta={classifier ? `AUC ${(classifier.metrics.auc ?? 0).toFixed(3)} · ${classifier.samples} samples` : "retrain to initialise"}
          tone="amber"
          icon="⚙"
        />
      </div>

      <Card>
        <CardHeader
          title="Question bank & difficulty prediction"
          subtitle="Author items, then simulate predicted success for any learner before you assign them"
          action={
            <div className="flex gap-2">
              <ActionButton
                label="Retrain classifier"
                url="/api/ml"
                body={{ action: "train" }}
                successMessage="Classifier retrained on latest responses"
                variant="secondary"
                size="sm"
              />
              <ActionButton
                label="Check calibration"
                url="/api/ml"
                body={{ action: "evaluate" }}
                successMessage="Calibration evaluated — see toasts and AI models page"
                variant="secondary"
                size="sm"
              />
            </div>
          }
        />
        <div className="mt-4">
          <QuestionBank questions={questions} skills={skills} learners={learners} canEdit={user.role !== "student"} />
        </div>
      </Card>
    </div>
  );
}
