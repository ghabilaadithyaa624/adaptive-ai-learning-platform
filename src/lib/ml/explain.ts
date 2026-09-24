/**
 * Deterministic natural-language explanations for adaptive decisions.
 *
 * Produces sentences in the required house style, e.g.:
 *   "Selected because Algebra mastery is 0.61, target is 0.85, prerequisite
 *    Geometry is sufficiently mastered, and this item provides high expected
 *    information gain."
 *
 * No LLM — the text is templated from the numeric decision factors so it is
 * reproducible and auditable. Driver phrases are verb-first so they compose
 * grammatically whether they lead a clause or follow "this item".
 */
import type { DecisionFactor, LearnerSkillState } from "@/lib/ml/interfaces";

const DRIVER_PHRASES: Record<string, (f: DecisionFactor) => string> = {
  informationGain: (f) =>
    `provides ${f.value >= 0.75 ? "high" : f.value >= 0.4 ? "solid" : "modest"} expected information gain`,
  difficultyFit: () => "sits squarely in the learner's zone of proximal development",
  expectedLearningGain: (f) =>
    `maximises expected mastery gain${f.value >= 0.6 ? " (a large step forward)" : ""}`,
  masteryGap: () => "targets the widest gap to the mastery goal",
  spacedReview: () => "is due for spaced review before it decays further",
  uncertainty: () => "sharpens a skill the model is still uncertain about",
  exploration: () => "explores an under-sampled skill for better coverage",
};

export function prereqClause(skill: LearnerSkillState): string | null {
  if (!skill.prereqMastery.length) return null;
  const weakest = [...skill.prereqMastery].sort((a, b) => a.mastery - b.mastery)[0];
  if (skill.prereqReadiness >= 0.6) {
    return `prerequisite ${weakest.name} is sufficiently mastered (${weakest.mastery.toFixed(2)})`;
  }
  return `prerequisite ${weakest.name} is still weak (${weakest.mastery.toFixed(2)}) so foundations are reinforced first`;
}

export function composeExplanation(params: {
  skill: LearnerSkillState;
  target: number;
  predictedCorrect: number;
  factors: DecisionFactor[];
}): string {
  const { skill, target, predictedCorrect, factors } = params;
  const positive = factors
    .filter((f) => f.weighted > 0 && DRIVER_PHRASES[f.key])
    .sort((a, b) => b.weighted - a.weighted);
  const lead = `Selected because ${skill.skillName} mastery is ${skill.mastery.toFixed(2)}, target is ${target.toFixed(2)}`;

  const clauses: string[] = [];
  const prereq = prereqClause(skill);
  if (prereq) clauses.push(prereq);

  const topDriver = positive[0];
  if (topDriver) clauses.push(`this item ${DRIVER_PHRASES[topDriver.key](topDriver)}`);
  const secondDriver = positive[1];
  if (secondDriver && secondDriver.key !== topDriver?.key) {
    clauses.push(`also ${DRIVER_PHRASES[secondDriver.key](secondDriver)}`);
  }

  clauses.push(`predicted success is ${(predictedCorrect * 100).toFixed(0)}%`);

  // Join with the required "…, …, and …" cadence.
  if (clauses.length === 1) return `${lead}, and ${clauses[0]}.`;
  const last = clauses.pop() as string;
  return `${lead}, ${clauses.join(", ")}, and ${last}.`;
}
