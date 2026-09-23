import { StatCard, Card, CardHeader } from "@/components/ui";
import { SkillsManager } from "@/components/skills-client";
import { requireUser } from "@/lib/auth";
import { getSkillCatalog, getSubjects } from "@/lib/queries";
import { pct } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function SkillsPage() {
  const [user, skills, subjects] = await Promise.all([requireUser(), getSkillCatalog(), getSubjects()]);
  const totalItems = skills.reduce((acc, skill) => acc + skill.questionCount, 0);
  const orphans = skills.filter((skill) => skill.questionCount === 0).length;
  const advanced = skills.filter((skill) => skill.difficultyBase >= 0.7).length;

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Skills in graph" value={skills.length} delta={`${subjects.length} subjects`} tone="violet" icon="▤" />
        <StatCard label="Bank items" value={totalItems} delta={`${orphans} skills without items`} tone="sky" icon="?" />
        <StatCard label="Advanced skills" value={advanced} delta="base difficulty ≥ 70%" tone="amber" icon="▲" />
        <StatCard
          label="Mean base difficulty"
          value={pct(skills.length ? skills.reduce((acc, skill) => acc + skill.difficultyBase, 0) / skills.length : 0)}
          delta="feeds gap severity + item selection"
          tone="emerald"
          icon="◎"
        />
      </div>

      <Card>
        <CardHeader
          title="Skill taxonomy"
          subtitle="Create, edit and delete skills, wire prerequisites and keep the question bank coverage healthy"
        />
        <div className="mt-4">
          <SkillsManager skills={skills} subjects={subjects} canEdit={user.role !== "student"} />
        </div>
      </Card>
    </div>
  );
}
