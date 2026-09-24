import { ActionButton } from "@/components/action-button";
import { AssessmentTable, StartAssessmentButton } from "@/components/assessments-client";
import { LearnerFilter } from "@/components/learner-filter";
import { Card, CardHeader, StatCard } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { listAssessments } from "@/lib/queries";
import { resolveFocusStudent, scopedLearners } from "@/lib/page-guards";
import { accessibleStudentIds } from "@/lib/authz";
import { pct } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function AssessmentsPage({
  searchParams,
}: {
  searchParams: Promise<{ studentId?: string }>;
}) {
  const [user, params] = await Promise.all([requireUser(), searchParams]);
  const requested = params.studentId ? Number(params.studentId) : undefined;
  const studentId = await resolveFocusStudent(user, requested);
  const scopeIds = await accessibleStudentIds(user);
  const [assessments, learners] = await Promise.all([
    studentId ? listAssessments(studentId, 60) : listAssessments(undefined, 60, scopeIds ?? undefined),
    scopedLearners(user),
  ]);

  const live = assessments.filter((assessment) => assessment.status === "in_progress");
  const completed = assessments.filter((assessment) => assessment.status === "completed");
  const avgScore = completed.length ? completed.reduce((acc, row) => acc + (row.score ?? 0), 0) / completed.length : 0;
  const predicted = completed.filter((row) => row.predictedScore !== null);
  const calibration = predicted.length
    ? predicted.reduce((acc, row) => acc + Math.abs((row.predictedScore ?? 0) - (row.score ?? 0)), 0) / predicted.length
    : 0;

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Sessions" value={assessments.length} delta={`${live.length} in progress`} tone="violet" icon="✎" />
        <StatCard label="Average score" value={pct(avgScore)} delta={`${completed.length} completed`} tone="sky" icon="✓" />
        <StatCard
          label="Forecast calibration"
          value={pct(Math.max(0, 1 - calibration))}
          delta={`mean |error| ${(calibration * 100).toFixed(1)} pts`}
          hint="Gap between predicted and realised session scores"
          tone="emerald"
          icon="▲"
        />
        <StatCard
          label="Live item selection"
          value="ZPD"
          delta="targeted p(correct) ≈ 0.75"
          hint="Items are chosen to maximise information gain"
          tone="amber"
          icon="◎"
        />
      </div>

      <Card>
        <CardHeader
          title="Adaptive quiz sessions"
          subtitle="Diagnostic checkpoints, adaptive quizzes and targeted practice sets"
          action={
            <div className="flex flex-wrap items-center gap-2">
              {user.role !== "student" ? (
                <LearnerFilter learners={learners} basePath="/dashboard/assessments" current={requested} />
              ) : null}
              <ActionButton
                label="Refresh priorities"
                url="/api/recommendations"
                body={{ studentId: studentId ?? learners[0]?.id }}
                successMessage="Priorities refreshed"
                variant="secondary"
                size="sm"
              />
              <StartAssessmentButton learners={learners} defaultStudentId={studentId} canPickLearner={user.role !== "student"} />
            </div>
          }
        />
        <div className="mt-4">
          <AssessmentTable assessments={assessments} showLearner={user.role !== "student"} canManage={user.role !== "student"} />
        </div>
      </Card>
    </div>
  );
}
