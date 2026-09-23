"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Modal } from "@/components/modal";
import { useToast } from "@/components/toast";
import { Badge, buttonClass, EmptyState, Field, inputClass, ProgressBar } from "@/components/ui";
import type { AssessmentView, StudentSummary } from "@/lib/queries";
import { formatRelative, pct } from "@/lib/utils";

export function StartAssessmentButton({
  learners,
  defaultStudentId,
  canPickLearner = true,
  label = "New adaptive quiz",
}: {
  learners: Pick<StudentSummary, "id" | "name" | "cohort" | "weakestSkill">[];
  defaultStudentId?: number;
  canPickLearner?: boolean;
  label?: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [form, setForm] = useState({
    studentId: defaultStudentId ? String(defaultStudentId) : learners[0]?.id ? String(learners[0].id) : "",
    mode: "adaptive_quiz",
    itemTarget: "8",
    title: "",
  });

  const start = async () => {
    if (!form.studentId) {
      toast.error("Pick a learner first");
      return;
    }
    setStarting(true);
    try {
      const response = await fetch("/api/assessments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentId: Number(form.studentId),
          mode: form.mode,
          itemTarget: Number(form.itemTarget),
          title: form.title || undefined,
        }),
      });
      const payload = (await response.json()) as { error?: string; assessmentId?: number };
      if (!response.ok || !payload.assessmentId) throw new Error(payload.error ?? "Could not start the session");
      toast.success("Adaptive session created", "Items are selected live from the difficulty classifier.");
      setOpen(false);
      router.push(`/dashboard/assessments/${payload.assessmentId}`);
    } catch (caught) {
      toast.error("Could not start session", caught instanceof Error ? caught.message : undefined);
    } finally {
      setStarting(false);
    }
  };

  return (
    <>
      <button className={buttonClass("primary", "sm")} onClick={() => setOpen(true)} disabled={!learners.length}>
        {label}
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Start an adaptive session"
        description="Deterministic inputs feed the knowledge tracer: focus skills are chosen by the lowest decay-adjusted mastery, then items are picked inside the zone of proximal development."
        footer={
          <>
            <button className={buttonClass("secondary", "md")} onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button className={buttonClass("primary", "md")} onClick={start} disabled={starting}>
              {starting ? "Selecting items…" : "Start session"}
            </button>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          {canPickLearner ? (
            <Field label="Learner" className="sm:col-span-2">
              <select className={inputClass} value={form.studentId} onChange={(event) => setForm({ ...form, studentId: event.target.value })}>
                {learners.map((learner) => (
                  <option key={learner.id} value={learner.id}>
                    {learner.name}
                    {learner.cohort ? ` · ${learner.cohort}` : ""}
                    {learner.weakestSkill ? ` · weakest: ${learner.weakestSkill}` : ""}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          <Field label="Session mode">
            <select className={inputClass} value={form.mode} onChange={(event) => setForm({ ...form, mode: event.target.value })}>
              <option value="diagnostic">Diagnostic checkpoint</option>
              <option value="adaptive_quiz">Adaptive quiz</option>
              <option value="practice">Targeted practice</option>
            </select>
          </Field>
          <Field label="Item target" hint="Client-side selection adapts inside the session.">
            <input
              type="number"
              min={3}
              max={20}
              className={inputClass}
              value={form.itemTarget}
              onChange={(event) => setForm({ ...form, itemTarget: event.target.value })}
            />
          </Field>
          <Field label="Custom title (optional)" className="sm:col-span-2">
            <input
              className={inputClass}
              value={form.title}
              placeholder="e.g. Week 6 exit ticket"
              onChange={(event) => setForm({ ...form, title: event.target.value })}
            />
          </Field>
        </div>
      </Modal>
    </>
  );
}

export function AssessmentTable({
  assessments,
  showLearner = true,
  canManage = true,
}: {
  assessments: AssessmentView[];
  showLearner?: boolean;
  canManage?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [deleting, setDeleting] = useState<number | null>(null);
  const [hidden, setHidden] = useState<number[]>([]);

  const remove = async (id: number) => {
    setDeleting(id);
    setHidden((current) => [...current, id]);
    try {
      const response = await fetch(`/api/assessments/${id}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Delete failed");
      toast.success("Session deleted");
      router.refresh();
    } catch (caught) {
      setHidden((current) => current.filter((entry) => entry !== id));
      toast.error("Could not delete session", caught instanceof Error ? caught.message : undefined);
    } finally {
      setDeleting(null);
    }
  };

  const visible = assessments.filter((assessment) => !hidden.includes(assessment.id));

  if (!visible.length) {
    return (
      <EmptyState
        icon="✎"
        title="No sessions recorded yet"
        description="Start an adaptive quiz to begin knowledge tracing — every response updates latent mastery for the tested skill."
      />
    );
  }

  return (
    <div className="overflow-x-auto scrollbar-thin">
      <table className="w-full min-w-[760px] text-left text-xs">
        <thead className="text-[11px] uppercase tracking-wide text-slate-400">
          <tr>
            <th className="pb-2">Session</th>
            {showLearner ? <th className="pb-2">Learner</th> : null}
            <th className="pb-2">Mode</th>
            <th className="pb-2">Progress</th>
            <th className="pb-2">Score</th>
            <th className="pb-2">Forecast</th>
            <th className="pb-2">Updated</th>
            <th className="pb-2 text-right">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {visible.map((assessment) => (
            <tr key={assessment.id} className={deleting === assessment.id ? "opacity-50" : undefined}>
              <td className="py-2 pr-3">
                <span className="block font-medium text-slate-800">{assessment.title}</span>
                <span className="text-[11px] text-slate-400">
                  {assessment.mode.replace("_", " ")} · ability {pct(assessment.ability)}
                </span>
              </td>
              {showLearner ? <td className="py-2 pr-3 text-slate-500">{assessment.studentName}</td> : null}
              <td className="py-2 pr-3 text-slate-500">{assessment.mode.replace("_", " ")}</td>
              <td className="w-32 py-2 pr-3">
                <ProgressBar value={assessment.items ? assessment.answered / Math.max(1, assessment.items) : 0} />
                <span className="text-[11px] text-slate-400">
                  {assessment.answered}/{assessment.items || assessment.itemTarget} items
                </span>
              </td>
              <td className="py-2 pr-3 text-slate-700">{assessment.score === null ? "—" : pct(assessment.score)}</td>
              <td className="py-2 pr-3">
                {assessment.predictedScore === null ? (
                  <span className="text-slate-400">—</span>
                ) : (
                  <span className="flex items-center gap-1.5">
                    <span className="text-slate-700">{pct(assessment.predictedScore)}</span>
                    <Badge tone={assessment.forecastLabel === "improving" ? "emerald" : assessment.forecastLabel === "declining" ? "rose" : "slate"}>
                      {assessment.forecastLabel ?? "—"}
                    </Badge>
                  </span>
                )}
              </td>
              <td className="py-2 pr-3 text-slate-500">{formatRelative(assessment.completedAt ?? assessment.startedAt)}</td>
              <td className="py-2">
                <div className="flex justify-end gap-2">
                  <a className={buttonClass(assessment.status === "in_progress" ? "primary" : "secondary", "sm")} href={`/dashboard/assessments/${assessment.id}`}>
                    {assessment.status === "in_progress" ? "Resume" : "Review"}
                  </a>
                  {canManage ? (
                    <button className={buttonClass("ghost", "sm", "text-rose-600 hover:bg-rose-50")} onClick={() => remove(assessment.id)}>
                      Delete
                    </button>
                  ) : null}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
