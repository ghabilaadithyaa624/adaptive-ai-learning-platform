"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Modal } from "@/components/modal";
import { useToast } from "@/components/toast";
import { Badge, buttonClass, Card, EmptyState, Field, inputClass, ProgressBar, Spinner } from "@/components/ui";
import type { SkillRow } from "@/lib/queries";
import {
  BLOOM_LEVELS,
  COGNITIVE_COMPLEXITY_LEVELS,
  DIFFICULTY_LABELS,
  QUESTION_STATUSES,
  type QuestionStatus,
} from "@/lib/questions/constants";
import { nextWorkflowActions } from "@/lib/questions/workflow";
import { pct } from "@/lib/utils";

type DistractorMeta = { optionIndex: number; misconception?: string; rationale?: string };

export type QuestionRow = {
  id: number;
  skillId: number;
  subskill: string | null;
  prerequisiteSkillIds: number[];
  stem: string;
  options: string[];
  correctIndex: number;
  difficultyLabel: string;
  difficultyValue: number;
  bloomLevel: string;
  cognitiveComplexity: string;
  explanation: string;
  hints: string[];
  distractorMeta: DistractorMeta[];
  estimatedSeconds: number;
  authorId: number | null;
  authorName: string | null;
  reviewerName: string | null;
  source: string;
  version: number;
  status: string;
  reviewNotes: string | null;
  qualityScore: number;
  exposureCount: number;
  successRate: number;
  discrimination: number;
  calibration: Record<string, unknown>;
  qualityFlags: string[];
  lastAnalyzedAt: string | null;
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

type BankAnalytics = {
  total: number;
  analyzed: number;
  meanQuality: number;
  flagged: number;
  byStatus: Record<string, number>;
  bySource: Record<string, number>;
  flagCounts: Record<string, number>;
};

type ValidationIssue = { code: string; field: string; message: string };

const STATUS_TONE: Record<string, string> = {
  draft: "slate",
  review: "amber",
  validated: "sky",
  published: "emerald",
  monitored: "violet",
  retired: "rose",
};

const FLAG_LABELS: Record<string, string> = {
  insufficient_sample: "Low sample",
  too_easy: "Too easy",
  too_hard: "Too hard",
  low_discrimination: "Weak discrimination",
  negative_discrimination: "Negative discrimination",
  nonfunctional_distractor: "Dead distractor",
  possible_miskey: "Possible mis-key",
  no_responses: "No responses",
};

function qualityTone(score: number): "emerald" | "sky" | "amber" | "rose" {
  if (score >= 0.7) return "emerald";
  if (score >= 0.5) return "sky";
  if (score >= 0.3) return "amber";
  return "rose";
}

function emptyForm(skills: { id: number }[]) {
  return {
    stem: "",
    skillId: skills[0]?.id ? String(skills[0].id) : "",
    subskill: "",
    options: ["", "", "", ""],
    correctIndex: "0",
    difficultyLabel: "medium",
    difficultyValue: "",
    bloomLevel: "apply",
    cognitiveComplexity: "skill_concept",
    explanation: "",
    estimatedSeconds: "60",
    source: "human",
    hints: "",
    prerequisiteSkillIds: [] as number[],
    distractorMisc: ["", "", "", ""],
  };
}

export function QuestionBank({
  questions: initialQuestions,
  skills,
  learners,
  canEdit,
  analytics: initialAnalytics,
}: {
  questions: QuestionRow[];
  skills: Pick<SkillRow, "id" | "name" | "code">[];
  learners: { id: number; name: string }[];
  canEdit: boolean;
  analytics: BankAnalytics;
}) {
  const router = useRouter();
  const toast = useToast();
  const [questions, setQuestions] = useState(initialQuestions);
  const [analytics, setAnalytics] = useState(initialAnalytics);
  const [query, setQuery] = useState("");
  const [skillFilter, setSkillFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<QuestionRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [transitioningId, setTransitioningId] = useState<number | null>(null);
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const [learnerId, setLearnerId] = useState(learners[0]?.id ? String(learners[0].id) : "");
  const [prediction, setPrediction] = useState<Prediction | null>(null);
  const [predicting, setPredicting] = useState<number | null>(null);
  const [issues, setIssues] = useState<{ errors: ValidationIssue[]; warnings: ValidationIssue[] } | null>(null);
  const [form, setForm] = useState(emptyForm(skills));

  const skillName = useMemo(() => new Map(skills.map((s) => [s.id, `${s.code} · ${s.name}`])), [skills]);

  const filtered = useMemo(
    () =>
      questions.filter(
        (q) =>
          (!skillFilter || q.skillId === Number(skillFilter)) &&
          (!statusFilter || q.status === statusFilter) &&
          (q.stem.toLowerCase().includes(query.toLowerCase()) || q.skillName.toLowerCase().includes(query.toLowerCase())),
      ),
    [questions, query, skillFilter, statusFilter],
  );

  const refresh = async () => {
    const res = await fetch("/api/questions");
    if (res.ok) {
      const data = (await res.json()) as { questions: QuestionRow[] };
      setQuestions(data.questions);
    }
    const ares = await fetch("/api/questions/analytics");
    if (ares.ok) {
      const data = (await ares.json()) as { analytics: BankAnalytics };
      setAnalytics(data.analytics);
    }
    router.refresh();
  };

  const openCreate = () => {
    setEditing(null);
    setIssues(null);
    setForm(emptyForm(skills));
    setOpen(true);
  };

  const openEdit = (q: QuestionRow) => {
    setEditing(q);
    setIssues(null);
    const distractorMisc = q.options.map((_, i) => q.distractorMeta.find((d) => d.optionIndex === i)?.misconception ?? "");
    setForm({
      stem: q.stem,
      skillId: String(q.skillId),
      subskill: q.subskill ?? "",
      options: q.options.length ? q.options : ["", "", "", ""],
      correctIndex: String(q.correctIndex),
      difficultyLabel: q.difficultyLabel,
      difficultyValue: String(q.difficultyValue ?? ""),
      bloomLevel: q.bloomLevel,
      cognitiveComplexity: q.cognitiveComplexity,
      explanation: q.explanation,
      estimatedSeconds: String(q.estimatedSeconds),
      source: q.source,
      hints: (q.hints ?? []).join("\n"),
      prerequisiteSkillIds: q.prerequisiteSkillIds ?? [],
      distractorMisc: distractorMisc.length ? distractorMisc : ["", "", "", ""],
    });
    setOpen(true);
  };

  const save = async () => {
    setSaving(true);
    setIssues(null);
    try {
      const options = form.options.map((o) => o.trim());
      const distractorMeta: DistractorMeta[] = [];
      options.forEach((_, i) => {
        const misc = form.distractorMisc[i]?.trim();
        if (misc) distractorMeta.push({ optionIndex: i, misconception: misc });
      });
      const body = {
        stem: form.stem,
        skillId: Number(form.skillId),
        subskill: form.subskill || null,
        options: options.filter((o) => o),
        correctIndex: Number(form.correctIndex),
        difficultyLabel: form.difficultyLabel,
        difficultyValue: form.difficultyValue ? Number(form.difficultyValue) : undefined,
        bloomLevel: form.bloomLevel,
        cognitiveComplexity: form.cognitiveComplexity,
        explanation: form.explanation,
        estimatedSeconds: Number(form.estimatedSeconds),
        source: form.source,
        hints: form.hints.split("\n").map((h) => h.trim()).filter(Boolean),
        prerequisiteSkillIds: form.prerequisiteSkillIds,
        distractorMeta,
      };
      const response = await fetch(editing ? `/api/questions/${editing.id}` : "/api/questions", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = (await response.json()) as { error?: string; errors?: ValidationIssue[]; warnings?: ValidationIssue[]; requeued?: boolean };
      if (!response.ok) {
        if (result.errors) setIssues({ errors: result.errors, warnings: result.warnings ?? [] });
        throw new Error(result.error ?? "Save failed");
      }
      if (result.warnings?.length) {
        toast.info("Saved with warnings", result.warnings.map((w) => w.message).join(" "));
      } else if (editing && result.requeued) {
        toast.success("Item updated", "Content changed — version bumped and returned to review.");
      } else {
        toast.success(editing ? "Item updated" : "Item drafted", editing ? undefined : "New items enter as Draft and must pass review before publishing.");
      }
      setOpen(false);
      await refresh();
    } catch (caught) {
      toast.error("Could not save item", caught instanceof Error ? caught.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  const transition = async (q: QuestionRow, to: QuestionStatus) => {
    setTransitioningId(q.id);
    try {
      const response = await fetch(`/api/questions/${q.id}/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to }),
      });
      const result = (await response.json()) as { error?: string; warnings?: ValidationIssue[] };
      if (!response.ok) throw new Error(result.error ?? "Transition failed");
      toast.success(`Moved to ${to}`, result.warnings?.length ? `${result.warnings.length} advisory warning(s).` : undefined);
      await refresh();
    } catch (caught) {
      toast.error("Transition blocked", caught instanceof Error ? caught.message : undefined);
    } finally {
      setTransitioningId(null);
    }
  };

  const runAnalytics = async () => {
    setAnalyzing(true);
    try {
      const response = await fetch("/api/questions/analytics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const result = (await response.json()) as { error?: string; report?: { itemsUpdated: number; summary: { meanQuality: number } }; questions?: QuestionRow[]; analytics?: BankAnalytics };
      if (!response.ok) throw new Error(result.error ?? "Analytics failed");
      if (result.questions) setQuestions(result.questions);
      if (result.analytics) setAnalytics(result.analytics);
      toast.success("Item analytics recomputed", `${result.report?.itemsUpdated ?? 0} items · mean quality ${pct(result.report?.summary.meanQuality ?? 0)}`);
    } catch (caught) {
      toast.error("Analytics failed", caught instanceof Error ? caught.message : undefined);
    } finally {
      setAnalyzing(false);
    }
  };

  const remove = async (id: number) => {
    setSaving(true);
    try {
      const response = await fetch(`/api/questions/${id}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Delete failed");
      toast.success("Item deleted");
      setConfirmId(null);
      await refresh();
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

  const calibrationB = (q: QuestionRow) => {
    const b = (q.calibration as { b?: number | null } | null)?.b;
    return typeof b === "number" ? b.toFixed(2) : "—";
  };

  return (
    <div className="space-y-4">
      {/* aggregate analytics */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Mean item quality</p>
          <p className="mt-1 text-2xl font-semibold text-slate-900">{pct(analytics.meanQuality)}</p>
          <p className="mt-1 text-[11px] text-slate-500">{analytics.analyzed} of {analytics.total} items analysed</p>
        </Card>
        <Card>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Workflow</p>
          <div className="mt-1 flex flex-wrap gap-1">
            {QUESTION_STATUSES.map((s) =>
              analytics.byStatus[s] ? (
                <Badge key={s} tone={STATUS_TONE[s] as never}>
                  {s} {analytics.byStatus[s]}
                </Badge>
              ) : null,
            )}
          </div>
        </Card>
        <Card>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Flagged for review</p>
          <p className="mt-1 text-2xl font-semibold text-slate-900">{analytics.flagged}</p>
          <p className="mt-1 text-[11px] text-slate-500">
            {Object.entries(analytics.flagCounts)
              .filter(([k]) => k !== "insufficient_sample")
              .slice(0, 3)
              .map(([k, v]) => `${FLAG_LABELS[k] ?? k}: ${v}`)
              .join(" · ") || "no quality flags"}
          </p>
        </Card>
        <Card>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">AI-authored items</p>
          <p className="mt-1 text-2xl font-semibold text-slate-900">{analytics.bySource.ai ?? 0}</p>
          <p className="mt-1 text-[11px] text-slate-500">reviewed like every other item — never auto-published</p>
        </Card>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-slate-500">
          <span className="mb-1 block">Search</span>
          <input className={`${inputClass} w-52 py-2`} placeholder="Stem or skill" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <label className="text-xs text-slate-500">
          <span className="mb-1 block">Skill</span>
          <select className={`${inputClass} w-56 py-2`} value={skillFilter} onChange={(e) => setSkillFilter(e.target.value)}>
            <option value="">All skills</option>
            {skills.map((s) => (
              <option key={s.id} value={s.id}>
                {s.code} · {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-slate-500">
          <span className="mb-1 block">Status</span>
          <select className={`${inputClass} w-40 py-2`} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">All statuses</option>
            {QUESTION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-slate-500">
          <span className="mb-1 block">Predict for learner</span>
          <select className={`${inputClass} w-44 py-2`} value={learnerId} onChange={(e) => setLearnerId(e.target.value)}>
            {learners.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        {canEdit ? (
          <>
            <button className={buttonClass("secondary", "md")} onClick={runAnalytics} disabled={analyzing}>
              {analyzing ? <Spinner /> : null}
              {analyzing ? "Analysing…" : "Run item analytics"}
            </button>
            <button className={buttonClass("primary", "md")} onClick={openCreate}>
              + New item
            </button>
          </>
        ) : null}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.7fr_1fr]">
        <div className="space-y-3">
          {filtered.length ? (
            filtered.slice(0, 25).map((q) => (
              <Card key={q.id} className="animate-in">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge tone={STATUS_TONE[q.status] as never}>{q.status}</Badge>
                      <Badge tone="slate">{q.difficultyLabel}</Badge>
                      <Badge tone="sky">{q.bloomLevel}</Badge>
                      <Badge tone="slate">DoK: {q.cognitiveComplexity.replace("_", " ")}</Badge>
                      {q.source === "ai" ? <Badge tone="amber">AI</Badge> : null}
                      <span className="text-[11px] text-slate-500">
                        {q.subjectName} · {q.skillName}
                        {q.subskill ? ` › ${q.subskill}` : ""} · v{q.version}
                      </span>
                    </div>
                    <p className="mt-2 text-sm font-medium text-slate-800">{q.stem}</p>
                    <ul className="mt-2 grid gap-1 sm:grid-cols-2">
                      {q.options.map((option, index) => {
                        const misc = q.distractorMeta.find((d) => d.optionIndex === index)?.misconception;
                        return (
                          <li
                            key={`${q.id}-${index}`}
                            className={`rounded-lg px-2 py-1 text-[11px] ${
                              index === q.correctIndex ? "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200" : "bg-slate-50 text-slate-600"
                            }`}
                          >
                            {String.fromCharCode(65 + index)}. {option}
                            {misc ? <span className="block text-[10px] text-slate-400">↳ {misc}</span> : null}
                          </li>
                        );
                      })}
                    </ul>

                    {/* psychometrics row */}
                    <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-slate-500 sm:grid-cols-4">
                      <span>
                        Quality{" "}
                        <span className="font-semibold" style={{ color: undefined }}>
                          {q.lastAnalyzedAt ? pct(q.qualityScore) : "—"}
                        </span>
                      </span>
                      <span>Discrimination <span className="font-semibold text-slate-700">{q.lastAnalyzedAt ? q.discrimination.toFixed(2) : "—"}</span></span>
                      <span>Success <span className="font-semibold text-slate-700">{q.attempts ? pct(q.pCorrect) : "—"}</span></span>
                      <span>Exposure <span className="font-semibold text-slate-700">{q.exposureCount || q.attempts}</span></span>
                      <span>IRT b <span className="font-semibold text-slate-700">{calibrationB(q)}</span></span>
                      <span>Est. time <span className="font-semibold text-slate-700">{q.estimatedSeconds}s</span></span>
                      <span className="col-span-2">
                        Author <span className="font-semibold text-slate-700">{q.authorName ?? "—"}</span>
                        {q.reviewerName ? <span className="text-slate-400"> · reviewed by {q.reviewerName}</span> : null}
                      </span>
                    </div>
                    {q.lastAnalyzedAt ? (
                      <ProgressBar value={q.qualityScore} tone={qualityTone(q.qualityScore)} className="mt-1.5" />
                    ) : null}

                    {q.qualityFlags.length ? (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {q.qualityFlags.map((f) => (
                          <span key={f} className="rounded-full bg-rose-50 px-2 py-0.5 text-[10px] font-medium text-rose-600 ring-1 ring-inset ring-rose-100">
                            {FLAG_LABELS[f] ?? f}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>

                  <div className="flex shrink-0 flex-col gap-2">
                    <button className={buttonClass("secondary", "sm")} onClick={() => predict(q.id)} disabled={predicting === q.id}>
                      {predicting === q.id ? <Spinner /> : null}
                      Predict
                    </button>
                    {canEdit ? (
                      <>
                        {nextWorkflowActions(q.status as QuestionStatus).map((action) => (
                          <button
                            key={action.to}
                            className={buttonClass("ghost", "sm")}
                            onClick={() => transition(q, action.to)}
                            disabled={transitioningId === q.id}
                            title={`Move to ${action.to}`}
                          >
                            {transitioningId === q.id ? <Spinner /> : null}
                            {action.label}
                          </button>
                        ))}
                        <button className={buttonClass("ghost", "sm")} onClick={() => openEdit(q)}>
                          Edit
                        </button>
                        <button className={buttonClass("ghost", "sm", "text-rose-600 hover:bg-rose-50")} onClick={() => setConfirmId(q.id)}>
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
          {filtered.length > 25 ? <p className="text-[11px] text-slate-400">Showing 25 of {filtered.length} matching items.</p> : null}
        </div>

        <div className="space-y-4">
          <Card>
            <p className="text-xs font-semibold text-slate-800">Difficulty prediction</p>
            <p className="mt-1 text-[11px] text-slate-500">
              The classifier estimates P(correct) for the selected learner and simulates one-band-easier / harder variants.
            </p>
            {prediction ? (
              <div className="mt-3 space-y-3">
                <div className="rounded-xl bg-slate-50 p-3 text-[11px] text-slate-600">
                  <p className="font-semibold text-slate-700">{prediction.skillName}</p>
                  <p>
                    latent mastery {pct(prediction.mastery)} · session ability {pct(prediction.ability)} · evidence {pct(prediction.evidence)}
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
                    <p className="mt-0.5 text-[10px] text-slate-400">
                      {entry.label.label} — {entry.label.hint}
                    </p>
                  </div>
                ))}
                <p className="rounded-lg bg-indigo-50/70 px-3 py-2 text-[11px] text-indigo-700 ring-1 ring-inset ring-indigo-100">{prediction.recommendation}</p>
              </div>
            ) : (
              <p className="mt-3 rounded-lg border border-dashed border-slate-200 px-3 py-6 text-center text-[11px] text-slate-400">
                Select an item and learner, then run a prediction.
              </p>
            )}
          </Card>

          <Card>
            <p className="text-xs font-semibold text-slate-800">Item-quality guide</p>
            <ul className="mt-2 space-y-1 text-[11px] text-slate-600">
              <li><b>Quality score</b> blends discrimination, facility, working distractors, sample size and calibration.</li>
              <li><b>Discrimination</b> (point-biserial): ≥0.30 strong, 0.15–0.30 fair, &lt;0.15 weak, &lt;0 review the key.</li>
              <li><b>IRT b</b> is a Rasch difficulty approximation — a full 2PL/3PL calibration can replace it without any schema change.</li>
              <li>Only <b>published</b> and <b>monitored</b> items are delivered to learners.</li>
            </ul>
          </Card>
        </div>
      </div>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? `Edit item (v${editing.version})` : "New item"}
        description="New items enter as Draft and must pass validation + human review before they can be published. AI-generated items are never auto-trusted."
        size="lg"
        footer={
          <>
            <button className={buttonClass("secondary", "md")} onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button className={buttonClass("primary", "md")} onClick={save} disabled={saving}>
              {saving ? "Saving…" : editing ? "Save item" : "Create draft"}
            </button>
          </>
        }
      >
        {issues?.errors.length ? (
          <div className="mb-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-[11px] text-rose-700">
            <p className="font-semibold">Validation failed</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {issues.errors.map((e, i) => (
                <li key={i}>{e.message}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {issues?.warnings.length ? (
          <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-[11px] text-amber-700">
            <p className="font-semibold">Warnings</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {issues.warnings.map((w, i) => (
                <li key={i}>{w.message}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Stem" className="sm:col-span-2">
            <textarea className={`${inputClass} h-20`} value={form.stem} onChange={(e) => setForm({ ...form, stem: e.target.value })} />
          </Field>
          <Field label="Skill">
            <select className={inputClass} value={form.skillId} onChange={(e) => setForm({ ...form, skillId: e.target.value })}>
              {skills.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code} · {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Subskill (optional)">
            <input className={inputClass} value={form.subskill} onChange={(e) => setForm({ ...form, subskill: e.target.value })} placeholder="finer-grained topic" />
          </Field>
          <Field label="Difficulty band">
            <select className={inputClass} value={form.difficultyLabel} onChange={(e) => setForm({ ...form, difficultyLabel: e.target.value })}>
              {DIFFICULTY_LABELS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Difficulty value (0–1, optional)">
            <input
              type="number"
              step="0.05"
              min="0"
              max="1"
              className={inputClass}
              value={form.difficultyValue}
              onChange={(e) => setForm({ ...form, difficultyValue: e.target.value })}
              placeholder="auto from band"
            />
          </Field>
          <Field label="Bloom level">
            <select className={inputClass} value={form.bloomLevel} onChange={(e) => setForm({ ...form, bloomLevel: e.target.value })}>
              {BLOOM_LEVELS.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Cognitive complexity (DoK)">
            <select className={inputClass} value={form.cognitiveComplexity} onChange={(e) => setForm({ ...form, cognitiveComplexity: e.target.value })}>
              {COGNITIVE_COMPLEXITY_LEVELS.map((c) => (
                <option key={c} value={c}>
                  {c.replace("_", " ")}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Estimated seconds">
            <input type="number" className={inputClass} value={form.estimatedSeconds} onChange={(e) => setForm({ ...form, estimatedSeconds: e.target.value })} />
          </Field>
          <Field label="Source">
            <select className={inputClass} value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} disabled={Boolean(editing)}>
              <option value="human">human</option>
              <option value="ai">ai</option>
              <option value="imported">imported</option>
            </select>
          </Field>

          {form.options.map((option, index) => (
            <Field key={index} label={`Option ${String.fromCharCode(65 + index)}`} className="sm:col-span-2">
              <div className="flex items-center gap-2">
                <input
                  className={inputClass}
                  value={option}
                  onChange={(e) => {
                    const next = [...form.options];
                    next[index] = e.target.value;
                    setForm({ ...form, options: next });
                  }}
                />
                <label className="flex shrink-0 items-center gap-1 text-[11px] text-slate-500">
                  <input type="radio" name="correct" checked={Number(form.correctIndex) === index} onChange={() => setForm({ ...form, correctIndex: String(index) })} />
                  key
                </label>
              </div>
              {Number(form.correctIndex) !== index ? (
                <input
                  className={`${inputClass} mt-1 text-[11px]`}
                  placeholder="Distractor targets which misconception? (optional)"
                  value={form.distractorMisc[index] ?? ""}
                  onChange={(e) => {
                    const next = [...form.distractorMisc];
                    next[index] = e.target.value;
                    setForm({ ...form, distractorMisc: next });
                  }}
                />
              ) : null}
            </Field>
          ))}

          <Field label="Hints (one per line)" className="sm:col-span-2">
            <textarea className={`${inputClass} h-16`} value={form.hints} onChange={(e) => setForm({ ...form, hints: e.target.value })} placeholder="Progressive hints shown before the answer" />
          </Field>
          <Field label="Prerequisite skills" className="sm:col-span-2">
            <select
              multiple
              className={`${inputClass} h-24`}
              value={form.prerequisiteSkillIds.map(String)}
              onChange={(e) => setForm({ ...form, prerequisiteSkillIds: Array.from(e.target.selectedOptions, (o) => Number(o.value)) })}
            >
              {skills
                .filter((s) => s.id !== Number(form.skillId))
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {skillName.get(s.id)}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Explanation" className="sm:col-span-2">
            <textarea className={`${inputClass} h-16`} value={form.explanation} onChange={(e) => setForm({ ...form, explanation: e.target.value })} />
          </Field>
        </div>
      </Modal>

      <Modal open={confirmId !== null} onClose={() => setConfirmId(null)} title="Delete item" size="sm">
        <p className="text-xs text-slate-600">This permanently removes the item, its analytics history and logged responses. Consider retiring it instead.</p>
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
