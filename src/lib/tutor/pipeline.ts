/**
 * The tutor pipeline — wires the stages together in the mandated order:
 *
 *     Learner Context → Retrieval/Curriculum → Tutor Policy → LLM
 *                         → Response → Learning Event
 *
 * Responsibilities that live HERE (not in any single stage):
 *   - apply the answer-withholding guard before retrieval so the answer key is
 *     never loaded into the prompt;
 *   - a second, post-generation answer-safety scan (defense in depth) that
 *     catches an external model that tries to give the answer away anyway;
 *   - persist the interaction as a learning event so its downstream impact can
 *     be evaluated later.
 *
 * INVARIANT: this module performs NO writes to `mastery_states`,
 * `assessment_items` or `assessments`. The deterministic engine owns those. The
 * tutor only ever INSERTs into `tutor_interactions` + `activity_events`.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { activityEvents, questions, tutorInteractions } from "@/db/schema";
import { events, now } from "@/lib/observability";
import { assembleLearnerContext } from "./context";
import { assembleCurriculumContext } from "./retrieval";
import { decidePolicy } from "./policy";
import { buildMessages } from "./prompt";
import { getTutorLlm } from "./llm";
import type {
  TutorCitation,
  TutorGenerationInput,
  TutorLlm,
  TutorRequest,
  TutorResponse,
} from "./types";

const MAX_OUTPUT_CHARS = 1400;

export interface RunTutorOptions {
  /** Override the LLM backend (tests / experiments). Defaults to env config. */
  llm?: TutorLlm;
  /** Injectable clock for deterministic tests. */
  now?: Date;
}

/**
 * Escape a string for safe use inside a RegExp.
 */
function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Second answer-safety layer. The pending item's correct answer is loaded here
 * ONLY for scanning — it is never placed in the prompt. Returns true if the
 * generated text appears to give the answer away.
 */
function leaksAnswer(message: string, correctText: string | null): boolean {
  if (!correctText) return false;
  const lower = message.toLowerCase();
  const givesAway = /(the answer is|the correct answer|correct answer is|correct option is|the solution is|answer:\s)/.test(
    lower,
  );
  const opt = correctText.trim().toLowerCase();
  const mentionsOption =
    opt.length >= 2 && new RegExp(`(^|[^\\w])${escapeRe(opt)}([^\\w]|$)`).test(lower);
  return givesAway || (mentionsOption && /\banswer\b/.test(lower));
}

function buildCitations(
  learner: NonNullable<Awaited<ReturnType<typeof assembleLearnerContext>>>,
  curriculum: Awaited<ReturnType<typeof assembleCurriculumContext>>,
): TutorCitation[] {
  const citations: TutorCitation[] = [];
  if (learner.focusSkill) citations.push({ type: "skill", ref: learner.focusSkill.skillName });
  for (const p of curriculum.prereqChain) citations.push({ type: "prerequisite", ref: p.skillName });
  for (const ex of curriculum.examples.slice(0, 2)) citations.push({ type: "example", ref: ex.stem });
  if (curriculum.misconceptionBank[0]) citations.push({ type: "misconception", ref: curriculum.misconceptionBank[0] });
  if (learner.currentMilestone) citations.push({ type: "milestone", ref: learner.currentMilestone.skillName });
  if (learner.recommendedActivity) citations.push({ type: "recommendation", ref: learner.recommendedActivity.title });
  return citations;
}

export type RunTutorResult = TutorResponse | { error: string };

export async function runTutor(request: TutorRequest, options: RunTutorOptions = {}): Promise<RunTutorResult> {
  const clock = options.now ?? new Date();
  const started = now();

  // ---- Stage 1: Learner Context (read-only) ----
  const learner = await assembleLearnerContext(
    request.studentId,
    { skillId: request.skillId, assessmentId: request.assessmentId, itemId: request.itemId },
    clock,
  );
  if (!learner) return { error: "Learner not found." };

  // ---- Stage 3 (guard first): decide policy incl. answer-withholding ----
  const policy = decidePolicy(learner, request);

  // ---- Stage 2: Retrieval / Curriculum (answers redacted per policy) ----
  const pendingQuestionId = learner.assessment?.pendingItem?.questionId ?? null;
  const curriculum = await assembleCurriculumContext(learner, {
    withholdAnswers: policy.withholdAnswers,
    pendingQuestionId,
  });

  // ---- Stage 4: LLM generation (prose only) ----
  const messages = buildMessages(learner, curriculum, policy, request.message ?? "");
  const genInput: TutorGenerationInput = {
    intent: policy.intent,
    policy,
    learner,
    curriculum,
    messages,
    userMessage: request.message ?? "",
    maxOutputChars: MAX_OUTPUT_CHARS,
  };
  const llm = options.llm ?? getTutorLlm();
  const generation = await llm.generate(genInput);

  // ---- Post-generation answer-safety scan (defense in depth) ----
  const safetyFlags: string[] = [];
  if (generation.usedFallback) safetyFlags.push("llm_fallback");
  let message = generation.message;

  if (policy.withholdAnswers && learner.assessment?.pendingItem) {
    const correctText = await loadCorrectAnswerText(learner.assessment.pendingItem.questionId);
    if (leaksAnswer(message, correctText)) {
      // Replace with a guaranteed-safe deterministic answer for this intent.
      const { deterministicTutor } = await import("./deterministic");
      const safe = await deterministicTutor.generate(genInput);
      message = safe.message;
      safetyFlags.push("withheld_answer_leak_blocked");
    }
  }

  const latencyMs = Math.round(now() - started);
  const masteryAtTime = learner.focusSkill?.mastery ?? null;

  // ---- Response ----
  const citations = buildCitations(learner, curriculum);
  const disclaimers = [
    "AI-generated tutoring. Your mastery scores are set by the assessment engine, not this chat.",
  ];
  if (policy.withholdAnswers) disclaimers.push("Answers are hidden while your assessment is in progress.");

  // ---- Learning Event (persisted; NEVER mutates mastery) ----
  const interactionId = await persistInteraction({
    request,
    learner,
    policy,
    generation: { ...generation, message },
    latencyMs,
    masteryAtTime,
    safetyFlags,
  });

  events.tutorInteraction({
    studentId: request.studentId,
    skillId: learner.focusSkill?.skillId ?? null,
    intent: policy.intent,
    requestedIntent: policy.requestedIntent,
    provider: generation.provider,
    withheldAnswer: policy.withholdAnswers,
    adjustedIntent: policy.adjustedIntent,
    latencyMs,
    fallback: generation.usedFallback,
  });

  return {
    interactionId,
    intent: policy.intent,
    requestedIntent: policy.requestedIntent,
    adjustedIntent: policy.adjustedIntent,
    skillId: learner.focusSkill?.skillId ?? null,
    skillName: learner.focusSkill?.skillName ?? null,
    message,
    followUps: generation.followUps,
    suggestedActivity: generation.suggestedActivity,
    difficulty: policy.difficulty,
    withheldAnswer: policy.withholdAnswers,
    guardrails: policy.guardrails,
    citations,
    provider: generation.provider,
    model: generation.model,
    safetyFlags,
    disclaimers,
  };
}

async function loadCorrectAnswerText(questionId: number): Promise<string | null> {
  const rows = await db
    .select({ options: questions.options, correctIndex: questions.correctIndex })
    .from(questions)
    .where(eq(questions.id, questionId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return row.options[row.correctIndex] ?? null;
}

async function persistInteraction(params: {
  request: TutorRequest;
  learner: NonNullable<Awaited<ReturnType<typeof assembleLearnerContext>>>;
  policy: ReturnType<typeof decidePolicy>;
  generation: { provider: string; model: string | null; message: string };
  latencyMs: number;
  masteryAtTime: number | null;
  safetyFlags: string[];
}): Promise<number> {
  const { request, learner, policy, generation, latencyMs, masteryAtTime, safetyFlags } = params;
  const skillId = learner.focusSkill?.skillId ?? null;

  const [row] = await db
    .insert(tutorInteractions)
    .values({
      studentId: request.studentId,
      skillId,
      assessmentId: learner.assessment?.assessmentId ?? request.assessmentId ?? null,
      itemId: learner.assessment?.pendingItem?.itemId ?? request.itemId ?? null,
      intent: policy.intent,
      requestedIntent: policy.requestedIntent,
      difficulty: policy.difficulty,
      masteryAtTime,
      withheldAnswer: policy.withholdAnswers,
      provider: generation.provider,
      model: generation.model,
      latencyMs,
      responseChars: generation.message.length,
      safetyFlags,
    })
    .returning({ id: tutorInteractions.id });

  // Mirror into the activity feed (typed "tutor") so it shows alongside other
  // learning events — but the rich, evaluable record lives in tutor_interactions.
  await db.insert(activityEvents).values({
    studentId: request.studentId,
    type: "tutor",
    skillId,
    summary: `Tutor · ${policy.intent}${learner.focusSkill ? ` · ${learner.focusSkill.skillName}` : ""}${
      policy.withholdAnswers ? " · answer withheld" : ""
    }`,
    value: masteryAtTime ?? 0,
  });

  return row.id;
}
