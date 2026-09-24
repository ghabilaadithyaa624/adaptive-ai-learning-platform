/**
 * Stage 2 — Retrieval / Curriculum context.
 *
 * Gathers the grounding material the tutor is allowed to reason from: the focus
 * skill's description, its prerequisite chain, and representative published
 * items (their progressive hints and per-distractor misconceptions).
 *
 * ANSWER SAFETY: when `withholdAnswers` is set (an assessment is live), item
 * explanations — which reveal the answer — are redacted here, at the retrieval
 * boundary, so the answer key never even enters the prompt. Progressive hints
 * are retained because they are authored specifically to be shown *before* the
 * answer. This is the first of two answer-safety layers (the second is a
 * post-generation scan in the pipeline).
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { questions, skills, subjects } from "@/db/schema";
import { SERVABLE_STATUSES } from "@/lib/questions/constants";
import { round } from "@/lib/utils";
import type { CurriculumContext, CurriculumExample, LearnerTutorContext } from "./types";

const MAX_EXAMPLES = 4;
const MAX_MISCONCEPTIONS = 6;

export interface RetrievalOptions {
  /** When true, redact answer-revealing explanations from all examples. */
  withholdAnswers: boolean;
  /** The pending item id, always redacted regardless of the global flag. */
  pendingQuestionId?: number | null;
}

export async function assembleCurriculumContext(
  learner: LearnerTutorContext,
  options: RetrievalOptions,
): Promise<CurriculumContext> {
  const focus = learner.focusSkill;
  if (!focus) {
    return {
      skillId: null,
      skillName: null,
      skillDescription: null,
      subjectName: null,
      prereqChain: [],
      examples: [],
      misconceptionBank: [],
    };
  }

  // Load the whole (small) taxonomy so we can walk the prerequisite chain and
  // resolve names without N+1 queries.
  const skillRows = await db
    .select({ skill: skills, subjectName: subjects.name })
    .from(skills)
    .innerJoin(subjects, eq(subjects.id, skills.subjectId));
  const byId = new Map(skillRows.map((r) => [r.skill.id, r]));
  const masteryByPrereq = new Map(focus.prereqs.map((p) => [p.skillId, p.mastery]));

  // ---- prerequisite chain, foundational-first (topological-ish by depth) ----
  const chainIds: number[] = [];
  const seen = new Set<number>();
  const walk = (id: number) => {
    const row = byId.get(id);
    if (!row) return;
    for (const pid of row.skill.prereqIds ?? []) {
      if (!seen.has(pid)) {
        seen.add(pid);
        walk(pid);
        chainIds.push(pid);
      }
    }
  };
  walk(focus.skillId);
  const prereqChain = chainIds.map((id) => {
    const row = byId.get(id);
    return {
      skillId: id,
      skillName: row?.skill.name ?? `Skill ${id}`,
      description: row?.skill.description ?? "",
      mastery: round(masteryByPrereq.get(id) ?? 0, 3),
    };
  });

  // ---- representative published items for grounding ----
  const questionRows = await db
    .select()
    .from(questions)
    .where(
      and(
        eq(questions.skillId, focus.skillId),
        eq(questions.isActive, true),
        inArray(questions.status, SERVABLE_STATUSES),
      ),
    )
    .orderBy(asc(questions.difficultyValue))
    .limit(MAX_EXAMPLES * 3);

  const examples: CurriculumExample[] = questionRows.slice(0, MAX_EXAMPLES).map((q) => {
    // Redact the answer for the live item specifically, or for every item when
    // an assessment is in progress (defense in depth).
    const redact = options.withholdAnswers || options.pendingQuestionId === q.id;
    const misconceptions = (q.distractorMeta ?? [])
      .filter((d) => d.rationale || d.misconception)
      .map((d) => ({ rationale: d.rationale ?? d.misconception ?? "" }))
      .filter((d) => d.rationale.length > 0);
    return {
      questionId: q.id,
      stem: q.stem,
      difficulty: q.difficultyLabel,
      bloom: q.bloomLevel,
      hints: q.hints ?? [],
      explanation: redact ? null : q.explanation || null,
      misconceptions,
      redacted: redact,
    };
  });

  // ---- aggregate misconception bank across the skill's items ----
  const misconceptionBank: string[] = [];
  const seenText = new Set<string>();
  for (const q of questionRows) {
    for (const d of q.distractorMeta ?? []) {
      const text = (d.rationale ?? d.misconception ?? "").trim();
      if (text && !seenText.has(text)) {
        seenText.add(text);
        misconceptionBank.push(text);
        if (misconceptionBank.length >= MAX_MISCONCEPTIONS) break;
      }
    }
    if (misconceptionBank.length >= MAX_MISCONCEPTIONS) break;
  }

  return {
    skillId: focus.skillId,
    skillName: focus.skillName,
    skillDescription: focus.description,
    subjectName: focus.subjectName,
    prereqChain,
    examples,
    misconceptionBank,
  };
}
