"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Modal } from "@/components/modal";
import { useToast } from "@/components/toast";
import { buttonClass, Field, inputClass } from "@/components/ui";
import type { DirectoryUser, InstitutionView, StudentSummary } from "@/lib/queries";

type LearnerRecord = Pick<
  StudentSummary,
  "id" | "name" | "email" | "gradeLevel" | "cohort" | "goal" | "avatarColor" | "institutionId" | "status"
>;

const COLORS = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ec4899", "#8b5cf6", "#14b8a6", "#ef4444"];

export function AddLearnerButton({
  institutions,
  canInvite = true,
}: {
  institutions: InstitutionView[];
  canInvite?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    name: "",
    email: "",
    gradeLevel: "Grade 10",
    cohort: "New Cohort",
    goal: "Close the highest-priority knowledge gaps",
    institutionId: institutions[0]?.id ? String(institutions[0].id) : "",
    ability: "0.45",
    avatarColor: COLORS[0],
  });

  const update = (key: keyof typeof form, value: string) => setForm((current) => ({ ...current, [key]: value }));

  const submit = async () => {
    setSaving(true);
    try {
      const response = await fetch("/api/students", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          institutionId: form.institutionId ? Number(form.institutionId) : null,
          ability: Number(form.ability),
        }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Could not create learner");
      toast.success("Learner added", "Cold-start mastery priors and a draft plan were generated.");
      setOpen(false);
      setForm((current) => ({ ...current, name: "", email: "" }));
      router.refresh();
    } catch (caught) {
      toast.error("Could not create learner", caught instanceof Error ? caught.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  if (!canInvite) return null;

  return (
    <>
      <button className={buttonClass("primary", "sm")} onClick={() => setOpen(true)}>
        + Add learner
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Add a learner"
        description="The knowledge tracer boots with priors over foundational skills, and the recommender immediately produces a first-priority list."
        footer={
          <>
            <button className={buttonClass("secondary", "md")} onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button className={buttonClass("primary", "md")} onClick={submit} disabled={saving}>
              {saving ? "Creating…" : "Create learner"}
            </button>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Full name">
            <input className={inputClass} value={form.name} onChange={(event) => update("name", event.target.value)} />
          </Field>
          <Field label="Email">
            <input className={inputClass} value={form.email} onChange={(event) => update("email", event.target.value)} />
          </Field>
          <Field label="Grade / level">
            <input className={inputClass} value={form.gradeLevel} onChange={(event) => update("gradeLevel", event.target.value)} />
          </Field>
          <Field label="Cohort">
            <input className={inputClass} value={form.cohort} onChange={(event) => update("cohort", event.target.value)} />
          </Field>
          <Field label="Institution">
            <select className={inputClass} value={form.institutionId} onChange={(event) => update("institutionId", event.target.value)}>
              <option value="">Independent learner</option>
              {institutions.map((institution) => (
                <option key={institution.id} value={institution.id}>
                  {institution.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Cold-start ability prior" hint="0.1 = novice, 0.9 = advanced. Drives the initial difficulty selection.">
            <input
              type="range"
              min="0.1"
              max="0.9"
              step="0.05"
              className="w-full"
              value={form.ability}
              onChange={(event) => update("ability", event.target.value)}
            />
          </Field>
          <Field label="Learning goal" className="sm:col-span-2">
            <input className={inputClass} value={form.goal} onChange={(event) => update("goal", event.target.value)} />
          </Field>
          <Field label="Avatar colour" className="sm:col-span-2">
            <div className="flex gap-2">
              {COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  onClick={() => update("avatarColor", color)}
                  className={`h-7 w-7 rounded-full ring-2 transition ${form.avatarColor === color ? "ring-slate-900" : "ring-transparent"}`}
                  style={{ background: color }}
                  aria-label={`Use ${color}`}
                />
              ))}
            </div>
          </Field>
        </div>
        <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-[11px] text-slate-500">
          Default password is <span className="font-mono">password123</span> — the learner can change it after their first sign-in.
        </p>
      </Modal>
    </>
  );
}

export function LearnerRowActions({
  learner,
  institutions,
  canDelete,
  canAssess = true,
  label = "Edit",
}: {
  learner: LearnerRecord;
  institutions: InstitutionView[];
  canDelete: boolean;
  canAssess?: boolean;
  label?: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    name: learner.name,
    email: learner.email,
    gradeLevel: learner.gradeLevel ?? "",
    cohort: learner.cohort ?? "",
    goal: learner.goal ?? "",
    status: learner.status,
    institutionId: learner.institutionId ? String(learner.institutionId) : "",
  });

  const patch = async () => {
    setSaving(true);
    try {
      const response = await fetch(`/api/students/${learner.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, institutionId: form.institutionId ? Number(form.institutionId) : null }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Update failed");
      toast.success("Learner updated");
      setEditOpen(false);
      router.refresh();
    } catch (caught) {
      toast.error("Update failed", caught instanceof Error ? caught.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setSaving(true);
    try {
      const response = await fetch(`/api/students/${learner.id}`, { method: "DELETE" });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Delete failed");
      toast.success("Learner removed", "All mastery, session and path data was cascaded.");
      setDeleteOpen(false);
      router.refresh();
    } catch (caught) {
      toast.error("Delete failed", caught instanceof Error ? caught.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  const quickAction = async (url: string, body: unknown, message: string) => {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Action failed");
      toast.success(message);
      router.refresh();
    } catch (caught) {
      toast.error("Action failed", caught instanceof Error ? caught.message : undefined);
    }
  };

  return (
    <div className="flex flex-wrap gap-2">
      <button className={buttonClass("secondary", "sm")} onClick={() => setEditOpen(true)}>
        {label}
      </button>
      {canAssess ? (
        <>
          <button
            className={buttonClass("ghost", "sm")}
            onClick={() => quickAction("/api/assessments", { studentId: learner.id, mode: "diagnostic", itemTarget: 6 }, "Diagnostic session queued")}
          >
            Diagnose
          </button>
          <button
            className={buttonClass("ghost", "sm")}
            onClick={() => quickAction("/api/paths", { studentId: learner.id }, "Learning path generated")}
          >
            Path
          </button>
        </>
      ) : null}
      {canDelete ? (
        <button className={buttonClass("ghost", "sm", "text-rose-600 hover:bg-rose-50")} onClick={() => setDeleteOpen(true)}>
          Delete
        </button>
      ) : null}

      <Modal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title={`Edit ${learner.name}`}
        description="Profile changes immediately affect cohort reporting and recommendation scoping."
        footer={
          <>
            <button className={buttonClass("secondary", "md")} onClick={() => setEditOpen(false)}>
              Cancel
            </button>
            <button className={buttonClass("primary", "md")} onClick={patch} disabled={saving}>
              {saving ? "Saving…" : "Save changes"}
            </button>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Full name">
            <input className={inputClass} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </Field>
          <Field label="Email">
            <input className={inputClass} value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />
          </Field>
          <Field label="Grade / level">
            <input className={inputClass} value={form.gradeLevel} onChange={(event) => setForm({ ...form, gradeLevel: event.target.value })} />
          </Field>
          <Field label="Cohort">
            <input className={inputClass} value={form.cohort} onChange={(event) => setForm({ ...form, cohort: event.target.value })} />
          </Field>
          <Field label="Institution">
            <select className={inputClass} value={form.institutionId} onChange={(event) => setForm({ ...form, institutionId: event.target.value })}>
              <option value="">Independent learner</option>
              {institutions.map((institution) => (
                <option key={institution.id} value={institution.id}>
                  {institution.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Status">
            <select className={inputClass} value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}>
              <option value="active">Active</option>
              <option value="invited">Invited</option>
              <option value="suspended">Suspended</option>
            </select>
          </Field>
          <Field label="Learning goal" className="sm:col-span-2">
            <input className={inputClass} value={form.goal} onChange={(event) => setForm({ ...form, goal: event.target.value })} />
          </Field>
        </div>
      </Modal>

      <Modal open={deleteOpen} onClose={() => setDeleteOpen(false)} title="Remove learner" size="sm">
        <p className="text-xs text-slate-600">
          Deleting <span className="font-semibold">{learner.name}</span> cascades mastery states, sessions, item responses,
          learning paths and recommendations. This cannot be undone.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button className={buttonClass("secondary", "md")} onClick={() => setDeleteOpen(false)}>
            Cancel
          </button>
          <button className={buttonClass("danger", "md")} onClick={remove} disabled={saving}>
            {saving ? "Deleting…" : "Delete learner"}
          </button>
        </div>
      </Modal>
    </div>
  );
}

export function DirectoryAdmin({ users }: { users: DirectoryUser[] }) {
  const [query, setQuery] = useState("");
  const filtered = users.filter(
    (user) => user.name.toLowerCase().includes(query.toLowerCase()) || user.email.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className="space-y-3">
      <input
        className={`${inputClass} max-w-xs`}
        placeholder="Filter accounts…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="overflow-x-auto scrollbar-thin">
        <table className="w-full min-w-[620px] text-left text-xs">
          <thead className="text-[11px] uppercase tracking-wide text-slate-400">
            <tr>
              <th className="pb-2">Account</th>
              <th className="pb-2">Role</th>
              <th className="pb-2">Cohort</th>
              <th className="pb-2">Institution</th>
              <th className="pb-2">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filtered.map((user) => (
              <tr key={user.id}>
                <td className="py-2 pr-3">
                  <span className="block font-medium text-slate-800">{user.name}</span>
                  <span className="text-[11px] text-slate-500">{user.email}</span>
                </td>
                <td className="py-2 pr-3 text-slate-500">{user.role}</td>
                <td className="py-2 pr-3 text-slate-500">{user.cohort ?? "—"}</td>
                <td className="py-2 pr-3 text-slate-500">{user.institutionName ?? "—"}</td>
                <td className="py-2 text-slate-500">{user.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
