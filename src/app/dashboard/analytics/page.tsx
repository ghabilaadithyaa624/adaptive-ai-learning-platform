import Link from "next/link";
import { BarList, ForecastChart, RadialGauge, Sparkline } from "@/components/charts";
import { LearnerFilter } from "@/components/learner-filter";
import { Badge, buttonClass, Card, CardHeader, EmptyState, ProgressBar, StatCard } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { getActivity, getCohortSnapshot, getStudentDetail } from "@/lib/queries";
import { institutionScopeId, resolveFocusStudent, scopedLearners } from "@/lib/page-guards";
import { accessibleStudentIds, isStudent } from "@/lib/authz";
import { MASTERY_TARGET, formatRelative, pct } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<{ studentId?: string }> }) {
  const [user, params] = await Promise.all([requireUser(), searchParams]);
  const requested = params.studentId ? Number(params.studentId) : undefined;
  const scoped = await resolveFocusStudent(user, requested);
  const scopeIds = await accessibleStudentIds(user);
  const [snapshot, learners, activity, detail] = await Promise.all([
    getCohortSnapshot(institutionScopeId(user)),
    scopedLearners(user),
    isStudent(user) ? getActivity(user.id, 12) : getActivity(undefined, 12, scopeIds ?? undefined),
    scoped ? getStudentDetail(scoped) : Promise.resolve(null),
  ]);
  const forecast = detail?.performance.forecast ?? null;

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="Progress analytics"
          subtitle={
            scoped
              ? "Mastery trajectory, forecast confidence and per-skill accuracy for a single learner"
              : "Cohort-level adoption, mastery distribution and weak-topic detection across every tracked learner"
          }
          action={user.role !== "student" ? <LearnerFilter learners={learners} basePath="/dashboard/analytics" current={requested} /> : undefined}
        />
      </Card>

      {detail && forecast ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Average mastery" value={pct(detail.avgMastery)} delta={`${detail.predictions.masteredCount} skills at target`} tone="violet" icon="◎" />
            <StatCard
              label="Forecast next session"
              value={pct(forecast.nextValue)}
              delta={`${forecast.trendLabel} · R² ${forecast.r2.toFixed(2)}`}
              hint={`95% band ${pct(forecast.projection[0]?.low ?? 0)} – ${pct(forecast.projection[0]?.high ?? 0)}`}
              tone="sky"
              icon="▲"
            />
            <StatCard
              label="Goal ETA"
              value={forecast.goalEta === null ? "not projected" : `${forecast.goalEta} sessions`}
              delta={`target ${pct(MASTERY_TARGET)}`}
              tone="emerald"
              icon="⇥"
            />
            <StatCard
              label="Risk classification"
              value={forecast.riskLabel}
              delta={`residual σ ${forecast.residualStd.toFixed(3)} · n=${forecast.history.length}`}
              tone={forecast.riskLabel === "at-risk" ? "rose" : forecast.riskLabel === "watch" ? "amber" : "emerald"}
              icon="!"
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
            <Card>
              <CardHeader
                title="Forecast with confidence band"
                subtitle="Linear regression over completed session scores; dashed line is the projection"
                action={
                  <div className="flex gap-2">
                    <Badge tone={forecast.trendLabel === "improving" ? "emerald" : forecast.trendLabel === "declining" ? "rose" : "slate"}>
                      slope {(forecast.slope * 100).toFixed(1)} pts/session
                    </Badge>
                    <Link className={buttonClass("secondary", "sm")} href={`/dashboard/students/${detail.student.id}`}>
                      Full profile
                    </Link>
                  </div>
                }
              />
              <div className="mt-4">
                {forecast.history.length >= 3 ? (
                  <ForecastChart history={forecast.history} projection={forecast.projection} height={230} goal={MASTERY_TARGET} />
                ) : (
                  <EmptyState
                    icon="▲"
                    title="Not enough history to project"
                    description="Three or more completed sessions are required before the regression and confidence band become meaningful."
                    action={
                      <Link className={buttonClass("primary", "sm")} href={`/dashboard/assessments?studentId=${detail.student.id}`}>
                        Launch session
                      </Link>
                    }
                  />
                )}
              </div>
              <div className="mt-4 grid gap-2 text-[11px] text-slate-500 sm:grid-cols-3">
                <span>Intercept {forecast.intercept.toFixed(3)}</span>
                <span>Confidence {pct(forecast.confidence)}</span>
                <span>Projected +4 {pct(forecast.projection.at(-1)?.value ?? forecast.nextValue)}</span>
              </div>
            </Card>

            <div className="space-y-4">
              <Card>
                <CardHeader title="Readiness index" subtitle="Weighted mastery and gap balance" />
                <div className="mt-2 flex flex-col items-center">
                  <RadialGauge value={detail.readiness} label="readiness" sublabel={`${detail.predictions.gapCount} high-priority gaps`} />
                </div>
                <div className="mt-4">
                  <p className="text-[11px] font-medium text-slate-500">Recent mastery path</p>
                  {(() => {
                    const series = detail.performance.abilityTrajectory.length
                      ? detail.performance.abilityTrajectory.map((point) => point.value)
                      : detail.mastery
                          .flatMap((row) => row.history)
                          .sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime())
                          .slice(-14)
                          .map((point) => point.m);
                    return series.length > 1 ? <Sparkline values={series} tone="#0ea5e9" /> : null;
                  })()}
                </div>
              </Card>
              <Card>
                <CardHeader title="Accuracy vs mastery" subtitle="Observation accuracy against latent mastery" />
                <div className="mt-3 space-y-2.5">
                  {detail.performance.accuracyBySkill.slice(0, 6).map((row) => (
                    <div key={row.skillName}>
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="truncate text-slate-600">{row.skillName}</span>
                        <span className="text-slate-500">
                          {pct(row.accuracy)} obs · {pct(row.mastery)} latent
                        </span>
                      </div>
                      <div className="mt-1 flex gap-1">
                        <ProgressBar value={row.accuracy} tone="sky" />
                        <ProgressBar value={row.mastery} tone="indigo" />
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            </div>
          </div>

          <Card>
            <CardHeader title="Session ledger" subtitle="Completed sessions with realised score and model prediction" />
            <div className="mt-4 overflow-x-auto scrollbar-thin">
              <table className="w-full min-w-[700px] text-left text-xs">
                <thead className="text-[11px] uppercase tracking-wide text-slate-400">
                  <tr>
                    <th className="pb-2">Session</th>
                    <th className="pb-2">Score</th>
                    <th className="pb-2">Predicted</th>
                    <th className="pb-2">Error</th>
                    <th className="pb-2">Items</th>
                    <th className="pb-2">Completed</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {detail.performance.completed.map((session) => (
                    <tr key={session.id}>
                      <td className="py-2 pr-3">
                        <Link className="font-medium text-slate-800 hover:text-indigo-600" href={`/dashboard/assessments/${session.id}`}>
                          {session.title}
                        </Link>
                        <span className="block text-[11px] text-slate-400">{session.mode.replace("_", " ")}</span>
                      </td>
                      <td className="py-2 pr-3 text-slate-700">{pct(session.score)}</td>
                      <td className="py-2 pr-3 text-slate-500">{session.predictedScore === null ? "—" : pct(session.predictedScore)}</td>
                      <td className="py-2 pr-3 text-slate-500">
                        {session.predictedScore === null ? "—" : `${((session.predictedScore - session.score) * 100).toFixed(1)} pts`}
                      </td>
                      <td className="py-2 pr-3 text-slate-500">{session.itemCount}</td>
                      <td className="py-2 text-slate-500">{formatRelative(session.completedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Learners tracked" value={snapshot.learners} delta={`${snapshot.cohorts.length} cohorts`} tone="violet" icon="☺" />
            <StatCard label="Mastery states" value={snapshot.masteryStates} delta={`${snapshot.completedAssessments} sessions scored`} tone="sky" icon="◎" />
            <StatCard label="Average score" value={pct(snapshot.avgScore)} delta={`${snapshot.activeAssessments} sessions live`} tone="emerald" icon="✓" />
            <StatCard label="Recommendation adoption" value={`${snapshot.acceptedRecommendations}/${snapshot.openRecommendations + snapshot.acceptedRecommendations}`} delta="accepted vs open queue" tone="amber" icon="★" />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader title="Weakest cohort topics" subtitle="Average decay-adjusted mastery per skill across all learners" />
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
              <CardHeader title="Cohort rollup" subtitle="Average mastery per cohort" />
              <div className="mt-4 space-y-3">
                {snapshot.cohorts.map((cohort) => (
                  <div key={cohort.cohort}>
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium text-slate-700">{cohort.cohort}</span>
                      <span className="text-slate-500">
                        {cohort.learners} learners · {pct(cohort.avgMastery)}
                      </span>
                    </div>
                    <ProgressBar value={cohort.avgMastery} className="mt-1.5" tone={cohort.avgMastery < 0.6 ? "rose" : cohort.avgMastery < 0.75 ? "amber" : "emerald"} />
                  </div>
                ))}
              </div>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
            <Card>
              <CardHeader title="Learner leaderboard" subtitle="Ranked by average mastery with trend and gap load" />
              <div className="mt-4 overflow-x-auto scrollbar-thin">
                <table className="w-full min-w-[620px] text-left text-xs">
                  <thead className="text-[11px] uppercase tracking-wide text-slate-400">
                    <tr>
                      <th className="pb-2">Learner</th>
                      <th className="pb-2">Cohort</th>
                      <th className="pb-2">Mastery</th>
                      <th className="pb-2">Trend</th>
                      <th className="pb-2">Gaps</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {[...learners]
                      .sort((a, b) => b.avgMastery - a.avgMastery)
                      .map((learner) => (
                        <tr key={learner.id}>
                          <td className="py-2 pr-3">
                            <Link className="font-medium text-slate-800 hover:text-indigo-600" href={`/dashboard/analytics?studentId=${learner.id}`}>
                              {learner.name}
                            </Link>
                          </td>
                          <td className="py-2 pr-3 text-slate-500">{learner.cohort}</td>
                          <td className="py-2 pr-3 text-slate-700">{pct(learner.avgMastery)}</td>
                          <td className={`py-2 pr-3 ${learner.masteryTrend >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                            {learner.masteryTrend >= 0 ? "▲" : "▼"} {Math.abs(learner.masteryTrend * 100).toFixed(1)}
                          </td>
                          <td className="py-2 text-slate-500">{learner.gaps}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </Card>

            <Card>
              <CardHeader title="Recent platform events" subtitle="Telemetry feeding the models" />
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
              </ul>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
