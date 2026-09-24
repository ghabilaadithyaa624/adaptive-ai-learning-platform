/**
 * Shared server-side helpers for the item bank: building the validation context
 * from the live taxonomy + bank, and normalising authoring input.
 */
import { db } from "@/db";
import { questions, skills } from "@/db/schema";
import {
  DIFFICULTY_TO_VALUE,
  type DifficultyLabel,
  difficultyLabelForValue,
} from "./constants";
import type { ValidationContext } from "./validation";

/** Build a `ValidationContext` (valid skills, prerequisite graph, existing stems). */
export async function buildValidationContext(): Promise<ValidationContext> {
  const [skillRows, questionRows] = await Promise.all([
    db.select({ id: skills.id, prereqIds: skills.prereqIds }).from(skills),
    db.select({ id: questions.id, skillId: questions.skillId, stem: questions.stem }).from(questions),
  ]);
  return {
    skillIds: new Set(skillRows.map((s) => s.id)),
    skillPrereqs: new Map(skillRows.map((s) => [s.id, s.prereqIds ?? []])),
    existing: questionRows,
    duplicateThreshold: 0.85,
  };
}

/** Fields whose change invalidates a published item's calibration and content trust. */
export const CONTENT_FIELDS = ["stem", "options", "correctIndex", "skillId"] as const;

/** Derive a numeric difficulty value that is consistent with the chosen band. */
export function resolveDifficultyValue(
  difficultyLabel: string,
  provided: number | null | undefined,
): number {
  if (provided != null && Number.isFinite(provided) && provided >= 0 && provided <= 1) return provided;
  return DIFFICULTY_TO_VALUE[difficultyLabel as DifficultyLabel] ?? 0.55;
}

export { difficultyLabelForValue };
