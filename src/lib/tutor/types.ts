/**
 * AI Tutor — shared contracts.
 *
 * These types define the boundaries between the pipeline stages so each stage is
 * independently testable and the LLM is confined to a single, replaceable step:
 *
 *     Learner Context  →  Retrieval / Curriculum  →  Tutor Policy  →  LLM
 *          ↓                       ↓                       ↓            ↓
 *     (read-only view       (grounding material     (deterministic  (prose only)
 *      of the learner        from the taxonomy /      rules about
 *      model)                question bank)           what to do)
 *          →  Response  →  Learning Event (persisted, read-only w.r.t. mastery)
 *
 * DESIGN INVARIANT: nothing produced by the LLM feeds back into the learner
 * model. Mastery, item grading and selection stay with the deterministic engine.
 * The LLM only generates natural-language *explanation*, never state.
 */

/* ------------------------------------------------------------------ */
/* Capabilities (intents)                                              */
/* ------------------------------------------------------------------ */

/** The tutor's capabilities, expressed as intents. */
export const TUTOR_INTENTS = [
  "explain", // 1. Explain concepts
  "hint", // 2. Give hints (progressive, never the answer)
  "socratic", // 3. Ask Socratic questions
  "worked_example", // 4. Generate worked examples
  "diagnose", // 5. Diagnose misconceptions
  "remediate", // 6. Provide targeted remediation
  "next_activity", // 7. Recommend the next activity
] as const;
export type TutorIntent = (typeof TUTOR_INTENTS)[number];

/** Requested difficulty adjustment (capability 8). `auto` lets policy decide. */
export const DIFFICULTY_REQUESTS = ["auto", "easier", "same", "harder"] as const;
export type DifficultyRequest = (typeof DIFFICULTY_REQUESTS)[number];

/** The register a response is pitched at — derived by policy from the model. */
export type DifficultyLevel = "foundational" | "core" | "stretch";

/* ------------------------------------------------------------------ */
/* Request                                                             */
/* ------------------------------------------------------------------ */

export interface TutorRequest {
  studentId: number;
  intent: TutorIntent;
  /** Free-text learner question / message (optional). */
  message?: string;
  /** Skill to focus on. When omitted, context inference picks one. */
  skillId?: number;
  /** Assessment currently in play (enables answer-withholding safety). */
  assessmentId?: number;
  /** Specific assessment item the learner is asking about. */
  itemId?: number;
  /** Difficulty adjustment request (capability 8). */
  difficulty?: DifficultyRequest;
}

/* ------------------------------------------------------------------ */
/* Learner context (the learner model, read-only)                      */
/* ------------------------------------------------------------------ */

/** A prerequisite skill and the learner's readiness on it. */
export interface PrereqView {
  skillId: number;
  skillName: string;
  mastery: number;
  met: boolean;
}

/** A recent incorrect (or slip) response, distilled for the tutor. */
export interface RecentMistake {
  skillId: number;
  skillName: string;
  difficulty: string;
  bloom: string;
  /** Response time relative to expected (~1 normal, <1 fast, >1 slow). */
  responseRatio: number;
  daysAgo: number;
  /** Item stem when available (never the answer key). */
  stem?: string;
}

export interface ActiveAssessmentContext {
  assessmentId: number;
  title: string;
  mode: string;
  status: string;
  itemsAnswered: number;
  itemTarget: number;
  /** The pending (unanswered) item, if the session has one queued. */
  pendingItem: {
    itemId: number;
    questionId: number;
    skillId: number;
    skillName: string;
    stem: string;
  } | null;
}

export interface CurrentMilestoneView {
  pathId: number;
  pathTitle: string;
  objective: string;
  milestoneId: number;
  skillId: number;
  skillName: string;
  position: number;
  status: string;
  currentMastery: number;
  targetMastery: number;
}

export interface RecommendedActivityView {
  kind: string;
  skillId: number | null;
  title: string;
  reason: string;
  priority: number;
  source: "recommendation" | "milestone" | "diagnostic";
}

/** The complete, read-only view of the learner the tutor reasons over. */
export interface LearnerTutorContext {
  studentId: number;
  studentName: string;
  gradeLevel: string | null;
  /** (learner goal) */
  goal: string | null;

  /** The skill the exchange is grounded in. */
  focusSkill: {
    skillId: number;
    skillName: string;
    subjectName: string;
    description: string;
    difficultyBase: number;
    /** (mastery estimate) decayed point estimate 0..1. */
    mastery: number;
    /** Evidence strength 0..1. */
    confidence: number;
    attempts: number;
    accuracy: number;
    recentAccuracy: number;
    /** Error diagnosis from the learner-state builder. */
    errorType: string;
    errorLabel: string;
    /** (prerequisites) */
    prereqReadiness: number;
    prereqs: PrereqView[];
  } | null;

  /** Global ability estimate (mean decayed mastery). */
  ability: number;
  /** (recent mistakes) most-recent incorrect / slip responses. */
  recentMistakes: RecentMistake[];
  /** (current learning path + current milestone) */
  currentMilestone: CurrentMilestoneView | null;
  /** (recommended activity) */
  recommendedActivity: RecommendedActivityView | null;
  /** (assessment context) */
  assessment: ActiveAssessmentContext | null;
  /** True when the learner has essentially no evidence yet (cold start). */
  coldStart: boolean;
}

/* ------------------------------------------------------------------ */
/* Retrieval / curriculum context                                      */
/* ------------------------------------------------------------------ */

/** A distilled question used purely as grounding material (answer-aware). */
export interface CurriculumExample {
  questionId: number;
  stem: string;
  difficulty: string;
  bloom: string;
  /** Progressive hints (safe to surface even mid-assessment, by design). */
  hints: string[];
  /**
   * Worked explanation. Present ONLY when the policy allows revealing answers
   * for this item — otherwise redacted to keep the answer hidden.
   */
  explanation: string | null;
  /** Misconception each distractor targets — powers diagnosis/remediation. */
  misconceptions: { rationale: string }[];
  /** True when this example was redacted because answers must be withheld. */
  redacted: boolean;
}

export interface CurriculumContext {
  skillId: number | null;
  skillName: string | null;
  skillDescription: string | null;
  subjectName: string | null;
  /** Prerequisite chain, foundational-first. */
  prereqChain: { skillId: number; skillName: string; description: string; mastery: number }[];
  /** Representative items for grounding (answers redacted per policy). */
  examples: CurriculumExample[];
  /** Common misconception rationales aggregated across the skill's items. */
  misconceptionBank: string[];
}

/* ------------------------------------------------------------------ */
/* Tutor policy (deterministic decision)                               */
/* ------------------------------------------------------------------ */

export interface TutorPolicyDecision {
  /** Intent actually served (may be downgraded from the request for safety). */
  intent: TutorIntent;
  requestedIntent: TutorIntent;
  /** True when the requested intent was changed by policy. */
  adjustedIntent: boolean;
  difficulty: DifficultyLevel;
  /** THE answer-safety switch: withhold answer keys / explanations. */
  withholdAnswers: boolean;
  /** Worked examples must use fresh values (not the live item's). */
  requireAnalogousExample: boolean;
  /** When remediation should drop to a prerequisite, its skill id. */
  focusPrereqSkillId: number | null;
  /** How remediation should be shaped, from the error profile. */
  remediationStyle: "scaffold" | "accuracy-checks" | "conceptual" | "stretch" | "foundational";
  /** Human-readable guardrails, surfaced for transparency + auditing. */
  guardrails: string[];
  /** Short rationale for why this policy was chosen. */
  rationale: string;
}

/* ------------------------------------------------------------------ */
/* LLM adapter contract                                                */
/* ------------------------------------------------------------------ */

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Structured grounding handed to the generator alongside the prompt. */
export interface TutorGenerationInput {
  intent: TutorIntent;
  policy: TutorPolicyDecision;
  learner: LearnerTutorContext;
  curriculum: CurriculumContext;
  messages: LlmMessage[];
  /** Learner's raw message, if any. */
  userMessage: string;
  maxOutputChars: number;
}

export interface TutorGenerationOutput {
  message: string;
  followUps: string[];
  /** Suggested next activity (mirrors / refines the recommended activity). */
  suggestedActivity: RecommendedActivityView | null;
  provider: string;
  model: string | null;
  /** Set true when the backend fell back to the deterministic composer. */
  usedFallback: boolean;
}

export interface TutorLlm {
  readonly id: string;
  generate(input: TutorGenerationInput): Promise<TutorGenerationOutput>;
}

/* ------------------------------------------------------------------ */
/* Response + persisted event                                          */
/* ------------------------------------------------------------------ */

export interface TutorCitation {
  type: "skill" | "prerequisite" | "example" | "misconception" | "milestone" | "recommendation";
  ref: string;
}

export interface TutorResponse {
  interactionId: number;
  intent: TutorIntent;
  requestedIntent: TutorIntent;
  adjustedIntent: boolean;
  skillId: number | null;
  skillName: string | null;
  message: string;
  followUps: string[];
  suggestedActivity: RecommendedActivityView | null;
  difficulty: DifficultyLevel;
  withheldAnswer: boolean;
  guardrails: string[];
  citations: TutorCitation[];
  provider: string;
  model: string | null;
  safetyFlags: string[];
  /** Disclaimers shown to the learner (e.g. "AI-generated"). */
  disclaimers: string[];
}
