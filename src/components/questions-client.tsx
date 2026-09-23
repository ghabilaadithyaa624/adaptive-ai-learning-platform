"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Modal } from "@/components/modal";
import { useToast } from "@/components/toast";
import { Badge, buttonClass, Card, EmptyState, Field, inputClass, ProgressBar, Spinner } from "@/components/ui";
import type { SkillRow } from "@/lib/queries";
import { pct } from "@/lib/utils";

type QuestionRow = {
  id: number;
  skillId: number;
  stem: string;
  options: string[];
  correctIndex: number;
  difficultyLabel: string;
  bloomLevel: string;
  explanation: string;
  estimatedSeconds: number;
  isActive: boolean;
  skillName: string;
  subjectName: string;
  subjectColor: string;
  attempts: number;
  correct: number;
  pCorrect: number;
};

type Prediction = {
  questionId: number;
  skillName: string;
  mastery: number;
  ability: number;
  evidence: number;
  modelVersion: string;
  predictions: { name: string; probability: number; label: { label: string; tone: string; hint: string } }[];
  recommendation: string;
};

const DIFFICULTIES = ["easy", "medium", "hard", "expert"];
const BLOOMS = ["remember", "understand", "apply", "analyze", "evaluate", "create"];

export function QuestionBank({
  questions,
  skills,
  learners,
  canEdit,
}: {
  questions: QuestionRow[];
  skills: Pick<SkillRow, "id" | "name" | "code">[];
  learners: { id: number; name: string }[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [skillFilter, setSkillFilter] = useState("");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<QuestionRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const [learnerId, setLearnerId] = useState(learners[0]?.id ? String(learners[0].id) : "");
  const [prediction, setPrediction] = useState<Prediction | null>(null);
  const [predicting, setPredicting] = useState<number | null>(null);
  const [form, setForm] = useState({
    stem: "",
    skillId: skills[0]?.id ? String(skills[0].id) : "",
    options: ["", "", "", ""],
    correctIndex: "0",
    difficultyLabel: "medium",
    bloomLevel: "apply",
    explanation: "",
    estimatedSeconds: "60",
    isActive: true,
  });

  const filtered = useMemo(
    () =>
      questions.filter(
        (question) =>
          (!skillFilter || question.skillId === Number(skillFilter)) &&
          (question.stem.toLowerCase().includes(query.toLowerCase()) || question.skillName.toLowerCase().includes(query.toLowerCase())),
      ),
    [questions, query, skillFilter],
  );

  const openCreate = () => {
    setEditing(null);
    setForm({
      stem: "",
      skillId: skills[0]?.id ? String(skills[0].id) : "",
      options: ["", "", "", ""],
      correctIndex: "0",
      difficultyLabel: "medium",
      bloomLevel: "apply",
      explanation: "",
      estimatedSeconds: "60",
      isActive: true,
    });
    setOpen(true);
  };

  const openEdit = (question: QuestionRow) => {
    setEditing(question);
    setForm({
      stem: question.stem,
      skillId: String(question.skillId),
      options: question.options.length ? question.options : ["", "", "", ""],
      correctIndex: String(question.correctIndex),
      difficultyLabel: question.difficultyLabel,
      bloomLevel: question.bloomLevel,
      explanation: question.explanation,
      estimatedSeconds: String(question.estimatedSeconds),
      isActive: question.isActive,
    });
    setOpen(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      const response = await fetch(editing ? `/api/questions/${editing.id}` : "/api/questions", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          skillId: Number(form.skillId),
          correctIndex: Number(form.correctIndex),
          estimatedSeconds: Number(form.estimatedSeconds),
          options: form.options.filter((option) => option.trim()),
        }),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Save failed");
      toast.success(editing ? "Item updated" : "Item added", "Difficulty classifier features refreshed.");
      setOpen(false);
      router.refresh();
    } catch (caught) {
      toast.error("Could not save item", caught instanceof Error ? caught.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: number) => {
    setSaving(true);
    try {
      const response = await fetch(`/api/questions/${id}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Delete failed");
      toast.success("Item deleted");
      setConfirmId(null);
      router.refresh();
    } catch (caught) {
      toast.error("Could not delete item", caught instanceof Error ? caught.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  const predict = async (questionId: number) => {
    if (!learnerId) {
      toast.error("Pick a learner for prediction");
      return;
    }
    setPredicting(questionId);
    try {
      const response = await fetch("/api/ml", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "predict", studentId: Number(learnerId), questionId }),
      });
      const payload = (await response.json()) as Prediction & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Prediction failed");
      setPrediction(payload);
      toast.info("Difficulty predicted", `${payload.skillName} · model ${payload.modelVersion}`);
    } catch (caught) {
      toast.error("Prediction failed", caught instanceof Error ? caught.message : undefined);
    } finally {
      setPredicting(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-slate-500">
          <span className="mb-1 block">Search</span>
          <input className={`${inputClass} w-56 py-2`} placeholder="Stem or skill" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <label className="text-xs text-slate-500">
          <span className="mb-1 block">Skill</span>
          <select className={`${inputClass} w-64 py-2`} value={skillFilter} onChange={(event) => setSkillFilter(event.target.value)}>
            <option value="">All skills</option>
            {skills.map((skill) => (
              <option key={skill.id} value={skill.id}>
                {skill.code} · {skill.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-slate-500">
          <span className="mb-1 block">Predict for learner</span>
          <select className={`${inputClass} w-48 py-2`} value={learnerId} onChange={(event) => setLearnerId(event.target.value)}>
            {learners.map((learner) => (
              <option key={learner.id} value={learner.id}>
                {learner.name}
              </option>
            ))}
          </select>
        </label>
        {canEdit ? (
          <button className={buttonClass("primary", "md")} onClick={openCreate}>
            + New item
          </button>
        ) : null}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <div className="space-y-3">
          {filtered.length ? (
            filtered.slice(0, 20).map((question) => (
              <Card key={question.id} className="animate-in">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="slate">{question.difficultyLabel}</Badge>
                      <Badge tone="sky">{question.bloomLevel}</Badge>
                      {question.isActive ? <Badge tone="emerald">active</Badge> : <Badge tone="rose">paused</Badge>}
                      <span className="text-[11px] text-slate-500">
                        {question.subjectName} · {question.skillName}
                      </span>
                    </div>
                    <p className="mt-2 text-sm font-medium text-slate-800">{question.stem}</p>
                    <ul className="mt-2 grid gap-1 sm:grid-cols-2">
                      {question.options.map((option, index) => (
                        <li
                          key={`${question.id}-${index}`}
                          className={`rounded-lg px-2 py-1 text-[11px] ${
                            index === question.correctIndex ? "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200" : "bg-slate-50 text-slate-600"
                          }`}
                        >
                          {String.fromCharCode(65 + index)}. {option}
                        </li>
                      ))}
                    </ul>
                    <p className="mt-2 text-[11px] text-slate-500">
                      {question.attempts} responses · observed accuracy {pct(question.pCorrect)} ·{" "}
                      {question.explanation || "no explanation stored"}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col gap-2">
                    <button className={buttonClass("secondary", "sm")} onClick={() => predict(question.id)} disabled={predicting === question.id}>
                      {predicting === question.id ? <Spinner /> : null}
                      Predict difficulty
                    </button>
                    {canEdit ? (
                      <>
                        <button className={buttonClass("ghost", "sm")} onClick={() => openEdit(question)}>
                          Edit
                        </button>
                        <button className={buttonClass("ghost", "sm", "text-rose-600 hover:bg-rose-50")} onClick={() => setConfirmId(question.id)}>
                          Delete
                        </button>
                      </>
                    ) : null}
                  </div>
                </div>
              </Card>
            ))
          ) : (
            <EmptyState icon="?" title="No items match" description="Clear the filters or author a new item for this skill." />
          )}
          {filtered.length > 20 ? (
            <p className="text-[11px] text-slate-400">Showing the 20 most recent of {filtered.length} matching items.</p>
          ) : null}
        </div>

        <div className="space-y-4">
          <Card>
            <p className="text-xs font-semibold text-slate-800">Difficulty prediction</p>
            <p className="mt-1 text-[11px] text-slate-500">
              The classifier estimates P(correct) for the selected learner and simulates how a one-band easier or harder
              variant would score.
            </p>
            {prediction ? (
              <div className="mt-3 space-y-3">
                <div className="rounded-xl bg-slate-50 p-3 text-[11px] text-slate-600">
                  <p className="font-semibold text-slate-700">{prediction.skillName}</p>
                  <p>
                    latent mastery {pct(prediction.mastery)} · session ability {pct(prediction.ability)} · evidence{" "}
                    {pct(prediction.evidence)}
                  </p>
                  <p className="mt-1 text-slate-400">model {prediction.modelVersion}</p>
                </div>
                {prediction.predictions.map((entry) => (
                  <div key={entry.name}>
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-slate-600">{entry.name}</span>
                      <span className="font-semibold text-slate-700">{pct(entry.probability)}</span>
                    </div>
                    <ProgressBar
                      value={entry.probability}
                      tone={entry.probability >= 0.88 ? "emerald" : entry.probability >= 0.6 ? "sky" : entry.probability >= 0.32 ? "amber" : "rose"}
                      className="mt-1"
                    />
                    <p className="mt-0.5 text-[10px] text-slate-400">{entry.label.label} — {entry.label.hint}</p>
                  </div>
                ))}
                <p className="rounded-lg bg-indigo-50/70 px-3 py-2 text-[11px] text-indigo-700 ring-1 ring-inset ring-indigo-100">
                  {prediction.recommendation}
                </p>
              </div>
            ) : (
              <p className="mt-3 rounded-lg border border-dashed border-slate-200 px-3 py-6 text-center text-[11px] text-slate-400">
                Select an item and learner, then run a prediction.
              </p>
            )}
          </Card>

          <Card>
            <p className="text-xs font-semibold text-slate-800">Calibration snapshot</p>
            <ul className="mt-2 space-y-1.5 text-[11px] text-slate-600">
              {filtered.slice(0, 6).map((question) => (
                <li key={`cal-${question.id}`} className="flex items-center justify-between gap-2">
                  <span className="truncate" title={question.stem}>
                    {question.skillName}
                  </span>
                  <span className="shrink-0 text-slate-500">
                    obs {pct(question.pCorrect)} ({question.attempts})
                  </span>
                </li>
              ))}
              {!filtered.length ? <li className="text-slate-400">No items to calibrate yet.</li> : null}
            </ul>
          </Card>
        </div>
      </div>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? "Edit item" : "New item"}
        description="Items are candidates for adaptive selection — the classifier learns difficulty from their response history."
        size="lg"
        footer={
          <>
            <button className={buttonClass("secondary", "md")} onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button className={buttonClass("primary", "md")} onClick={save} disabled={saving}>
              {saving ? "Saving…" : editing ? "Save item" : "Add item"}
            </button>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Stem" className="sm:col-span-2">
            <textarea className={`${inputClass} h-20`} value={form.stem} onChange={(event) => setForm({ ...form, stem: event.target.value })} />
          </Field>
          <Field label="Skill">
            <select className={inputClass} value={form.skillId} onChange={(event) => setForm({ ...form, skillId: event.target.value })}>
              {skills.map((skill) => (
                <option key={skill.id} value={skill.id}>
                  {skill.code} · {skill.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Estimated seconds">
            <input
              type="number"
              className={inputClass}
              value={form.estimatedSeconds}
              onChange={(event) => setForm({ ...form, estimatedSeconds: event.target.value })}
            />
          </Field>
          <Field label="Difficulty band">
            <select className={inputClass} value={form.difficultyLabel} onChange={(event) => setForm({ ...form, difficultyLabel: event.target.value })}>
              {DIFFICULTIES.map((difficulty) => (
                <option key={difficulty} value={difficulty}>
                  {difficulty}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Bloom level">
            <select className={inputClass} value={form.bloomLevel} onChange={(event) => setForm({ ...form, bloomLevel: event.target.value })}>
              {BLOOMS.map((bloom) => (
                <option key={bloom} value={bloom}>
                  {bloom}
                </option>
              ))}
            </select>
          </Field>
          {form.options.map((option, index) => (
            <Field key={index} label={`Option ${String.fromCharCode(65 + index)}`}>
              <div className="flex items-center gap-2">
                <input
                  className={inputClass}
                  value={option}
                  onChange={(event) => {
                    const next = [...form.options];
                    next[index] = event.target.value;
                    setForm({ ...form, options: next });
                  }}
                />
                <label className="flex shrink-0 items-center gap-1 text-[11px] text-slate-500">
                  <input
                    type="radio"
                    name="correct"
                    checked={Number(form.correctIndex) === index}
                    onChange={() => setForm({ ...form, correctIndex: String(index) })}
                  />
                  key
                </label>
              </div>
            </Field>
          ))}
          <Field label="Explanation" className="sm:col-span-2">
            <textarea
              className={`${inputClass} h-16`}
              value={form.explanation}
              onChange={(event) => setForm({ ...form, explanation: event.target.value })}
            />
          </Field>
          <label className="flex items-center gap-2 text-xs text-slate-600">
            <input type="checkbox" checked={form.isActive} onChange={(event) => setForm({ ...form, isActive: event.target.checked })} />
            Available for adaptive selection
          </label>
        </div>
      </Modal>

      <Modal open={confirmId !== null} onClose={() => setConfirmId(null)} title="Delete item" size="sm">
        <p className="text-xs text-slate-600">This removes the item and its logged responses from the training set.</p>
        <div className="mt-4 flex justify-end gap-2">
          <button className={buttonClass("secondary", "md")} onClick={() => setConfirmId(null)}>
            Cancel
          </button>
          <button className={buttonClass("danger", "md")} onClick={() => confirmId && remove(confirmId)} disabled={saving}>
            {saving ? "Deleting…" : "Delete item"}
          </button>
        </div>
      </Modal>
    </div>
  );
}
