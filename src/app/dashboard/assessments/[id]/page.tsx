import Link from "next/link";
import { notFound } from "next/navigation";
import { AssessmentTable } from "@/components/assessments-client";
import { Avatar, Badge, buttonClass, Card, CardHeader, EmptyState, KeyValue, ProgressBar } from "@/components/ui";
import { QuizRunner } from "@/components/quiz-runner";
import { requireUser } from "@/lib/auth";
import { computeNextSessionQuestion } from "@/lib/engine";
import { getAssessment, listAssessments } from "@/lib/queries";
import { formatRelative, pct } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function AssessmentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const [user, resolved] = await Promise.all([requireUser(), params]);
  const assessmentId = Number(resolved.id);
  const detail = await getAssessment(assessmentId);
  if (!detail) notFound();
  if (user.role === "student" && detail.assessment.studentId !== user.id) notFound();

  const answered = detail.items.filter((item) => item.studentAnswer !== null);
  const correct = answered.filter((item) => item.isCorrect).length;
  const inProgress = detail.assessment.status === "in_progress";
  const next = inProgress ? await computeNextSessionQuestion(assessmentId) : null;
  const others = (await listAssessments(detail.assessment.studentId, 6)).filter((row) => row.id !== assessmentId);

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title={detail.assessment.title}
          subtitle={`${detail.studentName} · ${detail.assessment.mode.replace("_", " ")} · started ${formatRelative(detail.assessment.startedAt)}`}
          action={
            <div className="flex flex-wrap gap-2">
              <Badge tone={inProgress ? "amber" : detail.assessment.status === "completed" ? "emerald" : "slate"}>
                {detail.assessment.status.replace("_", " ")}
              </Badge>
              <Link className={buttonClass("secondary", "sm")} href="/dashboard/assessments">
                All sessions
              </Link>
              <Link className={buttonClass("ghost", "sm")} href={`/dashboard/students/${detail.assessment.studentId}`}>
                Learner profile
              </Link>
            </div>
          }
        />
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl border border-slate-200 p-3">
            <p className="text-[11px] uppercase tracking-wide text-slate-400">Answered</p>
            <p className="mt-1 text-lg font-semibold text-slate-900">
              {answered.length}/{detail.assessment.itemTarget}
            </p>
            <ProgressBar value={answered.length / Math.max(1, detail.assessment.itemTarget)} className="mt-2" />
          </div>
          <div className="rounded-xl border border-slate-200 p-3">
            <p className="text-[11px] uppercase tracking-wide text-slate-400">Score</p>
            <p className="mt-1 text-lg font-semibold text-slate-900">{answered.length ? pct(correct / answered.length) : "—"}</p>
            <p className="text-[11px] text-slate-500">{correct} correct of {answered.length}</p>
          </div>
          <div className="rounded-xl border border-slate-200 p-3">
            <p className="text-[11px] uppercase tracking-wide text-slate-400">Forecast</p>
            <p className="mt-1 text-lg font-semibold text-slate-900">
              {detail.assessment.predictedScore === null ? "—" : pct(detail.assessment.predictedScore)}
            </p>
            <p className="text-[11px] text-slate-500">{detail.assessment.forecastLabel ?? "awaiting sessions"}</p>
          </div>
          <div className="rounded-xl border border-slate-200 p-3">
            <p className="text-[11px] uppercase tracking-wide text-slate-400">Latent ability</p>
            <p className="mt-1 text-lg font-semibold text-slate-900">{pct(detail.assessment.ability)}</p>
            <p className="text-[11px] text-slate-500">updated after every response</p>
          </div>
        </div>
      </Card>

      {inProgress ? (
        <QuizRunner
          assessmentId={assessmentId}
          initialQuestion={next}
          initialProgress={{ answered: answered.length, total: detail.assessment.itemTarget, correct }}
          learnerName={detail.studentName}
          title={detail.assessment.title}
          mode={detail.assessment.mode}
        />
      ) : (
        <Card>
          <CardHeader title="Item-level review" subtitle="Model prediction versus realised outcome for each item" />
          {detail.items.length ? (
            <div className="mt-4 overflow-x-auto scrollbar-thin">
              <table className="w-full min-w-[780px] text-left text-xs">
                <thead className="text-[11px] uppercase tracking-wide text-slate-400">
                  <tr>
                    <th className="pb-2">#</th>
                    <th className="pb-2">Item</th>
                    <th className="pb-2">Skill</th>
                    <th className="pb-2">p̂ correct</th>
                    <th className="pb-2">Outcome</th>
                    <th className="pb-2">Mastery move</th>
                    <th className="pb-2">Time</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {detail.items.map((item) => (
                    <tr key={item.id}>
                      <td className="py-2 pr-3 text-slate-400">{item.sequence}</td>
                      <td className="max-w-[280px] py-2 pr-3">
                        <span className="line-clamp-2 text-slate-700">{item.stem}</span>
                        <span className="text-[11px] text-slate-400">{item.difficultyLabel} · {item.bloomLevel}</span>
                      </td>
                      <td className="py-2 pr-3 text-slate-500">{item.skillName}</td>
                      <td className="py-2 pr-3 text-slate-700">{pct(item.predictedCorrectProb)}</td>
                      <td className="py-2 pr-3">
                        {item.studentAnswer === null ? (
                          <Badge tone="slate">pending</Badge>
                        ) : (
                          <Badge tone={item.isCorrect ? "emerald" : "rose"}>{item.isCorrect ? "correct" : "incorrect"}</Badge>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-slate-600">
                        {pct(item.masteryBefore)} → {pct(item.masteryAfter)}
                        <span className={item.masteryAfter >= item.masteryBefore ? " text-emerald-600" : " text-rose-600"}>
                          {" "}
                          ({((item.masteryAfter - item.masteryBefore) * 100).toFixed(0)})
                        </span>
                      </td>
                      <td className="py-2 text-slate-500">{(item.responseTimeMs / 1000).toFixed(1)}s</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState icon="✎" title="No items recorded" description="This session was ended before any responses were logged." />
          )}
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Other sessions for this learner" subtitle="Compare forecast trajectories" />
          <div className="mt-4">
            <AssessmentTable assessments={others} showLearner={false} canManage={false} />
          </div>
        </Card>
        <Card>
          <CardHeader title="Learner context" subtitle="Snapshot used by the adaptive engine" />
          <div className="mt-3 flex items-center gap-3">
            <Avatar name={detail.studentName} color={detail.avatarColor} size={40} />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-slate-900">{detail.studentName}</p>
              <p className="text-[11px] text-slate-500">Focus skills: {detail.assessment.targetSkillIds.length}</p>
            </div>
          </div>
          <div className="mt-3 divide-y divide-slate-100">
            <KeyValue label="Item target" value={detail.assessment.itemTarget} />
            <KeyValue label="Completed" value={detail.assessment.completedAt ? formatRelative(detail.assessment.completedAt) : "in progress"} />
            <KeyValue
              label="Mean predicted p̂"
              value={
                answered.length
                  ? pct(answered.reduce((acc, item) => acc + item.predictedCorrectProb, 0) / answered.length)
                  : "—"
              }
            />
            <KeyValue
              label="Mean response time"
              value={
                answered.length
                  ? `${(answered.reduce((acc, item) => acc + item.responseTimeMs, 0) / answered.length / 1000).toFixed(1)}s`
                  : "—"
              }
            />
          </div>
        </Card>
      </div>
    </div>
  );
}
