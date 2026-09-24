import { QuestionBank } from "@/components/questions-client";
import { Card, CardHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { getQuestionBank, getQuestionBankAnalytics, getSkillCatalog, getStudentOptions } from "@/lib/queries";
import { requireStaffPage, institutionScopeId } from "@/lib/page-guards";

export const dynamic = "force-dynamic";

export default async function QuestionsPage() {
  const user = await requireUser();
  // The question bank contains answer keys — staff only.
  requireStaffPage(user);
  const [questions, skills, learners, analytics] = await Promise.all([
    getQuestionBank(),
    getSkillCatalog(),
    getStudentOptions(institutionScopeId(user)),
    getQuestionBankAnalytics(),
  ]);

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="Item bank & psychometrics"
          subtitle="Author, validate and calibrate items through the Draft → Review → Validated → Published → Monitored → Retired workflow — with item-quality analytics from observed responses"
        />
        <div className="mt-4">
          <QuestionBank
            questions={questions}
            skills={skills}
            learners={learners}
            canEdit={user.role !== "student"}
            analytics={analytics}
          />
        </div>
      </Card>
    </div>
  );
}
