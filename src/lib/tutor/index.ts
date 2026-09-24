/**
 * AI Tutor — public barrel.
 *
 * The tutor is a read-only teaching layer on top of the deterministic learner
 * model. See TUTOR.md for the full architecture. The only entry point most
 * callers need is `runTutor`; the individual stages are exported for testing and
 * advanced composition.
 */
export { runTutor, type RunTutorOptions, type RunTutorResult } from "./pipeline";
export { assembleLearnerContext } from "./context";
export { assembleCurriculumContext } from "./retrieval";
export { decidePolicy, mustWithholdAnswers } from "./policy";
export { buildMessages, buildTutorSystemPrompt, buildTutorUserPrompt } from "./prompt";
export { getTutorLlm } from "./llm";
export { deterministicTutor } from "./deterministic";
export { TUTOR_INTENTS, DIFFICULTY_REQUESTS } from "./types";
export type {
  TutorIntent,
  DifficultyRequest,
  DifficultyLevel,
  TutorRequest,
  TutorResponse,
  TutorPolicyDecision,
  LearnerTutorContext,
  CurriculumContext,
  TutorLlm,
  TutorGenerationInput,
  TutorGenerationOutput,
} from "./types";
