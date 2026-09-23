"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Modal } from "@/components/modal";
import { useToast } from "@/components/toast";
import { Avatar, Badge, buttonClass, Card, CardHeader, EmptyState, Field, inputClass } from "@/components/ui";
import type { DirectoryUser, InstitutionView } from "@/lib/queries";
import { formatDate, roleLabels } from "@/lib/utils";

export function InstitutionAdmin({ institutions, canEdit }: { institutions: InstitutionView[]; canEdit: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<InstitutionView | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: "", type: "school", plan: "growth", region: "Global", seats: "250" });

  const save = async () => {
    setSaving(true);
    try {
      const response = await fetch(editing ? `/api/institutions/${editing.id}` : "/api/institutions", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, seats: Number(form.seats) }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Save failed");
      toast.success(editing ? "Institution updated" : "Institution created");
      setOpen(false);
      setEditing(null);
      router.refresh();
    } catch (caught) {
      toast.error("Could not save institution", caught instanceof Error ? caught.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (institution: InstitutionView) => {
    try {
      const response = await fetch(`/api/institutions/${institution.id}`, { method: "DELETE" });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Delete failed");
      toast.success("Institution deleted", "Members were detached and kept as independent accounts.");
      router.refresh();
    } catch (caught) {
      toast.error("Could not delete institution", caught instanceof Error ? caught.message : undefined);
    }
  };

  return (
    <Card>
      <CardHeader
        title="Institutions & tenants"
        subtitle="Plans, seats and membership counts"
        action={
          canEdit ? (
            <button
              className={buttonClass("primary", "sm")}
              onClick={() => {
                setEditing(null);
                setForm({ name: "", type: "school", plan: "growth", region: "Global", seats: "250" });
                setOpen(true);
              }}
            >
              + New institution
            </button>
          ) : null
        }
      />
      <div className="mt-4 overflow-x-auto scrollbar-thin">
        <table className="w-full min-w-[720px] text-left text-xs">
          <thead className="text-[11px] uppercase tracking-wide text-slate-400">
            <tr>
              <th className="pb-2">Institution</th>
              <th className="pb-2">Type</th>
              <th className="pb-2">Plan</th>
              <th className="pb-2">Region</th>
              <th className="pb-2">Members</th>
              <th className="pb-2">Seats</th>
              <th className="pb-2">Created</th>
              {canEdit ? <th className="pb-2 text-right">Actions</th> : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {institutions.map((institution) => (
              <tr key={institution.id}>
                <td className="py-2 pr-3 font-medium text-slate-800">{institution.name}</td>
                <td className="py-2 pr-3 text-slate-500">{institution.type}</td>
                <td className="py-2 pr-3">
                  <Badge tone={institution.plan === "enterprise" ? "violet" : institution.plan === "growth" ? "sky" : "slate"}>
                    {institution.plan}
                  </Badge>
                </td>
                <td className="py-2 pr-3 text-slate-500">{institution.region}</td>
                <td className="py-2 pr-3 text-slate-500">{institution.members}</td>
                <td className="py-2 pr-3 text-slate-500">{institution.seats}</td>
                <td className="py-2 pr-3 text-slate-500">{formatDate(institution.createdAt)}</td>
                {canEdit ? (
                  <td className="py-2">
                    <div className="flex justify-end gap-2">
                      <button
                        className={buttonClass("secondary", "sm")}
                        onClick={() => {
                          setEditing(institution);
                          setForm({
                            name: institution.name,
                            type: institution.type,
                            plan: institution.plan,
                            region: institution.region,
                            seats: String(institution.seats),
                          });
                          setOpen(true);
                        }}
                      >
                        Edit
                      </button>
                      <button className={buttonClass("ghost", "sm", "text-rose-600 hover:bg-rose-50")} onClick={() => remove(institution)}>
                        Delete
                      </button>
                    </div>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? `Edit ${editing.name}` : "New institution"}
        footer={
          <>
            <button className={buttonClass("secondary", "md")} onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button className={buttonClass("primary", "md")} onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" className="sm:col-span-2">
            <input className={inputClass} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </Field>
          <Field label="Type">
            <select className={inputClass} value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value })}>
              <option value="school">School</option>
              <option value="university">University</option>
              <option value="bootcamp">Bootcamp</option>
              <option value="corporate">Corporate</option>
            </select>
          </Field>
          <Field label="Plan">
            <select className={inputClass} value={form.plan} onChange={(event) => setForm({ ...form, plan: event.target.value })}>
              <option value="starter">Starter</option>
              <option value="growth">Growth</option>
              <option value="enterprise">Enterprise</option>
            </select>
          </Field>
          <Field label="Region">
            <input className={inputClass} value={form.region} onChange={(event) => setForm({ ...form, region: event.target.value })} />
          </Field>
          <Field label="Seats">
            <input type="number" className={inputClass} value={form.seats} onChange={(event) => setForm({ ...form, seats: event.target.value })} />
          </Field>
        </div>
      </Modal>
    </Card>
  );
}

export function UserAdmin({
  users,
  institutions,
  currentUserId,
  canEdit,
}: {
  users: DirectoryUser[];
  institutions: InstitutionView[];
  currentUserId: number;
  canEdit: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [optimistic, setOptimistic] = useState<Record<number, { role?: string; status?: string }>>({});
  const [form, setForm] = useState({
    name: "",
    email: "",
    role: "teacher",
    cohort: "",
    institutionId: institutions[0]?.id ? String(institutions[0].id) : "",
    password: "password123",
  });

  const filtered = useMemo(
    () =>
      users.filter(
        (user) =>
          (!roleFilter || user.role === roleFilter) &&
          (user.name.toLowerCase().includes(query.toLowerCase()) || user.email.toLowerCase().includes(query.toLowerCase())),
      ),
    [users, query, roleFilter],
  );

  const create = async () => {
    setSaving(true);
    try {
      const response = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, institutionId: form.institutionId ? Number(form.institutionId) : null }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Could not create account");
      toast.success("Account created", `${form.name} can sign in with the temporary password.`);
      setOpen(false);
      setForm({ ...form, name: "", email: "" });
      router.refresh();
    } catch (caught) {
      toast.error("Could not create account", caught instanceof Error ? caught.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  const patch = async (id: number, body: Record<string, unknown>) => {
    setOptimistic((current) => ({ ...current, [id]: { ...current[id], ...(body as { role?: string; status?: string }) } }));
    try {
      const response = await fetch(`/api/users/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Update failed");
      toast.success("Account updated");
      router.refresh();
    } catch (caught) {
      setOptimistic((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      toast.error("Update failed", caught instanceof Error ? caught.message : undefined);
    }
  };

  const remove = async (id: number) => {
    try {
      const response = await fetch(`/api/users/${id}`, { method: "DELETE" });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Delete failed");
      toast.success("Account deleted", "All related mastery, sessions and paths were removed.");
      router.refresh();
    } catch (caught) {
      toast.error("Delete failed", caught instanceof Error ? caught.message : undefined);
    }
  };

  return (
    <Card>
      <CardHeader
        title="Account directory"
        subtitle="Invite staff, adjust roles and suspend accounts"
        action={
          canEdit ? (
            <button className={buttonClass("primary", "sm")} onClick={() => setOpen(true)}>
              + New account
            </button>
          ) : null
        }
      />
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="text-xs text-slate-500">
          <span className="mb-1 block">Search</span>
          <input className={`${inputClass} w-56 py-2`} placeholder="Name or email" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <label className="text-xs text-slate-500">
          <span className="mb-1 block">Role</span>
          <select className={`${inputClass} w-44 py-2`} value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)}>
            <option value="">All roles</option>
            {Object.entries(roleLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {filtered.length ? (
        <div className="mt-4 overflow-x-auto scrollbar-thin">
          <table className="w-full min-w-[760px] text-left text-xs">
            <thead className="text-[11px] uppercase tracking-wide text-slate-400">
              <tr>
                <th className="pb-2">Account</th>
                <th className="pb-2">Role</th>
                <th className="pb-2">Cohort</th>
                <th className="pb-2">Institution</th>
                <th className="pb-2">Status</th>
                <th className="pb-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((user) => {
                const role = optimistic[user.id]?.role ?? user.role;
                const status = optimistic[user.id]?.status ?? user.status;
                return (
                  <tr key={user.id}>
                    <td className="py-2 pr-3">
                      <div className="flex items-center gap-2">
                        <Avatar name={user.name} color={user.avatarColor} size={26} />
                        <span>
                          <span className="block font-medium text-slate-800">{user.name}</span>
                          <span className="text-[11px] text-slate-500">{user.email}</span>
                        </span>
                      </div>
                    </td>
                    <td className="py-2 pr-3">
                      {canEdit ? (
                        <select
                          className="rounded-lg border border-slate-200 px-2 py-1 text-[11px]"
                          value={role}
                          onChange={(event) => patch(user.id, { role: event.target.value })}
                        >
                          {Object.entries(roleLabels).map(([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <Badge tone="violet">{roleLabels[role] ?? role}</Badge>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-slate-500">{user.cohort ?? "—"}</td>
                    <td className="py-2 pr-3 text-slate-500">{user.institutionName ?? "—"}</td>
                    <td className="py-2 pr-3">
                      <Badge tone={status === "active" ? "emerald" : status === "invited" ? "amber" : "rose"}>{status}</Badge>
                    </td>
                    <td className="py-2">
                      {canEdit ? (
                        <div className="flex justify-end gap-2">
                          <button
                            className={buttonClass("secondary", "sm")}
                            onClick={() => patch(user.id, { status: status === "active" ? "suspended" : "active" })}
                          >
                            {status === "active" ? "Suspend" : "Reactivate"}
                          </button>
                          {user.id === currentUserId ? (
                            <span className="text-[11px] text-slate-400">you</span>
                          ) : (
                            <button className={buttonClass("ghost", "sm", "text-rose-600 hover:bg-rose-50")} onClick={() => remove(user.id)}>
                              Delete
                            </button>
                          )}
                        </div>
                      ) : (
                        <span className="text-[11px] text-slate-400">read only</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="mt-4">
          <EmptyState icon="⛭" title="No accounts match" description="Adjust the filters or invite a new account." />
        </div>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Invite an account"
        description="Temporary password is shared with the invitee — they can change it after first sign-in."
        footer={
          <>
            <button className={buttonClass("secondary", "md")} onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button className={buttonClass("primary", "md")} onClick={create} disabled={saving}>
              {saving ? "Creating…" : "Create account"}
            </button>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name">
            <input className={inputClass} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </Field>
          <Field label="Email">
            <input className={inputClass} value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />
          </Field>
          <Field label="Role">
            <select className={inputClass} value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value })}>
              {Object.entries(roleLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Cohort">
            <input className={inputClass} value={form.cohort} onChange={(event) => setForm({ ...form, cohort: event.target.value })} />
          </Field>
          <Field label="Institution" className="sm:col-span-2">
            <select className={inputClass} value={form.institutionId} onChange={(event) => setForm({ ...form, institutionId: event.target.value })}>
              <option value="">None</option>
              {institutions.map((institution) => (
                <option key={institution.id} value={institution.id}>
                  {institution.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Temporary password" className="sm:col-span-2">
            <input className={inputClass} value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} />
          </Field>
        </div>
      </Modal>
    </Card>
  );
}
