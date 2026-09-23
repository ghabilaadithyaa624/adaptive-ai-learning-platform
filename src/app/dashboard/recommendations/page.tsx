import { ActionButton } from "@/components/action-button";
import { LearnerFilter } from "@/components/learner-filter";
import { RecommendationQueue } from "@/components/recommendation-queue";
import { Card, CardHeader, EmptyState, StatCard, Badge } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { getStudentDetail, getRecommendations, listStudents } from "@/lib/queries";
import { pct } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function RecommendationsPage({ searchParams }: { searchParams: Promise<{ studentId?: string }> }) {
  const [user, params] = await Promise.all([requireUser(), searchParams]);
  const requested = params.studentId ? Number(params.studentId) : undefined;
  const scoped = user.role === "student" ? user.id : requested;
  const [items, learners] = await Promise.all([getRecommendations({ studentId: scoped }), listStudents()]);
  const detail = scoped ? await getStudentDetail(scoped) : null;

  const open = items.filter((item) => item.status === "new");
  const accepted = items.filter((item) => item.status === "accepted");
  const completed = items.filter((item) => item.status === "completed");
  const meanPriority = open.length ? open.reduce((acc, item) => acc + item.priority, 0) / open.length : 0;

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Open priorities" value={open.length} delta={`${items.length} total scored`} tone="violet" icon="★" />
        <StatCard label="Accepted" value={accepted.length} delta={`${completed.length} completed`} tone="sky" icon="✓" />
        <StatCard label="Mean priority" value={meanPriority.toFixed(2)} delta="0-1 hybrid score" tone="amber" icon="◎" />
        <StatCard
          label="Scoring model"
          value="hybrid-v2"
          delta="gap · forgetting · prereq · alignment · confidence"
          hint="Every recommendation exposes its factor decomposition"
          tone="emerald"
          icon="⚙"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        <Card>
          <CardHeader
            title="Priority queue"
            subtitle="Accept, dismiss or complete — the engine learns from your decisions and avoids re-surfacing dismissed skills"
            action={
              <div className="flex flex-wrap items-center gap-2">
                {user.role !== "student" ? <LearnerFilter learners={learners} basePath="/dashboard/recommendations" current={requested} /> : null}
                <ActionButton
                  label="Regenerate"
                  url="/api/recommendations"
                  body={{ studentId: scoped ?? learners[0]?.id }}
                  successMessage="Priorities regenerated from current mastery"
                  variant="primary"
                  size="sm"
                  loadingLabel="Ranking…"
                />
              </div>
            }
          />
          <div className="mt-4">
            <RecommendationQueue items={items} />
          </div>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Explainability" subtitle="How the hybrid scorer composes a priority" />
            <ul className="mt-3 space-y-2 text-[11px] leading-relaxed text-slate-600">
              <li>
                <span className="font-semibold text-slate-700">Gap 40%</span> — distance from the 85% mastery target,
                weighted by evidence volume so thin data cannot dominate.
              </li>
              <li>
                <span className="font-semibold text-slate-700">Forgetting 20%</span> — exponential decay since the last
                practised response (retention risk).
              </li>
              <li>
                <span className="font-semibold text-slate-700">Prerequisites 16%</span> — readiness of upstream skills so
                we never recommend ahead of foundations.
              </li>
              <li>
                <span className="font-semibold text-slate-700">Path alignment 12%</span> — keeps the queue consistent with
                the active learning path.
              </li>
              <li>
                <span className="font-semibold text-slate-700">Confidence 12%</span> — evidence volume; low-confidence
                skills are routed to short checkpoints instead of remediation.
              </li>
            </ul>
          </Card>

          {detail ? (
            <Card>
              <CardHeader title="Snapshot feeding the scorer" subtitle={detail.student.name} />
              <div className="mt-3 space-y-2 text-[11px] text-slate-600">
                <p className="flex items-center justify-between">
                  <span>Average mastery</span>
                  <Badge tone="sky">{pct(detail.avgMastery)}</Badge>
                </p>
                <p className="flex items-center justify-between">
                  <span>Priority gaps (high + critical)</span>
                  <Badge tone="rose">{detail.predictions.gapCount}</Badge>
                </p>
                <p className="flex items-center justify-between">
                  <span>Skills at target</span>
                  <Badge tone="emerald">{detail.predictions.masteredCount}</Badge>
                </p>
                <p className="flex items-center justify-between">
                  <span>Forecast trend</span>
                  <Badge tone="violet">{detail.performance.forecast.trendLabel}</Badge>
                </p>
              </div>
            </Card>
          ) : (
            <Card>
              <EmptyState
                icon="★"
                title="Pick a learner to see context"
                description="Scope the queue to a single learner to inspect the exact signals feeding the recommender."
              />
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
