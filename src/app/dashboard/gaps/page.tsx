import Link from "next/link";
import { ActionButton } from "@/components/action-button";
import { BarList } from "@/components/charts";
import { LearnerFilter } from "@/components/learner-filter";
import { Avatar, Badge, buttonClass, Card, CardHeader, EmptyState, ProgressBar, StatCard } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { buildGapReadouts, getStudentDetail, getStudentMastery } from "@/lib/queries";
import { resolveFocusStudent, scopedLearners } from "@/lib/page-guards";
import { severityLabel, severityTone, type GapSeverity } from "@/lib/ml/gaps";
import { pct } from "@/lib/utils";

export const dynamic = "force-dynamic";

const SEVERITY_ORDER: GapSeverity[] = ["critical", "high", "moderate", "watch", "healthy"];

export default async function GapsPage({ searchParams }: { searchParams: Promise<{ studentId?: string; severity?: string }> }) {
  const [user, params] = await Promise.all([requireUser(), searchParams]);
  const requested = params.studentId ? Number(params.studentId) : undefined;
  const scoped = await resolveFocusStudent(user, requested);
  const [learners, mastery] = await Promise.all([scopedLearners(user), scoped ? getStudentMastery(scoped) : Promise.resolve([])]);
  const detail = scoped ? await getStudentDetail(scoped) : null;
  const gaps = buildGapReadouts(mastery);
  const severityFilter = params.severity as GapSeverity | undefined;
  const visible = severityFilter ? gaps.filter((gap) => gap.severity === severityFilter) : gaps;

  const counts = SEVERITY_ORDER.map((severity) => ({
    severity,
    count: gaps.filter((gap) => gap.severity === severity).length,
  }));

  return (
    <div className="space-y-5">
      {!scoped ? (
        <Card>
          <CardHeader
            title="Knowledge-gap detection"
            subtitle="Pick a learner to run the gap classifier across their tracked skills"
            action={<LearnerFilter learners={learners} basePath="/dashboard/gaps" current={requested} label="Learner" />}
          />
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {learners.slice(0, 9).map((learner) => (
              <Link
                key={learner.id}
                href={`/dashboard/gaps?studentId=${learner.id}`}
                className="flex items-center gap-3 rounded-xl border border-slate-200 p-3 transition hover:border-indigo-200 hover:bg-indigo-50/40"
              >
                <Avatar name={learner.name} color={learner.avatarColor} size={34} />
                <div className="min-w-0">
                  <p className="truncate text-xs font-semibold text-slate-800">{learner.name}</p>
                  <p className="truncate text-[11px] text-slate-500">
                    {pct(learner.avgMastery)} mastery · {learner.gaps} gaps · {learner.cohort}
                  </p>
                </div>
              </Link>
            ))}
          </div>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {counts.slice(0, 4).map((entry) => (
              <StatCard
                key={entry.severity}
                label={severityLabel[entry.severity]}
                value={entry.count}
                delta={entry.severity === "critical" ? "immediate remediation" : entry.severity === "high" ? "this week" : "queued"}
                tone={severityTone[entry.severity] === "violet" ? "violet" : severityTone[entry.severity]}
                icon={entry.severity === "critical" ? "!" : "◍"}
              />
            ))}
          </div>

          <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
            <Card>
              <CardHeader
                title="Gap classification"
                subtitle="Severity is a hybrid of mastery shortfall, Wilson lower bound and retention decay — escalated by prerequisite gaps"
                action={
                  <div className="flex flex-wrap items-center gap-2">
                    <LearnerFilter learners={learners} basePath="/dashboard/gaps" current={requested} />
                    <Link className={buttonClass("secondary", "sm")} href="/dashboard/gaps">
                      Reset
                    </Link>
                  </div>
                }
              />
              <div className="mt-3 flex flex-wrap gap-2">
                {SEVERITY_ORDER.map((severity) => (
                  <Link
                    key={severity}
                    href={`/dashboard/gaps?studentId=${scoped}${severityFilter === severity ? "" : `&severity=${severity}`}`}
                    className={buttonClass(severityFilter === severity ? "primary" : "secondary", "sm")}
                  >
                    {severityLabel[severity]} · {gaps.filter((gap) => gap.severity === severity).length}
                  </Link>
                ))}
              </div>
              <ul className="mt-4 space-y-3">
                {visible.map((gap) => (
                  <li key={gap.input.skillId} className="rounded-xl border border-slate-200 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-slate-800">{gap.input.skillName}</p>
                        <p className="text-[11px] text-slate-500">
                          {gap.input.subjectName} · {gap.input.attempts} responses · {gap.input.correct} correct
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] font-semibold text-slate-600">score {gap.severityScore.toFixed(3)}</span>
                        <Badge tone={severityTone[gap.severity]}>{severityLabel[gap.severity]}</Badge>
                      </div>
                    </div>
                    <ProgressBar
                      value={gap.input.mastery}
                      tone={gap.severity === "critical" || gap.severity === "high" ? "rose" : gap.severity === "moderate" ? "amber" : "sky"}
                      className="mt-2"
                    />
                    <div className="mt-2 grid gap-1 text-[11px] text-slate-500 sm:grid-cols-2">
                      <span>mastery {pct(gap.input.mastery)} · accuracy {pct(gap.accuracy)}</span>
                      <span>Wilson lower bound {pct(gap.confidenceBound)} · decay risk {pct(gap.decayRisk)}</span>
                    </div>
                    <ul className="mt-2 space-y-1">
                      {gap.drivers.slice(0, 3).map((driver) => (
                        <li key={driver} className="text-[11px] text-slate-500">
                          • {driver}
                        </li>
                      ))}
                    </ul>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <ActionButton
                        label="Queue remediation"
                        url="/api/recommendations"
                        body={{ studentId: scoped }}
                        successMessage="Priorities regenerated including this gap"
                        variant="secondary"
                        size="sm"
                      />
                      <ActionButton
                        label="Add to path"
                        url="/api/paths"
                        body={{ studentId: scoped, maxItems: 6 }}
                        successMessage="Gap-ordered path regenerated"
                        variant="ghost"
                        size="sm"
                      />
                      <Link className={buttonClass("ghost", "sm")} href={`/dashboard/assessments?studentId=${scoped}`}>
                        Run checkpoint
                      </Link>
                    </div>
                  </li>
                ))}
                {!visible.length ? (
                  <EmptyState icon="✓" title="No gaps in this severity band" description="Switch severity or reset the filter." />
                ) : null}
              </ul>
            </Card>

            <div className="space-y-4">
              <Card>
                <CardHeader title="Mastery distribution" subtitle="Decay-adjusted mastery per tracked skill" />
                <div className="mt-4">
                  <BarList
                    items={mastery
                      .slice()
                      .sort((a, b) => a.decayed - b.decayed)
                      .slice(0, 10)
                      .map((row) => ({
                        label: row.skillName,
                        value: row.decayed,
                        color: row.decayed < 0.4 ? "#e11d48" : row.decayed < 0.65 ? "#d97706" : "#0284c7",
                        hint: `${row.attempts} responses · ${Math.round(row.daysSincePractice)}d since practice`,
                      }))}
                  />
                </div>
              </Card>
              {detail ? (
                <Card>
                  <CardHeader title="Learner context" subtitle={detail.student.cohort ?? "—"} />
                  <div className="mt-3 space-y-1.5 text-[11px] text-slate-600">
                    <p className="flex justify-between">
                      <span>Readiness index</span>
                      <span className="font-semibold">{pct(detail.readiness)}</span>
                    </p>
                    <p className="flex justify-between">
                      <span>Skills tracked</span>
                      <span className="font-semibold">{mastery.length}</span>
                    </p>
                    <p className="flex justify-between">
                      <span>Forecast trend</span>
                      <span className="font-semibold">{detail.performance.forecast.trendLabel}</span>
                    </p>
                    <p className="flex justify-between">
                      <span>Open priorities</span>
                      <span className="font-semibold">{detail.recommendations.filter((item) => item.status === "new").length}</span>
                    </p>
                  </div>
                  <Link className={buttonClass("secondary", "sm", "mt-3 w-full")} href={`/dashboard/students/${scoped}`}>
                    Open full profile
                  </Link>
                </Card>
              ) : null}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
