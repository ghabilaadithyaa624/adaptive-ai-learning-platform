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

type EvaluationReport = {
  samples: number;
  message?: string;
  metrics?: {
    accuracy: number;
    precision: number;
    recall: number;
    f1: number;
    specificity: number;
    rocAuc: number | null;
    rocAucApplicable: boolean;
    prAuc: number | null;
    prAucApplicable: boolean;
    logLoss: number;
    brier: number;
    calibrationError: number;
    maxCalibrationError: number;
    baseRate: number;
  };
  confusion?: { truePositive: number; falsePositive: number; trueNegative: number; falseNegative: number };
  reliability?: { lower: number; upper: number; count: number; meanConfidence: number; observedAccuracy: number }[];
  recentHoldout?: {
    samples: number;
    accuracy: number;
    rocAuc: number | null;
    logLoss: number;
    calibrationError: number;
  } | null;
  error?: string;
};

type MetricComparison = {
  metric: string;
  baseline: number | null;
  candidate: number | null;
  delta: number | null;
  verdict: "improved" | "regressed" | "unchanged" | "incomparable";
};

type ComparisonResult = {
  verdict: string;
  promote: boolean;
  reasons: string[];
  improvements: string[];
  regressions: string[];
  regressionAlerts: { metric: string; delta: number | null }[];
  metrics: MetricComparison[];
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
  const [evaluation, setEvaluation] = useState<EvaluationReport | null>(null);
  const [comparison, setComparison] = useState<ComparisonResult | null>(null);
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
      const payload = (await response.json()) as {
        models?: ModelView[];
        model?: { metrics: Record<string, number>; samples: number; heldOutSamples?: number };
        comparison?: ComparisonResult;
        error?: string;
      };
      if (!response.ok || !payload.models) throw new Error(payload.error ?? "Training failed");
      setModels(payload.models);
      if (payload.comparison) setComparison(payload.comparison);
      const verdict = payload.comparison?.verdict ?? "recorded";
      toast.success(
        "Classifier retrained",
        `${payload.model?.heldOutSamples ?? 0} held-out · AUC ${(payload.model?.metrics.auc ?? 0).toFixed(3)} · verdict: ${verdict}`,
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
      const payload = (await response.json()) as EvaluationReport;
      if (!response.ok || payload.error) throw new Error(payload.error ?? "Evaluation failed");
      setEvaluation(payload);
      if (payload.metrics) {
        toast.info(
          "Held-out evaluation computed",
          `${payload.samples} responses · ROC-AUC ${payload.metrics.rocAuc?.toFixed(3) ?? "n/a"} · ECE ${payload.metrics.calibrationError.toFixed(3)}`,
        );
      } else {
        toast.info("Evaluation", payload.message ?? "No labelled data yet");
      }
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
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">ROC-AUC (held-out)</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900">{(classifier?.metrics.auc ?? 0).toFixed(3)}</p>
          <p className="mt-1 text-xs text-slate-500">
            PR-AUC {(classifier?.metrics.prAuc ?? 0).toFixed(3)} · F1 {(classifier?.metrics.f1 ?? 0).toFixed(3)}
          </p>
        </Card>
        <Card>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Calibration (ECE)</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900">{(classifier?.metrics.ece ?? 0).toFixed(3)}</p>
          <p className="mt-1 text-xs text-slate-500">
            Brier {(classifier?.metrics.brier ?? 0).toFixed(3)} · logloss {(classifier?.metrics.logLoss ?? 0).toFixed(3)}
          </p>
        </Card>
        <Card>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Held-out test set</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900">{classifier?.metrics.testSize ?? 0}</p>
          <p className="mt-1 text-xs text-slate-500">most-recent samples from the chronological (no-leakage) split</p>
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
                  {evaluating ? "Evaluating…" : "Evaluate held-out"}
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
                    {(model.datasetVersion || model.featureVersion) ? (
                      <p className="mt-0.5 text-[10px] text-slate-400">
                        {model.featureVersion ? `feature ${model.featureVersion}` : null}
                        {model.datasetVersion ? ` · dataset ${model.datasetVersion}` : null}
                        {model.evaluatedAt ? ` · evaluated ${new Date(model.evaluatedAt).toLocaleDateString()}` : null}
                      </p>
                    ) : null}
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

          {comparison ? (
            <div
              className={`mt-4 rounded-xl border p-3 ${
                comparison.regressions.length || comparison.regressionAlerts.length
                  ? "border-rose-200 bg-rose-50/60"
                  : comparison.promote
                    ? "border-emerald-200 bg-emerald-50/60"
                    : "border-slate-200 bg-slate-50/60"
              }`}
            >
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-slate-800">Retrain verdict vs. previous model</p>
                <Badge
                  tone={
                    comparison.regressionAlerts.length ? "rose" : comparison.verdict === "improved" ? "emerald" : "slate"
                  }
                >
                  {comparison.verdict}
                </Badge>
              </div>
              <ul className="mt-2 space-y-1 text-[11px] text-slate-600">
                {comparison.reasons.map((reason, index) => (
                  <li key={index}>• {reason}</li>
                ))}
              </ul>
              {comparison.metrics.length ? (
                <div className="mt-2 grid gap-1 text-[11px] sm:grid-cols-2">
                  {comparison.metrics
                    .filter((metric) => metric.verdict !== "incomparable")
                    .map((metric) => (
                      <span key={metric.metric} className="flex justify-between gap-2">
                        <span className="text-slate-500">{metric.metric}</span>
                        <span
                          className={
                            metric.verdict === "improved"
                              ? "font-semibold text-emerald-600"
                              : metric.verdict === "regressed"
                                ? "font-semibold text-rose-600"
                                : "text-slate-500"
                          }
                        >
                          {metric.delta === null ? "n/a" : `${metric.delta >= 0 ? "+" : ""}${metric.delta.toFixed(4)}`}
                        </span>
                      </span>
                    ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {evaluation?.metrics ? (
            <div className="mt-4 rounded-xl border border-slate-200 p-3">
              <p className="text-xs font-semibold text-slate-800">Held-out evaluation report</p>
              <p className="text-[10px] text-slate-400">{evaluation.samples} labelled serving predictions</p>
              <div className="mt-2 grid gap-1 text-[11px] text-slate-600 sm:grid-cols-3">
                <span>accuracy: <b className="text-slate-700">{evaluation.metrics.accuracy.toFixed(3)}</b></span>
                <span>precision: <b className="text-slate-700">{evaluation.metrics.precision.toFixed(3)}</b></span>
                <span>recall: <b className="text-slate-700">{evaluation.metrics.recall.toFixed(3)}</b></span>
                <span>F1: <b className="text-slate-700">{evaluation.metrics.f1.toFixed(3)}</b></span>
                <span>
                  ROC-AUC: <b className="text-slate-700">{evaluation.metrics.rocAuc?.toFixed(3) ?? "n/a"}</b>
                </span>
                <span>
                  PR-AUC: <b className="text-slate-700">{evaluation.metrics.prAuc?.toFixed(3) ?? "n/a"}</b>
                </span>
                <span>log loss: <b className="text-slate-700">{evaluation.metrics.logLoss.toFixed(3)}</b></span>
                <span>Brier: <b className="text-slate-700">{evaluation.metrics.brier.toFixed(3)}</b></span>
                <span>ECE: <b className="text-slate-700">{evaluation.metrics.calibrationError.toFixed(3)}</b></span>
              </div>

              {evaluation.confusion ? (
                <div className="mt-3">
                  <p className="text-[11px] font-semibold text-slate-700">Confusion matrix</p>
                  <div className="mt-1 grid w-full max-w-xs grid-cols-3 gap-px overflow-hidden rounded-lg bg-slate-200 text-center text-[10px]">
                    <div className="bg-slate-50 p-1 font-medium text-slate-400"> </div>
                    <div className="bg-slate-50 p-1 font-medium text-slate-500">pred +</div>
                    <div className="bg-slate-50 p-1 font-medium text-slate-500">pred −</div>
                    <div className="bg-slate-50 p-1 font-medium text-slate-500">actual +</div>
                    <div className="bg-emerald-50 p-2 font-semibold text-emerald-700">{evaluation.confusion.truePositive}</div>
                    <div className="bg-rose-50 p-2 font-semibold text-rose-700">{evaluation.confusion.falseNegative}</div>
                    <div className="bg-slate-50 p-1 font-medium text-slate-500">actual −</div>
                    <div className="bg-rose-50 p-2 font-semibold text-rose-700">{evaluation.confusion.falsePositive}</div>
                    <div className="bg-emerald-50 p-2 font-semibold text-emerald-700">{evaluation.confusion.trueNegative}</div>
                  </div>
                </div>
              ) : null}

              {evaluation.reliability?.length ? (
                <div className="mt-3">
                  <p className="text-[11px] font-semibold text-slate-700">Reliability (confidence vs. observed)</p>
                  <div className="mt-1 space-y-1">
                    {evaluation.reliability.map((bin) => (
                      <div key={bin.lower} className="flex items-center gap-2 text-[10px] text-slate-500">
                        <span className="w-16 tabular-nums">
                          {bin.lower.toFixed(1)}–{bin.upper.toFixed(1)}
                        </span>
                        <div className="flex-1">
                          <ProgressBar value={bin.meanConfidence} tone="indigo" />
                          <ProgressBar value={bin.observedAccuracy} tone="emerald" className="mt-0.5" />
                        </div>
                        <span className="w-8 text-right tabular-nums">n{bin.count}</span>
                      </div>
                    ))}
                  </div>
                  <p className="mt-1 text-[10px] text-slate-400">Indigo = mean predicted confidence · Green = observed accuracy</p>
                </div>
              ) : null}

              {evaluation.recentHoldout ? (
                <p className="mt-3 text-[11px] text-slate-600">
                  Most-recent {evaluation.recentHoldout.samples} predictions (temporal holdout): ROC-AUC{" "}
                  <b className="text-slate-700">{evaluation.recentHoldout.rocAuc?.toFixed(3) ?? "n/a"}</b> · ECE{" "}
                  <b className="text-slate-700">{evaluation.recentHoldout.calibrationError.toFixed(3)}</b>
                </p>
              ) : null}
            </div>
          ) : null}

          {evaluation && !evaluation.metrics ? (
            <p className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3 text-[11px] text-slate-500">
              {evaluation.message ?? "No labelled responses to evaluate yet."}
            </p>
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
