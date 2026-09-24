/**
 * Prompt construction.
 *
 * Turns the (context → retrieval → policy) output into a grounded system+user
 * message pair for an LLM. This is the ONLY place the model's behaviour is
 * shaped, and it is fully determined by upstream deterministic stages: the model
 * is told what it may and may not do (the policy guardrails), given the learner
 * model and curriculum material as grounding, and asked to render prose for one
 * capability. It is never asked to decide mastery, grade, or select items.
 */
import type {
  CurriculumContext,
  LearnerTutorContext,
  LlmMessage,
  TutorIntent,
  TutorPolicyDecision,
} from "./types";

const INTENT_TASK: Record<TutorIntent, string> = {
  explain:
    "Explain the concept clearly and concisely. Build from what the learner already knows, use one concrete illustration, and check understanding at the end.",
  hint: "Give ONE next hint that nudges the learner toward the method — never the answer. Keep it short. Offer to give a further hint if they are still stuck.",
  socratic:
    "Do NOT explain. Ask 2–3 short, guiding questions that lead the learner to reason it out themselves, ordered from foundational to the key insight.",
  worked_example:
    "Show a fully worked example step by step, narrating the reasoning at each step. End by stating the general method so it transfers.",
  diagnose:
    "Diagnose the likely misconception behind the learner's recent mistakes, citing the specific pattern. Be concrete and tentative where evidence is thin.",
  remediate:
    "Provide a short, targeted remediation plan: the specific gap, a scaffolded micro-explanation, and one practice step. Drop to the prerequisite if readiness is low.",
  next_activity:
    "Recommend the single best next activity and explain why in one or two sentences, grounded in the mastery gap, forgetting risk, path, or prerequisites.",
};

function difficultyRegister(level: TutorPolicyDecision["difficulty"]): string {
  switch (level) {
    case "foundational":
      return "Use simple language and small steps. Assume shaky foundations. Avoid jargon; define any term you must use.";
    case "stretch":
      return "The learner is strong here. Be concise, use precise terminology, and push toward transfer / deeper reasoning.";
    default:
      return "Pitch at a solid working level: clear, not condescending, with terminology introduced as needed.";
  }
}

export function buildTutorSystemPrompt(
  learner: LearnerTutorContext,
  curriculum: CurriculumContext,
  policy: TutorPolicyDecision,
): string {
  const lines: string[] = [];
  lines.push(
    "You are the AI tutor inside an adaptive learning platform. A deterministic learning engine — not you — is the single source of truth for the learner's mastery, grading and item selection. You provide natural-language teaching ONLY; you never state or change mastery scores.",
  );
  lines.push("");
  lines.push("PRINCIPLES:");
  lines.push("- Ground every claim in the LEARNER MODEL and CURRICULUM material below. Do not invent facts, formulas, or history the learner has not actually shown.");
  lines.push("- Be warm, brief, and specific. Prefer active guidance over walls of text.");
  lines.push("- " + difficultyRegister(policy.difficulty));
  if (policy.guardrails.length) {
    lines.push("");
    lines.push("HARD CONSTRAINTS (must follow):");
    for (const g of policy.guardrails) lines.push(`- ${g}`);
  }

  lines.push("");
  lines.push("LEARNER MODEL (read-only snapshot):");
  lines.push(`- Name: ${learner.studentName}${learner.gradeLevel ? ` · ${learner.gradeLevel}` : ""}`);
  if (learner.goal) lines.push(`- Goal: ${learner.goal}`);
  lines.push(`- Overall ability estimate: ${(learner.ability * 100).toFixed(0)}%`);
  const focus = learner.focusSkill;
  if (focus) {
    lines.push(
      `- Focus skill: ${focus.skillName} (${focus.subjectName}) — mastery ${(focus.mastery * 100).toFixed(
        0,
      )}%, confidence ${(focus.confidence * 100).toFixed(0)}%, ${focus.attempts} attempts, accuracy ${(
        focus.accuracy * 100
      ).toFixed(0)}%.`,
    );
    if (focus.description) lines.push(`  Skill description: ${focus.description}`);
    lines.push(`- Error profile: ${focus.errorLabel}.`);
    if (focus.prereqs.length) {
      lines.push(
        `- Prerequisites: ${focus.prereqs
          .map((p) => `${p.skillName} ${(p.mastery * 100).toFixed(0)}%${p.met ? "" : " (NOT met)"}`)
          .join(", ")} (readiness ${(focus.prereqReadiness * 100).toFixed(0)}%).`,
      );
    }
  }
  if (learner.recentMistakes.length) {
    lines.push("- Recent mistakes:");
    for (const m of learner.recentMistakes.slice(0, 4)) {
      const speed = m.responseRatio < 0.6 ? "very fast" : m.responseRatio > 1.3 ? "slow" : "normal-paced";
      lines.push(`  · ${m.skillName} (${m.difficulty}, ${m.bloom}) — ${speed}, ${m.daysAgo}d ago.`);
    }
  }
  if (learner.currentMilestone) {
    const ms = learner.currentMilestone;
    lines.push(
      `- Current path: "${ms.pathTitle}" → milestone #${ms.position} ${ms.skillName} (${ms.status}, ${(
        ms.currentMastery * 100
      ).toFixed(0)}%/${(ms.targetMastery * 100).toFixed(0)}%).`,
    );
  }
  if (learner.recommendedActivity) {
    const a = learner.recommendedActivity;
    lines.push(`- Engine-recommended next activity: ${a.title} — ${a.reason}`);
  }
  if (learner.assessment) {
    const a = learner.assessment;
    lines.push(
      `- Assessment context: "${a.title}" (${a.status}, ${a.itemsAnswered}/${a.itemTarget} answered)${
        a.pendingItem ? " with an item currently pending" : ""
      }.`,
    );
  }

  lines.push("");
  lines.push("CURRICULUM MATERIAL (grounding — hints are safe to use; redacted answers are hidden on purpose):");
  if (curriculum.prereqChain.length) {
    lines.push(
      `- Prerequisite chain: ${curriculum.prereqChain.map((p) => `${p.skillName} (${(p.mastery * 100).toFixed(0)}%)`).join(" → ")}.`,
    );
  }
  for (const ex of curriculum.examples) {
    lines.push(`- Example item (${ex.difficulty}/${ex.bloom}): "${ex.stem}"`);
    if (ex.hints.length) lines.push(`    hints: ${ex.hints.join(" | ")}`);
    if (ex.explanation) lines.push(`    method: ${ex.explanation}`);
    else if (ex.redacted) lines.push("    (answer/explanation withheld — assessment in progress)");
    if (ex.misconceptions.length) {
      lines.push(`    common misconceptions: ${ex.misconceptions.map((m) => m.rationale).join("; ")}`);
    }
  }
  if (curriculum.misconceptionBank.length) {
    lines.push(`- Known misconceptions for this skill: ${curriculum.misconceptionBank.join("; ")}.`);
  }

  return lines.join("\n");
}

export function buildTutorUserPrompt(intent: TutorIntent, userMessage: string): string {
  const task = INTENT_TASK[intent];
  const learnerAsk = userMessage.trim()
    ? `The learner said: "${userMessage.trim()}"\n\n`
    : "";
  return `${learnerAsk}TASK (${intent}): ${task}`;
}

export function buildMessages(
  learner: LearnerTutorContext,
  curriculum: CurriculumContext,
  policy: TutorPolicyDecision,
  userMessage: string,
): LlmMessage[] {
  return [
    { role: "system", content: buildTutorSystemPrompt(learner, curriculum, policy) },
    { role: "user", content: buildTutorUserPrompt(policy.intent, userMessage) },
  ];
}
