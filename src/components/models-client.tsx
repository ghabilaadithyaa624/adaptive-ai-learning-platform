"use client";

import { useState } from "react";
import { BarList } from "@/components/charts";
import { useToast } from "@/components/toast";
import { Badge, buttonClass, Card, CardHeader, EmptyState, Field, inputClass, ProgressBar, Spinner } from "@/components/ui";
import type { ModelView } from "@/lib/queries";
import { pct } from "@/lib/utils";

type Prediction = {
  questionId: number;
  skillName: string;
  mastery: number;
  ability: number;
  evidence: number;
  modelVersion: string;
  predictions: { name: string; probability: number; label: { label: string; hint: string } }[];
  recommendation: string;
};

type Calibration = {
  samples: number;
  observedAccuracy: number;
  meanPredicted: number;
  calibrationGap: number;
  truePositives: number;
  error?: string;
};

export function ModelsWorkbench({
  models: initialModels,
  learners,
  questions,
  trainingSamples,
}: {
  models: ModelView[];
  learners: { id: number; name: string }[];
  questions: { id: number; stem: string; skillName: string }[];
  trainingSamples: number;
}) {
  const toast = useToast();
  const [models, setModels] = useState(initialModels);
  const [training, setTraining] = useState(false);
  const [evaluating, setEvaluating] = useState(false);
  const [calibration, setCalibration] = useState<Calibration | null>(null);
  const [predicting, setPredicting] = useState(false);
  const [prediction, setPrediction] = useState<Prediction | null>(null);
  const [form, setForm] = useState({
    studentId: learners[0]?.id ? String(learners[0].id) : "",
    questionId: questions[0]?.id ? String(questions[0].id) : "",
  });

  const classifier = models.find((model) => model.kind === "classifier");

  const retrain = async () => {
    setTraining(true);
    try {
      const response = await fetch("/api/ml", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "train" }),
      });
      const payload = (await response.json()) as { models?: ModelView[]; model?: { metrics: Record<string, number>; samples: number }; error?: string };
      if (!response.ok || !payload.models) throw new Error(payload.error ?? "Training failed");
      setModels(payload.models);
      toast.success(
        "Classifier retrained",
        `${payload.model?.samples ?? 0} responses · accuracy ${pct(payload.model?.metrics.accuracy ?? 0)} · AUC ${(payload.model?.metrics.auc ?? 0).toFixed(3)}`,
      );
    } catch (caught) {
      toast.error("Training failed", caught instanceof Error ? caught.message : undefined);
    } finally {
      setTraining(false);
    }
  };

  const evaluate = async () => {
    setEvaluating(true);
    try {
      const response = await fetch("/api/ml", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "evaluate" }),
      });
      const payload = (await response.json()) as Calibration;
      if (!response.ok || payload.error) throw new Error(payload.error ?? "Evaluation failed");
      setCalibration(payload);
      toast.info("Calibration computed", `observed ${pct(payload.observedAccuracy)} vs predicted ${pct(payload.meanPredicted)}`);
    } catch (caught) {
      toast.error("Evaluation failed", caught instanceof Error ? caught.message : undefined);
    } finally {
      setEvaluating(false);
    }
  };

  const predict = async () => {
    setPredicting(true);
    try {
      const response = await fetch("/api/ml", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "predict", studentId: Number(form.studentId), questionId: Number(form.questionId) }),
      });
      const payload = (await response.json()) as Prediction & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Prediction failed");
      setPrediction(payload);
      toast.info("Prediction ready", `${payload.skillName} · ${payload.modelVersion}`);
    } catch (caught) {
      toast.error("Prediction failed", caught instanceof Error ? caught.message : undefined);
    } finally {
      setPredicting(false);
    }
  };

  const weights = classifier
    ? (classifier.params as { featureNames?: string[]; weights?: number[] }).featureNames?.map((name, index) => ({
        label: name,
        value: Math.abs((classifier.params as { weights?: number[] }).weights?.[index] ?? 0),
        color: ((classifier.params as { weights?: number[] }).weights?.[index] ?? 0) >= 0 ? "#4f46e5" : "#e11d48",
        hint: `signed weight ${((classifier.params as { weights?: number[] }).weights?.[index] ?? 0).toFixed(3)}`,
      })) ?? []
    : [];

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Registered models</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900">{models.length}</p>
          <p className="mt-1 text-xs text-slate-500">{trainingSamples} logged responses available for training</p>
        </Card>
        <Card>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Classifier accuracy</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900">{classifier ? pct(classifier.metrics.accuracy ?? 0) : "—"}</p>
          <p className="mt-1 text-xs text-slate-500">
            AUC {(classifier?.metrics.auc ?? 0).toFixed(3)} · logloss {(classifier?.metrics.logLoss ?? 0).toFixed(3)}
          </p>
        </Card>
        <Card>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Brier score</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900">{(classifier?.metrics.brier ?? 0).toFixed(3)}</p>
          <p className="mt-1 text-xs text-slate-500">
            precision {pct(classifier?.metrics.precision ?? 0)} · recall {pct(classifier?.metrics.recall ?? 0)}
          </p>
        </Card>
        <Card>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Held-out test set</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900">{classifier?.metrics.testSize ?? 0}</p>
          <p className="mt-1 text-xs text-slate-500">samples reserved by the deterministic 80/20 split</p>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Card>
          <CardHeader
            title="Model registry"
            subtitle="Knowledge tracer snapshots and the difficulty classifier, retrained on demand"
            action={
              <div className="flex flex-wrap gap-2">
                <button className={buttonClass("primary", "sm")} onClick={retrain} disabled={training}>
                  {training ? <Spinner className="border-white/40 border-t-white" /> : null}
                  {training ? "Training…" : "Retrain classifier"}
                </button>
                <button className={buttonClass("secondary", "sm")} onClick={evaluate} disabled={evaluating}>
                  {evaluating ? "Evaluating…" : "Evaluate calibration"}
                </button>
              </div>
            }
          />
          <ul className="mt-4 space-y-3">
            {models.map((model) => (
              <li key={model.id} className="rounded-xl border border-slate-200 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-slate-800">{model.name}</p>
                    <p className="text-[11px] text-slate-500">
                      {model.kind} · {model.version} · trained {new Date(model.trainedAt).toLocaleString()}
                    </p>
                  </div>
                  <Badge tone="violet">{model.samples} samples</Badge>
                </div>
                <div className="mt-2 grid gap-1 text-[11px] text-slate-500 sm:grid-cols-3">
                  {Object.entries(model.metrics).map(([key, value]) => (
                    <span key={key}>
                      {key}: <span className="font-semibold text-slate-700">{typeof value === "number" ? value.toFixed(3) : String(value)}</span>
                    </span>
                  ))}
                </div>
              </li>
            ))}
            {!models.length ? <EmptyState icon="⚙" title="No models registered" description="Run a retraining job to persist the first classifier snapshot." /> : null}
          </ul>

          {calibration ? (
            <div className="mt-4 rounded-xl border border-slate-200 p-3">
              <p className="text-xs font-semibold text-slate-800">Calibration report</p>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                <div>
                  <div className="flex justify-between text-[11px] text-slate-500">
                    <span>predicted {pct(calibration.meanPredicted)}</span>
                    <span>observed {pct(calibration.observedAccuracy)}</span>
                  </div>
                  <ProgressBar value={calibration.meanPredicted} tone="indigo" className="mt-1" />
                  <ProgressBar value={calibration.observedAccuracy} tone="emerald" className="mt-1" />
                </div>
                <div className="text-[11px] text-slate-600">
                  <p>{calibration.samples} graded responses</p>
                  <p>{calibration.truePositives} correct outcomes</p>
                  <p>
                    Calibration gap:{" "}
                    <span className={Math.abs(calibration.calibrationGap) < 0.05 ? "text-emerald-600" : "text-amber-600"}>
                      {calibration.calibrationGap >= 0 ? "+" : ""}
                      {(calibration.calibrationGap * 100).toFixed(1)} pts
                    </span>
                  </p>
                </div>
              </div>
            </div>
          ) : null}
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Learned feature weights" subtitle="Signed logistic-regression coefficients (absolute magnitude)" />
            <div className="mt-4">
              {weights.length ? (
                <BarList items={weights} max={Math.max(...weights.map((weight) => weight.value), 0.1)} formatter={(value) => value.toFixed(3)} />
              ) : (
                <EmptyState icon="⚙" title="Nothing learned yet" description="Retrain the classifier to inspect its coefficients." />
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="Prediction playground" subtitle="Score any learner × item pair before assigning work" />
            <div className="mt-3 grid gap-3">
              <Field label="Learner">
                <select className={inputClass} value={form.studentId} onChange={(event) => setForm({ ...form, studentId: event.target.value })}>
                  {learners.map((learner) => (
                    <option key={learner.id} value={learner.id}>
                      {learner.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Item">
                <select className={inputClass} value={form.questionId} onChange={(event) => setForm({ ...form, questionId: event.target.value })}>
                  {questions.map((question) => (
                    <option key={question.id} value={question.id}>
                      {question.skillName} — {question.stem.slice(0, 48)}
                    </option>
                  ))}
                </select>
              </Field>
              <button className={buttonClass("primary", "md")} onClick={predict} disabled={predicting}>
                {predicting ? "Scoring…" : "Predict difficulty"}
              </button>
            </div>

            {prediction ? (
              <div className="mt-4 space-y-3">
                <div className="rounded-xl bg-slate-50 p-3 text-[11px] text-slate-600">
                  <p className="font-semibold text-slate-700">{prediction.skillName}</p>
                  <p>
                    mastery {pct(prediction.mastery)} · ability {pct(prediction.ability)} · evidence {pct(prediction.evidence)}
                  </p>
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
                    <p className="mt-0.5 text-[10px] text-slate-400">{entry.label.hint}</p>
                  </div>
                ))}
                <p className="rounded-lg bg-indigo-50/70 px-3 py-2 text-[11px] text-indigo-700 ring-1 ring-inset ring-indigo-100">
                  {prediction.recommendation}
                </p>
              </div>
            ) : null}
          </Card>
        </div>
      </div>
    </div>
  );
}
