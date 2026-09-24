/**
 * Policy weights & parameters — where every number comes from.
 *
 * The brief was explicit: **no arbitrary weights**. So each weight is produced by
 * a two-stage, reproducible procedure:
 *
 *   Stage 1 — *theory-anchored prior* (`PRIOR_WEIGHTS`). Each objective gets a
 *   prior weight justified by the learning-science / psychometric literature and
 *   recorded in `OBJECTIVE_METADATA[key].rationale`. Priors sum to 1 over the
 *   benefit objectives, so the composite score is a convex combination and the
 *   score itself is interpretable on a 0..1 utility scale.
 *
 *   Stage 2 — *evidence-based refinement* (`TUNED_WEIGHTS`). A deterministic
 *   coordinate-ascent search (`benchmarks/tune.ts`) moves each weight over a
 *   fixed multiplier grid to maximise a **pre-registered** objective on the
 *   TRAIN split of the simulation benchmark only (never the held-out split).
 *   The search, its objective, its split and its result hash are recorded in
 *   `TUNING_PROVENANCE` and reproducible with `npm run bench:tune`.
 *
 * Anything a deployment wants to change is configuration: per-call overrides,
 * environment variables, or one of the documented presets. Weights are
 * renormalised (benefits sum to 1) before use, so relative emphasis — not
 * absolute magnitude — is what a tenant actually controls.
 */
import { clamp } from "@/lib/utils";
import { DEFAULT_BKT } from "@/lib/ml/knowledge-tracing";
import { MASTERY_TARGET } from "@/lib/utils";
import {
  ALL_OBJECTIVES,
  BENEFIT_OBJECTIVES,
  PENALTY_OBJECTIVES,
  type ObjectiveKey,
  type PolicyConfigOverrides,
  type PolicyParams,
  type PolicyWeights,
  type ResolvedPolicyConfig,
} from "./types";

/* ------------------------------------------------------------------ */
/* Objective documentation                                             */
/* ------------------------------------------------------------------ */

export interface ObjectiveMeta {
  label: string;
  /** What the objective measures and why it is in the policy. */
  rationale: string;
  /** Where the prior weight comes from. */
  evidence: string;
  direction: "benefit" | "penalty";
}

export const OBJECTIVE_METADATA: Record<ObjectiveKey, ObjectiveMeta> = {
  expectedMasteryGain: {
    label: "Expected mastery gain",
    rationale:
      "Headroom to the mastery target × productive-difficulty efficiency × prerequisite support. " +
      "This is the terminal objective — the thing the platform exists to maximise — so it carries the largest prior.",
    evidence:
      "Mastery learning (Bloom 1968; Guskey 2007): learning rate is proportional to remaining headroom and " +
      "collapses when instruction lands outside the learner's reachable band.",
    direction: "benefit",
  },
  informationGain: {
    label: "Information gain",
    rationale:
      "Fisher information 4·p·(1−p), scaled by item discrimination. Keeps the learner-state estimate sharp, " +
      "which every other objective depends on — a wrong state makes every other objective optimise the wrong thing.",
    evidence:
      "Maximum-information item selection is the standard CAT rule (Lord 1980; van der Linden & Glas 2000).",
    direction: "benefit",
  },
  zpdTargeting: {
    label: "ZPD targeting",
    rationale:
      "Gaussian proximity of predicted success to a confidence-adaptive success target: 0.5 (pure measurement) " +
      "when the estimate is untrusted, drifting to `successTarget` (pure pedagogy) once evidence accumulates.",
    evidence:
      "Zone of proximal development (Vygotsky 1978); flow/challenge–skill balance (Csikszentmihalyi 1990); " +
      "the 'eighty-five percent rule' for optimal error-driven learning (Wilson et al., Nat. Commun. 2019).",
    direction: "benefit",
  },
  prerequisiteCorrectness: {
    label: "Prerequisite correctness",
    rationale:
      "Conservative (lower-confidence-bound) readiness of the weakest prerequisite. Rewards items the learner " +
      "is genuinely supported for, and is also enforced as a hard gate.",
    evidence:
      "Learning hierarchies (Gagné 1968) and knowledge-space theory (Doignon & Falmagne 1985): practice on a " +
      "skill whose prerequisites are missing yields a fraction of the normal gain.",
    direction: "benefit",
  },
  skillCoverage: {
    label: "Skill coverage",
    rationale:
      "Diminishing-returns novelty of the skill this session, plus the number of downstream skills this item " +
      "would unblock. Prevents tunnel-drilling one skill and keeps the curriculum blueprint valid.",
    evidence:
      "Content-balancing constraints in operational CAT (Kingsbury & Zara 1989); interleaving benefits " +
      "(Rohrer & Taylor 2007).",
    direction: "benefit",
  },
  retention: {
    label: "Retention",
    rationale:
      "Forecast forgetting of already-valuable skills at the review horizon: mastery worth protecting × " +
      "(1 − predicted retrievability). Turns the policy from a one-shot optimiser into a durable-learning one.",
    evidence:
      "Spacing and retrieval-practice effects (Ebbinghaus 1885; Cepeda et al. 2006; Roediger & Karpicke 2006); " +
      "expanding-interval scheduling as used by SM-2/DSR half-life models.",
    direction: "benefit",
  },
  difficultyAppropriateness: {
    label: "Difficulty appropriateness",
    rationale:
      "Distance from an ideal item difficulty (estimated mastery + a desirable-difficulty offset) in *item-parameter* " +
      "space, plus Bloom-level fit. Deliberately independent of the response model, so a miscalibrated classifier " +
      "cannot push the learner into absurd items.",
    evidence:
      "Desirable difficulties (Bjork 1994); Bloom's taxonomy progression (Anderson & Krathwohl 2001). " +
      "Acts as the robustness term against response-model error.",
    direction: "benefit",
  },
  uncertaintyReduction: {
    label: "Learner-uncertainty reduction",
    rationale:
      "Expected *posterior variance* reduction for this skill (Bayesian D-optimality), weighted by how uncertain " +
      "the skill currently is. Distinct from information gain: it scores what we learn about the learner, not the item.",
    evidence:
      "Bayesian optimal experimental design (Lindley 1956; Chaloner & Verdinelli 1995); active learning.",
    direction: "benefit",
  },
  assessmentEfficiency: {
    label: "Assessment efficiency",
    rationale:
      "Time economy: expected item cost against a reference budget, counted more heavily as session fatigue grows. " +
      "Learning per minute — not per item — is what a learner actually spends.",
    evidence:
      "Test-length/efficiency trade-offs in CAT (Weiss & Kingsbury 1984); fatigue effects on response quality " +
      "(Ackerman & Kanfer 2009). Smallest prior: it is a tie-breaker, never a driver.",
    direction: "benefit",
  },
  repeatedExposure: {
    label: "Repeated-exposure penalty",
    rationale:
      "Penalises over-drilling the same skill/Bloom level this session and over-exposed bank items. Exact repeats " +
      "are removed by a hard filter; this term handles near-repeats.",
    evidence:
      "Item-exposure control (Sympson & Hetter 1985); interleaving over blocking (Taylor & Rohrer 2010).",
    direction: "penalty",
  },
  prerequisiteRisk: {
    label: "Prerequisite-risk penalty",
    rationale:
      "Applied only when the hard prerequisite gate had to be relaxed (nothing safe existed). Keeps the learner " +
      "moving without pretending the item is pedagogically safe.",
    evidence:
      "Fail-safe sequencing: never dead-end a session, but never silently treat an unsafe item as safe.",
    direction: "penalty",
  },
};

/* ------------------------------------------------------------------ */
/* Stage 1 — theory-anchored priors                                    */
/* ------------------------------------------------------------------ */

/**
 * Benefit priors sum to exactly 1.00; penalties are on the same 0..1 scale but
 * are *subtracted*, so they can dominate when a constraint is being violated.
 */
export const PRIOR_WEIGHTS: PolicyWeights = {
  // terminal objective — the only one that is literally "learning"
  expectedMasteryGain: 0.22,
  // pedagogy: keep the item in the productive band
  zpdTargeting: 0.15,
  // safety: never build on sand
  prerequisiteCorrectness: 0.14,
  // measurement: keep the state estimate sharp
  informationGain: 0.12,
  uncertaintyReduction: 0.09,
  // durability
  retention: 0.09,
  // robustness to response-model error
  difficultyAppropriateness: 0.08,
  // curriculum validity
  skillCoverage: 0.07,
  // time economy (tie-breaker)
  assessmentEfficiency: 0.04,
  // penalties
  repeatedExposure: 0.1,
  prerequisiteRisk: 0.25,
};

/* ------------------------------------------------------------------ */
/* Stage 2 — weights refined on the TRAIN split only                   */
/* ------------------------------------------------------------------ */

export interface TuningProvenance {
  /** How the weights were produced. */
  method: string;
  /** The pre-registered objective that was maximised. */
  objective: string;
  /** Which simulation cells were used (never the held-out split). */
  trainSplit: string;
  /** Multiplier grid explored per weight. */
  grid: number[];
  /** Value grid explored per structural parameter. */
  paramGrids: Record<string, number[]>;
  passes: number;
  /** Number of distinct simulated configurations evaluated. */
  evaluations: number;
  /** Composite TRAIN utility of the prior and of the tuned vector. */
  priorUtility: number;
  tunedUtility: number;
  generatedBy: string;
}

/**
 * Result of `npm run bench:tune` (deterministic). Do not hand-edit: re-run the
 * tuner, which rewrites this block and the provenance below.
 */
export const TUNED_WEIGHTS: PolicyWeights = {
  expectedMasteryGain: 0.094,
  informationGain: 0.106,
  zpdTargeting: 0.209,
  prerequisiteCorrectness: 0.249,
  skillCoverage: 0.037,
  retention: 0.16,
  difficultyAppropriateness: 0.071,
  uncertaintyReduction: 0.039,
  assessmentEfficiency: 0.035,
  repeatedExposure: 0.1,
  prerequisiteRisk: 0.25,
};

/**
 * Structural parameters the same search tuned in its stage-B passes. These are
 * merged into `DEFAULT_POLICY_PARAMS` below; they live in their own object so
 * the tuner's output and the shipped defaults are diffable.
 *
 * The headline result: what matters is not the gate *height* but what the gate
 * is applied to. Held at v2's 0.60, the search still moved `prereqPessimismZ`
 * from 0 (v2's behaviour: trust the point estimate) to 1.25 — i.e. gate on a
 * pessimistic lower bound instead. That single change carries essentially all
 * of v3's prerequisite-safety improvement, because the tracer runs ahead of
 * truth on thin evidence and a point estimate lets learners through gates they
 * have not actually passed. `maxPerSkill` tightened 4 → 3, which spreads
 * practice without breaching the coverage guardrail. See
 * `benchmarks/tuning.json` → `paramProfiles` for the full profile of each.
 */
export const TUNED_PARAMS = {
  prereqGate: 0.6,
  prereqPessimismZ: 1.25,
  maxPerSkill: 3,
} as const;

/**
 * The theory-prior values those structural parameters started from, so the
 * report can show what the search actually moved. `prereqPessimismZ = 0` is
 * v2's behaviour (gate on the point estimate); it is the prior because "trust
 * your own estimate" is the assumption v3 set out to test.
 */
export const PRIOR_PARAMS: Record<keyof typeof TUNED_PARAMS, number> = {
  prereqGate: 0.6,
  prereqPessimismZ: 0,
  maxPerSkill: 4,
};

export const TUNING_PROVENANCE: TuningProvenance = {
  method: "deterministic coordinate ascent over a fixed multiplier grid (order = PRIOR_WEIGHTS key order)",
  objective:
    "pre-registered, evaluated under a 14-minute-per-session TIME budget (not an item budget): " +
    "0.6·rel(retained mastery gain) + 0.4·rel(immediate mastery gain) " +
    "− 3·Σ max(0, relative regression − 2% tolerance) over guarded metrics " +
    "[estimation RMSE, Brier, ECE, prerequisite-violation rate, eligible skill coverage, ZPD hit rate, repeats]",
  trainSplit:
    "archetypes {cold-start-novice, intermediate, advanced, uneven, slow-learner} × 4 seeds × base world " +
    "(20 cells; the 5 held-out-only archetypes are never seen by the search)",
  grid: [0.6, 0.8, 1, 1.25, 1.6],
  paramGrids: {
    prereqGate: [0.45, 0.5, 0.55, 0.6],
    prereqPessimismZ: [0, 0.5, 0.75, 1, 1.25],
    maxPerSkill: [3, 4, 5],
  },
  passes: 2,
  evaluations: 133,
  priorUtility: -0.7978,
  tunedUtility: 0.0015,
  generatedBy: "benchmarks/tune.ts",
};

export const DEFAULT_POLICY_WEIGHTS: PolicyWeights = { ...TUNED_WEIGHTS };

/* ------------------------------------------------------------------ */
/* Objective-shape parameters                                          */
/* ------------------------------------------------------------------ */

export const DEFAULT_POLICY_PARAMS: PolicyParams = {
  masteryTarget: MASTERY_TARGET,
  successTarget: 0.75,
  zpdSigma: 0.18,
  prereqGate: TUNED_PARAMS.prereqGate,
  prereqPessimismZ: TUNED_PARAMS.prereqPessimismZ,
  desirableDifficultyOffset: 0.08,
  difficultyTolerance: 0.35,
  bloomShare: 0.3,
  retentionHorizonDays: 7,
  forgetPerDay: DEFAULT_BKT.forget,
  coverageUnblockShare: 0.4,
  maxPerSkill: TUNED_PARAMS.maxPerSkill,
  maxPerBloom: 4,
  maxConsecutiveSameSkill: 3,
  exposureSkillShare: 0.55,
  exposureBloomShare: 0.25,
  timeReferenceSeconds: 150,
  efficiencyBaseline: 0.5,
  referenceDiscrimination: 1,
};

export const POLICY_PARAM_RATIONALE: Record<keyof PolicyParams, string> = {
  masteryTarget:
    "0.85 — the platform-wide mastery bar (`MASTERY_TARGET`), already used by the gap detector and the UI bands.",
  successTarget:
    "0.75 — midpoint of the pedagogically optimal success band. Measurement optimum is 0.50 (max Fisher information), " +
    "error-driven learning optimum is ≈0.85 (Wilson et al. 2019); the policy interpolates between them by confidence " +
    "rather than committing to either.",
  zpdSigma:
    "0.18 — a Gaussian with this SD gives ≈0.60 efficiency one band-width (±0.18) from target and ≈0.13 two away, " +
    "matching the empirical 'productive difficulty' plateau of roughly 0.55–0.90 success.",
  prereqGate:
    "0.60 — the 'proficient' band boundary used across the platform, and confirmed by tuning (grid " +
    "0.45/0.50/0.55/0.60). Loosening the gate buys items the learner cannot yet learn from, which is expensive " +
    "once the budget is the learner's time rather than a fixed item count.",
  prereqPessimismZ:
    "1.0 posterior SD of pessimism — tuned (grid 0/0.5/0.75/1/1.25) and by far the largest single structural " +
    "effect in the search. z=0 *is* v2's gate: it applies the threshold to the point estimate, which runs ahead of " +
    "true ability early in a session (BKT's learning transition inflates mastery on thin evidence) and unlocks " +
    "downstream skills prematurely — the single biggest diagnosed defect of v2. Train utility by z: " +
    "the theory prior z=0 scores −0.527 against +0.170 for the tuned vector. Gating on a lower confidence bound is " +
    "worth more than every weight in this file put together; per-value utilities are in `benchmarks/tuning.json`.",
  desirableDifficultyOffset:
    "+0.08 above estimated mastery — small, deliberate stretch (desirable difficulty) without leaving the ZPD.",
  difficultyTolerance:
    "0.35 — items further than this from the ideal difficulty score ~0 on this objective; ≈ the width of one " +
    "difficulty band in the question bank (easy/medium/hard/expert).",
  bloomShare:
    "0.30 — Bloom fit is a real but secondary constraint next to raw difficulty; difficulty keeps the 0.70 majority.",
  retentionHorizonDays:
    "7 days — a weekly study cycle, the horizon at which a skill practised today should still be retrievable.",
  forgetPerDay:
    "0.035/day — the platform's BKT forgetting rate, so the policy's retention forecast and the tracer's decay agree.",
  coverageUnblockShare:
    "0.40 of the coverage objective is graph-unblocking value; 0.60 is session novelty. Unblocking matters, but a " +
    "policy that only chases downstream unlocks would abandon the skill in front of the learner.",
  maxPerSkill:
    "4 items per skill per session — beyond this, marginal diagnostic value falls off sharply. Confirmed by tuning " +
    "(grid 3/4/5); see `benchmarks/tuning.json` → `paramProfiles` for the per-value utilities.",
  maxPerBloom: "4 items per Bloom level per session — keeps cognitive demand varied.",
  maxConsecutiveSameSkill:
    "3 — hard cap; blocked practice beyond ~3 items in a row measurably underperforms interleaving.",
  exposureSkillShare: "0.55 — same-skill repetition is the dominant over-exposure risk inside a session.",
  exposureBloomShare: "0.25 — Bloom repetition matters less than skill repetition; the remaining 0.20 is bank exposure.",
  timeReferenceSeconds:
    "150 s — roughly twice the median item time in the bank; items at or beyond it consume a disproportionate share " +
    "of a session.",
  efficiencyBaseline:
    "0.50 — time economy always counts at half strength and reaches full strength only when the learner is fatigued " +
    "or at the end of the item budget.",
  referenceDiscrimination:
    "1.0 — items without a calibrated discrimination are treated as average, so an uncalibrated bank behaves exactly " +
    "like the v2 information term.",
};

/* ------------------------------------------------------------------ */
/* Presets (documented transformations of the prior, never new magic)  */
/* ------------------------------------------------------------------ */

export type PolicyPresetId = "balanced" | "learning-first" | "measurement-first" | "retention-first" | "theory-prior";

export interface PolicyPreset {
  id: PolicyPresetId;
  label: string;
  description: string;
  weights: PolicyWeights;
}

function scale(base: PolicyWeights, multipliers: Partial<Record<ObjectiveKey, number>>): PolicyWeights {
  const out = { ...base };
  for (const [key, m] of Object.entries(multipliers) as [ObjectiveKey, number][]) {
    out[key] = round3(base[key] * m);
  }
  return out;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export const POLICY_PRESETS: Record<PolicyPresetId, PolicyPreset> = {
  balanced: {
    id: "balanced",
    label: "Balanced (default)",
    description:
      "Benchmark-tuned weights: maximises durable learning on the TRAIN split subject to measurement and " +
      "prerequisite-safety guardrails.",
    weights: { ...TUNED_WEIGHTS },
  },
  "theory-prior": {
    id: "theory-prior",
    label: "Theory prior (untuned)",
    description: "The literature-anchored prior before any benchmark refinement. Useful as an ablation baseline.",
    weights: { ...PRIOR_WEIGHTS },
  },
  "learning-first": {
    id: "learning-first",
    label: "Learning first",
    description:
      "For practice/homework surfaces where the score is not reported: ×1.5 expected gain and ×1.25 ZPD, " +
      "×0.6 information and uncertainty.",
    weights: scale(TUNED_WEIGHTS, {
      expectedMasteryGain: 1.5,
      zpdTargeting: 1.25,
      informationGain: 0.6,
      uncertaintyReduction: 0.6,
    }),
  },
  "measurement-first": {
    id: "measurement-first",
    label: "Measurement first",
    description:
      "For placement/diagnostic sessions where an accurate state matters more than this session's learning: " +
      "×1.6 information, ×1.5 uncertainty reduction, ×0.6 expected gain and retention.",
    weights: scale(TUNED_WEIGHTS, {
      informationGain: 1.6,
      uncertaintyReduction: 1.5,
      expectedMasteryGain: 0.6,
      retention: 0.6,
    }),
  },
  "retention-first": {
    id: "retention-first",
    label: "Retention first",
    description:
      "For review/exam-prep sessions: ×2 retention and ×1.2 coverage, ×0.8 expected gain (new material takes a " +
      "back seat to consolidating what is already known).",
    weights: scale(TUNED_WEIGHTS, { retention: 2, skillCoverage: 1.2, expectedMasteryGain: 0.8 }),
  },
};

/* ------------------------------------------------------------------ */
/* Resolution, validation, fingerprinting                              */
/* ------------------------------------------------------------------ */

/** Deterministic 32-bit FNV-1a hash → 8-char hex. No crypto dependency. */
export function fingerprint(value: unknown): string {
  const text = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export class PolicyConfigError extends Error {}

function sanitizeWeights(input: Record<string, number> | undefined, base: PolicyWeights): PolicyWeights {
  const out = { ...base };
  if (!input) return out;
  for (const [key, value] of Object.entries(input)) {
    if (!(ALL_OBJECTIVES as readonly string[]).includes(key)) {
      throw new PolicyConfigError(`Unknown policy weight "${key}"`);
    }
    if (!Number.isFinite(value) || value < 0) {
      throw new PolicyConfigError(`Policy weight "${key}" must be a finite number >= 0 (got ${value})`);
    }
    out[key as ObjectiveKey] = value;
  }
  return out;
}

function sanitizeParams(input: Record<string, number> | undefined, base: PolicyParams): PolicyParams {
  const out = { ...base };
  if (!input) return out;
  for (const [key, value] of Object.entries(input)) {
    if (!(key in base)) throw new PolicyConfigError(`Unknown policy parameter "${key}"`);
    if (!Number.isFinite(value)) throw new PolicyConfigError(`Policy parameter "${key}" must be finite`);
    (out as unknown as Record<string, number>)[key] = value;
  }
  // Guard the parameters that would otherwise break the objective maths.
  out.masteryTarget = clamp(out.masteryTarget, 0.05, 1);
  out.successTarget = clamp(out.successTarget, 0.05, 0.98);
  out.zpdSigma = clamp(out.zpdSigma, 0.02, 1);
  out.prereqGate = clamp(out.prereqGate, 0, 1);
  out.prereqPessimismZ = clamp(out.prereqPessimismZ, 0, 4);
  out.difficultyTolerance = clamp(out.difficultyTolerance, 0.05, 1);
  out.bloomShare = clamp(out.bloomShare, 0, 1);
  out.coverageUnblockShare = clamp(out.coverageUnblockShare, 0, 1);
  out.retentionHorizonDays = clamp(out.retentionHorizonDays, 0, 365);
  out.forgetPerDay = clamp(out.forgetPerDay, 0, 1);
  out.maxPerSkill = Math.max(1, Math.round(out.maxPerSkill));
  out.maxPerBloom = Math.max(1, Math.round(out.maxPerBloom));
  out.maxConsecutiveSameSkill = Math.max(1, Math.round(out.maxConsecutiveSameSkill));
  out.exposureSkillShare = clamp(out.exposureSkillShare, 0, 1);
  out.exposureBloomShare = clamp(out.exposureBloomShare, 0, 1 - out.exposureSkillShare);
  out.timeReferenceSeconds = Math.max(5, out.timeReferenceSeconds);
  out.efficiencyBaseline = clamp(out.efficiencyBaseline, 0, 1);
  out.referenceDiscrimination = clamp(out.referenceDiscrimination, 0.1, 5);
  return out;
}

/**
 * Renormalise the benefit weights to sum to 1 so the composite score stays a
 * convex combination (0..1 before penalties) no matter what a tenant configures.
 * Penalty weights keep their absolute scale — a constraint violation must be
 * able to outvote the entire benefit sum.
 */
export function normalizeWeights(weights: PolicyWeights): PolicyWeights {
  const benefitSum = BENEFIT_OBJECTIVES.reduce((acc, key) => acc + weights[key], 0);
  const out = { ...weights };
  if (benefitSum > 0) {
    for (const key of BENEFIT_OBJECTIVES) out[key] = weights[key] / benefitSum;
  } else {
    // Degenerate config (every benefit weight 0) — fall back to the prior.
    for (const key of BENEFIT_OBJECTIVES) out[key] = PRIOR_WEIGHTS[key];
  }
  for (const key of PENALTY_OBJECTIVES) out[key] = weights[key];
  return out;
}

export function resolvePolicyConfig(overrides: PolicyConfigOverrides = {}): ResolvedPolicyConfig {
  const weights = sanitizeWeights(overrides.weights as Record<string, number> | undefined, DEFAULT_POLICY_WEIGHTS);
  const params = sanitizeParams(overrides.params as Record<string, number> | undefined, DEFAULT_POLICY_PARAMS);
  const normalizedWeights = normalizeWeights(weights);
  return {
    weights,
    params,
    normalizedWeights,
    fingerprint: fingerprint({ w: normalizedWeights, p: params }),
  };
}

/** Parse a JSON blob (env var / tenant setting) into weight overrides. */
export function parsePolicyWeights(raw: string | undefined | null): Partial<PolicyWeights> | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PolicyConfigError("ADAPTIVE_POLICY_WEIGHTS must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PolicyConfigError("ADAPTIVE_POLICY_WEIGHTS must be a JSON object of weight overrides");
  }
  const out: Partial<PolicyWeights> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!(ALL_OBJECTIVES as readonly string[]).includes(key)) {
      throw new PolicyConfigError(`Unknown policy weight "${key}"`);
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new PolicyConfigError(`Policy weight "${key}" must be a finite number >= 0`);
    }
    out[key as ObjectiveKey] = value;
  }
  return out;
}

export function presetWeights(id: PolicyPresetId): PolicyWeights {
  const preset = POLICY_PRESETS[id];
  if (!preset) throw new PolicyConfigError(`Unknown policy preset "${id}"`);
  return { ...preset.weights };
}
