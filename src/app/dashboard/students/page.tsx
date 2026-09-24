import Link from "next/link";
import { ActionButton } from "@/components/action-button";
import { AddLearnerButton, LearnerRowActions } from "@/components/learner-admin";
import { Avatar, Badge, buttonClass, Card, CardHeader, EmptyState, ProgressBar } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { masteryBand, pct } from "@/lib/utils";
import { requireStaffPage, scopedInstitutions, scopedLearners } from "@/lib/page-guards";
import { isPlatformAdmin } from "@/lib/authz";

export const dynamic = "force-dynamic";

export default async function StudentsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; institutionId?: string }>;
}) {
  const params = await searchParams;
  const user = await requireUser();
  // The learner directory is staff-only; students use their own profile page.
  requireStaffPage(user);
  const [learners, institutionList] = await Promise.all([
    // Tenant isolation: non-platform-admins are pinned to their own institution
    // regardless of any institutionId param supplied in the URL.
    scopedLearners(user, params.q).then((rows) =>
      isPlatformAdmin(user) && params.institutionId
        ? rows.filter((r) => r.institutionId === Number(params.institutionId))
        : rows,
    ),
    scopedInstitutions(user),
  ]);
  const canEdit = user.role !== "student";

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="Learner directory"
          subtitle="Adaptive mastery, gap load and cohort placement for every learner"
          action={
            <div className="flex flex-wrap items-center gap-2">
              <Link className={buttonClass("secondary", "sm")} href="/dashboard/students">
                Reset filters
              </Link>
              <Link className={buttonClass("secondary", "sm")} href="/dashboard/analytics">
                Cohort analytics
              </Link>
              <AddLearnerButton institutions={institutionList} canInvite={canEdit} />
            </div>
          }
        />
        <form className="mt-4 flex flex-wrap items-end gap-3" method="get">
          <label className="text-xs text-slate-500">
            <span className="mb-1 block">Search</span>
            <input
              name="q"
              defaultValue={params.q ?? ""}
              placeholder="Name or email"
              className="w-56 rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-indigo-400"
            />
          </label>
          <label className="text-xs text-slate-500">
            <span className="mb-1 block">Institution</span>
            <select
              name="institutionId"
              defaultValue={params.institutionId ?? ""}
              className="w-56 rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-indigo-400"
            >
              <option value="">All institutions</option>
              {institutionList.map((institution) => (
                <option key={institution.id} value={institution.id}>
                  {institution.name}
                </option>
              ))}
            </select>
          </label>
          <button className={buttonClass("subtle", "md")} type="submit">
            Apply filters
          </button>
        </form>
      </Card>

      {learners.length ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {learners.map((learner) => {
            const band = masteryBand(learner.avgMastery);
            return (
              <Card key={learner.id} className="animate-in">
                <div className="flex items-start gap-3">
                  <Avatar name={learner.name} color={learner.avatarColor} size={40} />
                  <div className="min-w-0 flex-1">
                    <Link href={`/dashboard/students/${learner.id}`} className="block truncate text-sm font-semibold text-slate-900 hover:text-indigo-600">
                      {learner.name}
                    </Link>
                    <p className="truncate text-[11px] text-slate-500">{learner.email}</p>
                    <p className="mt-0.5 truncate text-[11px] text-slate-400">
                      {learner.gradeLevel ?? "—"} · {learner.cohort ?? "—"} · {learner.institutionName ?? "Independent"}
                    </p>
                  </div>
                  <Badge tone={band.tone}>{band.label}</Badge>
                </div>
                <p className="mt-3 line-clamp-2 text-[11px] text-slate-500">{learner.goal ?? "No goal recorded"}</p>
                <div className="mt-3">
                  <div className="flex items-center justify-between text-[11px] text-slate-500">
                    <span>Average mastery</span>
                    <span className="font-semibold text-slate-700">{pct(learner.avgMastery)}</span>
                  </div>
                  <ProgressBar
                    value={learner.avgMastery}
                    tone={band.tone === "emerald" ? "emerald" : band.tone === "sky" ? "sky" : band.tone === "amber" ? "amber" : "rose"}
                    className="mt-1.5"
                  />
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-lg bg-slate-50 px-2 py-1.5">
                    <p className="text-[10px] uppercase text-slate-400">Gaps</p>
                    <p className="text-sm font-semibold text-slate-700">{learner.gaps}</p>
                  </div>
                  <div className="rounded-lg bg-slate-50 px-2 py-1.5">
                    <p className="text-[10px] uppercase text-slate-400">Sessions</p>
                    <p className="text-sm font-semibold text-slate-700">{learner.assessments}</p>
                  </div>
                  <div className="rounded-lg bg-slate-50 px-2 py-1.5">
                    <p className="text-[10px] uppercase text-slate-400">Trend</p>
                    <p className={`text-sm font-semibold ${learner.masteryTrend >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                      {learner.masteryTrend >= 0 ? "+" : ""}
                      {(learner.masteryTrend * 100).toFixed(1)}
                    </p>
                  </div>
                </div>
                <p className="mt-3 text-[11px] text-slate-500">Weakest skill: {learner.weakestSkill ?? "—"}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Link className={buttonClass("secondary", "sm")} href={`/dashboard/students/${learner.id}`}>
                    Open profile
                  </Link>
                  <ActionButton
                    label="Regenerate priorities"
                    url="/api/recommendations"
                    body={{ studentId: learner.id }}
                    successMessage="Priorities regenerated"
                    variant="primary"
                    size="sm"
                    loadingLabel="Ranking…"
                  />
                  {canEdit ? (
                    <LearnerRowActions
                      learner={learner}
                      institutions={institutionList}
                      canDelete={user.role === "admin" || user.role === "institution"}
                    />
                  ) : null}
                </div>
              </Card>
            );
          })}
        </div>
      ) : (
        <Card>
          <EmptyState
            icon="☺"
            title="No learners match those filters"
            description="Adjust the search, or clear filters to see the full directory of tracked learners."
            action={
              <Link className={buttonClass("primary", "sm")} href="/dashboard/students">
                Clear filters
              </Link>
            }
          />
        </Card>
      )}
    </div>
  );
}
