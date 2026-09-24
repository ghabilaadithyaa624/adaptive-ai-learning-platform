import Link from "next/link";
import { ActionButton } from "@/components/action-button";
import { BarList } from "@/components/charts";
import { StudentOverview } from "@/components/student-overview";
import { Avatar, Badge, buttonClass, Card, CardHeader, EmptyState, ProgressBar, StatCard } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import {
  getActivity,
  getCohortSnapshot,
  getModelRegistry,
  getStudentDetail,
} from "@/lib/queries";
import { formatRelative, masteryBand, pct } from "@/lib/utils";
import { institutionScopeId, scopedInstitutions, scopedLearners } from "@/lib/page-guards";
import { accessibleStudentIds } from "@/lib/authz";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await requireUser();

  if (user.role === "student") {
    const detail = await getStudentDetail(user.id);
    if (!detail) {
      return (
        <Card>
          <EmptyState
            icon="◎"
            title="Your learner profile is being prepared"
            description="We could not find mastery data for your account yet. Launch a diagnostic to start knowledge tracing."
            action={
              <ActionButton
                label="Start diagnostic"
                url="/api/assessments"
                body={{ studentId: user.id, mode: "diagnostic", itemTarget: 8 }}
                successMessage="Diagnostic queued"
                size="sm"
              />
            }
          />
        </Card>
      );
    }
    return <StudentOverview detail={detail} isSelf />;
  }

  const scopeId = institutionScopeId(user);
  const scopeIds = await accessibleStudentIds(user);
  const [snapshot, learners, activity, models, institutionList] = await Promise.all([
    getCohortSnapshot(scopeId),
    scopedLearners(user),
    getActivity(undefined, 10, scopeIds ?? undefined),
    getModelRegistry(),
    scopedInstitutions(user),
  ]);

  const classifier = models.find((model) => model.kind === "classifier");
  const tracer = models.find((model) => model.kind === "tracer");
  const atRisk = learners.filter((learner) => learner.avgMastery < 0.55 || learner.masteryTrend < -0.02);

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Learners tracked"
          value={snapshot.learners}
          delta={`${snapshot.cohorts.length} cohorts`}
          hint={`${snapshot.masteryStates} live mastery states`}
          tone="violet"
          icon="☺"
        />
        <StatCard
          label="Average session score"
          value={pct(snapshot.avgScore)}
          delta={`${snapshot.completedAssessments} completed · ${snapshot.activeAssessments} live`}
          hint="Scored across all adaptive sessions"
          tone="sky"
          icon="✎"
        />
        <StatCard
          label="Open priorities"
          value={snapshot.openRecommendations}
          delta={`${snapshot.acceptedRecommendations} acted on`}
          hint="Hybrid recommender queue awaiting educator action"
          tone="amber"
          icon="★"
        />
        <StatCard
          label="Classifier quality"
          value={classifier ? pct(classifier.metrics.accuracy ?? 0) : "untrained"}
          delta={classifier ? `AUC ${(classifier.metrics.auc ?? 0).toFixed(3)} · logloss ${(classifier.metrics.logLoss ?? 0).toFixed(3)}` : "Run a retraining job"}
          hint={classifier ? `${classifier.samples} training responses · ${classifier.version}` : "Difficulty classifier not trained yet"}
          tone="emerald"
          icon="⚙"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Weak-topic heatmap"
            subtitle="Cohort-level decay-adjusted mastery per skill — the remediation priority list"
            action={
              <Link className={buttonClass("secondary", "sm")} href="/dashboard/gaps">
                Gap explorer
              </Link>
            }
          />
          <div className="mt-4">
            <BarList
              items={snapshot.weakTopics.map((topic) => ({
                label: topic.skillName,
                value: topic.avgMastery,
                color: topic.avgMastery < 0.5 ? "#e11d48" : topic.avgMastery < 0.7 ? "#d97706" : "#0284c7",
                hint: `${topic.learners} learners · ${topic.atRisk} at risk · ${topic.attempts} responses`,
              }))}
            />
          </div>
        </Card>

        <Card>
          <CardHeader title="At-risk learners" subtitle="Mastery below 55% or declining trend" />
          <ul className="mt-3 space-y-3">
            {atRisk.slice(0, 6).map((learner) => {
              const band = masteryBand(learner.avgMastery);
              return (
                <li key={learner.id} className="flex items-center gap-3">
                  <Avatar name={learner.name} color={learner.avatarColor} size={32} />
                  <div className="min-w-0 flex-1">
                    <Link href={`/dashboard/students/${learner.id}`} className="block truncate text-xs font-semibold text-slate-800 hover:text-indigo-600">
                      {learner.name}
                    </Link>
                    <p className="truncate text-[11px] text-slate-500">
                      {learner.cohort} · weakest {learner.weakestSkill ?? "—"}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs font-semibold text-slate-700">{pct(learner.avgMastery)}</p>
                    <Badge tone={band.tone}>{band.label}</Badge>
                  </div>
                </li>
              );
            })}
            {!atRisk.length ? <EmptyState icon="✓" title="No learners at risk" description="Every cohort member is above the mastery floor." /> : null}
          </ul>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Cohort mastery rollup"
            subtitle="Average decay-adjusted mastery per cohort"
            action={
              <div className="flex gap-2">
                <ActionButton
                  label="Retrain models"
                  url="/api/ml"
                  body={{ action: "train" }}
                  successMessage="Models retrained on live response logs"
                  variant="secondary"
                  size="sm"
                />
                <Link className={buttonClass("primary", "sm")} href="/dashboard/analytics">
                  Analytics
                </Link>
              </div>
            }
          />
          <div className="mt-4 space-y-3">
            {snapshot.cohorts.map((cohort) => {
              const band = masteryBand(cohort.avgMastery);
              return (
                <div key={cohort.cohort}>
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-slate-700">{cohort.cohort}</span>
                    <span className="text-slate-500">
                      {cohort.learners} learners · {pct(cohort.avgMastery)}
                    </span>
                  </div>
                  <ProgressBar
                    value={cohort.avgMastery}
                    tone={band.tone === "emerald" ? "emerald" : band.tone === "sky" ? "sky" : band.tone === "amber" ? "amber" : "rose"}
                    className="mt-1.5"
                  />
                </div>
              );
            })}
            {!snapshot.cohorts.length ? <EmptyState icon="☺" title="No learners yet" description="Invite learners to see cohort rollups." /> : null}
          </div>
        </Card>

        <Card>
          <CardHeader title="Live model registry" subtitle="Continuous learning status" />
          <ul className="mt-3 space-y-3 text-xs">
            {[classifier, tracer].filter(Boolean).map((model) => (
              <li key={model!.name} className="rounded-xl border border-slate-200 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-semibold text-slate-800">{model!.name}</span>
                  <Badge tone="sky">{model!.version}</Badge>
                </div>
                <p className="mt-1 text-[11px] text-slate-500">
                  {model!.samples} samples · trained {formatRelative(model!.trainedAt)}
                </p>
                {model!.kind === "classifier" ? (
                  <div className="mt-2 grid grid-cols-2 gap-1 text-[11px] text-slate-500">
                    <span>accuracy {pct(model!.metrics.accuracy ?? 0)}</span>
                    <span>auc {(model!.metrics.auc ?? 0).toFixed(3)}</span>
                    <span>precision {pct(model!.metrics.precision ?? 0)}</span>
                    <span>recall {pct(model!.metrics.recall ?? 0)}</span>
                  </div>
                ) : (
                  <div className="mt-2 grid grid-cols-2 gap-1 text-[11px] text-slate-500">
                    <span>pairs {model!.samples}</span>
                    <span>sessions {model!.metrics.sessions ?? 0}</span>
                    <span>avg mastery {pct(model!.metrics.avgMastery ?? 0)}</span>
                    <span>responses {model!.metrics.responses ?? 0}</span>
                  </div>
                )}
              </li>
            ))}
            {!classifier && !tracer ? (
              <EmptyState icon="⚙" title="No models registered" description="Retrain to register the classifier and tracer snapshots." />
            ) : null}
          </ul>
          <div className="mt-4 rounded-xl bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-600">
            <span className="font-semibold text-slate-700">Tenants:</span>{" "}
            {institutionList.map((institution) => `${institution.name} (${institution.plan})`).join(" · ") || "None configured"}
          </div>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Learner roster"
            subtitle="Mastery, gap load and trend at a glance"
            action={
              <Link className={buttonClass("secondary", "sm")} href="/dashboard/students">
                Manage learners
              </Link>
            }
          />
          <div className="mt-4 overflow-x-auto scrollbar-thin">
            <table className="w-full min-w-[680px] text-left text-xs">
              <thead className="text-[11px] uppercase tracking-wide text-slate-400">
                <tr>
                  <th className="pb-2">Learner</th>
                  <th className="pb-2">Cohort</th>
                  <th className="pb-2">Avg mastery</th>
                  <th className="pb-2">Trend</th>
                  <th className="pb-2">Gaps</th>
                  <th className="pb-2">Sessions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {learners.slice(0, 8).map((learner) => (
                  <tr key={learner.id}>
                    <td className="py-2 pr-3">
                      <div className="flex items-center gap-2">
                        <Avatar name={learner.name} color={learner.avatarColor} size={26} />
                        <Link className="font-medium text-slate-800 hover:text-indigo-600" href={`/dashboard/students/${learner.id}`}>
                          {learner.name}
                        </Link>
                      </div>
                    </td>
                    <td className="py-2 pr-3 text-slate-500">{learner.cohort}</td>
                    <td className="py-2 pr-3 text-slate-700">{pct(learner.avgMastery)}</td>
                    <td className="py-2 pr-3">
                      <span className={learner.masteryTrend >= 0 ? "text-emerald-600" : "text-rose-600"}>
                        {learner.masteryTrend >= 0 ? "▲" : "▼"} {Math.abs(learner.masteryTrend * 100).toFixed(1)} pts
                      </span>
                    </td>
                    <td className="py-2 pr-3 text-slate-500">{learner.gaps}</td>
                    <td className="py-2 text-slate-500">{learner.assessments}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card>
          <CardHeader title="Platform activity" subtitle="Latest tracked events" />
          <ul className="mt-3 space-y-3">
            {activity.map((event) => (
              <li key={event.id} className="flex gap-3">
                <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-indigo-500" />
                <div className="min-w-0">
                  <p className="text-xs text-slate-700">{event.summary}</p>
                  <p className="text-[11px] text-slate-400">
                    {event.studentName ?? "System"} · {formatRelative(event.createdAt)}
                  </p>
                </div>
              </li>
            ))}
            {!activity.length ? <EmptyState icon="⟳" title="No activity yet" description="Events appear as learners practise." /> : null}
          </ul>
        </Card>
      </div>
    </div>
  );
}
