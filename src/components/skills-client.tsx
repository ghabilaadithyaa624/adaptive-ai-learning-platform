"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Modal } from "@/components/modal";
import { useToast } from "@/components/toast";
import { Badge, buttonClass, EmptyState, Field, inputClass } from "@/components/ui";
import type { SkillRow, SubjectInfo } from "@/lib/queries";
import { pct } from "@/lib/utils";

export function SkillsManager({
  skills,
  subjects,
  canEdit,
}: {
  skills: SkillRow[];
  subjects: SubjectInfo[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [subjectFilter, setSubjectFilter] = useState("");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<SkillRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState<SkillRow | null>(null);
  const [form, setForm] = useState({
    name: "",
    code: "",
    description: "",
    subjectId: subjects[0]?.id ? String(subjects[0].id) : "",
    difficultyBase: "0.5",
    gradeBand: "Core",
    prereqIds: [] as number[],
  });

  const filtered = useMemo(
    () =>
      skills.filter(
        (skill) =>
          (!subjectFilter || skill.subjectId === Number(subjectFilter)) &&
          (skill.name.toLowerCase().includes(query.toLowerCase()) || skill.code.toLowerCase().includes(query.toLowerCase())),
      ),
    [skills, query, subjectFilter],
  );

  const openCreate = () => {
    setEditing(null);
    setForm({
      name: "",
      code: "",
      description: "",
      subjectId: subjects[0]?.id ? String(subjects[0].id) : "",
      difficultyBase: "0.5",
      gradeBand: "Core",
      prereqIds: [],
    });
    setOpen(true);
  };

  const openEdit = (skill: SkillRow) => {
    setEditing(skill);
    setForm({
      name: skill.name,
      code: skill.code,
      description: skill.description,
      subjectId: String(skill.subjectId),
      difficultyBase: String(skill.difficultyBase),
      gradeBand: skill.gradeBand,
      prereqIds: skill.prereqIds ?? [],
    });
    setOpen(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      const payload = {
        ...form,
        subjectId: Number(form.subjectId),
        difficultyBase: Number(form.difficultyBase),
      };
      const response = await fetch(editing ? `/api/skills/${editing.id}` : "/api/skills", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Save failed");
      toast.success(editing ? "Skill updated" : "Skill created", "Prerequisite graph re-indexed.");
      setOpen(false);
      router.refresh();
    } catch (caught) {
      toast.error("Could not save skill", caught instanceof Error ? caught.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (skill: SkillRow) => {
    setSaving(true);
    try {
      const response = await fetch(`/api/skills/${skill.id}`, { method: "DELETE" });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Delete failed");
      toast.success("Skill removed", `${skill.name} and its items were deleted.`);
      setConfirming(null);
      router.refresh();
    } catch (caught) {
      toast.error("Could not delete skill", caught instanceof Error ? caught.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-slate-500">
          <span className="mb-1 block">Search</span>
          <input className={`${inputClass} w-56 py-2`} placeholder="Skill name or code" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <label className="text-xs text-slate-500">
          <span className="mb-1 block">Subject</span>
          <select className={`${inputClass} w-48 py-2`} value={subjectFilter} onChange={(event) => setSubjectFilter(event.target.value)}>
            <option value="">All subjects</option>
            {subjects.map((subject) => (
              <option key={subject.id} value={subject.id}>
                {subject.name}
              </option>
            ))}
          </select>
        </label>
        {canEdit ? (
          <button className={buttonClass("primary", "md")} onClick={openCreate}>
            + New skill
          </button>
        ) : null}
      </div>

      {filtered.length ? (
        <div className="overflow-x-auto scrollbar-thin">
          <table className="w-full min-w-[820px] text-left text-xs">
            <thead className="text-[11px] uppercase tracking-wide text-slate-400">
              <tr>
                <th className="pb-2">Skill</th>
                <th className="pb-2">Subject</th>
                <th className="pb-2">Band</th>
                <th className="pb-2">Base difficulty</th>
                <th className="pb-2">Prerequisites</th>
                <th className="pb-2">Items</th>
                <th className="pb-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((skill) => (
                <tr key={skill.id}>
                  <td className="py-2 pr-3">
                    <span className="block font-medium text-slate-800">{skill.name}</span>
                    <span className="text-[11px] text-slate-400">
                      <span className="font-mono">{skill.code}</span> · {skill.description || "no description"}
                    </span>
                  </td>
                  <td className="py-2 pr-3">
                    <span className="inline-flex items-center gap-1.5 text-slate-600">
                      <span className="h-2 w-2 rounded-full" style={{ background: skill.subject.color }} />
                      {skill.subject.name}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-slate-500">{skill.gradeBand}</td>
                  <td className="py-2 pr-3">
                    <Badge tone={skill.difficultyBase >= 0.7 ? "rose" : skill.difficultyBase >= 0.5 ? "amber" : "emerald"}>
                      {pct(skill.difficultyBase)}
                    </Badge>
                  </td>
                  <td className="py-2 pr-3 text-slate-500">
                    {skill.prereqIds?.length
                      ? skill.prereqIds
                          .map((id) => skills.find((entry) => entry.id === id)?.code ?? id)
                          .join(", ")
                      : "—"}
                  </td>
                  <td className="py-2 pr-3 text-slate-500">{skill.questionCount}</td>
                  <td className="py-2">
                    <div className="flex justify-end gap-2">
                      {canEdit ? (
                        <>
                          <button className={buttonClass("secondary", "sm")} onClick={() => openEdit(skill)}>
                            Edit
                          </button>
                          <button className={buttonClass("ghost", "sm", "text-rose-600 hover:bg-rose-50")} onClick={() => setConfirming(skill)}>
                            Delete
                          </button>
                        </>
                      ) : (
                        <span className="text-[11px] text-slate-400">read only</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState icon="▤" title="No skills match" description="Adjust the filters, or author a new skill to extend the knowledge graph." />
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? `Edit ${editing.name}` : "New skill"}
        description="The prerequisite graph drives path generation and gap escalation."
        size="lg"
        footer={
          <>
            <button className={buttonClass("secondary", "md")} onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button className={buttonClass("primary", "md")} onClick={save} disabled={saving}>
              {saving ? "Saving…" : editing ? "Save skill" : "Create skill"}
            </button>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name">
            <input className={inputClass} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </Field>
          <Field label="Code" hint="Unique identifier used across analytics.">
            <input className={inputClass} value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} />
          </Field>
          <Field label="Subject">
            <select className={inputClass} value={form.subjectId} onChange={(event) => setForm({ ...form, subjectId: event.target.value })}>
              {subjects.map((subject) => (
                <option key={subject.id} value={subject.id}>
                  {subject.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Grade band">
            <select className={inputClass} value={form.gradeBand} onChange={(event) => setForm({ ...form, gradeBand: event.target.value })}>
              <option value="Foundational">Foundational</option>
              <option value="Core">Core</option>
              <option value="Advanced">Advanced</option>
            </select>
          </Field>
          <Field label={`Base difficulty · ${pct(Number(form.difficultyBase))}`} className="sm:col-span-2">
            <input
              type="range"
              min="0.1"
              max="0.95"
              step="0.05"
              className="w-full"
              value={form.difficultyBase}
              onChange={(event) => setForm({ ...form, difficultyBase: event.target.value })}
            />
          </Field>
          <Field label="Description" className="sm:col-span-2">
            <textarea
              className={`${inputClass} h-20`}
              value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
            />
          </Field>
          <Field label="Prerequisites" className="sm:col-span-2" hint="Hold ctrl/cmd to select multiple upstream skills.">
            <select
              multiple
              className={`${inputClass} h-32`}
              value={form.prereqIds.map(String)}
              onChange={(event) =>
                setForm({
                  ...form,
                  prereqIds: Array.from(event.target.selectedOptions).map((option) => Number(option.value)),
                })
              }
            >
              {skills
                .filter((skill) => skill.id !== editing?.id)
                .map((skill) => (
                  <option key={skill.id} value={skill.id}>
                    {skill.code} · {skill.name}
                  </option>
                ))}
            </select>
          </Field>
        </div>
      </Modal>

      <Modal open={Boolean(confirming)} onClose={() => setConfirming(null)} title="Delete skill" size="sm">
        <p className="text-xs text-slate-600">
          Deleting <span className="font-semibold">{confirming?.name}</span> removes its items, mastery states and path
          milestones. Existing sessions referencing those items are cleaned up too.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button className={buttonClass("secondary", "md")} onClick={() => setConfirming(null)}>
            Cancel
          </button>
          <button className={buttonClass("danger", "md")} onClick={() => confirming && remove(confirming)} disabled={saving}>
            {saving ? "Deleting…" : "Delete skill"}
          </button>
        </div>
      </Modal>
    </div>
  );
}
