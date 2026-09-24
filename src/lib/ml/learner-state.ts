/**
 * Composite learner-state builder.
 *
 * Turns raw persistence rows (mastery states + recent responses + skill
 * metadata) into the rich `LearnerState` the adaptive engine reasons over. It is
 * a *pure* function — no DB, no wall clock (callers pass `now`) — so it is fully
 * unit-testable and deterministic.
 *
 * It fuses the 15 required signals:
 *  1 mastery · 2 recent perf · 3 historical perf · 4 response time ·
 *  5 difficulty faced · 6 bloom faced · 7 attempts · 8 confidence/evidence ·
 *  9 forgetting/retention · 10 prerequisite mastery · 11 assessment context ·
 * 12 learning velocity · 13 error patterns · 14 hint usage · 15 engagement.
 */
import { DEFAULT_BKT } from "@/lib/ml/knowledge-tracing";
import { DEFAULT_BAYESIAN } from "@/lib/ml/models/bayesian";
import { clamp, daysBetween, mean, round } from "@/lib/utils";
import { detectMisconceptions } from "./misconceptions";
import type {
  AssessmentContext,
  ErrorProfile,
  LearnerSkillState,
  LearnerState,
} from "@/lib/ml/interfaces";

export interface RawSkillState {
  skillId: number;
  skillName: string;
  subjectName: string;
  /** Stored (pre-decay) mastery. */
  mastery: number;
  attempts: number;
  correct: number;
  streak: number;
  history: { t: string; m: number }[];
  lastPracticedAt: Date | string | null;
  prereqIds: number[];
  difficultyBase: number;
  /** Alignment with the active learning path, 0..1. Optional. */
  pathAlignment?: number;
}

export interface RawResponse {
  skillId: number;
  isCorrect: boolean;
  responseTimeMs: number;
  estimatedSeconds: number;
  difficulty: number;
  bloom: number;
  hintUsed?: boolean;
  questionId?: number;
  responseId?: number;
  subskill?: string | null;
  selectedOption?: number | null;
  distractor?: string | null;
  misconception?: string | null;
  prerequisiteSkillId?: number | null;
  masteryAtObservation?: number;
  createdAt: Date | string;
}

export interface BuildLearnerStateInput {
  studentId: number;
  skillStates: RawSkillState[];
  responses: RawResponse[];
  now?: Date;
  recentWindow?: number;
  context?: Partial<AssessmentContext>;
}

const EMPTY_ERROR: ErrorProfile = {
  type: "insufficient-data",
  carelessRate: 0,
  strugglingRate: 0,
  guessRate: 0,
  label: "Not enough responses to profile errors",
};

/** Forgetting-curve decay relative to an explicit `now` (keeps the builder pure). */
function decayMastery(mastery: number, lastPracticedAt: Date | string | null, now: Date, forget = DEFAULT_BKT.forget) {
  if (!lastPracticedAt) return mastery;
  const days = Math.max(0, daysBetween(lastPracticedAt, now));
  return clamp(mastery * Math.exp(-forget * days), 0.01, 0.995);
}

/** Response-time ratio: observed / expected (~1 normal, <1 fast, >1 slow). */
function responseRatio(r: RawResponse) {
  const expected = Math.max(1, r.estimatedSeconds) * 1000;
  return clamp(r.responseTimeMs / expected, 0, 5);
}

/** Slope of the mastery history per step, scaled to roughly -1..1. */
function velocityFromHistory(history: { m: number }[], window: number) {
  const pts = history.slice(-window).map((h) => h.m);
  if (pts.length < 2) return 0;
  const xs = pts.map((_, i) => i);
  const mx = mean(xs);
  const my = mean(pts);
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < pts.length; i += 1) {
    sxy += (xs[i] - mx) * (pts[i] - my);
    sxx += (xs[i] - mx) ** 2;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  return clamp(slope * 4, -1, 1);
}

/** Evidence-based uncertainty via a Beta posterior over aggregate counts. */
export function uncertaintyFromCounts(attempts: number, correct: number) {
  const alpha = DEFAULT_BAYESIAN.priorAlpha + correct;
  const beta = DEFAULT_BAYESIAN.priorBeta + Math.max(0, attempts - correct);
  const n = alpha + beta;
  const variance = (alpha * beta) / (n * n * (n + 1));
  return clamp(Math.sqrt(variance) / 0.5, 0.02, 1);
}

function classifyErrors(responses: RawResponse[]): ErrorProfile {
  if (responses.length < 3) return { ...EMPTY_ERROR };
  const wrongs = responses.filter((r) => !r.isCorrect);
  const corrects = responses.filter((r) => r.isCorrect);
  const fastWrong = wrongs.filter((r) => responseRatio(r) < 0.6).length;
  const slowWrong = wrongs.filter((r) => responseRatio(r) > 1.3).length;
  const guessyCorrect = corrects.filter((r) => r.difficulty > 0.6 && responseRatio(r) < 0.5).length;

  const carelessRate = wrongs.length ? fastWrong / wrongs.length : 0;
  const strugglingRate = wrongs.length ? slowWrong / wrongs.length : 0;
  const guessRate = corrects.length ? guessyCorrect / corrects.length : 0;
  const accuracy = corrects.length / responses.length;

  let type: ErrorProfile["type"] = "none";
  let label = "Errors look random / no dominant pattern";
  if (!wrongs.length && guessRate < 0.4) {
    type = "none";
    label = "No incorrect responses in the window";
  } else if (carelessRate >= 0.5) {
    type = "careless";
    label = "Fast incorrect answers — likely careless slips, not knowledge gaps";
  } else if (strugglingRate >= 0.5) {
    type = "struggling";
    label = "Slow incorrect answers — genuine difficulty, scaffold down";
  } else if (guessRate >= 0.4) {
    type = "guessing";
    label = "Fast correct answers on hard items — possible guessing";
  } else if (accuracy >= 0.7 && slowWrong > 0) {
    type = "slipping";
    label = "Mostly correct but occasional slips under load";
  }

  return {
    type,
    carelessRate: round(carelessRate, 3),
    strugglingRate: round(strugglingRate, 3),
    guessRate: round(guessRate, 3),
    label,
  };
}

export function buildLearnerState(input: BuildLearnerStateInput): LearnerState {
  const now = input.now ?? new Date();
  const window = input.recentWindow ?? 10;
  const responses = [...input.responses].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
  const responsesBySkill = new Map<number, RawResponse[]>();
  for (const r of responses) {
    const list = responsesBySkill.get(r.skillId) ?? [];
    list.push(r);
    responsesBySkill.set(r.skillId, list);
  }

  // Decayed mastery per skill (needed for prereq readiness lookups).
  const decayedMastery = new Map<number, number>();
  for (const s of input.skillStates) {
    decayedMastery.set(s.skillId, decayMastery(s.mastery, s.lastPracticedAt, now));
  }

  const skills = new Map<number, LearnerSkillState>();
  for (const s of input.skillStates) {
    const raw = clamp(s.mastery, 0, 1);
    const decayed = decayedMastery.get(s.skillId) ?? raw;
    const daysSince = s.lastPracticedAt ? Math.max(0, daysBetween(s.lastPracticedAt, now)) : Infinity;
    const skillResponses = responsesBySkill.get(s.skillId) ?? [];
    const recent = skillResponses.slice(-window);

    const accuracy = s.attempts ? clamp(s.correct / s.attempts) : 0.5;
    const recentAccuracy = recent.length
      ? recent.filter((r) => r.isCorrect).length / recent.length
      : accuracy;
    const ratio = recent.length ? mean(recent.map(responseRatio)) : 1;
    const uncertainty = uncertaintyFromCounts(s.attempts, s.correct);

    const prereqMastery = s.prereqIds.map((id) => ({
      skillId: id,
      name: input.skillStates.find((x) => x.skillId === id)?.skillName ?? `Skill ${id}`,
      mastery: round(decayedMastery.get(id) ?? 0, 3),
    }));
    // Bottleneck semantics: a learner is only as ready as their *weakest*
    // prerequisite (with a small credit for the average), which keeps the engine
    // from advancing on the back of one strong prereq while another is weak.
    const prereqReadiness = prereqMastery.length
      ? clamp(Math.min(...prereqMastery.map((p) => p.mastery)) * 0.85 + mean(prereqMastery.map((p) => p.mastery)) * 0.15)
      : 1;

    const hintResponses = skillResponses.filter((r) => r.hintUsed !== undefined);
    const hasHintData = hintResponses.length > 0;
    const hintReliance = hasHintData
      ? hintResponses.filter((r) => r.hintUsed).length / hintResponses.length
      : 0;

    const avgDifficulty = recent.length ? mean(recent.map((r) => r.difficulty)) : s.difficultyBase;
    const avgBloom = recent.length ? mean(recent.map((r) => r.bloom)) : 3;
    const misconceptions = detectMisconceptions(skillResponses.map((r, index) => ({
      responseId: r.responseId,
      questionId: r.questionId ?? -(index + 1),
      skillId: r.skillId,
      subskill: r.subskill,
      selectedOption: r.selectedOption ?? null,
      distractor: r.distractor,
      misconception: r.misconception,
      prerequisiteSkillId: r.prerequisiteSkillId,
      isCorrect: r.isCorrect,
      responseTimeRatio: responseRatio(r),
      observedAt: r.createdAt,
      masteryAtObservation: r.masteryAtObservation,
    })));

    skills.set(s.skillId, {
      skillId: s.skillId,
      skillName: s.skillName,
      subjectName: s.subjectName,
      mastery: round(decayed, 3),
      rawMastery: round(raw, 3),
      confidence: round(1 - uncertainty, 3),
      uncertainty: round(uncertainty, 3),
      attempts: s.attempts,
      correct: s.correct,
      streak: s.streak,
      accuracy: round(accuracy, 3),
      recentAccuracy: round(recentAccuracy, 3),
      responseRatio: round(ratio, 3),
      retention: raw > 0 ? round(clamp(decayed / raw), 3) : 1,
      daysSincePractice: Number.isFinite(daysSince) ? round(daysSince, 2) : 999,
      velocity: round(velocityFromHistory(s.history, window), 3),
      prereqReadiness: round(prereqReadiness, 3),
      prereqMastery,
      errorProfile: classifyErrors(skillResponses),
      misconceptions,
      hintReliance: round(hintReliance, 3),
      hasHintData,
      avgDifficulty: round(avgDifficulty, 3),
      avgBloom: round(avgBloom, 3),
      difficultyBase: s.difficultyBase,
      pathAlignment: clamp(s.pathAlignment ?? 0.3),
      prereqIds: s.prereqIds,
    });
  }

  // ---- global aggregates ----
  const masteries = [...skills.values()].map((s) => s.mastery);
  const ability = masteries.length ? clamp(mean(masteries)) : 0.45;
  const totalAttempts = input.skillStates.reduce((a, s) => a + s.attempts, 0);
  const totalCorrect = input.skillStates.reduce((a, s) => a + s.correct, 0);
  const historicalAccuracy = totalAttempts ? clamp(totalCorrect / totalAttempts) : 0.5;
  const recentAll = responses.slice(-window);
  const recentAccuracy = recentAll.length
    ? recentAll.filter((r) => r.isCorrect).length / recentAll.length
    : historicalAccuracy;
  const avgResponseRatio = recentAll.length ? mean(recentAll.map(responseRatio)) : 1;
  const velocity = skills.size ? mean([...skills.values()].map((s) => s.velocity)) : 0;

  // engagement (15): recency + volume + consistency of recent activity
  const mostRecent = responses.at(-1);
  const daysSinceAny = mostRecent ? Math.max(0, daysBetween(mostRecent.createdAt, now)) : Infinity;
  const recencyScore = Number.isFinite(daysSinceAny) ? clamp(1 - daysSinceAny / 14) : 0;
  const volumeScore = clamp(recentAll.length / window);
  // consistency: low variance in correctness → steady engagement
  const consistency = recentAll.length
    ? 1 - Math.abs(0.5 - recentAll.filter((r) => r.isCorrect).length / recentAll.length) * 2 * 0.4
    : 0.5;
  const engagement = clamp(recencyScore * 0.5 + volumeScore * 0.3 + consistency * 0.2);

  const itemsAnswered = input.context?.itemsAnswered ?? 0;
  const itemTarget = input.context?.itemTarget ?? 8;
  const context: AssessmentContext = {
    mode: input.context?.mode ?? "adaptive_quiz",
    itemsAnswered,
    itemTarget,
    sessionAccuracy: input.context?.sessionAccuracy ?? recentAccuracy,
    fatigue: clamp(itemsAnswered / Math.max(1, itemTarget * 1.5)),
  };

  return {
    studentId: input.studentId,
    ability: round(ability, 3),
    historicalAccuracy: round(historicalAccuracy, 3),
    recentAccuracy: round(recentAccuracy, 3),
    avgResponseRatio: round(avgResponseRatio, 3),
    velocity: round(velocity, 3),
    engagement: round(engagement, 3),
    context,
    skills,
  };
}
