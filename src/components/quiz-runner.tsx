"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Badge, buttonClass, Card, ProgressBar, Spinner } from "@/components/ui";
import { RadialGauge } from "@/components/charts";
import { useToast } from "@/components/toast";
import type { SessionQuestion } from "@/lib/engine";
import { cn, pct } from "@/lib/utils";

type Feedback = {
  isCorrect: boolean;
  correctIndex: number;
  explanation: string;
  predictedSuccess: number;
  masteryBefore: number;
  masteryAfter: number;
  delta: number;
  streak: number;
  completed: boolean;
  next: SessionQuestion | null;
  summary: {
    score: number;
    correct: number;
    total: number;
    forecastLabel: string;
    predictedNext: number;
    weakestSkill: string;
    strongestSkill: string;
  } | null;
};

export function QuizRunner({
  assessmentId,
  initialQuestion,
  initialProgress,
  learnerName,
  title,
  mode,
}: {
  assessmentId: number;
  initialQuestion: SessionQuestion | null;
  initialProgress: { answered: number; total: number; correct: number };
  learnerName: string;
  title: string;
  mode: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [question, setQuestion] = useState<SessionQuestion | null>(initialQuestion);
  const [progress, setProgress] = useState(initialProgress);
  const [selected, setSelected] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [summary, setSummary] = useState<Feedback["summary"]>(null);
  const [log, setLog] = useState<
    { skill: string; correct: boolean; predicted: number; before: number; after: number }[]
  >([]);
  const startedAt = useRef<number>(0);

  // Reset the selected answer when the question changes. This is the
  // React-recommended "adjust state during render" pattern (see
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes),
  // which avoids a cascading setState-in-effect.
  const [shownItemId, setShownItemId] = useState<number | null>(question?.itemId ?? null);
  if ((question?.itemId ?? null) !== shownItemId) {
    setShownItemId(question?.itemId ?? null);
    setSelected(null);
  }

  // Timestamp the moment each question is shown so we can measure response
  // time. `Date.now()` is impure, so it must run in an effect rather than
  // during render.
  useEffect(() => {
    startedAt.current = Date.now();
  }, [question?.itemId]);

  const submit = async () => {
    if (!question || selected === null || submitting) return;
    setSubmitting(true);
    try {
      const response = await fetch(`/api/assessments/${assessmentId}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          itemId: question.itemId,
          studentAnswer: selected,
          responseTimeMs: Date.now() - startedAt.current,
        }),
      });
      const payload = (await response.json()) as Feedback & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Could not submit answer");
      if (!payload.next) payload.next = null;
      setFeedback(payload);
      setLog((current) => [
        ...current,
        {
          skill: question.skillName,
          correct: payload.isCorrect,
          predicted: payload.predictedSuccess,
          before: payload.masteryBefore,
          after: payload.masteryAfter,
        },
      ]);
      setProgress((current) => ({
        answered: current.answered + 1,
        total: current.total,
        correct: current.correct + (payload.isCorrect ? 1 : 0),
      }));
      if (payload.completed) {
        setSummary(payload.summary);
        toast.success("Session complete", "Forecast and mastery updates are live.");
        router.refresh();
      }
    } catch (caught) {
      toast.error("Could not submit answer", caught instanceof Error ? caught.message : undefined);
    } finally {
      setSubmitting(false);
    }
  };

  const next = () => {
    if (!feedback) return;
    const upcoming = feedback.next ?? null;
    setFeedback(null);
    setQuestion(upcoming);
    if (!upcoming && !feedback.completed) {
      setSummary(feedback.summary);
    }
  };

  const endSession = async () => {
    setSubmitting(true);
    try {
      const response = await fetch(`/api/assessments/${assessmentId}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "complete" }),
      });
      const payload = (await response.json()) as { summary?: Feedback["summary"]; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Could not end session");
      setSummary(payload.summary ?? null);
      setQuestion(null);
      toast.info("Session closed", "Partial results were scored against the tracer state.");
      router.refresh();
    } catch (caught) {
      toast.error("Could not end session", caught instanceof Error ? caught.message : undefined);
    } finally {
      setSubmitting(false);
    }
  };

  if (summary) {
    return (
      <Card className="animate-in">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold tracking-tight text-slate-900">Session complete</h2>
            <p className="mt-1 text-xs text-slate-500">
              {learnerName} · {title} · knowledge tracing updated for every attempted item
            </p>
          </div>
          <Badge tone="emerald">completed</Badge>
        </div>
        <div className="mt-5 grid gap-5 lg:grid-cols-[220px_1fr]">
          <div className="flex flex-col items-center">
            <RadialGauge value={summary.score} label="session score" sublabel={`${summary.correct}/${summary.total} correct`} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-slate-200 p-3">
              <p className="text-[11px] uppercase tracking-wide text-slate-400">Forecast next score</p>
              <p className="mt-1 text-lg font-semibold text-slate-900">{pct(summary.predictedNext)}</p>
              <p className="text-[11px] text-slate-500">trend: {summary.forecastLabel}</p>
            </div>
            <div className="rounded-xl border border-slate-200 p-3">
              <p className="text-[11px] uppercase tracking-wide text-slate-400">Weakest skill this session</p>
              <p className="mt-1 text-sm font-semibold text-slate-900">{summary.weakestSkill}</p>
              <p className="text-[11px] text-slate-500">strongest: {summary.strongestSkill}</p>
            </div>
            <div className="sm:col-span-2">
              <p className="text-[11px] uppercase tracking-wide text-slate-400">Item-level trace</p>
              <ul className="mt-2 space-y-1.5">
                {log.map((entry, index) => (
                  <li key={`${entry.skill}-${index}`} className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-1.5 text-[11px]">
                    <span className="truncate font-medium text-slate-600">
                      {index + 1}. {entry.skill}
                    </span>
                    <span className={entry.correct ? "text-emerald-600" : "text-rose-600"}>
                      {entry.correct ? "correct" : "incorrect"} · p̂ {pct(entry.predicted)} · mastery{" "}
                      {pct(entry.before)} → {pct(entry.after)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          <Link className={buttonClass("primary", "md")} href={`/dashboard/assessments/${assessmentId}`}>
            Open session report
          </Link>
          <Link className={buttonClass("secondary", "md")} href="/dashboard/recommendations">
            View new priorities
          </Link>
          <button className={buttonClass("ghost", "md")} onClick={() => router.refresh()}>
            Refresh dashboard
          </button>
        </div>
      </Card>
    );
  }

  if (!question) {
    return (
      <Card>
        <p className="text-sm text-slate-600">
          No further items are queued for this session.
        </p>
        <div className="mt-4">
          <button className={buttonClass("primary", "sm")} onClick={endSession} disabled={submitting}>
            Finalise session
          </button>
        </div>
      </Card>
    );
  }

  const options = question.options ?? [];
  const isMasteryDrop = feedback ? feedback.delta < 0 : false;

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs text-slate-500">
              {learnerName} · {title} · {mode.replace("_", " ")}
            </p>
            <p className="mt-1 text-sm font-semibold text-slate-900">
              Item {progress.answered + (feedback ? 0 : 1)} of {progress.total}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge tone="violet">{question.subjectName}</Badge>
            <Badge tone="sky">{question.skillName}</Badge>
            <Badge tone="slate">{question.difficultyLabel}</Badge>
            <button className={buttonClass("ghost", "sm", "text-rose-600 hover:bg-rose-50")} onClick={endSession} disabled={submitting}>
              End session
            </button>
          </div>
        </div>
        <ProgressBar
          value={progress.answered / Math.max(1, progress.total)}
          className="mt-3"
          label={`${progress.answered}/${progress.total} answered · ${progress.correct} correct`}
        />
      </Card>

      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <Card>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Selected for you by the adaptive engine</p>
          <h2 className="mt-2 text-base font-semibold leading-relaxed text-slate-900">{question.stem}</h2>
          <div className="mt-4 space-y-2">
            {options.map((option, index) => {
              const chosen = selected === index;
              const showCorrect = feedback && index === feedback.correctIndex;
              const showWrong = feedback && chosen && !feedback.isCorrect;
              return (
                <button
                  key={`${index}-${option}`}
                  onClick={() => (feedback ? undefined : setSelected(index))}
                  disabled={Boolean(feedback) || submitting}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left text-sm transition",
                    chosen && !feedback ? "border-indigo-400 bg-indigo-50" : "border-slate-200 hover:border-indigo-200 hover:bg-slate-50",
                    showCorrect && "border-emerald-400 bg-emerald-50",
                    showWrong && "border-rose-400 bg-rose-50",
                    feedback && "cursor-default",
                  )}
                >
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white text-[11px] font-semibold text-slate-500 ring-1 ring-slate-200">
                    {String.fromCharCode(65 + index)}
                  </span>
                  <span className="text-slate-700">{option}</span>
                </button>
              );
            })}
          </div>

          {feedback ? (
            <div
              className={cn(
                "mt-4 rounded-xl border p-3",
                feedback.isCorrect ? "border-emerald-200 bg-emerald-50/60" : "border-rose-200 bg-rose-50/60",
              )}
            >
              <p className={cn("text-sm font-semibold", feedback.isCorrect ? "text-emerald-700" : "text-rose-700")}>
                {feedback.isCorrect ? "Correct — mastery increased" : "Incorrect — the tracer updated downward"}
              </p>
              <p className="mt-1 text-xs text-slate-600">{feedback.explanation}</p>
              <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-slate-600">
                <span>predicted p̂ {(feedback.predictedSuccess * 100).toFixed(0)}%</span>
                <span>
                  mastery {(feedback.masteryBefore * 100).toFixed(0)}% →{" "}
                  <span className={isMasteryDrop ? "text-rose-600" : "text-emerald-600"}>
                    {(feedback.masteryAfter * 100).toFixed(0)}%
                  </span>
                </span>
                <span>Δ {(feedback.delta * 100).toFixed(1)} pts</span>
                <span>streak {feedback.streak}</span>
              </div>
            </div>
          ) : null}

          <div className="mt-4 flex flex-wrap gap-2">
            {feedback ? (
              <button className={buttonClass("primary", "md")} onClick={next}>
                Next item →
              </button>
            ) : (
              <button className={buttonClass("primary", "md")} onClick={submit} disabled={selected === null || submitting}>
                {submitting ? <Spinner className="border-white/40 border-t-white" /> : null}
                Submit answer
              </button>
            )}
            {!feedback ? (
              <button className={buttonClass("ghost", "md")} onClick={() => setSelected(null)} disabled={selected === null}>
                Clear selection
              </button>
            ) : null}
          </div>
        </Card>

        <div className="space-y-4">
          <Card>
            <p className="text-xs font-semibold text-slate-800">Why this item?</p>
            <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">{question.rationale}</p>
            <div className="mt-3 grid grid-cols-2 gap-2 text-center">
              <div className="rounded-lg bg-slate-50 px-2 py-2">
                <p className="text-[10px] uppercase text-slate-400">mastery</p>
                <p className="text-sm font-semibold text-slate-800">{pct(question.mastery)}</p>
              </div>
              <div className="rounded-lg bg-slate-50 px-2 py-2">
                <p className="text-[10px] uppercase text-slate-400">p̂(correct)</p>
                <p className="text-sm font-semibold text-slate-800">{pct(question.predictedSuccess)}</p>
              </div>
              <div className="rounded-lg bg-slate-50 px-2 py-2">
                <p className="text-[10px] uppercase text-slate-400">info gain</p>
                <p className="text-sm font-semibold text-slate-800">{question.informationGain}</p>
              </div>
              <div className="rounded-lg bg-slate-50 px-2 py-2">
                <p className="text-[10px] uppercase text-slate-400">expected</p>
                <p className="text-sm font-semibold text-slate-800">{question.estimatedSeconds}s</p>
              </div>
            </div>
            <p className="mt-3 rounded-lg bg-indigo-50/70 px-3 py-2 text-[11px] text-indigo-700 ring-1 ring-inset ring-indigo-100">
              {question.label.label}: {question.label.hint}
            </p>
          </Card>

          <Card>
            <p className="text-xs font-semibold text-slate-800">Session trace</p>
            {log.length ? (
              <ul className="mt-2 space-y-1.5">
                {log.map((entry, index) => (
                  <li key={`${entry.skill}-${index}`} className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="truncate text-slate-600">
                      {index + 1}. {entry.skill}
                    </span>
                    <span className={entry.correct ? "text-emerald-600" : "text-rose-600"}>
                      {entry.correct ? "✓" : "✕"} {pct(entry.after)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-[11px] text-slate-400">Answers will stream here as the tracer updates.</p>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
