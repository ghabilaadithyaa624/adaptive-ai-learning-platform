import Link from "next/link";
import { ActionButton } from "@/components/action-button";
import { ForecastChart, MasteryGrid, RadialGauge, Sparkline } from "@/components/charts";
import { RecommendationQueue } from "@/components/recommendation-queue";
import { Avatar, Badge, buttonClass, Card, CardHeader, EmptyState, KeyValue, ProgressBar, StatCard } from "@/components/ui";
import type { StudentDetail } from "@/lib/queries";
import { MASTERY_TARGET, formatRelative, masteryBand, pct } from "@/lib/utils";

const TREND_TONE: Record<string, "emerald" | "amber" | "rose" | "slate"> = {
  improving: "emerald",
  steady: "slate",
  declining: "rose",
  "insufficient-data": "slate",
};

const RISK_TONE: Record<string, "emerald" | "amber" | "rose" | "slate"> = {
  "on-track": "emerald",
  watch: "amber",
  "at-risk": "rose",
  unknown: "slate",
};

export function StudentOverview({ detail, isSelf }: { detail: StudentDetail; isSelf: boolean }) {
  const { student, mastery, performance, paths, recommendations, activity, assessments, topRecommendations, gaps, subjectRollup } = detail;
  const activePath = paths.find((path) => path.status === "active") ?? paths[0] ?? null;
  const trajectory = performance.abilityTrajectory.map((point) => point.value);
  const openRecommendations = recommendations.filter((item) => item.status === "new").slice(0, 4);

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Average mastery"
          value={pct(detail.avgMastery)}
          delta={`${detail.predictions.masteredCount} skills at target`}
          hint={`${mastery.length} tracked skills · ${detail.retentionRisk} decaying`}
          tone="violet"
          icon="◎"
        />
        <StatCard
          label="Forecast next score"
          value={pct(performance.forecast.nextValue)}
          delta={`${performance.forecast.trendLabel} · R² ${performance.forecast.r2.toFixed(2)}`}
          hint={`Goal ETA ${performance.forecast.goalEta === null ? "not projected" : `${performance.forecast.goalEta} sessions`}`}
          tone={TREND_TONE[performance.forecast.trendLabel] ?? "slate"}
          icon="▲"
        />
        <StatCard
          label="Priority gaps"
          value={detail.predictions.gapCount}
          delta={`${gaps.filter((gap) => gap.severity === "critical").length} critical`}
          hint="Wilson-bound gap detection across the skill graph"
          tone="rose"
          icon="◍"
        />
        <StatCard
          label="Readiness index"
          value={pct(detail.readiness)}
          delta={`${openRecommendations.length} open priorities`}
          hint={`Evidence from ${assessments.length} sessions`}
          tone="sky"
          icon="✦"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Mastery trajectory & forecast"
            subtitle="Completed session scores with linear-regression projection and 95% confidence band"
            action={
              <div className="flex items-center gap-2">
                <Badge tone={RISK_TONE[performance.forecast.riskLabel] ?? "slate"}>{performance.forecast.riskLabel}</Badge>
                <Badge tone={TREND_TONE[performance.forecast.trendLabel] ?? "slate"}>{performance.forecast.trendLabel}</Badge>
              </div>
            }
          />
          {performance.forecast.history.length >= 3 ? (
            <div className="mt-4">
              <ForecastChart history={performance.forecast.history} projection={performance.forecast.projection} goal={MASTERY_TARGET} />
              <div className="mt-3 grid gap-3 text-[11px] text-slate-500 sm:grid-cols-4">
                <div>Slope: <span className="font-semibold text-slate-700">{(performance.forecast.slope * 100).toFixed(1)} pts/session</span></div>
                <div>Confidence: <span className="font-semibold text-slate-700">{pct(performance.forecast.confidence)}</span></div>
                <div>Residual σ: <span className="font-semibold text-slate-700">{performance.forecast.residualStd.toFixed(3)}</span></div>
                <div>Projected: <span className="font-semibold text-slate-700">{pct(performance.forecast.projection.at(-1)?.value ?? performance.forecast.nextValue)}</span></div>
              </div>
            </div>
          ) : (
            <div className="mt-4">
              <EmptyState
                icon="▲"
                title="Not enough sessions to forecast"
                description="Forecasting needs at least three completed sessions. Launch an adaptive quiz to start building signal."
                action={<Link className={buttonClass("primary", "sm")} href="/dashboard/assessments">Launch adaptive quiz</Link>}
              />
            </div>
          )}
        </Card>

        <Card>
          <CardHeader title={isSelf ? "Your progress summary" : `${student.name.split(" ")[0]}'s profile`} subtitle={student.goal ?? "Goal not set"} />
          <div className="mt-2 flex items-center gap-3">
            <Avatar name={student.name} color={student.avatarColor} size={44} />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-slate-900">{student.name}</p>
              <p className="truncate text-[11px] text-slate-500">
                {student.gradeLevel ?? "—"} · {student.cohort ?? "—"} · {student.institutionName ?? "Independent"}
              </p>
            </div>
          </div>
          <div className="mt-3 flex justify-center">
            <RadialGauge value={detail.readiness} label="readiness" sublabel="Weighted mastery + gap balance" />
          </div>
          <div className="mt-3 divide-y divide-slate-100">
            <KeyValue label="Skills tracked" value={mastery.length} />
            <KeyValue label="Responses analysed" value={mastery.reduce((acc, row) => acc + row.attempts, 0)} />
            <KeyValue label="Mastery trend" value={`${detail.predictions.masteredCount}/${mastery.length} at target`} />
            <KeyValue label="Retention decay flags" value={detail.retentionRisk} />
          </div>
          {isSelf ? null : (
            <div className="mt-4 flex flex-wrap gap-2">
              <Link className={buttonClass("secondary", "sm")} href={`/dashboard/students/${student.id}`}>
                Full profile
              </Link>
              <ActionButton
                label="Regenerate priorities"
                url={`/api/recommendations`}
                body={{ studentId: student.id }}
                successMessage="Priorities regenerated"
                variant="primary"
                size="sm"
              />
            </div>
          )}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Skill mastery map" subtitle="Decay-adjusted latent mastery per tracked skill" />
          <div className="mt-4">
            {mastery.length ? (
              <MasteryGrid
                items={[...mastery]
                  .sort((a, b) => a.decayed - b.decayed)
                  .map((row) => ({
                    label: row.skillName,
                    value: row.decayed,
                    secondary: `${row.correct}/${row.attempts} correct · ${Math.round(row.daysSincePractice)}d idle`,
                  }))}
              />
            ) : (
              <EmptyState icon="◎" title="No mastery evidence yet" description="Run a diagnostic checkpoint to start knowledge tracing." />
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="Subject rollup" subtitle="Where mastery is concentrated" />
          <ul className="mt-3 space-y-3">
            {subjectRollup.map((subject) => {
              const band = masteryBand(subject.mastery);
              return (
                <li key={subject.subjectName}>
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-slate-700">{subject.subjectName}</span>
                    <Badge tone={band.tone}>{band.label}</Badge>
                  </div>
                  <ProgressBar
                    value={subject.mastery}
                    tone={band.tone === "emerald" ? "emerald" : band.tone === "sky" ? "sky" : band.tone === "amber" ? "amber" : "rose"}
                    className="mt-1.5"
                  />
                  <p className="mt-1 text-[11px] text-slate-400">
                    {subject.skills} skills · weakest: {subject.weakest}
                  </p>
                </li>
              );
            })}
            {!subjectRollup.length ? <EmptyState icon="▤" title="No subject data" description="Mastery evidence will roll up here." /> : null}
          </ul>
          {trajectory.length > 1 ? (
            <div className="mt-4">
              <p className="text-[11px] font-medium text-slate-500">Recent mastery path</p>
              <Sparkline values={trajectory} tone="#0ea5e9" />
            </div>
          ) : null}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Recommendation queue"
            subtitle="Explainable priorities from the hybrid recommender"
            action={
              <ActionButton
                label="Refresh"
                url="/api/recommendations"
                body={{ studentId: student.id }}
                successMessage="Priority queue refreshed"
                variant="secondary"
                size="sm"
              />
            }
          />
          <div className="mt-4">
            <RecommendationQueue
              items={openRecommendations.length ? openRecommendations : recommendations.slice(0, 4)}
              showLearner={false}
              compact
            />
          </div>
        </Card>

        <Card>
          <CardHeader title="Weak-topic detection" subtitle="Severity classification with statistical confidence bounds" />
          <ul className="mt-3 space-y-2.5">
            {gaps.slice(0, 5).map((gap) => {
              const tone = gap.severity === "critical" || gap.severity === "high" ? "rose" : gap.severity === "moderate" ? "amber" : "sky";
              return (
                <li key={gap.input.skillId} className="rounded-xl border border-slate-200 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs font-semibold text-slate-800">{gap.input.skillName}</span>
                    <Badge tone={tone}>{gap.severity}</Badge>
                  </div>
                  <ProgressBar value={gap.input.mastery} tone={tone === "rose" ? "rose" : tone === "amber" ? "amber" : "sky"} className="mt-2" />
                  <p className="mt-1.5 text-[11px] text-slate-500">{gap.drivers[0]}</p>
                  <p className="mt-0.5 text-[11px] text-slate-400">Next: {gap.recommendation}</p>
                </li>
              );
            })}
            {!gaps.length ? <EmptyState icon="◍" title="No gaps detected" description="Every tracked skill is within target range." /> : null}
          </ul>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Learning path"
            subtitle={activePath ? `${activePath.strategy} · target ${pct(activePath.targetMastery)}` : "No active plan"}
            action={<Link className={buttonClass("secondary", "sm")} href="/dashboard/paths">Manage paths</Link>}
          />
          {activePath ? (
            <div className="mt-4">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-slate-800">{activePath.title}</span>
                <span className="text-slate-500">{pct(activePath.progress)} complete</span>
              </div>
              <ProgressBar value={activePath.progress} className="mt-2" />
              <ol className="mt-4 space-y-2">
                {activePath.milestones.slice(0, 5).map((milestone) => (
                  <li key={milestone.id} className="flex items-center gap-3 rounded-lg border border-slate-100 bg-slate-50/60 px-3 py-2">
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white text-[11px] font-semibold text-slate-600 ring-1 ring-slate-200">
                      {milestone.position}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium text-slate-700">{milestone.skillName}</p>
                      <p className="text-[11px] text-slate-400">
                        {milestone.subjectName} · due {milestone.dueDate ?? "—"} · {pct(milestone.currentMastery)} / {pct(milestone.targetMastery)}
                      </p>
                    </div>
                    <Badge tone={milestone.status === "completed" ? "emerald" : milestone.status === "in_progress" ? "sky" : "slate"}>
                      {milestone.status.replace("_", " ")}
                    </Badge>
                  </li>
                ))}
              </ol>
              {activePath.projectedCompletion ? (
                <p className="mt-3 text-[11px] text-slate-500">Projected completion: {activePath.projectedCompletion}</p>
              ) : null}
            </div>
          ) : (
            <div className="mt-4">
              <EmptyState
                icon="⇥"
                title="No learning path yet"
                description="Generate a gap-ordered path from the live mastery graph in one click."
                action={
                  <ActionButton
                    label="Generate path"
                    url="/api/paths"
                    body={{ studentId: student.id }}
                    successMessage="Learning path generated"
                    variant="primary"
                    size="sm"
                  />
                }
              />
            </div>
          )}
        </Card>

        <Card>
          <CardHeader title="Activity feed" subtitle="Model-driven events across this learner" />
          <ul className="mt-3 space-y-3">
            {activity.slice(0, 6).map((event) => (
              <li key={event.id} className="flex gap-3">
                <span
                  className={`mt-1 h-2 w-2 shrink-0 rounded-full ${
                    event.type === "assessment" ? "bg-indigo-500" : event.type === "recommendation" ? "bg-violet-500" : event.type === "path" ? "bg-sky-500" : "bg-emerald-500"
                  }`}
                />
                <div className="min-w-0">
                  <p className="text-xs text-slate-700">{event.summary}</p>
                  <p className="text-[11px] text-slate-400">{formatRelative(event.createdAt)}</p>
                </div>
              </li>
            ))}
            {!activity.length ? <EmptyState icon="⟳" title="No recent activity" description="Practice and recommendation events will appear here." /> : null}
          </ul>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Recent sessions"
          subtitle="Item-level outcomes, predicted success and mastery movement"
          action={<Link className={buttonClass("secondary", "sm")} href="/dashboard/assessments">All sessions</Link>}
        />
        <div className="mt-4 overflow-x-auto scrollbar-thin">
          <table className="w-full min-w-[720px] text-left text-xs">
            <thead className="text-[11px] uppercase tracking-wide text-slate-400">
              <tr>
                <th className="pb-2">Session</th>
                <th className="pb-2">Mode</th>
                <th className="pb-2">Score</th>
                <th className="pb-2">Predicted</th>
                <th className="pb-2">Items</th>
                <th className="pb-2">Completed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {assessments.slice(0, 6).map((assessment) => (
                <tr key={assessment.id}>
                  <td className="py-2 pr-3">
                    <Link className="font-medium text-slate-800 hover:text-indigo-600" href={`/dashboard/assessments/${assessment.id}`}>
                      {assessment.title}
                    </Link>
                  </td>
                  <td className="py-2 pr-3 text-slate-500">{assessment.mode.replace("_", " ")}</td>
                  <td className="py-2 pr-3 text-slate-700">{assessment.score === null ? "—" : pct(assessment.score)}</td>
                  <td className="py-2 pr-3 text-slate-500">{assessment.predictedScore === null ? "—" : pct(assessment.predictedScore)}</td>
                  <td className="py-2 pr-3 text-slate-500">
                    {assessment.answered}/{assessment.items}
                  </td>
                  <td className="py-2 text-slate-500">{formatRelative(assessment.completedAt ?? assessment.startedAt)}</td>
                </tr>
              ))}
              {!assessments.length ? (
                <tr>
                  <td colSpan={6} className="py-6 text-center text-slate-400">
                    No sessions yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <CardHeader title="Top model prioritisation" subtitle="Skill-level scores produced by the hybrid recommender before queueing" />
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {topRecommendations.map((entry) => (
            <div key={entry.signal.skillId} className="rounded-xl border border-slate-200 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-xs font-semibold text-slate-800">{entry.signal.skillName}</span>
                <span className="text-[11px] font-semibold text-indigo-600">{Math.round(entry.priority * 100)}/100</span>
              </div>
              <ProgressBar value={entry.priority} className="mt-2" />
              <p className="mt-2 text-[11px] leading-relaxed text-slate-500">{entry.reason}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {Object.entries(entry.factors).map(([key, value]) => (
                  <span key={key} className="rounded-md bg-slate-50 px-1.5 py-0.5 text-[10px] text-slate-500 ring-1 ring-inset ring-slate-200">
                    {key} {value}
                  </span>
                ))}
              </div>
            </div>
          ))}
          {!topRecommendations.length ? <EmptyState icon="★" title="Nothing scored yet" description="Run a diagnostic to give the recommender evidence." /> : null}
        </div>
      </Card>
    </div>
  );
}
