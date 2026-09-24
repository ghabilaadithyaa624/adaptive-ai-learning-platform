/**
 * Synthetic world for the adaptive-policy benchmark.
 *
 * The world is the *ground truth* the policies are graded against. It is
 * deliberately specified independently of any policy, and its functional forms
 * differ from the ones the v3 policy reasons with (the policy sees noisy
 * estimates, the world knows the latent state), so a policy cannot win simply by
 * sharing the simulator's algebra.
 *
 * Model
 * -----
 * 1. **Response** — 4PL-flavoured IRT:
 *      p = guess + (1 − guess − slip) · σ( a·slope·(θ_eff − b_eff) )
 *    with θ_eff the *retrievable* ability (memory below) discounted by missing
 *    prerequisite support, and b_eff the item difficulty adjusted for Bloom load.
 *
 * 2. **Learning** — ZPD-modulated power-law acquisition:
 *      Δability = rate · zpd(p) · prereq(minPrereq) · outcome · (1 − ability)^1.15
 *    Practice outside the productive band, or without prerequisite support,
 *    returns a fraction of the gain; errors still teach (feedback) but less.
 *
 * 3. **Memory** — stability/retrievability (DSR-style):
 *      R(t) = exp(−elapsedDays / stability)
 *      θ_eff = ability · (floor + (1 − floor)·R)
 *    Successful retrieval *after partial forgetting* increases stability the
 *    most — the spacing effect — so review timing matters, not just review count.
 *
 * 4. **Common random numbers** — every (learner, item) pair has a fixed uniform
 *    draw derived by hashing, so two policies that serve the same item to the
 *    same learner get the same luck. This is textbook variance reduction for
 *    paired simulation comparisons.
 *
 * Everything is deterministic: no `Math.random`, no wall clock.
 */
import { clamp } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/* Skill graph + item bank                                             */
/* ------------------------------------------------------------------ */

export interface SkillDef {
  id: number;
  name: string;
  difficultyBase: number;
  prereqIds: number[];
}

export interface ItemDef {
  id: number;
  skillId: number;
  difficulty: number;
  bloom: number;
  discrimination: number;
  estimatedSeconds: number;
}

/** 8 skills, depth-4 prerequisite DAG (two branches + a join). */
export const SKILLS: SkillDef[] = [
  { id: 1, name: "Number Sense", difficultyBase: 0.22, prereqIds: [] },
  { id: 2, name: "Fractions", difficultyBase: 0.38, prereqIds: [1] },
  { id: 3, name: "Geometry", difficultyBase: 0.45, prereqIds: [1] },
  { id: 4, name: "Ratios & Proportion", difficultyBase: 0.5, prereqIds: [2] },
  { id: 5, name: "Algebra", difficultyBase: 0.56, prereqIds: [2] },
  { id: 6, name: "Functions", difficultyBase: 0.68, prereqIds: [5] },
  { id: 7, name: "Statistics", difficultyBase: 0.62, prereqIds: [3, 4] },
  { id: 8, name: "Probability", difficultyBase: 0.66, prereqIds: [4] },
];

export const SKILL_BY_ID = new Map(SKILLS.map((s) => [s.id, s]));

/** 10 items per skill spanning difficulty, Bloom level, discrimination and time. */
export const ITEMS: ItemDef[] = (() => {
  const out: ItemDef[] = [];
  let id = 1;
  for (const skill of SKILLS) {
    for (let i = 0; i < 10; i += 1) {
      out.push({
        id,
        skillId: skill.id,
        difficulty: clamp(0.1 + (i / 9) * 0.85, 0.05, 0.95),
        bloom: 1 + (i % 6),
        // 0.8 … 1.4 — an item bank with real discrimination spread
        discrimination: 0.8 + ((i * 3) % 7) * 0.1,
        estimatedSeconds: 40 + (i % 5) * 25 + (skill.id % 3) * 10,
      });
      id += 1;
    }
  }
  return out;
})();

export const ITEM_BY_ID = new Map(ITEMS.map((q) => [q.id, q]));

/* ------------------------------------------------------------------ */
/* World parameters (and the perturbations used for robustness)        */
/* ------------------------------------------------------------------ */

export interface WorldParams {
  id: string;
  label: string;
  /** True success probability at which learning is fastest. */
  zpdPeak: number;
  /** Width of the productive band. */
  zpdSigma: number;
  /** Base acquisition rate per item. */
  learnRate: number;
  /** Learning from an incorrect answer, as a share of a correct one. */
  errorLearningShare: number;
  /** Gain multiplier when prerequisites are completely missing. */
  prereqFloor: number;
  /** True prerequisite ability required for full downstream credit. */
  prereqThreshold: number;
  /** How much missing prerequisites depress *performance* (not just gain). */
  prereqPerformanceCoupling: number;
  /** Logistic slope applied to (ability − difficulty). */
  slope: number;
  /** Initial memory stability in days. */
  baseStabilityDays: number;
  /** Multiplier on stability growth from a well-spaced successful retrieval. */
  stabilitySpacingGain: number;
  /** Additive stability gain per practice (days). */
  stabilityBaseIncrement: number;
  /** Cap on stability (days). */
  maxStabilityDays: number;
  /** Share of ability that survives complete forgetting. */
  retentionFloor: number;

  /* ---- Fatigue ---- */
  /** Minutes of continuous session work at which fatigue reaches ~63% of max. */
  fatigueOnsetMinutes: number;
  /** Max multiplicative loss of effective ability at full fatigue. */
  fatiguePerformancePenalty: number;
  /** Max multiplicative loss of acquisition rate at full fatigue. */
  fatigueLearningPenalty: number;

  /* ---- Confidence ---- */
  /** How strongly over/under-confidence distorts the slip rate. */
  confidenceSlipCoupling: number;
  /** How strongly over/under-confidence distorts the guess rate. */
  confidenceGuessCoupling: number;
  /** How strongly confidence speeds up (over) or slows down (under) responses. */
  confidenceTimeCoupling: number;
}

export const BASE_WORLD: WorldParams = {
  id: "base",
  label: "Base world",
  zpdPeak: 0.72,
  zpdSigma: 0.2,
  learnRate: 0.14,
  errorLearningShare: 0.7,
  prereqFloor: 0.25,
  prereqThreshold: 0.55,
  prereqPerformanceCoupling: 0.25,
  slope: 4.5,
  baseStabilityDays: 6,
  stabilitySpacingGain: 1.1,
  stabilityBaseIncrement: 1.5,
  maxStabilityDays: 120,
  retentionFloor: 0.45,
  fatigueOnsetMinutes: 18,
  fatiguePerformancePenalty: 0.18,
  fatigueLearningPenalty: 0.35,
  confidenceSlipCoupling: 0.18,
  confidenceGuessCoupling: 0.22,
  confidenceTimeCoupling: 0.35,
};

/**
 * Perturbed worlds for the robustness sweep. Each one breaks an assumption the
 * v3 policy makes by default (its success target is 0.75, its ZPD kernel has
 * σ=0.18, its forgetting rate is 0.035/day, its prerequisite gate is 0.60), so a
 * policy that only wins in the base world is exposed.
 */
export const WORLD_VARIANTS: WorldParams[] = [
  BASE_WORLD,
  {
    ...BASE_WORLD,
    id: "easy-optimum",
    label: "Learning peaks at 85% success (Wilson-style optimum)",
    zpdPeak: 0.85,
    zpdSigma: 0.16,
  },
  {
    ...BASE_WORLD,
    id: "hard-optimum",
    label: "Learning peaks at 55% success (struggle-tolerant learners)",
    zpdPeak: 0.55,
    zpdSigma: 0.24,
  },
  {
    ...BASE_WORLD,
    id: "fast-forgetting",
    label: "Fast forgetting, low retention floor",
    baseStabilityDays: 3,
    stabilitySpacingGain: 0.7,
    stabilityBaseIncrement: 0.8,
    retentionFloor: 0.25,
  },
  {
    ...BASE_WORLD,
    id: "strict-prereqs",
    label: "Prerequisites strongly gate both learning and performance",
    prereqFloor: 0.1,
    prereqThreshold: 0.65,
    prereqPerformanceCoupling: 0.45,
  },
  {
    ...BASE_WORLD,
    id: "slow-noisy",
    label: "Slow acquisition, shallow learning curve",
    learnRate: 0.09,
    errorLearningShare: 0.45,
    slope: 3.4,
  },
];

/* ------------------------------------------------------------------ */
/* Learner archetypes                                                  */
/* ------------------------------------------------------------------ */

export interface Archetype {
  id: string;
  name: string;
  description: string;
  seedBase: number;
  /** Latent ability per skill id, 0..1. */
  ability: Record<number, number>;
  /** Multiplier on the world's acquisition rate. */
  learnRateScale: number;
  /** Multiplier on forgetting speed (>1 = forgets faster). */
  forgetScale: number;
  /** Multiplier on the world's retention floor. */
  retentionFloorScale: number;
  /** Response noise: P(wrong | knows) and P(right | doesn't know). */
  slip: number;
  guess: number;
  /**
   * Calibration of self-belief against actual competence, −1..+1.
   *
   *   > 0  over-confident — commits fast without checking (more careless slips)
   *        and attempts items far beyond reach (more guessing). Answers quickly.
   *   < 0  under-confident — knows it but hesitates to commit (slips on items
   *        it could do) and declines to guess. Answers slowly.
   *
   * This is a *behavioural* trait, not a competence one: it moves observable
   * responses without moving latent ability, which is exactly what makes the
   * pair (over-confident/low-mastery, under-confident/high-mastery) a hard
   * estimation problem for the platform.
   */
  confidenceBias: number;
  /**
   * Resistance to within-session fatigue (1 = world default, >1 = stamina,
   * <1 = tires quickly).
   */
  fatigueResistance: number;
  /** Prior practice per skill before the benchmark session (0 = cold start). */
  priorEvidence: number;
  /** Days since that prior practice. */
  priorDaysAgo: number;
}

const ability = (values: number[]): Record<number, number> =>
  Object.fromEntries(SKILLS.map((s, i) => [s.id, values[i]]));

/**
 * Learner archetypes.
 *
 * Eight are the population the brief calls for; `intermediate` and
 * `high-variance` are kept as a mid-scale baseline and a pure response-noise
 * stress case. Abilities are latent competence per skill id, in skill order.
 *
 * Every trait is independent of every policy: nothing here is tuned to make a
 * particular selector look good.
 */
export const ARCHETYPES: Archetype[] = [
  {
    id: "cold-start-novice",
    name: "Cold-start novice",
    description: "Brand new account: low ability everywhere and zero prior evidence for the tracer.",
    seedBase: 101,
    ability: ability([0.34, 0.2, 0.22, 0.14, 0.15, 0.1, 0.12, 0.12]),
    learnRateScale: 1,
    forgetScale: 1,
    retentionFloorScale: 1,
    slip: 0.1,
    guess: 0.2,
    confidenceBias: 0,
    fatigueResistance: 1,
    priorEvidence: 0,
    priorDaysAgo: 0,
  },
  {
    id: "fast-learner",
    name: "Fast learner",
    description: "Acquires at nearly twice the base rate and consolidates well — ceiling effects appear early.",
    seedBase: 202,
    ability: ability([0.55, 0.42, 0.4, 0.32, 0.3, 0.22, 0.26, 0.24]),
    learnRateScale: 1.9,
    forgetScale: 0.8,
    retentionFloorScale: 1.1,
    slip: 0.09,
    guess: 0.2,
    confidenceBias: 0.1,
    fatigueResistance: 1.2,
    priorEvidence: 5,
    priorDaysAgo: 3,
  },
  {
    id: "slow-learner",
    name: "Slow learner",
    description: "Half the acquisition rate and tires quickly; every wasted item costs double.",
    seedBase: 303,
    ability: ability([0.6, 0.42, 0.4, 0.3, 0.3, 0.2, 0.25, 0.24]),
    learnRateScale: 0.5,
    forgetScale: 1.2,
    retentionFloorScale: 0.9,
    slip: 0.12,
    guess: 0.2,
    confidenceBias: -0.1,
    fatigueResistance: 0.7,
    priorEvidence: 6,
    priorDaysAgo: 4,
  },
  {
    id: "advanced",
    name: "Advanced learner",
    description: "Near mastery everywhere; needs stretch and consolidation, not remediation.",
    seedBase: 404,
    ability: ability([0.92, 0.88, 0.84, 0.8, 0.79, 0.72, 0.74, 0.7]),
    learnRateScale: 1,
    forgetScale: 1,
    retentionFloorScale: 1,
    slip: 0.08,
    guess: 0.18,
    confidenceBias: 0.05,
    fatigueResistance: 1.1,
    priorEvidence: 8,
    priorDaysAgo: 4,
  },
  {
    id: "uneven",
    name: "Uneven learner",
    description: "Strong in places, hollow foundations elsewhere — a prerequisite trap in every branch.",
    seedBase: 505,
    ability: ability([0.88, 0.36, 0.82, 0.3, 0.74, 0.58, 0.28, 0.33]),
    learnRateScale: 1,
    forgetScale: 1,
    retentionFloorScale: 1,
    slip: 0.1,
    guess: 0.2,
    confidenceBias: 0,
    fatigueResistance: 1,
    priorEvidence: 6,
    priorDaysAgo: 5,
  },
  {
    id: "forgetful",
    name: "Forgetful learner",
    description: "Learns normally but decays 3x fast with a low retention floor — spacing is the binding constraint.",
    seedBase: 606,
    ability: ability([0.7, 0.58, 0.52, 0.45, 0.43, 0.3, 0.36, 0.34]),
    learnRateScale: 1,
    forgetScale: 3,
    retentionFloorScale: 0.45,
    slip: 0.12,
    guess: 0.2,
    confidenceBias: 0,
    fatigueResistance: 1,
    priorEvidence: 6,
    priorDaysAgo: 6,
  },
  {
    id: "overconfident",
    name: "High-confidence / low-mastery",
    description:
      "Believes they know it. Commits fast without checking and attempts items far beyond reach, so the " +
      "response stream looks stronger than the latent ability behind it — the classic premature-unlock trap.",
    seedBase: 707,
    ability: ability([0.42, 0.3, 0.28, 0.22, 0.2, 0.15, 0.18, 0.16]),
    learnRateScale: 0.9,
    forgetScale: 1.1,
    retentionFloorScale: 1,
    slip: 0.12,
    guess: 0.2,
    confidenceBias: 0.75,
    fatigueResistance: 1,
    priorEvidence: 6,
    priorDaysAgo: 4,
  },
  {
    id: "underconfident",
    name: "Low-confidence / high-mastery",
    description:
      "Knows more than they show. Hesitates, second-guesses and declines to attempt, so the response stream " +
      "understates real competence and the platform risks under-challenging them.",
    seedBase: 808,
    ability: ability([0.85, 0.8, 0.76, 0.7, 0.68, 0.6, 0.64, 0.62]),
    learnRateScale: 1,
    forgetScale: 0.9,
    retentionFloorScale: 1,
    slip: 0.1,
    guess: 0.18,
    confidenceBias: -0.75,
    fatigueResistance: 0.9,
    priorEvidence: 7,
    priorDaysAgo: 4,
  },
  {
    id: "intermediate",
    name: "Intermediate",
    description: "Solid foundations, developing mid-graph skills — the mid-scale baseline.",
    seedBase: 909,
    ability: ability([0.78, 0.62, 0.55, 0.46, 0.45, 0.32, 0.38, 0.35]),
    learnRateScale: 1,
    forgetScale: 1,
    retentionFloorScale: 1,
    slip: 0.1,
    guess: 0.2,
    confidenceBias: 0,
    fatigueResistance: 1,
    priorEvidence: 6,
    priorDaysAgo: 3,
  },
  {
    id: "high-variance",
    name: "High-variance",
    description: "Very noisy responses (high slip and guess) with no confidence bias — pure estimation stress.",
    seedBase: 1010,
    ability: ability([0.72, 0.55, 0.5, 0.48, 0.44, 0.34, 0.4, 0.38]),
    learnRateScale: 1,
    forgetScale: 1,
    retentionFloorScale: 1,
    slip: 0.28,
    guess: 0.32,
    confidenceBias: 0,
    fatigueResistance: 0.9,
    priorEvidence: 5,
    priorDaysAgo: 4,
  },
];

export const ARCHETYPE_BY_ID = new Map(ARCHETYPES.map((a) => [a.id, a]));

/* ------------------------------------------------------------------ */
/* Ground-truth learner state + dynamics                               */
/* ------------------------------------------------------------------ */

export interface TrueSkillState {
  skillId: number;
  /** Latent competence 0..1. */
  ability: number;
  /** Memory stability in days. */
  stability: number;
  /** Simulation day of the last practice (null = the warm-up). */
  lastPracticedDay: number;
}

export interface TrueLearnerState {
  skills: Map<number, TrueSkillState>;
}

export function initialTrueState(archetype: Archetype, world: WorldParams): TrueLearnerState {
  const skills = new Map<number, TrueSkillState>();
  for (const skill of SKILLS) {
    skills.set(skill.id, {
      skillId: skill.id,
      ability: clamp(archetype.ability[skill.id] ?? 0.3, 0.01, 0.99),
      stability: (world.baseStabilityDays / archetype.forgetScale) * (0.6 + 0.8 * (archetype.ability[skill.id] ?? 0.3)),
      lastPracticedDay: -archetype.priorDaysAgo,
    });
  }
  return { skills };
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

/** Retrievability of a skill at a given simulation day. */
export function retrievability(state: TrueSkillState, day: number): number {
  const elapsed = Math.max(0, day - state.lastPracticedDay);
  return Math.exp(-elapsed / Math.max(0.25, state.stability));
}

/** Ability actually available to the learner right now (after forgetting). */
export function effectiveAbility(
  state: TrueSkillState,
  day: number,
  archetype: Archetype,
  world: WorldParams,
): number {
  const floor = clamp(world.retentionFloor * archetype.retentionFloorScale, 0, 1);
  return state.ability * (floor + (1 - floor) * retrievability(state, day));
}

/** True prerequisite support, 0..1 (1 = every prerequisite at/above threshold). */
export function prereqSupport(skillId: number, truth: TrueLearnerState, world: WorldParams): number {
  const skill = SKILL_BY_ID.get(skillId);
  if (!skill || !skill.prereqIds.length) return 1;
  let worst = 1;
  for (const id of skill.prereqIds) {
    const prereq = truth.skills.get(id);
    const ratio = clamp((prereq?.ability ?? 0) / world.prereqThreshold, 0, 1);
    if (ratio < worst) worst = ratio;
  }
  return worst;
}

/** Did this item violate prerequisite sequencing (true state, not estimated)? */
export function isPrereqViolation(skillId: number, truth: TrueLearnerState, world: WorldParams): boolean {
  const skill = SKILL_BY_ID.get(skillId);
  if (!skill || !skill.prereqIds.length) return false;
  return skill.prereqIds.some((id) => (truth.skills.get(id)?.ability ?? 0) < world.prereqThreshold);
}

/* ------------------------------------------------------------------ */
/* Fatigue                                                             */
/* ------------------------------------------------------------------ */

/**
 * Within-session fatigue, 0..1, as a saturating function of minutes already
 * spent in *this* session. Resets between sessions — this models tiring within
 * a sitting, not chronic burnout.
 *
 *   fatigue = 1 − exp(−minutes / (onset · resistance))
 *
 * Fatigue is a property of the learner's session, not of the item, so a policy
 * cannot dodge it by picking different content — only by using less of the
 * learner's time or ending the session.
 */
export function fatigueLevel(minutesThisSession: number, archetype: Archetype, world: WorldParams): number {
  const onset = Math.max(1, world.fatigueOnsetMinutes * Math.max(0.1, archetype.fatigueResistance));
  return clamp(1 - Math.exp(-Math.max(0, minutesThisSession) / onset), 0, 1);
}

/* ------------------------------------------------------------------ */
/* Confidence                                                          */
/* ------------------------------------------------------------------ */

/**
 * Observable slip/guess rates after the learner's confidence bias is applied.
 *
 * Both over- and under-confidence *raise* the slip rate, but for opposite
 * reasons and with opposite effects on guessing:
 *
 *   over-confident  → careless commitment   (slip ↑, guess ↑)
 *   under-confident → failure to commit     (slip ↑, guess ↓)
 *
 * The asymmetry in `guess` is what lets the two archetypes be told apart from
 * the response stream at all — without it they would be observationally
 * identical to a plain high-slip learner.
 */
export function effectiveNoise(archetype: Archetype, world: WorldParams): { slip: number; guess: number } {
  const bias = clamp(archetype.confidenceBias, -1, 1);
  const slip = clamp(archetype.slip + Math.abs(bias) * world.confidenceSlipCoupling, 0.01, 0.6);
  const guess = clamp(archetype.guess + bias * world.confidenceGuessCoupling, 0.02, 0.6);
  return { slip, guess };
}

/**
 * Expected response time in milliseconds. Over-confident learners answer fast,
 * under-confident learners deliberate, everyone slows down as they tire, and
 * items the learner is likely to get right are answered faster than ones they
 * are struggling with.
 *
 * This matters because the platform's `buildLearnerState` reads response-time
 * ratios as a signal, so confidence has to be visible in the timing channel and
 * not only in the correctness channel.
 */
export function responseTimeMs(params: {
  item: ItemDef;
  trueP: number;
  fatigue: number;
  archetype: Archetype;
  world: WorldParams;
}): number {
  const { item, trueP, fatigue, archetype, world } = params;
  const base = item.estimatedSeconds * 1000;
  const struggle = 1.3 - 0.5 * clamp(trueP, 0, 1);
  const confidence = 1 - clamp(archetype.confidenceBias, -1, 1) * world.confidenceTimeCoupling;
  const tiring = 1 + 0.4 * fatigue;
  return Math.round(base * struggle * confidence * tiring);
}

/* ------------------------------------------------------------------ */
/* Response                                                            */
/* ------------------------------------------------------------------ */

/** Ground-truth P(correct) for an item at a point in time. */
export function trueProbCorrect(params: {
  item: ItemDef;
  truth: TrueLearnerState;
  day: number;
  archetype: Archetype;
  world: WorldParams;
  /** Minutes already spent in the current session (0 = fresh). */
  minutesThisSession?: number;
}): number {
  const { item, truth, day, archetype, world } = params;
  const state = truth.skills.get(item.skillId);
  if (!state) return 0.5;
  const support = prereqSupport(item.skillId, truth, world);
  const fatigue = fatigueLevel(params.minutesThisSession ?? 0, archetype, world);
  const theta =
    effectiveAbility(state, day, archetype, world) *
    (1 - world.prereqPerformanceCoupling * (1 - support)) *
    (1 - world.fatiguePerformancePenalty * fatigue);
  const bEff = clamp(item.difficulty + 0.03 * (item.bloom - 3), 0, 1.1);
  const core = sigmoid(item.discrimination * world.slope * (theta - bEff));
  const { slip, guess } = effectiveNoise(archetype, world);
  return clamp(guess + (1 - guess - slip) * core, 0.02, 0.98);
}

/**
 * Apply one practice event to the ground truth: acquisition (ZPD- and
 * prerequisite-modulated) plus a memory-stability update (spacing effect).
 */
export function applyPractice(params: {
  item: ItemDef;
  truth: TrueLearnerState;
  day: number;
  isCorrect: boolean;
  trueP: number;
  archetype: Archetype;
  world: WorldParams;
  /** Minutes already spent in the current session (0 = fresh). */
  minutesThisSession?: number;
}): { gain: number; zpdEfficiency: number; support: number; fatigue: number } {
  const { item, truth, day, isCorrect, trueP, archetype, world } = params;
  const state = truth.skills.get(item.skillId);
  if (!state) return { gain: 0, zpdEfficiency: 0, support: 1, fatigue: 0 };
  const fatigue = fatigueLevel(params.minutesThisSession ?? 0, archetype, world);

  const z = (trueP - world.zpdPeak) / world.zpdSigma;
  const zpdEfficiency = Math.exp(-0.5 * z * z);
  const support = prereqSupport(item.skillId, truth, world);
  const prereqEff = world.prereqFloor + (1 - world.prereqFloor) * support;
  const outcome = isCorrect ? 1 : world.errorLearningShare;
  const gain =
    world.learnRate *
    archetype.learnRateScale *
    zpdEfficiency *
    prereqEff *
    outcome *
    // A tired learner encodes less from the same practice than a fresh one.
    (1 - world.fatigueLearningPenalty * fatigue) *
    Math.pow(1 - state.ability, 1.15);

  // Spacing effect: successful retrieval after partial forgetting consolidates
  // the most; massed re-practice of a fresh memory adds little stability.
  const r = retrievability(state, day);
  const spacingBoost = 1 + world.stabilitySpacingGain * (1 - r) * (isCorrect ? 1 : 0.3);
  state.stability = Math.min(
    world.maxStabilityDays,
    state.stability * spacingBoost + world.stabilityBaseIncrement * (isCorrect ? 1 : 0.5),
  );
  state.ability = clamp(state.ability + gain, 0, 0.995);
  state.lastPracticedDay = day;

  return { gain, zpdEfficiency, support, fatigue };
}

/* ------------------------------------------------------------------ */
/* Common random numbers                                               */
/* ------------------------------------------------------------------ */

/**
 * Deterministic uniform draw in [0,1) from integer coordinates. Used so that the
 * same (learner, item) pair gets the same luck under every policy — paired
 * comparisons then measure the policy, not the dice.
 */
export function hashUniform(...coords: number[]): number {
  let h = 2166136261 >>> 0;
  for (const coord of coords) {
    let x = Math.imul(coord | 0, 0x9e3779b1) >>> 0;
    x ^= x >>> 15;
    h = Math.imul(h ^ x, 16777619) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909) >>> 0;
  h ^= h >>> 16;
  // `^=` yields a *signed* int32; coerce back to unsigned before scaling or the
  // result lands in (-0.5, 0.5) instead of [0, 1).
  return (h >>> 0) / 4294967296;
}
