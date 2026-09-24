/**
 * Deterministic tutor generator (the zero-config LLM backend).
 *
 * This is a *grounded composer*, not a random chatbot: for each capability it
 * assembles prose strictly from the learner model + curriculum material handed
 * to it by the upstream stages. It is fully deterministic (identical input →
 * identical output), which makes the whole pipeline testable offline and gives
 * the platform a safe default when no external model is configured.
 *
 * It honours the same policy guardrails the prompt encodes — most importantly,
 * it never emits a withheld answer, because the retrieval stage has already
 * redacted answer explanations from its inputs when an assessment is live.
 */
import type {
  CurriculumContext,
  LearnerTutorContext,
  RecommendedActivityView,
  TutorGenerationInput,
  TutorGenerationOutput,
  TutorLlm,
  TutorPolicyDecision,
} from "./types";

function primaryExample(curriculum: CurriculumContext) {
  // Prefer an example we are allowed to fully work through.
  return curriculum.examples.find((e) => !e.redacted && e.explanation) ?? curriculum.examples[0] ?? null;
}

function skillName(learner: LearnerTutorContext, curriculum: CurriculumContext): string {
  return learner.focusSkill?.skillName ?? curriculum.skillName ?? "this skill";
}

function joinSentences(parts: (string | null | undefined)[]): string {
  return parts.filter((p): p is string => Boolean(p && p.trim())).join(" ").replace(/\s+/g, " ").trim();
}

function clampText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("\n"));
  return (lastStop > maxChars * 0.6 ? cut.slice(0, lastStop + 1) : cut).trim() + " …";
}

/* --------------------------- per-intent composers --------------------------- */

function explain(learner: LearnerTutorContext, curriculum: CurriculumContext, policy: TutorPolicyDecision): string {
  const name = skillName(learner, curriculum);
  const opener =
    policy.difficulty === "foundational"
      ? `Let's build up ${name} step by step.`
      : policy.difficulty === "stretch"
        ? `You're strong on ${name} — here's the crux.`
        : `Here's how ${name} works.`;

  const concept = curriculum.skillDescription
    ? `The core idea: ${curriculum.skillDescription}.`
    : `${name} is best understood by the method it uses rather than memorising results.`;

  const prereqNote =
    learner.focusSkill && learner.focusSkill.prereqReadiness < 0.6 && learner.focusSkill.prereqs.length
      ? `Because this builds on ${learner.focusSkill.prereqs
          .filter((p) => !p.met)
          .map((p) => p.skillName)
          .join(" and ") || learner.focusSkill.prereqs[0].skillName}, make sure that feels solid first.`
      : null;

  const ex = primaryExample(curriculum);
  const illustration =
    ex && !policy.withholdAnswers && ex.explanation
      ? `For instance, take "${ex.stem}" — ${ex.explanation}.`
      : ex
        ? `For instance, when you see "${ex.stem}", focus on the method, not the specific numbers.`
        : null;

  const check = `Quick check: can you say, in your own words, the first step you'd take?`;

  return joinSentences([opener, concept, prereqNote, illustration, check]);
}

function hint(learner: LearnerTutorContext, curriculum: CurriculumContext): string {
  const name = skillName(learner, curriculum);
  const pendingStem = learner.assessment?.pendingItem?.stem;
  // Progressive hints are authored to be shown before the answer — safe to use.
  const bankHint = curriculum.examples.flatMap((e) => e.hints)[0];
  const target = pendingStem ? `For "${pendingStem}"` : `On ${name}`;

  if (bankHint) {
    return joinSentences([`${target}, here's a nudge:`, `${bankHint}.`, "Want another hint, or shall I let you try?"]);
  }
  const method = curriculum.skillDescription
    ? `Start from the definition: ${curriculum.skillDescription}.`
    : `Identify what's being asked and the very first operation the method needs.`;
  return joinSentences([`${target}, don't jump to the answer.`, method, "Try the first step and tell me what you get."]);
}

function socratic(learner: LearnerTutorContext, curriculum: CurriculumContext): string {
  const name = skillName(learner, curriculum);
  const questions: string[] = [];
  const unmet = learner.focusSkill?.prereqs.find((p) => !p.met);
  if (unmet) questions.push(`What do you remember about ${unmet.skillName}, which this relies on?`);
  questions.push(`When you look at a ${name} problem, what's the very first thing you notice?`);
  questions.push(`What single step would move you closer — and how could you check it's right?`);
  const numbered = questions.slice(0, 3).map((q, i) => `${i + 1}. ${q}`);
  return joinSentences([`Let's reason it out together — no answers from me yet:`]) + "\n" + numbered.join("\n");
}

function workedExample(
  learner: LearnerTutorContext,
  curriculum: CurriculumContext,
  policy: TutorPolicyDecision,
): string {
  const name = skillName(learner, curriculum);
  if (policy.withholdAnswers || policy.requireAnalogousExample) {
    // Cannot solve the live item — walk the METHOD using hints as steps.
    const steps = curriculum.examples.flatMap((e) => e.hints).slice(0, 4);
    const body = steps.length
      ? steps.map((s, i) => `Step ${i + 1}: ${s}.`).join(" ")
      : `Step 1: restate the problem. Step 2: apply the core rule of ${name}. Step 3: simplify. Step 4: check your result.`;
    return joinSentences([
      `Since your assessment is live, I won't solve the current question — here's the general method on a fresh, similar problem instead.`,
      body,
      `Now apply that same sequence to your item.`,
    ]);
  }
  const ex = primaryExample(curriculum);
  if (ex && ex.explanation) {
    const steps = ex.hints.length ? ex.hints.map((h, i) => `Step ${i + 1}: ${h}.`).join(" ") : "";
    return joinSentences([
      `Worked example — "${ex.stem}":`,
      steps,
      `Putting it together: ${ex.explanation}.`,
      `The general method: identify the pattern, apply the rule, then verify. Try the same steps on the next one.`,
    ]);
  }
  return joinSentences([
    `Here's the method for ${name}: restate the problem, apply the core rule, simplify, then check.`,
    `Work an example slowly and narrate each step — that's what makes it transfer.`,
  ]);
}

function diagnose(learner: LearnerTutorContext, curriculum: CurriculumContext): string {
  const focus = learner.focusSkill;
  const name = skillName(learner, curriculum);
  if (learner.coldStart || !focus || focus.attempts < 3) {
    return joinSentences([
      `There isn't enough evidence yet to diagnose a misconception on ${name} with confidence.`,
      `A short diagnostic checkpoint would calibrate this — treat anything now as provisional.`,
    ]);
  }
  const patternMap: Record<string, string> = {
    careless: "you're answering quickly and slipping on execution rather than concept — the ideas are there, the checks aren't",
    struggling: "you're spending longer and still missing — this looks like a genuine concept gap, not a slip",
    guessing: "some fast correct answers on hard items look like guessing rather than secure reasoning",
    slipping: "mostly solid with occasional slips under load",
    none: "no single dominant error pattern stands out",
  };
  const pattern = patternMap[focus.errorType] ?? "the pattern is mixed";
  const misconception = curriculum.misconceptionBank[0]
    ? `A common trap here is: ${curriculum.misconceptionBank[0]}.`
    : null;
  const recent = learner.recentMistakes[0]
    ? `Your most recent miss was on a ${learner.recentMistakes[0].difficulty} ${learner.recentMistakes[0].skillName} item.`
    : null;
  return joinSentences([
    `Looking at ${name}: ${pattern}.`,
    recent,
    misconception,
    focus.errorType === "careless"
      ? "Try slowing down and re-reading before you commit."
      : "Let's target the underlying idea directly.",
  ]);
}

function remediate(
  learner: LearnerTutorContext,
  curriculum: CurriculumContext,
  policy: TutorPolicyDecision,
): string {
  const focus = learner.focusSkill;
  const name = skillName(learner, curriculum);
  const prereq =
    policy.focusPrereqSkillId != null
      ? focus?.prereqs.find((p) => p.skillId === policy.focusPrereqSkillId)
      : undefined;

  const opener = prereq
    ? `Before pushing on ${name}, let's shore up ${prereq.skillName} (currently ${(prereq.mastery * 100).toFixed(
        0,
      )}%) — that's the gap holding you back.`
    : `Here's a focused plan for ${name}.`;

  const styleMove: Record<TutorPolicyDecision["remediationStyle"], string> = {
    scaffold: "We'll drop to smaller, guided steps and rebuild from a worked example.",
    "accuracy-checks": "The concept is mostly there, so we'll add a quick self-check routine to catch slips.",
    conceptual: "We'll focus on the 'why' so the method stops feeling arbitrary.",
    stretch: "You're ready for harder, transfer-style problems to consolidate.",
    foundational: "We'll start from the basics and build evidence with a short checkpoint.",
  };

  const microExplanation = curriculum.skillDescription ? `Key idea to hold onto: ${curriculum.skillDescription}.` : null;
  const practice = learner.recommendedActivity
    ? `Practice step: ${learner.recommendedActivity.title}.`
    : `Practice step: a short set of ${name} items at your level.`;

  return joinSentences([opener, styleMove[policy.remediationStyle], microExplanation, practice]);
}

function nextActivity(learner: LearnerTutorContext, curriculum: CurriculumContext): string {
  const a = learner.recommendedActivity;
  if (a) {
    return joinSentences([`Do this next: ${a.title}.`, a.reason, `It's the highest-leverage move for you right now.`]);
  }
  const focus = learner.focusSkill;
  const name = skillName(learner, curriculum);
  if (focus && focus.mastery < 0.85) {
    return joinSentences([
      `Do this next: a targeted practice set on ${name}.`,
      `Mastery is ${(focus.mastery * 100).toFixed(0)}%, so focused reps here move your overall progress most.`,
    ]);
  }
  return joinSentences([
    `You're on top of your tracked skills.`,
    `A short spaced-review session will keep them from decaying — that's the best next step.`,
  ]);
}

/* ------------------------------ follow-ups etc ------------------------------ */

function followUpsFor(intent: TutorGenerationInput["intent"], policy: TutorPolicyDecision): string[] {
  switch (intent) {
    case "explain":
      return ["Show me a worked example", "Ask me a question to check I got it"];
    case "hint":
      return policy.withholdAnswers ? ["I'm still stuck — another hint", "Let me try now"] : ["Another hint", "Show the full method"];
    case "socratic":
      return ["I answered — what's next?", "Give me a hint instead"];
    case "worked_example":
      return ["Let me try one myself", "Explain why that step works"];
    case "diagnose":
      return ["How do I fix it?", "Give me practice on this"];
    case "remediate":
      return ["Start the practice", "Explain the prerequisite first"];
    case "next_activity":
      return ["Why this one?", "Give me a different option"];
    default:
      return [];
  }
}

function suggestedActivityFor(
  intent: TutorGenerationInput["intent"],
  learner: LearnerTutorContext,
): RecommendedActivityView | null {
  if (intent === "next_activity" || intent === "remediate") return learner.recommendedActivity;
  return null;
}

/* --------------------------------- provider -------------------------------- */

export const deterministicTutor: TutorLlm = {
  id: "deterministic",
  async generate(input: TutorGenerationInput): Promise<TutorGenerationOutput> {
    const { learner, curriculum, policy, intent } = input;
    let message: string;
    switch (intent) {
      case "explain":
        message = explain(learner, curriculum, policy);
        break;
      case "hint":
        message = hint(learner, curriculum);
        break;
      case "socratic":
        message = socratic(learner, curriculum);
        break;
      case "worked_example":
        message = workedExample(learner, curriculum, policy);
        break;
      case "diagnose":
        message = diagnose(learner, curriculum);
        break;
      case "remediate":
        message = remediate(learner, curriculum, policy);
        break;
      case "next_activity":
        message = nextActivity(learner, curriculum);
        break;
      default:
        message = explain(learner, curriculum, policy);
    }

    return {
      message: clampText(message, input.maxOutputChars),
      followUps: followUpsFor(intent, policy),
      suggestedActivity: suggestedActivityFor(intent, learner),
      provider: "deterministic",
      model: "grounded-composer-v1",
      usedFallback: false,
    };
  },
};
