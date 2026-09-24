import { InstitutionAdmin, UserAdmin } from "@/components/admin-client";
import { ActionButton } from "@/components/action-button";
import { Card, CardHeader, EmptyState, StatCard } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { getCohortSnapshot, getUserDirectory } from "@/lib/queries";
import { pct } from "@/lib/utils";
import { institutionScopeId, scopedInstitutions } from "@/lib/page-guards";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const user = await requireUser();
  if (user.role !== "admin" && user.role !== "institution") {
    return (
      <Card>
        <EmptyState
          icon="⛭"
          title="Administration is restricted"
          description="Only platform admins and institution administrators can manage tenants, seats and accounts."
        />
      </Card>
    );
  }

  // Institution admins are scoped to their own tenant; platform admins see all.
  const scopeId = institutionScopeId(user);
  const [users, institutions, snapshot] = await Promise.all([
    getUserDirectory(undefined, scopeId),
    scopedInstitutions(user),
    getCohortSnapshot(scopeId),
  ]);
  const canEdit = user.role === "admin";
  const staff = users.filter((entry) => entry.role !== "student");
  const suspended = users.filter((entry) => entry.status === "suspended");

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Accounts" value={users.length} delta={`${staff.length} staff · ${users.length - staff.length} learners`} tone="violet" icon="⛭" />
        <StatCard label="Institutions" value={institutions.length} delta={`${institutions.reduce((acc, row) => acc + row.seats, 0)} licensed seats`} tone="sky" icon="▤" />
        <StatCard label="Suspended" value={suspended.length} delta="access revoked" tone="rose" icon="!" />
        <StatCard label="Platform mastery" value={pct(snapshot.weakTopics.length ? snapshot.weakTopics.reduce((acc, row) => acc + row.avgMastery, 0) / snapshot.weakTopics.length : 0)} delta="across weak-topic set" tone="emerald" icon="▲" />
      </div>

      <Card>
        <CardHeader
          title="Platform operations"
          subtitle="Model refresh, tenant hygiene and account governance in one place"
          action={
            <div className="flex flex-wrap gap-2">
              <ActionButton label="Retrain all models" url="/api/ml" body={{ action: "train" }} successMessage="Models retrained" variant="primary" size="sm" />
              <ActionButton label="Evaluate calibration" url="/api/ml" body={{ action: "evaluate" }} successMessage="Calibration evaluated" variant="secondary" size="sm" />
            </div>
          }
        />
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {institutions.map((institution) => (
            <div key={institution.id} className="rounded-xl border border-slate-200 p-3">
              <p className="text-xs font-semibold text-slate-800">{institution.name}</p>
              <p className="text-[11px] text-slate-500">
                {institution.type} · {institution.plan} plan · {institution.region}
              </p>
              <p className="mt-1 text-[11px] text-slate-500">
                {institution.members}/{institution.seats} seats used
              </p>
            </div>
          ))}
        </div>
      </Card>

      <UserAdmin users={users} institutions={institutions} currentUserId={user.id} canEdit={canEdit} />
      <InstitutionAdmin institutions={institutions} canEdit={canEdit} />
    </div>
  );
}
