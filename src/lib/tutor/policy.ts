/**
 * Stage 3 — Tutor Policy.
 *
 * A PURE, deterministic function that turns the learner context + the requested
 * intent into a concrete plan for the generator: which capability to serve, what
 * difficulty register to pitch at, whether answers must be withheld, how to
 * shape remediation (from the diagnosed error profile), and which prerequisite
 * to drop back to when readiness is low.
 *
 * The LLM never makes these decisions — it only renders prose within the
 * guardrails this policy sets. That keeps the pedagogy explainable and auditable
 * and prevents the model from, e.g., revealing an answer or over-reaching a
 * struggling learner.
 */
import { MASTERY_TARGET } from "@/lib/utils";
import type {
  DifficultyLevel,
  DifficultyRequest,
  LearnerTutorContext,
  TutorIntent,
  TutorPolicyDecision,
  TutorRequest,
} from "./types";

const PREREQ_MET = 0.6;
const FOUNDATIONAL_MASTERY = 0.4;

/**
 * THE answer-safety guard. Returns true when the tutor must not reveal answer
 * keys: an assessment is in progress with a pending (unanswered) item on the
 * skill in focus, or the request explicitly references that pending item.
 *
 * Exported so the pipeline can apply it *before* retrieval — the answer key is
 * then never loaded into the prompt in the first place.
 */
export function mustWithholdAnswers(learner: LearnerTutorContext, request: TutorRequest): boolean {
  const a = learner.assessment;
  if (!a || a.status !== "in_progress" || !a.pendingItem) return false;
  const focusId = learner.focusSkill?.skillId ?? null;
  // Withhold when the live pending item is the very thing being tutored:
  //  - the request points at that item, or
  //  - the focus skill is the pending item's skill (the default inference).
  if (request.itemId && request.itemId === a.pendingItem.itemId) return true;
  if (focusId != null && focusId === a.pendingItem.skillId) return true;
  // If no skill was requested, focus defaults to the pending item's skill.
  if (request.skillId == null && focusId === a.pendingItem.skillId) return true;
  return false;
}

function baseDifficulty(learner: LearnerTutorContext): DifficultyLevel {
  const focus = learner.focusSkill;
  if (learner.coldStart || !focus) return "foundational";
  if (focus.prereqReadiness < 0.5 || focus.mastery < FOUNDATIONAL_MASTERY) return "foundational";
  if (focus.mastery >= MASTERY_TARGET) return "stretch";
  return "core";
}

function applyAdjustment(level: DifficultyLevel, request: DifficultyRequest): DifficultyLevel {
  const order: DifficultyLevel[] = ["foundational", "core", "stretch"];
  let idx = order.indexOf(level);
  if (request === "easier") idx = Math.max(0, idx - 1);
  else if (request === "harder") idx = Math.min(order.length - 1, idx + 1);
  return order[idx];
}

function remediationStyle(learner: LearnerTutorContext): TutorPolicyDecision["remediationStyle"] {
  const focus = learner.focusSkill;
  if (!focus || learner.coldStart || focus.attempts < 3) return "foundational";
  if (focus.prereqReadiness < PREREQ_MET) return "scaffold";
  switch (focus.errorType) {
    case "careless":
      return "accuracy-checks";
    case "struggling":
      return "scaffold";
    case "guessing":
      return "conceptual";
    case "slipping":
      return "accuracy-checks";
    default:
      return focus.mastery >= MASTERY_TARGET ? "stretch" : "conceptual";
  }
}

function weakestUnmetPrereq(learner: LearnerTutorContext): number | null {
  const focus = learner.focusSkill;
  if (!focus) return null;
  const unmet = focus.prereqs.filter((p) => !p.met).sort((a, b) => a.mastery - b.mastery);
  return unmet[0]?.skillId ?? null;
}

export function decidePolicy(learner: LearnerTutorContext, request: TutorRequest): TutorPolicyDecision {
  const requestedIntent = request.intent;
  let intent: TutorIntent = requestedIntent;
  const guardrails: string[] = [];

  const withholdAnswers = mustWithholdAnswers(learner, request);
  const focus = learner.focusSkill;
  const prereqTarget = weakestUnmetPrereq(learner);

  // ---- answer-safety guardrails ----
  let requireAnalogousExample = false;
  if (withholdAnswers) {
    guardrails.push(
      "An assessment is in progress — do NOT reveal the correct answer, the correct option, or a full solution to the current item.",
    );
    if (intent === "worked_example") {
      // Keep the capability, but force a fresh, analogous problem so we never
      // solve the live item.
      requireAnalogousExample = true;
      guardrails.push("Worked examples must use a fresh, analogous problem — never the live question's values.");
    }
    if (intent === "explain") {
      guardrails.push("Explain the underlying concept and method, not the specific answer to the pending item.");
    }
    guardrails.push("Prefer hints and Socratic prompts that move the learner forward without giving the result.");
  }

  // ---- difficulty (capability 8) ----
  const difficulty = applyAdjustment(baseDifficulty(learner), request.difficulty ?? "auto");

  // ---- remediation shaping (capabilities 5 & 6) ----
  const style = remediationStyle(learner);
  if ((intent === "remediate" || intent === "diagnose") && prereqTarget != null) {
    guardrails.push("Prerequisite readiness is low — anchor remediation in the weakest prerequisite before advancing.");
  }

  // ---- evidence guardrails ----
  if (learner.coldStart) {
    guardrails.push("No mastery evidence yet — avoid over-claiming what the learner knows; suggest a short diagnostic.");
    if (intent === "diagnose") {
      guardrails.push("Diagnosis has little to work from; frame findings as provisional.");
    }
  } else if (focus && focus.attempts < 3 && intent === "diagnose") {
    guardrails.push("Thin evidence on this skill — present the diagnosis as tentative.");
  }

  // ---- next-activity grounding ----
  if (intent === "next_activity" && !learner.recommendedActivity) {
    guardrails.push("No queued recommendation — base the suggestion on the mastery gap or spaced review.");
  }

  const adjustedIntent = intent !== requestedIntent;

  const rationale = buildRationale({ learner, intent, difficulty, withholdAnswers, style });

  return {
    intent,
    requestedIntent,
    adjustedIntent,
    difficulty,
    withholdAnswers,
    requireAnalogousExample,
    focusPrereqSkillId: prereqTarget,
    remediationStyle: style,
    guardrails,
    rationale,
  };
}

function buildRationale(params: {
  learner: LearnerTutorContext;
  intent: TutorIntent;
  difficulty: DifficultyLevel;
  withholdAnswers: boolean;
  style: TutorPolicyDecision["remediationStyle"];
}): string {
  const { learner, intent, difficulty, withholdAnswers, style } = params;
  const focus = learner.focusSkill;
  const parts: string[] = [];
  if (focus) {
    parts.push(
      `${intent} on ${focus.skillName} at ${difficulty} level (mastery ${(focus.mastery * 100).toFixed(0)}%, ${
        focus.errorType
      } error profile)`,
    );
  } else {
    parts.push(`${intent} at ${difficulty} level`);
  }
  parts.push(`remediation style: ${style}`);
  if (withholdAnswers) parts.push("answer-withholding active");
  return parts.join("; ") + ".";
}
