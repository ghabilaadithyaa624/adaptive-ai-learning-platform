"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Modal } from "@/components/modal";
import { useToast } from "@/components/toast";
import { Avatar, Badge, buttonClass, Card, EmptyState, Field, inputClass, ProgressBar } from "@/components/ui";
import type { PathView, SkillRow, StudentSummary } from "@/lib/queries";
import { formatRelative, pct } from "@/lib/utils";

export function PathsManager({
  paths,
  learners,
  skills,
  canEdit,
  canPickLearner = true,
}: {
  paths: PathView[];
  learners: Pick<StudentSummary, "id" | "name" | "cohort">[];
  skills: Pick<SkillRow, "id" | "name" | "code">[];
  canEdit: boolean;
  canPickLearner?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [generateOpen, setGenerateOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [editPath, setEditPath] = useState<PathView | null>(null);
  const [milestonePath, setMilestonePath] = useState<PathView | null>(null);
  const [saving, setSaving] = useState(false);
  const [optimistic, setOptimistic] = useState<Record<number, { status?: string; progress?: number }>>({});
  const [genForm, setGenForm] = useState({
    studentId: learners[0]?.id ? String(learners[0].id) : "",
    title: "",
    objective: "Close the highest-priority knowledge gaps in prerequisite order",
    targetMastery: "0.85",
    maxItems: "6",
  });
  const [pathForm, setPathForm] = useState({ title: "", objective: "", status: "active", targetMastery: "0.85" });
  const [milestoneForm, setMilestoneForm] = useState({ skillId: skills[0]?.id ? String(skills[0].id) : "", dueDate: "" });

  const generate = async () => {
    if (!genForm.studentId) {
      toast.error("Pick a learner");
      return;
    }
    setGenerating(true);
    try {
      const response = await fetch("/api/paths", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentId: Number(genForm.studentId),
          title: genForm.title || undefined,
          objective: genForm.objective,
          targetMastery: Number(genForm.targetMastery),
          maxItems: Number(genForm.maxItems),
          autoGenerate: true,
        }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Could not generate path");
      toast.success("Learning path generated", "Milestones are ordered by the prerequisite graph.");
      setGenerateOpen(false);
      router.refresh();
    } catch (caught) {
      toast.error("Could not generate path", caught instanceof Error ? caught.message : undefined);
    } finally {
      setGenerating(false);
    }
  };

  const savePath = async () => {
    if (!editPath) return;
    setSaving(true);
    try {
      const response = await fetch(`/api/paths/${editPath.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: pathForm.title,
          objective: pathForm.objective,
          status: pathForm.status,
          targetMastery: Number(pathForm.targetMastery),
        }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Update failed");
      toast.success("Path updated");
      setEditPath(null);
      router.refresh();
    } catch (caught) {
      toast.error("Could not update path", caught instanceof Error ? caught.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  const removePath = async (id: number) => {
    try {
      const response = await fetch(`/api/paths/${id}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Delete failed");
      toast.success("Path deleted");
      router.refresh();
    } catch (caught) {
      toast.error("Could not delete path", caught instanceof Error ? caught.message : undefined);
    }
  };

  const toggleMilestone = async (milestoneId: number, nextStatus: string) => {
    setOptimistic((current) => ({ ...current, [milestoneId]: { status: nextStatus } }));
    try {
      const response = await fetch(`/api/milestones/${milestoneId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: nextStatus }),
      });
      const payload = (await response.json()) as { error?: string; progress?: number };
      if (!response.ok) throw new Error(payload.error ?? "Update failed");
      toast.success(`Milestone ${nextStatus.replace("_", " ")}`, payload.progress !== undefined ? `Path progress ${pct(payload.progress)}` : undefined);
      router.refresh();
    } catch (caught) {
      setOptimistic((current) => {
        const next = { ...current };
        delete next[milestoneId];
        return next;
      });
      toast.error("Could not update milestone", caught instanceof Error ? caught.message : undefined);
    }
  };

  const addMilestone = async () => {
    if (!milestonePath) return;
    setSaving(true);
    try {
      const response = await fetch("/api/milestones", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pathId: milestonePath.id,
          skillId: Number(milestoneForm.skillId),
          dueDate: milestoneForm.dueDate || null,
          targetMastery: milestonePath.targetMastery,
        }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Could not add milestone");
      toast.success("Milestone added");
      router.refresh();
    } catch (caught) {
      toast.error("Could not add milestone", caught instanceof Error ? caught.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  const removeMilestone = async (milestoneId: number) => {
    try {
      const response = await fetch(`/api/milestones/${milestoneId}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Delete failed");
      toast.success("Milestone removed");
      router.refresh();
    } catch (caught) {
      toast.error("Could not remove milestone", caught instanceof Error ? caught.message : undefined);
    }
  };

  if (!paths.length) {
    return (
      <Card>
        <EmptyState
          icon="⇥"
          title="No learning paths yet"
          description="Generate a gap-ordered path: the engine ranks skills by decay-adjusted mastery, keeps prerequisites ahead of dependents and projects a completion date."
          action={
            canEdit ? (
              <button className={buttonClass("primary", "sm")} onClick={() => setGenerateOpen(true)}>
                Generate a path
              </button>
            ) : undefined
          }
        />
        {renderGenerateModal()}
      </Card>
    );
  }

  function renderGenerateModal() {
    return (
      <Modal
        open={generateOpen}
        onClose={() => setGenerateOpen(false)}
        title="Generate a personalised path"
        description="Hybrid prioritisation: mastery gap, prerequisite readiness, forgetting risk and path alignment."
        footer={
          <>
            <button className={buttonClass("secondary", "md")} onClick={() => setGenerateOpen(false)}>
              Cancel
            </button>
            <button className={buttonClass("primary", "md")} onClick={generate} disabled={generating}>
              {generating ? "Building path…" : "Generate path"}
            </button>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          {canPickLearner ? (
            <Field label="Learner" className="sm:col-span-2">
              <select className={inputClass} value={genForm.studentId} onChange={(event) => setGenForm({ ...genForm, studentId: event.target.value })}>
                {learners.map((learner) => (
                  <option key={learner.id} value={learner.id}>
                    {learner.name}
                    {learner.cohort ? ` · ${learner.cohort}` : ""}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          <Field label="Title (optional)" className="sm:col-span-2">
            <input className={inputClass} value={genForm.title} onChange={(event) => setGenForm({ ...genForm, title: event.target.value })} />
          </Field>
          <Field label="Objective" className="sm:col-span-2">
            <input className={inputClass} value={genForm.objective} onChange={(event) => setGenForm({ ...genForm, objective: event.target.value })} />
          </Field>
          <Field label={`Target mastery · ${pct(Number(genForm.targetMastery))}`}>
            <input
              type="range"
              min="0.6"
              max="0.98"
              step="0.01"
              className="w-full"
              value={genForm.targetMastery}
              onChange={(event) => setGenForm({ ...genForm, targetMastery: event.target.value })}
            />
          </Field>
          <Field label="Max milestones">
            <input
              type="number"
              min={4}
              max={8}
              className={inputClass}
              value={genForm.maxItems}
              onChange={(event) => setGenForm({ ...genForm, maxItems: event.target.value })}
            />
          </Field>
        </div>
      </Modal>
    );
  }

  return (
    <div className="space-y-4">
      {canEdit ? (
        <div className="flex flex-wrap justify-end gap-2">
          <button className={buttonClass("primary", "md")} onClick={() => setGenerateOpen(true)}>
            + Generate path
          </button>
        </div>
      ) : null}

      <div className="space-y-4">
        {paths.map((path) => {
          const milestones = path.milestones.map((milestone) => ({
            ...milestone,
            status: optimistic[milestone.id]?.status ?? milestone.status,
          }));
          const progress =
            optimistic[path.milestones[0]?.id ?? 0]?.progress ??
            (milestones.length ? milestones.reduce((acc, m) => acc + Math.min(1, m.currentMastery / (m.targetMastery || 0.85)), 0) / milestones.length : 0);

          return (
            <Card key={path.id} className="animate-in">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <Avatar name={path.studentName} color={path.avatarColor} size={38} />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-slate-900">{path.title}</p>
                    <p className="text-[11px] text-slate-500">
                      <Link className="hover:text-indigo-600" href={`/dashboard/students/${path.studentId}`}>
                        {path.studentName}
                      </Link>{" "}
                      · {path.strategy} · target {pct(path.targetMastery)} · created {formatRelative(path.createdAt)}
                    </p>
                    <p className="mt-1 text-[11px] text-slate-500">{path.objective}</p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={path.status === "completed" ? "emerald" : path.status === "paused" ? "amber" : path.status === "draft" ? "slate" : "sky"}>
                    {path.status}
                  </Badge>
                  {canEdit ? (
                    <>
                      <button
                        className={buttonClass("secondary", "sm")}
                        onClick={() => {
                          setEditPath(path);
                          setPathForm({
                            title: path.title,
                            objective: path.objective,
                            status: path.status,
                            targetMastery: String(path.targetMastery),
                          });
                        }}
                      >
                        Edit
                      </button>
                      <button
                        className={buttonClass("ghost", "sm")}
                        onClick={() => {
                          setMilestonePath(path);
                          setMilestoneForm({ skillId: skills[0]?.id ? String(skills[0].id) : "", dueDate: "" });
                        }}
                      >
                        + Milestone
                      </button>
                      <button className={buttonClass("ghost", "sm", "text-rose-600 hover:bg-rose-50")} onClick={() => removePath(path.id)}>
                        Delete
                      </button>
                    </>
                  ) : null}
                </div>
              </div>

              <div className="mt-3">
                <div className="flex items-center justify-between text-[11px] text-slate-500">
                  <span>Milestone progress</span>
                  <span className="font-semibold text-slate-700">{pct(progress)}</span>
                </div>
                <ProgressBar value={progress} className="mt-1.5" />
              </div>

              <ol className="mt-4 space-y-2">
                {milestones.map((milestone) => (
                  <li key={milestone.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-100 bg-slate-50/60 px-3 py-2">
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white text-[11px] font-semibold text-slate-600 ring-1 ring-slate-200">
                      {milestone.position}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium text-slate-800">{milestone.skillName}</p>
                      <p className="text-[11px] text-slate-400">
                        {milestone.subjectName} · {pct(milestone.currentMastery)} / {pct(milestone.targetMastery)} · due{" "}
                        {milestone.dueDate ?? "—"}
                      </p>
                    </div>
                    <Badge
                      tone={
                        milestone.status === "completed"
                          ? "emerald"
                          : milestone.status === "in_progress"
                            ? "sky"
                            : milestone.status === "available"
                              ? "violet"
                              : "slate"
                      }
                    >
                      {milestone.status.replace("_", " ")}
                    </Badge>
                    {canEdit ? (
                      <div className="flex gap-1.5">
                        {milestone.status !== "completed" ? (
                          <button className={buttonClass("secondary", "sm")} onClick={() => toggleMilestone(milestone.id, "completed")}>
                            Complete
                          </button>
                        ) : (
                          <button className={buttonClass("ghost", "sm")} onClick={() => toggleMilestone(milestone.id, "available")}>
                            Reopen
                          </button>
                        )}
                        {milestone.status === "locked" ? (
                          <button className={buttonClass("ghost", "sm")} onClick={() => toggleMilestone(milestone.id, "in_progress")}>
                            Start
                          </button>
                        ) : null}
                        <button className={buttonClass("ghost", "sm", "text-rose-600 hover:bg-rose-50")} onClick={() => removeMilestone(milestone.id)}>
                          Remove
                        </button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ol>
              {path.projectedCompletion ? (
                <p className="mt-3 text-[11px] text-slate-500">Projected completion: {path.projectedCompletion}</p>
              ) : null}
            </Card>
          );
        })}
      </div>

      {renderGenerateModal()}

      <Modal
        open={Boolean(editPath)}
        onClose={() => setEditPath(null)}
        title="Edit learning path"
        footer={
          <>
            <button className={buttonClass("secondary", "md")} onClick={() => setEditPath(null)}>
              Cancel
            </button>
            <button className={buttonClass("primary", "md")} onClick={savePath} disabled={saving}>
              {saving ? "Saving…" : "Save path"}
            </button>
          </>
        }
      >
        <div className="grid gap-3">
          <Field label="Title">
            <input className={inputClass} value={pathForm.title} onChange={(event) => setPathForm({ ...pathForm, title: event.target.value })} />
          </Field>
          <Field label="Objective">
            <input className={inputClass} value={pathForm.objective} onChange={(event) => setPathForm({ ...pathForm, objective: event.target.value })} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Status">
              <select className={inputClass} value={pathForm.status} onChange={(event) => setPathForm({ ...pathForm, status: event.target.value })}>
                <option value="draft">Draft</option>
                <option value="active">Active</option>
                <option value="paused">Paused</option>
                <option value="completed">Completed</option>
              </select>
            </Field>
            <Field label={`Target mastery · ${pct(Number(pathForm.targetMastery))}`}>
              <input
                type="range"
                min="0.6"
                max="0.98"
                step="0.01"
                className="w-full"
                value={pathForm.targetMastery}
                onChange={(event) => setPathForm({ ...pathForm, targetMastery: event.target.value })}
              />
            </Field>
          </div>
        </div>
      </Modal>

      <Modal open={Boolean(milestonePath)} onClose={() => setMilestonePath(null)} title="Add milestone" size="sm">
        <div className="grid gap-3">
          <Field label="Skill">
            <select className={inputClass} value={milestoneForm.skillId} onChange={(event) => setMilestoneForm({ ...milestoneForm, skillId: event.target.value })}>
              {skills.map((skill) => (
                <option key={skill.id} value={skill.id}>
                  {skill.code} · {skill.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Due date">
            <input
              type="date"
              className={inputClass}
              value={milestoneForm.dueDate}
              onChange={(event) => setMilestoneForm({ ...milestoneForm, dueDate: event.target.value })}
            />
          </Field>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button className={buttonClass("secondary", "md")} onClick={() => setMilestonePath(null)}>
            Close
          </button>
          <button className={buttonClass("primary", "md")} onClick={addMilestone} disabled={saving}>
            {saving ? "Adding…" : "Add milestone"}
          </button>
        </div>
      </Modal>
    </div>
  );
}
