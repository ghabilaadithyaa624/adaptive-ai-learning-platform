/**
 * Deterministic multi-session simulation of one (policy × archetype × world ×
 * seed) cell, plus the metric set the policies are graded on.
 *
 * Protocol (identical for every policy):
 *   • a warm-up history gives the tracer prior evidence (except for cold-start)
 *   • N study sessions of M items, `daysBetweenSessions` apart — so forgetting
 *     between sessions is real and spaced review is a genuine option
 *   • a final retention probe `retentionDelayDays` after the last session
 *
 * All policies share the same knowledge tracer (BKT + the platform's
 * `buildLearnerState`), the same response model, the same item bank and — via
 * common random numbers — the same luck. The only difference is *which item is
 * served next*.
 */
import { clamp, mean, round } from "@/lib/utils";
import { DEFAULT_BKT, posterior, type BktParams } from "@/lib/ml/knowledge-tracing";
import { HEURISTIC_MODEL } from "@/lib/ml/classifier";
import { buildLearnerState, type RawResponse, type RawSkillState } from "@/lib/ml/learner-state";
import { LogisticResponseModel } from "@/lib/ml/models/logistic";
import { bktModel } from "@/lib/ml/models/bkt";
import type { KnowledgeTracingModel } from "@/lib/ml/interfaces";
import { brierScore, calibration } from "@/lib/ml/evaluation";
import { MASTERY_TARGET } from "@/lib/utils";
import type { CandidateItem } from "@/lib/ml/interfaces";
import {
  ITEM_BY_ID,
  ITEMS,
  SKILLS,
  applyPractice,
  fatigueLevel,
  responseTimeMs,
  effectiveAbility,
  hashUniform,
  initialTrueState,
  isPrereqViolation,
  retrievability,
  trueProbCorrect,
  type Archetype,
  type ItemDef,
  type WorldParams,
} from "./world";
import { buildCandidatePool, type BenchPolicy, type EstimatedSkill, type PolicyContext } from "./policies";

/* ------------------------------------------------------------------ */
/* Protocol                                                            */
/* ------------------------------------------------------------------ */

export interface SimulationProtocol {
  sessions: number;
  itemsPerSession: number;
  /**
   * Optional *time* budget per session, in minutes. When set, a session serves
   * items until the next item would exceed the budget (capped at
   * `itemsPerSession × 3` for safety) instead of serving a fixed count.
   *
   * This exists because an item-budgeted comparison silently rewards a policy
   * for choosing longer items. The equal-time run is the control for that.
   */
  minutesPerSession?: number;
  daysBetweenSessions: number;
  retentionDelayDays: number;
  /** True ability at which a skill counts as mastered. */
  masteryThreshold: number;
  /** True P(correct) band that counts as a ZPD hit. */
  zpdBand: [number, number];
  /** Outside this band an item is "wasted" (too easy / too hard). */
  usefulBand: [number, number];
  /**
   * Knowledge-tracing parameters shared by every policy.
   *
   * These are the *platform defaults* (`DEFAULT_BKT`). They are exposed here
   * because the benchmark also runs a tracer-sensitivity analysis: BKT with
   * `learn = 0.22` is strongly upward-biased (see `RESULTS.md` §6.1), and an
   * over-confident state hurts every policy — most of all the ones that gate on
   * a point estimate.
   */
  tracer: BktParams;
}

export const DEFAULT_PROTOCOL: SimulationProtocol = {
  sessions: 4,
  itemsPerSession: 8,
  daysBetweenSessions: 2,
  retentionDelayDays: 14,
  masteryThreshold: MASTERY_TARGET,
  zpdBand: [0.5, 0.85],
  usefulBand: [0.25, 0.93],
  tracer: { ...DEFAULT_BKT },
};

export interface CellSpec {
  archetype: Archetype;
  world: WorldParams;
  seed: number;
  protocol?: SimulationProtocol;
}

export const cellKey = (cell: CellSpec) => `${cell.archetype.id}|${cell.world.id}|${cell.seed}`;

/* ------------------------------------------------------------------ */
/* Metrics                                                             */
/* ------------------------------------------------------------------ */

export interface CellMetrics {
  itemsServed: number;
  minutesSpent: number;

  /** Learning outcomes (ground truth). */
  masteryGain: number;
  retainedGain: number;
  retainedMastery: number;
  retentionRatio: number;
  masteryGainPerItem: number;
  masteryGainPerMinute: number;

  /** Targeting quality. */
  zpdHitRate: number;
  wastedRate: number;
  avgInformation: number;

  /** Safety + breadth. */
  prereqViolations: number;
  prereqViolationRate: number;
  skillCoverage: number;
  /**
   * Share of *prerequisite-eligible* skills touched at least once.
   *
   * A skill counts as eligible when every prerequisite's **true** ability is at
   * or above the world's `prereqThreshold` at session start — i.e. the learner
   * could actually have learned it. Raw `skillCoverage` treats "declined to
   * teach calculus to someone who cannot add" as a failure; this does not.
   */
  eligibleCoverage: number;
  /** Denominator of `eligibleCoverage`, for auditing. */
  eligibleSkills: number;
  /** Skills never served that the learner *was* ready for — real neglect. */
  missedEligible: number;
  /** Skills never served whose prerequisites were unmet — correct restraint. */
  missedIneligible: number;
  coverageEntropy: number;
  repeats: number;

  /** Learner-state estimation. */
  estimationRmse: number;
  estimationBias: number;
  brier: number;
  ece: number;
  mce: number;

  /** Efficiency of reaching mastery (censored-aware sums). */
  skillsMastered: number;
  masteryEvents: number;
  itemsToMasterySum: number;
  minutesToMasterySum: number;
  censoredSkills: number;
}

export interface StepTrace {
  step: number;
  day: number;
  session: number;
  itemId: number;
  skillId: number;
  difficulty: number;
  bloom: number;
  trueP: number;
  predicted: number;
  isCorrect: boolean;
  trueAbilityBefore: number;
  estMasteryBefore: number;
  headroom: number;
  zpdEfficiency: number;
  prereqSupport: number;
  gain: number;
  prereqViolation: boolean;
  /** Within-session fatigue at the moment this item was served, 0..1. */
  fatigue: number;
}

export interface CellResult {
  key: string;
  policyId: string;
  archetypeId: string;
  worldId: string;
  seed: number;
  metrics: CellMetrics;
  trace: StepTrace[];
  /** End-of-run tracer state vs. ground truth, per skill (tracer diagnostics). */
  finalState: SkillSnapshot[];
  /** Per-step longitudinal series: latent truth vs. platform belief. */
  trajectory: TrajectoryPoint[];
}

/** One point on a learner's longitudinal trajectory. */
export interface TrajectoryPoint {
  step: number;
  day: number;
  session: number;
  /** Mean latent ability across all skills (what the learner actually knows). */
  meanTrueAbility: number;
  /** Mean ability retrievable *right now*, after forgetting. */
  meanRetrievable: number;
  /** Mean tracer belief (what the platform thinks they know). */
  meanEstimated: number;
  fatigue: number;
}

/** Per-skill snapshot taken after the last graded session. */
export interface SkillSnapshot {
  skillId: number;
  attempts: number;
  correct: number;
  /** Raw tracer belief. */
  estimated: number;
  /** Tracer belief after recency decay — what the serving path would show. */
  estimatedDecayed: number;
  trueAbility: number;
}

/* ------------------------------------------------------------------ */
/* Tracer-side (estimated) state                                       */
/* ------------------------------------------------------------------ */

interface EstState {
  skillId: number;
  mastery: number;
  attempts: number;
  correct: number;
  streak: number;
  history: { t: string; m: number }[];
  lastPracticedAt: Date | null;
}

const EPOCH = new Date("2026-01-05T09:00:00Z").getTime();
const dayToDate = (day: number) => new Date(EPOCH + day * 86_400_000);

/**
 * The knowledge model handed to the policies, bound to the protocol's tracer
 * parameters so the policy's simulated posterior steps agree with the tracer
 * that actually updates the state.
 */
function tracerModel(params: BktParams): KnowledgeTracingModel {
  return {
    id: `bkt-bench:learn=${params.learn}`,
    kind: "bkt",
    prior: (p) => bktModel.prior({ ...params, ...(p ?? {}) }),
    observe: (belief, obs, p) => bktModel.observe(belief, obs, { ...params, ...(p ?? {}) }),
    decay: (belief, days, p) => bktModel.decay(belief, days, { ...params, ...(p ?? {}) }),
    predictCorrect: (belief, item, p) => bktModel.predictCorrect(belief, item, { ...params, ...(p ?? {}) }),
  };
}

function initEstimates(): Map<number, EstState> {
  return new Map(
    SKILLS.map((s) => [
      s.id,
      { skillId: s.id, mastery: 0.3, attempts: 0, correct: 0, streak: 0, history: [], lastPracticedAt: null },
    ]),
  );
}

/* ------------------------------------------------------------------ */
/* Simulation                                                          */
/* ------------------------------------------------------------------ */

export function simulateCell(policy: BenchPolicy, cell: CellSpec): CellResult {
  const protocol = cell.protocol ?? DEFAULT_PROTOCOL;
  const { archetype, world, seed } = cell;
  const truth = initialTrueState(archetype, world);
  const startAbility = new Map([...truth.skills].map(([id, s]) => [id, s.ability]));
  const startStability = new Map([...truth.skills].map(([id, s]) => [id, s.stability]));
  const startLastDay = new Map([...truth.skills].map(([id, s]) => [id, s.lastPracticedDay]));

  const est = initEstimates();
  const responses: RawResponse[] = [];
  const seen = new Set<number>();
  const askedSkill = new Map<number, number>();
  const askedBloom = new Map<number, number>();
  const recentSkillIds: number[] = [];
  const candidates: CandidateItem[] = buildCandidatePool(ITEMS);
  const responseModel = new LogisticResponseModel(HEURISTIC_MODEL);
  const knowledgeModel = tracerModel(protocol.tracer);

  /* ---------------- warm-up: prior evidence for the tracer --------------- */
  // Synthetic prior practice (not part of the graded session and not drawn from
  // the item bank) so returning learners start with a realistic — and imperfect —
  // estimate. The cold-start archetype skips this entirely.
  if (archetype.priorEvidence > 0) {
    const priorDay = -archetype.priorDaysAgo;
    const at = dayToDate(priorDay);
    for (const skill of SKILLS) {
      const state = est.get(skill.id)!;
      for (let i = 0; i < archetype.priorEvidence; i += 1) {
        const pseudoItem: ItemDef = {
          id: -(skill.id * 100 + i),
          skillId: skill.id,
          difficulty: skill.difficultyBase,
          bloom: 3,
          discrimination: 1,
          estimatedSeconds: 60,
        };
        const p = trueProbCorrect({ item: pseudoItem, truth, day: priorDay, archetype, world });
        const isCorrect = hashUniform(seed, 7919, skill.id, i) < p;
        state.mastery = posterior(state.mastery, isCorrect, protocol.tracer);
        state.attempts += 1;
        state.correct += isCorrect ? 1 : 0;
        state.streak = isCorrect ? state.streak + 1 : 0;
        state.history.push({ t: at.toISOString(), m: state.mastery });
        state.lastPracticedAt = at;
        responses.push({
          skillId: skill.id,
          isCorrect,
          responseTimeMs: 60_000,
          estimatedSeconds: 60,
          difficulty: skill.difficultyBase,
          bloom: 3,
          createdAt: at,
        });
      }
    }
  }

  /* --------------------------- graded sessions --------------------------- */
  const trace: StepTrace[] = [];
  const trajectory: TrajectoryPoint[] = [];
  const predictions: number[] = [];
  const outcomes: number[] = [];
  let repeats = 0;
  let minutes = 0;
  let step = 0;
  const masteredAt = new Map<number, { items: number; minutes: number }>();
  const totalItems = protocol.sessions * protocol.itemsPerSession;

  for (let session = 0; session < protocol.sessions; session += 1) {
    const day = session * protocol.daysBetweenSessions;
    const now = dayToDate(day);

    const sessionItemCap = protocol.minutesPerSession ? protocol.itemsPerSession * 3 : protocol.itemsPerSession;
    const sessionMinuteBudget = protocol.minutesPerSession ?? Infinity;
    let sessionMinutes = 0;

    for (let inSession = 0; inSession < sessionItemCap; inSession += 1) {
      if (sessionMinutes >= sessionMinuteBudget) break;
      const estimates: EstimatedSkill[] = SKILLS.map((s) => {
        const e = est.get(s.id)!;
        return {
          skillId: s.id,
          mastery: e.mastery,
          attempts: e.attempts,
          correct: e.correct,
          streak: e.streak,
          lastPracticedAt: e.lastPracticedAt,
          daysSincePractice: e.lastPracticedAt
            ? Math.max(0, (now.getTime() - e.lastPracticedAt.getTime()) / 86_400_000)
            : 30,
        };
      });

      const rawSkillStates: RawSkillState[] = SKILLS.map((s) => {
        const e = est.get(s.id)!;
        return {
          skillId: s.id,
          skillName: s.name,
          subjectName: "Mathematics",
          mastery: e.mastery,
          attempts: e.attempts,
          correct: e.correct,
          streak: e.streak,
          history: e.history,
          lastPracticedAt: e.lastPracticedAt,
          prereqIds: s.prereqIds,
          difficultyBase: s.difficultyBase,
          pathAlignment: 0.3,
        };
      });

      const learner = buildLearnerState({
        studentId: 1,
        now,
        skillStates: rawSkillStates,
        responses,
        context: { itemsAnswered: step, itemTarget: totalItems },
      });

      const ctx: PolicyContext = {
        seed,
        step,
        truth: {
          trueProbFor(questionId: number) {
            const item = ITEM_BY_ID.get(questionId);
            if (!item) return 0.5;
            return trueProbCorrect({
              item,
              truth,
              day,
              archetype,
              world,
              minutesThisSession: sessionMinutes,
            });
          },
          abilityBySkill: new Map([...truth.skills].map(([id, sk]) => [id, sk.ability])),
        },
        learner,
        estimates,
        candidates,
        seen,
        askedSkill,
        askedBloom,
        recentSkillIds,
        responseModel,
        knowledgeModel,
        masteryTarget: MASTERY_TARGET,
      };

      const choice = policy.select(ctx);
      if (!choice) break;
      const item = ITEM_BY_ID.get(choice.questionId);
      if (!item) break;
      if (seen.has(item.id)) repeats += 1;

      const itemMinutes = item.estimatedSeconds / 60;
      // Equal-time mode: never overrun the budget. A policy that picks long
      // items simply gets fewer of them, which is the whole point of the control.
      if (sessionMinutes + itemMinutes > sessionMinuteBudget) break;

      const state = truth.skills.get(item.skillId)!;
      const trueAbilityBefore = state.ability;
      const estMasteryBefore = est.get(item.skillId)!.mastery;
      // Fatigue is evaluated on the time spent *before* this item, so the
      // learner is not penalised for an item they have not answered yet.
      const fatigueBefore = fatigueLevel(sessionMinutes, archetype, world);
      const trueP = trueProbCorrect({ item, truth, day, archetype, world, minutesThisSession: sessionMinutes });
      const violation = isPrereqViolation(item.skillId, truth, world);

      // Common random numbers: luck is a property of (learner, item), not of the
      // order in which a policy happens to serve it.
      const isCorrect = hashUniform(seed, item.id, 1013) < trueP;

      predictions.push(clamp(choice.predictedCorrect, 0.001, 0.999));
      outcomes.push(isCorrect ? 1 : 0);
      minutes += itemMinutes;
      sessionMinutes += itemMinutes;

      const { gain, zpdEfficiency, support } = applyPractice({
        item,
        truth,
        day,
        isCorrect,
        trueP,
        archetype,
        world,
        minutesThisSession: sessionMinutes,
      });

      // ---- tracer update (identical for every policy) ----
      const e = est.get(item.skillId)!;
      e.mastery = posterior(e.mastery, isCorrect, protocol.tracer);
      e.attempts += 1;
      e.correct += isCorrect ? 1 : 0;
      e.streak = isCorrect ? e.streak + 1 : 0;
      e.history = [...e.history, { t: now.toISOString(), m: e.mastery }].slice(-40);
      e.lastPracticedAt = now;

      responses.push({
        skillId: item.skillId,
        isCorrect,
        responseTimeMs: responseTimeMs({ item, trueP, fatigue: fatigueBefore, archetype, world }),
        estimatedSeconds: item.estimatedSeconds,
        difficulty: item.difficulty,
        bloom: item.bloom,
        createdAt: now,
      });
      if (responses.length > 120) responses.splice(0, responses.length - 120);

      seen.add(item.id);
      askedSkill.set(item.skillId, (askedSkill.get(item.skillId) ?? 0) + 1);
      askedBloom.set(item.bloom, (askedBloom.get(item.bloom) ?? 0) + 1);
      recentSkillIds.push(item.skillId);
      step += 1;

      if (
        !masteredAt.has(item.skillId) &&
        state.ability >= protocol.masteryThreshold &&
        (startAbility.get(item.skillId) ?? 0) < protocol.masteryThreshold
      ) {
        masteredAt.set(item.skillId, { items: step, minutes });
      }

      trace.push({
        step,
        day,
        session,
        itemId: item.id,
        skillId: item.skillId,
        difficulty: item.difficulty,
        bloom: item.bloom,
        trueP,
        predicted: choice.predictedCorrect,
        isCorrect,
        trueAbilityBefore,
        estMasteryBefore,
        headroom: 1 - trueAbilityBefore,
        zpdEfficiency,
        prereqSupport: support,
        gain,
        prereqViolation: violation,
        fatigue: round(fatigueBefore, 4),
      });

      // Longitudinal snapshot: latent truth vs. what the platform believes,
      // after this item. This is the series a learning-curve plot needs.
      trajectory.push({
        step,
        day,
        session,
        meanTrueAbility: round(mean(SKILLS.map((sk) => truth.skills.get(sk.id)?.ability ?? 0)), 4),
        meanRetrievable: round(
          mean(SKILLS.map((sk) => effectiveAbility(truth.skills.get(sk.id)!, day, archetype, world))),
          4,
        ),
        meanEstimated: round(mean(SKILLS.map((sk) => est.get(sk.id)?.mastery ?? 0)), 4),
        fatigue: round(fatigueBefore, 4),
      });
    }
  }

  /* --------------------------- retention probe --------------------------- */
  const lastDay = (protocol.sessions - 1) * protocol.daysBetweenSessions;
  const probeDay = lastDay + protocol.retentionDelayDays;

  let masteryGain = 0;
  let retainedAfter = 0;
  let retainedCounterfactual = 0;
  for (const skill of SKILLS) {
    const state = truth.skills.get(skill.id)!;
    const start = startAbility.get(skill.id) ?? 0;
    masteryGain += state.ability - start;
    retainedAfter += effectiveAbility(state, probeDay, archetype, world);
    // Counterfactual: the same learner if this session had never happened.
    const untouched = {
      skillId: skill.id,
      ability: start,
      stability: startStability.get(skill.id) ?? 1,
      lastPracticedDay: startLastDay.get(skill.id) ?? 0,
    };
    retainedCounterfactual += effectiveAbility(untouched, probeDay, archetype, world);
  }

  /* ------------------------------- metrics ------------------------------- */
  const n = trace.length || 1;
  const zpdHits = trace.filter((t) => t.trueP >= protocol.zpdBand[0] && t.trueP <= protocol.zpdBand[1]).length;
  const wasted = trace.filter((t) => t.trueP < protocol.usefulBand[0] || t.trueP > protocol.usefulBand[1]).length;
  const violations = trace.filter((t) => t.prereqViolation).length;
  const perSkillCounts = new Map<number, number>();
  for (const t of trace) perSkillCounts.set(t.skillId, (perSkillCounts.get(t.skillId) ?? 0) + 1);
  // Eligibility is judged against the *starting* truth, so a policy is not
  // rewarded for unlocking a skill and then declining to teach it.
  const eligibleSkillIds = SKILLS.filter((s) =>
    s.prereqIds.every((pid) => (startAbility.get(pid) ?? 0) >= world.prereqThreshold),
  ).map((s) => s.id);

  const shares = [...perSkillCounts.values()].map((c) => c / n);
  const entropy = shares.length
    ? -shares.reduce((acc, p) => acc + (p > 0 ? p * Math.log(p) : 0), 0) / Math.log(SKILLS.length)
    : 0;

  // The tracer's *decayed* belief on the last session day is what the platform
  // would show, so that is what we grade against the latent truth.
  const finalState: SkillSnapshot[] = SKILLS.map((s) => {
    const e = est.get(s.id)!;
    const daysSince = e.lastPracticedAt
      ? Math.max(0, (dayToDate(lastDay).getTime() - e.lastPracticedAt.getTime()) / 86_400_000)
      : 0;
    const decayed = clamp(e.mastery * Math.exp(-protocol.tracer.forget * daysSince), 0.01, 0.995);
    return {
      skillId: s.id,
      attempts: e.attempts,
      correct: e.correct,
      estimated: round(e.mastery, 4),
      estimatedDecayed: round(decayed, 4),
      trueAbility: round(truth.skills.get(s.id)?.ability ?? 0, 4),
    };
  });
  const errors = finalState.map((f) => f.estimatedDecayed - f.trueAbility);

  const cal = calibration(outcomes, predictions, 10);
  const skillsMastered = SKILLS.filter(
    (s) =>
      (truth.skills.get(s.id)?.ability ?? 0) >= protocol.masteryThreshold &&
      (startAbility.get(s.id) ?? 0) < protocol.masteryThreshold,
  ).length;
  const eligible = SKILLS.filter((s) => (startAbility.get(s.id) ?? 0) < protocol.masteryThreshold).length;

  const metrics: CellMetrics = {
    itemsServed: trace.length,
    minutesSpent: round(minutes, 2),
    masteryGain: round(masteryGain, 4),
    retainedGain: round(retainedAfter - retainedCounterfactual, 4),
    retainedMastery: round(retainedAfter, 4),
    retentionRatio: masteryGain > 1e-6 ? round((retainedAfter - retainedCounterfactual) / masteryGain, 4) : 0,
    masteryGainPerItem: round(masteryGain / n, 5),
    masteryGainPerMinute: round(masteryGain / Math.max(1e-6, minutes), 5),
    zpdHitRate: round(zpdHits / n, 4),
    wastedRate: round(wasted / n, 4),
    avgInformation: round(mean(trace.map((t) => t.trueP * (1 - t.trueP))), 4),
    prereqViolations: violations,
    prereqViolationRate: round(violations / n, 4),
    skillCoverage: perSkillCounts.size,
    eligibleCoverage: eligibleSkillIds.length
      ? round(eligibleSkillIds.filter((id) => perSkillCounts.has(id)).length / eligibleSkillIds.length, 4)
      : 1,
    eligibleSkills: eligibleSkillIds.length,
    missedEligible: eligibleSkillIds.filter((id) => !perSkillCounts.has(id)).length,
    missedIneligible: SKILLS.filter((s) => !perSkillCounts.has(s.id) && !eligibleSkillIds.includes(s.id)).length,
    coverageEntropy: round(entropy, 4),
    repeats,
    estimationRmse: round(Math.sqrt(mean(errors.map((e) => e * e))), 4),
    estimationBias: round(mean(errors), 4),
    brier: round(brierScore(outcomes, predictions), 4),
    ece: round(cal.ece, 4),
    mce: round(cal.mce, 4),
    skillsMastered,
    masteryEvents: masteredAt.size,
    itemsToMasterySum: [...masteredAt.values()].reduce((a, m) => a + m.items, 0),
    minutesToMasterySum: round([...masteredAt.values()].reduce((a, m) => a + m.minutes, 0), 2),
    censoredSkills: Math.max(0, eligible - masteredAt.size),
  };

  return {
    key: cellKey(cell),
    policyId: policy.id,
    archetypeId: archetype.id,
    worldId: world.id,
    seed,
    metrics,
    trace,
    trajectory,
    finalState,
  };
}

/* ------------------------------------------------------------------ */
/* Aggregation                                                         */
/* ------------------------------------------------------------------ */

/** Metrics that aggregate as a mean across cells. */
const MEAN_KEYS = [
  "itemsServed",
  "minutesSpent",
  "masteryGain",
  "retainedGain",
  "retainedMastery",
  "retentionRatio",
  "masteryGainPerItem",
  "masteryGainPerMinute",
  "zpdHitRate",
  "wastedRate",
  "avgInformation",
  "prereqViolationRate",
  "skillCoverage",
  "eligibleCoverage",
  "eligibleSkills",
  "coverageEntropy",
  "estimationRmse",
  "estimationBias",
  "brier",
  "ece",
  "mce",
  "skillsMastered",
] as const;

/** Metrics that aggregate as a sum across cells. */
const SUM_KEYS = [
  "missedEligible",
  "missedIneligible",
  "prereqViolations",
  "repeats",
  "masteryEvents",
  "itemsToMasterySum",
  "minutesToMasterySum",
  "censoredSkills",
] as const;

export interface AggregateMetrics extends CellMetrics {
  cells: number;
  /** Mean items served before a skill first crossed the mastery threshold. */
  itemsToMastery: number | null;
  /** Mean simulated minutes before that crossing. */
  minutesToMastery: number | null;
}

export function aggregateCells(results: CellResult[]): AggregateMetrics {
  const metrics = results.map((r) => r.metrics);
  const out = {} as AggregateMetrics;
  for (const key of MEAN_KEYS) {
    (out as unknown as Record<string, number>)[key] = round(mean(metrics.map((m) => m[key])), 5);
  }
  for (const key of SUM_KEYS) {
    (out as unknown as Record<string, number>)[key] = round(
      metrics.reduce((a, m) => a + (m[key] as number), 0),
      4,
    );
  }
  out.cells = results.length;
  out.itemsToMastery = out.masteryEvents > 0 ? round(out.itemsToMasterySum / out.masteryEvents, 3) : null;
  out.minutesToMastery = out.masteryEvents > 0 ? round(out.minutesToMasterySum / out.masteryEvents, 3) : null;
  return out;
}

/** Retrievability of the truth at the probe day — exposed for tests. */
export { retrievability };
