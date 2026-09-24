/**
 * Domain event emitters.
 *
 * Thin, typed helpers that fire the correct structured log AND the correct
 * metric for each business event, so instrumentation at the call site is a
 * single line and the event/metric names stay consistent across the codebase.
 *
 * IMPORTANT: these helpers only accept opaque identifiers and enum-like values.
 * They never take (and therefore never log) names, emails, question stems, or
 * answer text. Passwords and session tokens are never passed here at all.
 */
import { log } from "./logger";
import type { DecisionExplanation } from "@/lib/ml/interfaces";
import { metrics } from "./metrics";
import { maskEmail } from "./redact";

type AuthOutcome = "success" | "failure" | "denied";

export const events = {
  // ---- Authentication ----
  auth(
    action: "login" | "register" | "logout",
    outcome: AuthOutcome,
    fields: { userId?: number | null; role?: string | null; email?: string | null; reason?: string } = {},
  ): void {
    metrics.authEventsTotal.inc({ action, outcome });
    const level = outcome === "success" ? "info" : "warn";
    log[level](`auth.${action}`, {
      outcome,
      userId: fields.userId ?? undefined,
      role: fields.role ?? undefined,
      // Masked so ops can spot enumeration/abuse without storing PII in the clear.
      emailMasked: fields.email ? maskEmail(fields.email) : undefined,
      reason: fields.reason,
    });
  },

  // ---- Assessment lifecycle ----
  assessmentStarted(f: { assessmentId: number; studentId: number; mode: string; itemTarget: number }): void {
    metrics.assessmentsStartedTotal.inc({ mode: f.mode });
    log.info("assessment.started", f);
  },
  assessmentCompleted(f: {
    assessmentId: number;
    studentId: number;
    mode: string;
    outcome: "completed" | "abandoned";
    score?: number;
    items?: number;
  }): void {
    metrics.assessmentsCompletedTotal.inc({ mode: f.mode, outcome: f.outcome });
    if (typeof f.score === "number") metrics.assessmentScore.observe(f.score, { mode: f.mode });
    log.info("assessment.completed", f);
  },

  // ---- Adaptive question selection ----
  questionSelected(f: {
    assessmentId: number;
    studentId: number;
    itemId: number;
    questionId: number;
    skillId: number;
    sequence: number;
    predictedSuccess: number;
    informationGain: number;
    durationMs: number;
    /** Which selection policy served this item. */
    policyId?: string;
    /** Machine-readable decision explanation (v3 policy only). */
    decision?: DecisionExplanation | null;
  }): void {
    metrics.adaptiveSelectionDuration.observe(f.durationMs / 1000);
    const { decision, ...rest } = f;
    // The full objective breakdown is verbose; log a compact summary at info
    // level and keep the complete record at debug for audit replay.
    log.info("question.selected", {
      ...rest,
      decisionScore: decision?.score,
      decisionDrivers: decision?.topDrivers,
      gatesApplied: decision?.gates.filter((g) => g.filtered > 0).map((g) => g.key),
    });
    if (decision) log.debug("question.selected.decision", { itemId: f.itemId, decision });
  },
  selectionExhausted(f: { assessmentId: number; studentId: number; durationMs: number }): void {
    metrics.adaptiveSelectionDuration.observe(f.durationMs / 1000);
    log.info("question.selection_exhausted", f);
  },

  // ---- Answer submission ----
  answerSubmitted(f: {
    assessmentId: number;
    studentId: number;
    itemId: number;
    questionId: number;
    skillId: number;
    isCorrect: boolean;
    responseTimeMs: number;
    predictedSuccess: number;
  }): void {
    metrics.answersTotal.inc({ correct: String(f.isCorrect) });
    metrics.questionResponseTime.observe(f.responseTimeMs / 1000);
    log.info("answer.submitted", f);
  },

  // ---- Mastery updates ----
  masteryUpdated(f: {
    studentId: number;
    skillId: number;
    masteryBefore: number;
    masteryAfter: number;
    delta: number;
  }): void {
    const direction = f.delta > 0 ? "up" : f.delta < 0 ? "down" : "flat";
    metrics.masteryUpdatesTotal.inc({ direction });
    metrics.masteryUpdateDelta.observe(f.delta);
    log.info("mastery.updated", f);
  },

  // ---- Recommendations ----
  recommendationsGenerated(f: { studentId: number; generated: number }): void {
    if (f.generated > 0) metrics.recommendationsGeneratedTotal.inc({}, f.generated);
    log.info("recommendation.generated", f);
  },
  recommendationActed(f: { studentId: number; recommendationId: number; status: string }): void {
    metrics.recommendationActionsTotal.inc({ status: f.status });
    log.info("recommendation.acted", f);
  },

  // ---- AI tutor ----
  tutorInteraction(f: {
    studentId: number;
    skillId: number | null;
    intent: string;
    requestedIntent: string;
    provider: string;
    withheldAnswer: boolean;
    adjustedIntent: boolean;
    latencyMs: number;
    fallback: boolean;
  }): void {
    metrics.tutorInteractionsTotal.inc({ intent: f.intent, provider: f.provider });
    metrics.tutorLatency.observe(f.latencyMs / 1000, { provider: f.provider });
    if (f.withheldAnswer) metrics.tutorAnswersWithheldTotal.inc({});
    if (f.fallback) metrics.tutorFallbacksTotal.inc({});
    // Opaque identifiers + enum-like values only — never the learner's prose.
    log.info("tutor.interaction", {
      studentId: f.studentId,
      skillId: f.skillId ?? undefined,
      intent: f.intent,
      requestedIntent: f.requestedIntent,
      adjustedIntent: f.adjustedIntent,
      provider: f.provider,
      withheldAnswer: f.withheldAnswer,
      fallback: f.fallback,
      latencyMs: f.latencyMs,
    });
  },

  // ---- ML predictions ----
  modelPrediction(f: {
    model: string;
    surface: string;
    count?: number;
    studentId?: number;
    questionId?: number;
    probability?: number;
  }): void {
    metrics.modelPredictionsTotal.inc({ model: f.model, surface: f.surface }, f.count ?? 1);
    log.debug("model.prediction", f);
  },
  modelError(model: string, op: string, error: unknown): void {
    metrics.modelErrorsTotal.inc({ model, op });
    log.exception("model.error", error, { model, op });
  },

  // ---- Model training ----
  modelTrained(f: {
    model: string;
    version: string;
    samples: number;
    verdict: string;
    promote: boolean;
    durationMs: number;
  }): void {
    metrics.modelTrainingDuration.observe(f.durationMs / 1000, { model: f.model });
    metrics.modelTrainingTotal.inc({ model: f.model, verdict: f.verdict });
    log.info("model.trained", f);
  },
};
