/** Structured, deterministic misconception hypotheses from observed response evidence. */
import { round } from "@/lib/utils";

export type MisconceptionConfidence = "LOW" | "MEDIUM" | "HIGH";
export type DiagnosticClassification =
  | "isolated_mistake"
  | "repeated_misconception"
  | "prerequisite_weakness"
  | "careless_error"
  | "knowledge_decay"
  | "insufficient_evidence";

export interface MisconceptionEvidence {
  responseId?: number;
  questionId: number;
  skillId: number;
  subskill?: string | null;
  selectedOption: number | null;
  distractor?: string | null;
  misconception?: string | null;
  prerequisiteSkillId?: number | null;
  isCorrect: boolean;
  responseTimeRatio: number;
  observedAt: Date | string;
  masteryAtObservation?: number;
}

export interface MisconceptionHypothesis {
  id: string;
  skillId: number;
  subskill: string | null;
  misconception: string;
  distractors: string[];
  prerequisiteSkillId: number | null;
  errorPattern: DiagnosticClassification;
  evidenceCount: number;
  confidence: MisconceptionConfidence;
  confidenceScore: number;
  firstObserved: string;
  lastObserved: string;
  evidenceQuestionIds: number[];
}

const normalized = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const confidenceFor = (n: number): MisconceptionConfidence => n >= 3 ? "HIGH" : n >= 2 ? "MEDIUM" : "LOW";

/**
 * Only authored distractor metadata can name a misconception. The detector does
 * not infer semantic labels from prose and an LLM is never consulted.
 */
export function detectMisconceptions(evidence: MisconceptionEvidence[]): MisconceptionHypothesis[] {
  const wrong = evidence.filter(e => !e.isCorrect);
  const groups = new Map<string, MisconceptionEvidence[]>();
  for (const e of wrong) {
    if (!e.misconception?.trim()) continue;
    const key = `${e.skillId}|${e.subskill ?? ""}|${e.prerequisiteSkillId ?? ""}|${normalized(e.misconception)}`;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  const hypotheses: MisconceptionHypothesis[] = [];
  for (const [id, rows] of groups) {
    const ordered = [...rows].sort((a, b) => +new Date(a.observedAt) - +new Date(b.observedAt));
    // Distinct questions prevent retries on one item from manufacturing confidence.
    const distinct = new Map<number, MisconceptionEvidence>();
    for (const row of ordered) distinct.set(row.questionId, row);
    const support = [...distinct.values()];
    const count = support.length;
    const fastShare = support.filter(e => e.responseTimeRatio < .55).length / count;
    const priorMastery = support.map(e => e.masteryAtObservation).filter((x): x is number => x != null);
    const decayed = priorMastery.length > 1 && priorMastery[0] >= .7 && priorMastery.at(-1)! < priorMastery[0] - .15;
    let pattern: DiagnosticClassification = "isolated_mistake";
    if (count < 1) pattern = "insufficient_evidence";
    else if (fastShare >= .67) pattern = "careless_error";
    else if (support.some(e => e.prerequisiteSkillId != null)) pattern = "prerequisite_weakness";
    else if (decayed) pattern = "knowledge_decay";
    else if (count >= 2) pattern = "repeated_misconception";
    // Careless/prerequisite/decay observations remain hypotheses but cannot be
    // promoted HIGH as a content misconception without three clean repetitions.
    const confidence = pattern === "repeated_misconception" ? confidenceFor(count) : count >= 2 ? "MEDIUM" : "LOW";
    const score = confidence === "HIGH" ? .9 : confidence === "MEDIUM" ? .6 : .3;
    hypotheses.push({
      id, skillId: support[0].skillId, subskill: support[0].subskill ?? null,
      misconception: support[0].misconception!.trim(),
      distractors: [...new Set(support.map(e => e.distractor).filter((x): x is string => Boolean(x)))],
      prerequisiteSkillId: support.find(e => e.prerequisiteSkillId != null)?.prerequisiteSkillId ?? null,
      errorPattern: pattern, evidenceCount: count, confidence, confidenceScore: round(score, 2),
      firstObserved: new Date(support[0].observedAt).toISOString(),
      lastObserved: new Date(support.at(-1)!.observedAt).toISOString(),
      evidenceQuestionIds: support.map(e => e.questionId),
    });
  }
  return hypotheses.sort((a, b) => b.confidenceScore - a.confidenceScore || b.evidenceCount - a.evidenceCount || a.id.localeCompare(b.id));
}
