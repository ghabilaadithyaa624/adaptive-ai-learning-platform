import { LearnerFilter } from "@/components/learner-filter";
import { PathsManager } from "@/components/paths-client";
import { Card, CardHeader, StatCard } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { getPaths, getSkillCatalog } from "@/lib/queries";
import { resolveFocusStudent, scopedLearners } from "@/lib/page-guards";
import { accessibleStudentIds } from "@/lib/authz";
import { pct } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function PathsPage({ searchParams }: { searchParams: Promise<{ studentId?: string }> }) {
  const [user, params] = await Promise.all([requireUser(), searchParams]);
  const requested = params.studentId ? Number(params.studentId) : undefined;
  const studentId = await resolveFocusStudent(user, requested);
  const scopeIds = await accessibleStudentIds(user);
  const [paths, learners, skills] = await Promise.all([
    studentId ? getPaths(studentId) : getPaths(undefined, scopeIds ?? undefined),
    scopedLearners(user),
    getSkillCatalog(),
  ]);

  const active = paths.filter((path) => path.status === "active");
  const milestones = paths.flatMap((path) => path.milestones);
  const completedMilestones = milestones.filter((milestone) => milestone.status === "completed");

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Paths" value={paths.length} delta={`${active.length} active`} tone="violet" icon="⇥" />
        <StatCard label="Milestones" value={milestones.length} delta={`${completedMilestones.length} completed`} tone="sky" icon="✓" />
        <StatCard
          label="Mean path progress"
          value={pct(active.length ? active.reduce((acc, path) => acc + path.progress, 0) / active.length : 0)}
          delta="weighted by milestone mastery"
          tone="emerald"
          icon="▲"
        />
        <StatCard
          label="Sequencing"
          value="Topological"
          delta="prerequisites always precede dependents"
          hint="Generated paths respect the skill graph and decay-adjusted gaps"
          tone="amber"
          icon="◎"
        />
      </div>

      <Card>
        <CardHeader
          title="Personalised learning paths"
          subtitle="Generated from gap ordering, prerequisite chains and mastery decay — with milestone-level CRUD"
          action={user.role !== "student" ? <LearnerFilter learners={learners} basePath="/dashboard/paths" current={requested} /> : undefined}
        />
        <div className="mt-4">
          <PathsManager
            paths={paths}
            learners={learners}
            skills={skills}
            canEdit={user.role !== "student"}
            canPickLearner={user.role !== "student"}
          />
        </div>
      </Card>
    </div>
  );
}
