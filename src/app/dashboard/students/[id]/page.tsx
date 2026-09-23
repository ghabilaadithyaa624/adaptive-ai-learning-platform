import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionButton } from "@/components/action-button";
import { AddLearnerButton, LearnerRowActions } from "@/components/learner-admin";
import { StudentOverview } from "@/components/student-overview";
import { buttonClass, Card, CardHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { getInstitutionList, getStudentDetail } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function StudentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const [user, resolved] = await Promise.all([requireUser(), params]);
  const detail = await getStudentDetail(Number(resolved.id));
  if (!detail) notFound();
  const institutionList = await getInstitutionList();
  const isSelf = user.id === detail.student.id;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title={isSelf ? "My learning profile" : `Learner profile · ${detail.student.name}`}
          subtitle="Full mastery, gap, path and forecast view generated from live knowledge tracing"
          action={
            <div className="flex flex-wrap gap-2">
              <Link className={buttonClass("secondary", "sm")} href="/dashboard/students">
                Back to directory
              </Link>
              <ActionButton
                label="Start adaptive quiz"
                url="/api/assessments"
                body={{ studentId: detail.student.id, mode: "adaptive_quiz", itemTarget: 8 }}
                successMessage="Adaptive quiz queued"
                variant="primary"
                size="sm"
              />
              <AddLearnerButton institutions={institutionList} canInvite={!isSelf && user.role !== "student"} />
            </div>
          }
        />
        {isSelf ? null : (
          <div className="mt-3">
            <LearnerRowActions
              learner={{
                id: detail.student.id,
                name: detail.student.name,
                email: detail.student.email,
                gradeLevel: detail.student.gradeLevel,
                cohort: detail.student.cohort,
                goal: detail.student.goal,
                avatarColor: detail.student.avatarColor,
                institutionId: detail.student.institutionId,
                status: detail.student.status,
              }}
              institutions={institutionList}
              canDelete={user.role === "admin" || user.role === "institution"}
              label="Edit profile"
            />
          </div>
        )}
      </Card>

      <StudentOverview detail={detail} isSelf={isSelf} />
    </div>
  );
}
