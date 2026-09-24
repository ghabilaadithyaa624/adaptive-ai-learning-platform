/**
 * Item validation — psychometric and structural integrity checks.
 *
 * Returns a structured report of blocking `errors` and advisory `warnings`.
 * An item may only advance to `validated`/`published` when it has zero errors
 * (see workflow guards). Warnings surface quality concerns without blocking.
 *
 * Pure and deterministic — no I/O. Callers pass the taxonomy + existing items as
 * a `ValidationContext`.
 */
import {
  BLOOM_LEVELS,
  COGNITIVE_COMPLEXITY_LEVELS,
  DIFFICULTY_LABELS,
  DIFFICULTY_TO_VALUE,
  QUESTION_SOURCES,
  difficultyLabelForValue,
} from "./constants";

export interface QuestionInput {
  id?: number;
  stem: string;
  options: string[];
  correctIndex: number;
  skillId: number;
  subskill?: string | null;
  prerequisiteSkillIds?: number[];
  difficultyLabel: string;
  difficultyValue?: number | null;
  bloomLevel: string;
  cognitiveComplexity?: string | null;
  estimatedSeconds?: number | null;
  hints?: string[];
  distractorMeta?: { optionIndex: number; misconception?: string; rationale?: string; prerequisiteSkillId?: number }[];
  source?: string;
}

export interface ValidationContext {
  /** Set of valid skill ids in the taxonomy. */
  skillIds: Set<number>;
  /** skillId → prerequisite skill ids, for cycle detection. */
  skillPrereqs?: Map<number, number[]>;
  /** Existing items to check duplicates against. */
  existing?: { id: number; skillId: number; stem: string }[];
  /** Jaccard similarity at/above which two stems in the same skill are "near duplicates". */
  duplicateThreshold?: number;
}

export interface ValidationIssue {
  code: string;
  field: string;
  message: string;
}

export interface ValidationReport {
  valid: boolean; // true when there are no errors
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 8;
const IDEAL_OPTIONS = [3, 4, 5];

/** Normalise a stem for duplicate detection: lowercase, strip punctuation, collapse spaces. */
export function normalizeStem(stem: string): string {
  return stem
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Token-set Jaccard similarity of two stems in [0,1]. */
export function stemSimilarity(a: string, b: string): number {
  const ta = new Set(normalizeStem(a).split(" ").filter(Boolean));
  const tb = new Set(normalizeStem(b).split(" ").filter(Boolean));
  if (!ta.size && !tb.size) return 1;
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  const union = ta.size + tb.size - inter;
  return union ? inter / union : 0;
}

/** Detect whether adding `prereqIds` to `skillId` would create a prerequisite cycle. */
export function wouldCreateCycle(
  skillId: number,
  prereqIds: number[],
  graph: Map<number, number[]>,
): boolean {
  // If any prereq can (transitively) reach skillId, adding it forms a cycle.
  const target = skillId;
  const seen = new Set<number>();
  const stack = [...prereqIds];
  while (stack.length) {
    const node = stack.pop() as number;
    if (node === target) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const next of graph.get(node) ?? []) stack.push(next);
  }
  return false;
}

export function validateQuestion(input: QuestionInput, ctx: ValidationContext): ValidationReport {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const err = (code: string, field: string, message: string) => errors.push({ code, field, message });
  const warn = (code: string, field: string, message: string) => warnings.push({ code, field, message });

  /* ------------------------------- stem -------------------------------- */
  const stem = (input.stem ?? "").trim();
  if (stem.length < 3) err("stem_too_short", "stem", "The question stem is required.");
  if (stem.length > 2000) err("stem_too_long", "stem", "The question stem is too long (max 2000 chars).");

  /* ----------------------------- options ------------------------------- */
  const options = (input.options ?? []).map((o) => (o ?? "").trim());
  const nonEmpty = options.filter((o) => o.length > 0);
  if (nonEmpty.length < MIN_OPTIONS) {
    err("too_few_options", "options", `At least ${MIN_OPTIONS} non-empty options are required.`);
  }
  if (nonEmpty.length > MAX_OPTIONS) {
    err("too_many_options", "options", `At most ${MAX_OPTIONS} options are allowed.`);
  }
  if (nonEmpty.length >= MIN_OPTIONS && !IDEAL_OPTIONS.includes(nonEmpty.length)) {
    warn("option_count_atypical", "options", "Most multiple-choice items work best with 3–5 options.");
  }
  // duplicate option texts
  const seenOpt = new Map<string, number>();
  for (const o of nonEmpty) {
    const key = o.toLowerCase();
    seenOpt.set(key, (seenOpt.get(key) ?? 0) + 1);
  }
  for (const [, count] of seenOpt) {
    if (count > 1) {
      err("duplicate_options", "options", "Two or more options are identical.");
      break;
    }
  }

  /* -------------------------- correct answer --------------------------- */
  const correctIndex = input.correctIndex;
  if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= options.length) {
    err("correct_index_out_of_range", "correctIndex", "The correct-answer index is out of range.");
  } else if (!options[correctIndex] || options[correctIndex].length === 0) {
    err("correct_answer_empty", "correctIndex", "The correct answer points to an empty option.");
  }

  /* ---------------------------- difficulty ----------------------------- */
  if (!DIFFICULTY_LABELS.includes(input.difficultyLabel as never)) {
    err("invalid_difficulty_label", "difficultyLabel", `Difficulty must be one of: ${DIFFICULTY_LABELS.join(", ")}.`);
  }
  if (input.difficultyValue != null) {
    if (typeof input.difficultyValue !== "number" || Number.isNaN(input.difficultyValue) || input.difficultyValue < 0 || input.difficultyValue > 1) {
      err("invalid_difficulty_value", "difficultyValue", "Difficulty value must be a number between 0 and 1.");
    } else if (
      DIFFICULTY_LABELS.includes(input.difficultyLabel as never) &&
      difficultyLabelForValue(input.difficultyValue) !== input.difficultyLabel
    ) {
      warn(
        "difficulty_mismatch",
        "difficultyValue",
        `Difficulty value ${input.difficultyValue.toFixed(2)} is closer to "${difficultyLabelForValue(
          input.difficultyValue,
        )}" than the chosen band "${input.difficultyLabel}".`,
      );
    }
  }

  /* ------------------------------- Bloom ------------------------------- */
  if (!BLOOM_LEVELS.includes(input.bloomLevel as never)) {
    err("invalid_bloom_level", "bloomLevel", `Bloom level must be one of: ${BLOOM_LEVELS.join(", ")}.`);
  }
  if (input.cognitiveComplexity != null && input.cognitiveComplexity !== "") {
    if (!COGNITIVE_COMPLEXITY_LEVELS.includes(input.cognitiveComplexity as never)) {
      err(
        "invalid_cognitive_complexity",
        "cognitiveComplexity",
        `Cognitive complexity must be one of: ${COGNITIVE_COMPLEXITY_LEVELS.join(", ")}.`,
      );
    }
  }

  /* ------------------------- skill relationships ----------------------- */
  if (!ctx.skillIds.has(input.skillId)) {
    err("unknown_skill", "skillId", "The item references a skill that does not exist.");
  }
  const prereqs = input.prerequisiteSkillIds ?? [];
  for (const pid of prereqs) {
    if (!ctx.skillIds.has(pid)) {
      err("unknown_prerequisite", "prerequisiteSkillIds", `Prerequisite skill ${pid} does not exist.`);
    }
    if (pid === input.skillId) {
      err("self_prerequisite", "prerequisiteSkillIds", "An item's skill cannot be its own prerequisite.");
    }
  }
  if (ctx.skillPrereqs && prereqs.length) {
    if (wouldCreateCycle(input.skillId, prereqs, ctx.skillPrereqs)) {
      warn("prerequisite_cycle", "prerequisiteSkillIds", "These prerequisites introduce a cycle in the skill graph.");
    }
  }
  if (input.subskill != null && input.subskill.length > 120) {
    err("subskill_too_long", "subskill", "Subskill label is too long (max 120 chars).");
  }

  /* --------------------------- estimated time -------------------------- */
  if (input.estimatedSeconds != null) {
    if (!Number.isFinite(input.estimatedSeconds) || input.estimatedSeconds < 5 || input.estimatedSeconds > 3600) {
      err("invalid_estimated_time", "estimatedSeconds", "Estimated time must be between 5 and 3600 seconds.");
    }
  }

  /* ------------------------------- hints ------------------------------- */
  if (input.hints) {
    if (input.hints.length > 5) warn("too_many_hints", "hints", "More than 5 hints is unusual; consider trimming.");
    if (input.hints.some((h) => (h ?? "").trim().length === 0)) {
      warn("empty_hint", "hints", "One or more hints are empty and will be ignored.");
    }
  }

  /* ------------------------ distractor metadata ------------------------ */
  if (input.distractorMeta) {
    for (const meta of input.distractorMeta) {
      if (!Number.isInteger(meta.optionIndex) || meta.optionIndex < 0 || meta.optionIndex >= options.length) {
        err("distractor_index_out_of_range", "distractorMeta", `Distractor metadata references option ${meta.optionIndex}, which does not exist.`);
      } else if (meta.optionIndex === correctIndex) {
        warn("distractor_meta_on_key", "distractorMeta", "Distractor metadata describes the correct answer, not a distractor.");
      }
      if (meta.prerequisiteSkillId != null && !ctx.skillIds.has(meta.prerequisiteSkillId)) {
        err("invalid_distractor_prerequisite", "distractorMeta", `Unknown prerequisite skill ${meta.prerequisiteSkillId}.`);
      }
    }
  }

  /* ------------------------------ source ------------------------------- */
  if (input.source != null && !QUESTION_SOURCES.includes(input.source as never)) {
    err("invalid_source", "source", `Source must be one of: ${QUESTION_SOURCES.join(", ")}.`);
  }

  /* --------------------------- duplicates ------------------------------ */
  if (ctx.existing?.length) {
    const threshold = ctx.duplicateThreshold ?? 0.85;
    const norm = normalizeStem(stem);
    for (const other of ctx.existing) {
      if (input.id != null && other.id === input.id) continue;
      if (normalizeStem(other.stem) === norm && norm.length > 0) {
        err("duplicate_question", "stem", `This stem is an exact duplicate of item #${other.id}.`);
        break;
      }
    }
    // near-duplicate within the same skill
    for (const other of ctx.existing) {
      if (input.id != null && other.id === input.id) continue;
      if (other.skillId !== input.skillId) continue;
      const sim = stemSimilarity(stem, other.stem);
      if (sim >= threshold && sim < 1) {
        warn("near_duplicate_question", "stem", `This stem is ${(sim * 100).toFixed(0)}% similar to item #${other.id} in the same skill.`);
        break;
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}
