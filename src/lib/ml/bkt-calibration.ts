/**
 * Offline BKT parameter estimation. **Never loaded by production serving.**
 *
 * Like `irt-calibration.ts`, this module is a research/offline estimator: it
 * produces a *versioned artifact* that a human may later choose to adopt. It
 * does not read the serving path, does not write to it, and importing it has no
 * effect on any learner-facing behaviour. Serving continues to use the global
 * constants in `knowledge-tracing.ts` until someone deliberately promotes an
 * artifact.
 *
 * ── Why skill-specific parameters need evidence, not just code ───────────────
 *
 * BKT's four parameters are only weakly identified. The classic failure
 * (Beck & Chang 2007, "Identifiability: A Fundamental Problem of Student
 * Modeling") is that several very different (L0, T, S, G) tuples produce nearly
 * identical likelihoods, and some of them are *degenerate*: a skill fitted with
 * slip 0.6 / guess 0.5 predicts responses acceptably while making mastery
 * meaningless — the model says a learner who answers correctly probably guessed,
 * so mastery never rises and the adaptive policy never lets them advance. A
 * per-skill fit on thin data walks straight into that region. Hence:
 * bounded parameters, minimum-evidence gates, shrinkage toward a global fit, and
 * an explicit degeneracy check.
 *
 * ── Estimation ──────────────────────────────────────────────────────────────
 *
 * Expectation-Maximisation over per-(learner, skill) response sequences, which
 * is the standard BKT fitting procedure and, unlike gradient descent on the raw
 * likelihood, respects the latent-state structure. Forgetting is *not* fitted
 * (see `FORGET_POLICY` below).
 *
 * Determinism: no `Math.random`, no `Date.now`, no ambient config. Same rows +
 * same options ⇒ byte-identical artifact.
 */
import { clamp, mean, round } from "@/lib/utils";
import { DEFAULT_BKT } from "@/lib/ml/knowledge-tracing";

/* ------------------------------------------------------------------ */
/* Current (pre-upgrade) parameterization — documented as data          */
/* ------------------------------------------------------------------ */

/**
 * What production uses **today**, recorded here so the comparison baseline is
 * a fact in code rather than a claim in a document. Audited from:
 *
 *   knowledge-tracing.ts  DEFAULT_BKT           slip/guess/learn/forget
 *   models/bkt.ts         DEFAULT_BKT_EXT       priorMastery 0.3
 *   db/schema.ts          mastery_states        mastery/prior_mastery 0.4,
 *                                               slip 0.1, guess 0.2,
 *                                               learn_rate 0.22 (column
 *                                               defaults = the globals)
 *   engine.ts:544         diagnostic first-touch prior 0.5
 *   engine.ts:69          loadSkillFeatures     0 when no state row exists
 *   engine.ts:70          cold ability fallback 0.45
 *
 * NOTE the inconsistency this audit surfaced: **initial mastery has four
 * different values** depending on the entry point (0.3 / 0.4 / 0.5 / 0). They
 * are not reconciled here — that is a serving change, and this task is
 * explicitly offline-only — but a calibrated L0 makes the divergence
 * measurable, and it is reported in `BKT_CALIBRATION.md`.
 */
export const CURRENT_SERVING_PARAMS = {
  /** models/bkt.ts `DEFAULT_BKT_EXT.priorMastery`. */
  priorMastery: 0.3,
  learn: DEFAULT_BKT.learn, // 0.22
  slip: DEFAULT_BKT.slip, // 0.10
  guess: DEFAULT_BKT.guess, // 0.20
  /** Exponential decay per day, applied outside the BKT recursion. */
  forget: DEFAULT_BKT.forget, // 0.035
} as const;

/** Other initial-mastery values live in the serving path; see the comment above. */
export const INITIAL_MASTERY_VARIANTS = {
  bktModelPrior: 0.3,
  masteryStateColumnDefault: 0.4,
  diagnosticFirstTouch: 0.5,
  missingStateFeature: 0,
} as const;

/**
 * Forgetting is deliberately NOT estimated by this pipeline.
 *
 * In the serving implementation `forget` is not a BKT transition at all — it is
 * an exponential decay applied to stored mastery between sessions
 * (`applyDecay`), outside the posterior recursion. Fitting a within-sequence
 * forget transition here would estimate a *different quantity* from the one the
 * engine applies, and adopting it would silently change semantics. Estimating
 * the decay rate properly needs spaced-retention data (same skill, long gap,
 * no intervening practice), which is a separate study.
 */
export const FORGET_POLICY = {
  estimated: false,
  reason:
    "serving applies `forget` as between-session exponential decay outside the BKT recursion; " +
    "fitting a within-sequence forget transition would estimate a different quantity",
  inheritedValue: CURRENT_SERVING_PARAMS.forget,
} as const;

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface BktResponseRow {
  learnerId: string | number;
  skillId: string | number;
  isCorrect: boolean;
  occurredAt: string | Date;
  /** Simulation-only ground truth. Never used for fitting; evaluation only. */
  trueMastery?: number;
}

export interface BktSkillParams {
  priorMastery: number;
  learn: number;
  slip: number;
  guess: number;
  /** Inherited, never fitted — see FORGET_POLICY. */
  forget: number;
}

export type ParameterSource = "fitted" | "shrunk" | "global-fallback";

export interface BktSkillArtifactEntry {
  skillId: string;
  params: BktSkillParams;
  /** Pre-shrinkage maximum-likelihood fit, for audit. Null when not fitted. */
  rawFit: BktSkillParams | null;
  source: ParameterSource;
  opportunities: number;
  learners: number;
  sequences: number;
  /** Shrinkage weight actually applied to the raw fit (1 = no shrinkage). */
  shrinkageWeight: number;
  /** Mean per-response log-likelihood on the fitting data. */
  trainLogLikelihood: number | null;
  emIterations: number;
  converged: boolean;
  flags: string[];
}

export interface BktCalibrationArtifact {
  /** Artifact schema version — bump on any shape change. */
  schemaVersion: "bkt-params-v1";
  /** Parameter-set version, e.g. "bkt-skill-2026.09". Chosen by the operator. */
  version: string;
  global: BktSkillParams;
  skills: Record<string, BktSkillArtifactEntry>;
  provenance: {
    algorithm: string;
    datasetVersion: string;
    trainedThrough: string;
    rows: number;
    learners: number;
    skills: number;
    heldOutLearners: number;
    thresholds: BktCalibrationThresholds;
    shrinkageK: number;
    bounds: typeof PARAM_BOUNDS;
    forgetPolicy: typeof FORGET_POLICY;
    emIterations: number;
    tolerance: number;
  };
}

export interface BktCalibrationThresholds {
  /** Minimum responses on a skill before it may get its own parameters. */
  minOpportunitiesPerSkill: number;
  /** Minimum distinct learners — guards against one learner defining a skill. */
  minLearnersPerSkill: number;
  /** Minimum (learner, skill) sequences of length ≥ 2 (transitions carry T). */
  minSequencesPerSkill: number;
  /** Minimum responses in a sequence for it to inform the fit. */
  minSequenceLength: number;
  /** Total responses required before ANY skill-specific fitting is attempted. */
  minTotalOpportunities: number;
}

/**
 * Defaults chosen from the BKT literature's identifiability guidance rather
 * than from this dataset (choosing them after looking at results would be
 * fitting the threshold to the answer).
 *
 * 200 opportunities / 30 learners per skill is the commonly cited floor for a
 * stable four-parameter BKT fit; below it, published estimates swing wildly
 * between runs. `minSequenceLength: 2` is structural: a single response carries
 * no transition, so it cannot inform the learn rate.
 */
export const DEFAULT_THRESHOLDS: BktCalibrationThresholds = {
  minOpportunitiesPerSkill: 200,
  minLearnersPerSkill: 30,
  minSequencesPerSkill: 30,
  minSequenceLength: 2,
  minTotalOpportunities: 2000,
};

/**
 * Hard bounds keeping fits out of the degenerate region.
 *
 * `slip + guess < 1` is the classic non-degeneracy condition: at or beyond it,
 * a correct answer becomes evidence *against* mastery and the model inverts.
 * The individual caps (0.3/0.4) are the conventional ceilings — a skill that
 * genuinely needs slip 0.5 is telling you the item pool is broken, not that the
 * learner model needs a wider bound.
 */
export const PARAM_BOUNDS = {
  priorMastery: { min: 0.01, max: 0.95 },
  learn: { min: 0.001, max: 0.6 },
  slip: { min: 0.01, max: 0.3 },
  guess: { min: 0.01, max: 0.4 },
  maxSlipPlusGuess: 0.9,
} as const;

export interface BktCalibrationOptions {
  version: string;
  datasetVersion: string;
  trainedThrough: string;
  thresholds?: Partial<BktCalibrationThresholds>;
  /**
   * Shrinkage strength: a skill with `k` opportunities is pulled halfway to the
   * global fit. Larger k = more conservative. Default 300 ≈ "trust a skill's own
   * parameters once it has clearly more evidence than the per-skill minimum".
   */
  shrinkageK?: number;
  emIterations?: number;
  tolerance?: number;
}

/* ------------------------------------------------------------------ */
/* Sequence construction (leakage-free by construction)                */
/* ------------------------------------------------------------------ */

function toEpoch(value: string | Date): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

export interface BktSequence {
  learnerId: string;
  skillId: string;
  responses: { isCorrect: boolean; at: number; trueMastery?: number }[];
}

/**
 * Group responses into per-(learner, skill) chronological sequences.
 *
 * Ordering is by timestamp with a stable tiebreak on input index, so a batch of
 * responses sharing a timestamp cannot be silently reordered between runs —
 * that would make the artifact non-reproducible.
 */
export function buildSequences(rows: BktResponseRow[]): BktSequence[] {
  const groups = new Map<string, { learnerId: string; skillId: string; items: { row: BktResponseRow; i: number }[] }>();
  rows.forEach((row, i) => {
    const learnerId = String(row.learnerId);
    const skillId = String(row.skillId);
    const key = `${learnerId}\u0000${skillId}`;
    const group = groups.get(key) ?? { learnerId, skillId, items: [] };
    group.items.push({ row, i });
    groups.set(key, group);
  });
  return [...groups.values()]
    .sort((a, b) => (a.learnerId < b.learnerId ? -1 : a.learnerId > b.learnerId ? 1 : a.skillId < b.skillId ? -1 : a.skillId > b.skillId ? 1 : 0))
    .map((group) => ({
      learnerId: group.learnerId,
      skillId: group.skillId,
      responses: group.items
        .map((entry) => ({ ...entry, t: toEpoch(entry.row.occurredAt) }))
        .sort((a, b) => a.t - b.t || a.i - b.i)
        .map((entry) => ({
          isCorrect: entry.row.isCorrect,
          at: entry.t,
          ...(entry.row.trueMastery !== undefined ? { trueMastery: entry.row.trueMastery } : {}),
        })),
    }));
}

/* ------------------------------------------------------------------ */
/* Splitting: held-out learners + chronological                        */
/* ------------------------------------------------------------------ */

/** Deterministic learner hash (FNV-1a). No RNG, so splits are reproducible. */
export function learnerHash(learnerId: string | number): number {
  const s = String(learnerId);
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

export interface BktSplit {
  /** Fitting data: non-held-out learners, earliest `trainRatio` of time. */
  train: BktResponseRow[];
  /** Same learners, strictly later responses — tests temporal generalisation. */
  chronologicalTest: BktResponseRow[];
  /** Learners the fit never saw, at any time — tests learner generalisation. */
  heldOutLearnerTest: BktResponseRow[];
  boundaryAt: number | null;
  heldOutLearnerIds: string[];
}

/**
 * Two independent generalisation tests, because they fail differently: a model
 * can memorise the learners it trained on (caught by the held-out learner set)
 * or ride a population trend that will not repeat (caught by the chronological
 * set). Both splits are *response-level disjoint* from training, and the
 * chronological boundary is a wall-clock instant, so no training response can
 * postdate any chronological-test response.
 */
export function splitBktResponses(
  rows: BktResponseRow[],
  opts: { heldOutLearnerFraction?: number; trainRatio?: number } = {},
): BktSplit {
  const heldOutFraction = opts.heldOutLearnerFraction ?? 0.2;
  const trainRatio = opts.trainRatio ?? 0.8;

  const heldOutLearnerIds = [...new Set(rows.map((r) => String(r.learnerId)))]
    .filter((id) => learnerHash(id) < heldOutFraction)
    .sort();
  const heldOut = new Set(heldOutLearnerIds);

  const fitPool = rows.filter((r) => !heldOut.has(String(r.learnerId)));
  const ordered = [...fitPool]
    .map((row, i) => ({ row, i, t: toEpoch(row.occurredAt) }))
    .sort((a, b) => a.t - b.t || a.i - b.i);
  const cut = Math.floor(ordered.length * trainRatio);
  const boundaryAt = cut > 0 && cut <= ordered.length ? (ordered[cut - 1]?.t ?? null) : null;

  return {
    train: ordered.slice(0, cut).map((e) => e.row),
    chronologicalTest: ordered.slice(cut).map((e) => e.row),
    heldOutLearnerTest: rows.filter((r) => heldOut.has(String(r.learnerId))),
    boundaryAt,
    heldOutLearnerIds,
  };
}

/* ------------------------------------------------------------------ */
/* EM fitting                                                          */
/* ------------------------------------------------------------------ */

function applyBounds(p: BktSkillParams): BktSkillParams {
  const slip = clamp(p.slip, PARAM_BOUNDS.slip.min, PARAM_BOUNDS.slip.max);
  const guess = clamp(p.guess, PARAM_BOUNDS.guess.min, PARAM_BOUNDS.guess.max);
  // Preserve the non-degeneracy condition by scaling both down together rather
  // than clipping one, which would distort their ratio.
  const sum = slip + guess;
  const scale = sum > PARAM_BOUNDS.maxSlipPlusGuess ? PARAM_BOUNDS.maxSlipPlusGuess / sum : 1;
  return {
    priorMastery: clamp(p.priorMastery, PARAM_BOUNDS.priorMastery.min, PARAM_BOUNDS.priorMastery.max),
    learn: clamp(p.learn, PARAM_BOUNDS.learn.min, PARAM_BOUNDS.learn.max),
    slip: slip * scale,
    guess: guess * scale,
    forget: p.forget,
  };
}

/** P(correct | latent mastery state). */
function emit(isCorrect: boolean, known: boolean, p: BktSkillParams): number {
  if (known) return isCorrect ? 1 - p.slip : p.slip;
  return isCorrect ? p.guess : 1 - p.guess;
}

/**
 * Scaled forward-backward over one sequence for the two-state BKT chain.
 *
 * States: 0 = not-known, 1 = known. Transition is absorbing —
 * P(known → known) = 1, P(not-known → known) = `learn` — because within a
 * practice sequence BKT has no forgetting (between-session decay is applied by
 * the serving layer; see FORGET_POLICY).
 *
 * Scaling (dividing by the per-step evidence mass) keeps long sequences from
 * underflowing to zero, and the scale factors are exactly the per-step
 * likelihood, so the log-likelihood falls out of the same pass.
 */
function forwardBackward(seq: BktSequence, p: BktSkillParams) {
  const n = seq.responses.length;
  const obs = seq.responses.map((r) => r.isCorrect);

  // Forward (filtered, scaled).
  const fwd: { unknown: number; known: number }[] = new Array(n);
  const scale: number[] = new Array(n).fill(1);
  let priorKnown = p.priorMastery;

  for (let t = 0; t < n; t += 1) {
    const known = priorKnown * emit(obs[t], true, p);
    const unknown = (1 - priorKnown) * emit(obs[t], false, p);
    const c = known + unknown;
    scale[t] = c > 0 ? c : 1e-12;
    fwd[t] = { known: known / scale[t], unknown: unknown / scale[t] };
    // Transition into t+1.
    priorKnown = fwd[t].known + fwd[t].unknown * p.learn;
  }

  // Backward (scaled with the same factors).
  const bwd: { unknown: number; known: number }[] = new Array(n);
  bwd[n - 1] = { unknown: 1, known: 1 };
  for (let t = n - 2; t >= 0; t -= 1) {
    const eKnownNext = emit(obs[t + 1], true, p);
    const eUnknownNext = emit(obs[t + 1], false, p);
    const known = eKnownNext * bwd[t + 1].known; // known -> known w.p. 1
    const unknown =
      p.learn * eKnownNext * bwd[t + 1].known + (1 - p.learn) * eUnknownNext * bwd[t + 1].unknown;
    const c = scale[t + 1];
    bwd[t] = { known: known / c, unknown: unknown / c };
  }

  // Smoothed state posteriors and not-known -> known transition posteriors.
  const gamma: number[] = new Array(n).fill(0);
  const xiLearn: number[] = new Array(Math.max(0, n - 1)).fill(0);
  for (let t = 0; t < n; t += 1) {
    const known = fwd[t].known * bwd[t].known;
    const unknown = fwd[t].unknown * bwd[t].unknown;
    const total = known + unknown;
    gamma[t] = total > 0 ? known / total : fwd[t].known;
  }
  for (let t = 0; t < n - 1; t += 1) {
    const eKnownNext = emit(obs[t + 1], true, p);
    const numerator = (fwd[t].unknown * p.learn * eKnownNext * bwd[t + 1].known) / scale[t + 1];
    xiLearn[t] = clamp(numerator, 0, 1);
  }

  const logLikelihood = scale.reduce((sum, c) => sum + Math.log(Math.max(1e-12, c)), 0);
  return { gamma, xiLearn, logLikelihood };
}

export interface EmFitResult {
  params: BktSkillParams;
  iterations: number;
  converged: boolean;
  /** Mean per-response log-likelihood (comparable across differently sized skills). */
  logLikelihood: number;
  responses: number;
}

/**
 * Fit (L0, T, S, G) by EM on the supplied sequences.
 *
 * Initialised at the current serving parameters rather than at random or at
 * neutral values: it keeps the search in the sane region, makes the result
 * reproducible without a seed, and means "no improvement" converges back to
 * what production already does.
 */
export function fitBktEm(
  sequences: BktSequence[],
  opts: { iterations?: number; tolerance?: number; init?: BktSkillParams } = {},
): EmFitResult {
  const iterations = opts.iterations ?? 200;
  const tolerance = opts.tolerance ?? 1e-6;
  let params: BktSkillParams = applyBounds({ ...(opts.init ?? { ...CURRENT_SERVING_PARAMS }) });

  const usable = sequences.filter((s) => s.responses.length >= 1);
  const totalResponses = usable.reduce((sum, s) => sum + s.responses.length, 0);
  if (!usable.length || totalResponses === 0) {
    return { params, iterations: 0, converged: false, logLikelihood: -Infinity, responses: 0 };
  }

  let previousLl = -Infinity;
  let iteration = 0;
  let converged = false;

  for (; iteration < iterations; iteration += 1) {
    // --- E step: expected latent states ---
    let priorSum = 0;
    let priorCount = 0;
    let learnNum = 0;
    let learnDen = 0;
    let slipNum = 0;
    let slipDen = 0;
    let guessNum = 0;
    let guessDen = 0;
    let ll = 0;

    for (const seq of usable) {
      const { gamma, xiLearn, logLikelihood } = forwardBackward(seq, params);
      ll += logLikelihood;
      priorSum += gamma[0];
      priorCount += 1;

      for (let t = 0; t < seq.responses.length; t += 1) {
        const known = gamma[t];
        const correct = seq.responses[t].isCorrect;
        // slip = P(incorrect | known); guess = P(correct | not known).
        slipDen += known;
        if (!correct) slipNum += known;
        guessDen += 1 - known;
        if (correct) guessNum += 1 - known;
      }
      // learn = expected not-known -> known transitions / expected time spent
      // not-known, over transition opportunities only (t < last).
      for (let t = 0; t < seq.responses.length - 1; t += 1) {
        learnNum += xiLearn[t];
        learnDen += 1 - gamma[t];
      }
    }

    // --- M step ---
    const next: BktSkillParams = applyBounds({
      priorMastery: priorCount ? priorSum / priorCount : params.priorMastery,
      learn: learnDen > 1e-9 ? learnNum / learnDen : params.learn,
      slip: slipDen > 1e-9 ? slipNum / slipDen : params.slip,
      guess: guessDen > 1e-9 ? guessNum / guessDen : params.guess,
      forget: params.forget,
    });

    const meanLl = ll / totalResponses;
    params = next;
    if (Math.abs(meanLl - previousLl) < tolerance) {
      previousLl = meanLl;
      converged = true;
      iteration += 1;
      break;
    }
    previousLl = meanLl;
  }

  return {
    params,
    iterations: iteration,
    converged,
    logLikelihood: previousLl,
    responses: totalResponses,
  };
}

/* ------------------------------------------------------------------ */
/* Evidence sufficiency                                                */
/* ------------------------------------------------------------------ */

export interface SkillEvidence {
  skillId: string;
  opportunities: number;
  learners: number;
  sequences: number;
  sufficient: boolean;
  shortfalls: string[];
}

export interface EvidenceReport {
  totalResponses: number;
  totalLearners: number;
  totalSkills: number;
  /** Skills meeting every per-skill threshold. */
  eligibleSkills: string[];
  ineligibleSkills: SkillEvidence[];
  thresholds: BktCalibrationThresholds;
  /** False ⇒ do not fit skill-specific parameters at all; keep the global model. */
  sufficientForSkillSpecific: boolean;
  /** Human-readable statement of what is still missing. */
  requirement: string;
}

/**
 * Decide — before fitting anything — whether the dataset can support
 * skill-specific parameters, and say precisely what is missing if it cannot.
 */
export function assessEvidence(
  rows: BktResponseRow[],
  thresholds: BktCalibrationThresholds = DEFAULT_THRESHOLDS,
): EvidenceReport {
  const sequences = buildSequences(rows);
  const bySkill = new Map<string, { opportunities: number; learners: Set<string>; sequences: number }>();

  for (const seq of sequences) {
    const entry = bySkill.get(seq.skillId) ?? { opportunities: 0, learners: new Set<string>(), sequences: 0 };
    entry.opportunities += seq.responses.length;
    entry.learners.add(seq.learnerId);
    if (seq.responses.length >= thresholds.minSequenceLength) entry.sequences += 1;
    bySkill.set(seq.skillId, entry);
  }

  const eligible: string[] = [];
  const ineligible: SkillEvidence[] = [];
  for (const [skillId, entry] of [...bySkill.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const shortfalls: string[] = [];
    if (entry.opportunities < thresholds.minOpportunitiesPerSkill) {
      shortfalls.push(`needs ${thresholds.minOpportunitiesPerSkill - entry.opportunities} more responses`);
    }
    if (entry.learners.size < thresholds.minLearnersPerSkill) {
      shortfalls.push(`needs ${thresholds.minLearnersPerSkill - entry.learners.size} more distinct learners`);
    }
    if (entry.sequences < thresholds.minSequencesPerSkill) {
      shortfalls.push(
        `needs ${thresholds.minSequencesPerSkill - entry.sequences} more multi-response sequences`,
      );
    }
    const evidence: SkillEvidence = {
      skillId,
      opportunities: entry.opportunities,
      learners: entry.learners.size,
      sequences: entry.sequences,
      sufficient: shortfalls.length === 0,
      shortfalls,
    };
    if (evidence.sufficient) eligible.push(skillId);
    else ineligible.push(evidence);
  }

  const totalResponses = rows.length;
  const totalLearners = new Set(rows.map((r) => String(r.learnerId))).size;
  const sufficient = totalResponses >= thresholds.minTotalOpportunities && eligible.length > 0;

  const requirement = sufficient
    ? `Sufficient: ${eligible.length}/${bySkill.size} skills meet the per-skill thresholds.`
    : [
        `Insufficient evidence for skill-specific BKT — retain the current global parameters.`,
        `Required before training:`,
        `  • ≥ ${thresholds.minTotalOpportunities} total graded responses (have ${totalResponses}` +
          `, need ${Math.max(0, thresholds.minTotalOpportunities - totalResponses)} more)`,
        `  • ≥ 1 skill with ≥ ${thresholds.minOpportunitiesPerSkill} responses from ` +
          `≥ ${thresholds.minLearnersPerSkill} distinct learners and ` +
          `≥ ${thresholds.minSequencesPerSkill} sequences of ≥ ${thresholds.minSequenceLength} responses ` +
          `(have ${eligible.length} such skills)`,
      ].join("\n");

  return {
    totalResponses,
    totalLearners,
    totalSkills: bySkill.size,
    eligibleSkills: eligible,
    ineligibleSkills: ineligible,
    thresholds,
    sufficientForSkillSpecific: sufficient,
    requirement,
  };
}

/* ------------------------------------------------------------------ */
/* Artifact construction                                               */
/* ------------------------------------------------------------------ */

/** Deterministic dataset signature — part of reproducibility provenance. */
export function bktDatasetSignature(rows: BktResponseRow[]): string {
  if (!rows.length) return "empty";
  let checksum = 0;
  let min = Infinity;
  let max = -Infinity;
  rows.forEach((row, i) => {
    const t = toEpoch(row.occurredAt);
    min = Math.min(min, t);
    max = Math.max(max, t);
    const token = (row.isCorrect ? 1 : 2) * (i + 1) + String(row.skillId).length * 31 + String(row.learnerId).length;
    checksum = (checksum + token * 2654435761) % 1_000_000_007;
  });
  const spanDays = Math.round((max - min) / 86_400_000);
  return `n${rows.length}-span${spanDays}d-c${checksum.toString(36)}`;
}

function roundParams(p: BktSkillParams): BktSkillParams {
  return {
    priorMastery: round(p.priorMastery, 4),
    learn: round(p.learn, 4),
    slip: round(p.slip, 4),
    guess: round(p.guess, 4),
    forget: round(p.forget, 4),
  };
}

/**
 * Detect fits that predict acceptably while making mastery meaningless.
 * These are rejected outright and fall back to global parameters, because a
 * skill whose mastery estimate never moves silently breaks the adaptive policy
 * downstream even when its Brier score looks fine.
 */
function degeneracyFlags(p: BktSkillParams): string[] {
  const flags: string[] = [];
  if (p.slip + p.guess >= 0.85) flags.push("degenerate_slip_guess_sum");
  if (p.guess >= PARAM_BOUNDS.guess.max - 1e-6) flags.push("guess_at_bound");
  if (p.slip >= PARAM_BOUNDS.slip.max - 1e-6) flags.push("slip_at_bound");
  if (p.learn <= PARAM_BOUNDS.learn.min + 1e-6) flags.push("no_learning_signal");
  if (p.priorMastery >= 0.9) flags.push("prior_saturated");
  return flags;
}

export type BktVariant = "global" | "skill-specific" | "skill-specific-shrunk";

/**
 * Fit an artifact from training rows.
 *
 * `variant` selects which of the three compared models is produced, so the
 * comparison harness can build all three from one code path — the models differ
 * only in this function's shrinkage/eligibility handling, never in their
 * estimator, split or evaluation.
 */
export function fitBktCalibration(
  trainRows: BktResponseRow[],
  options: BktCalibrationOptions & { variant?: BktVariant },
): BktCalibrationArtifact {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds ?? {}) };
  const variant = options.variant ?? "skill-specific-shrunk";
  const shrinkageK = options.shrinkageK ?? 300;
  const emIterations = options.emIterations ?? 200;
  const tolerance = options.tolerance ?? 1e-6;

  const sequences = buildSequences(trainRows);
  const evidence = assessEvidence(trainRows, thresholds);

  // Global fit: every sequence pooled. This is both the "current global BKT"
  // comparison arm (when variant === "global") and the shrinkage target.
  const globalFit = fitBktEm(sequences, { iterations: emIterations, tolerance });
  const globalParams = roundParams(globalFit.params);

  const skills: Record<string, BktSkillArtifactEntry> = {};
  const bySkill = new Map<string, BktSequence[]>();
  for (const seq of sequences) {
    bySkill.set(seq.skillId, [...(bySkill.get(seq.skillId) ?? []), seq]);
  }

  for (const [skillId, skillSequences] of [...bySkill.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const opportunities = skillSequences.reduce((sum, s) => sum + s.responses.length, 0);
    const learners = new Set(skillSequences.map((s) => s.learnerId)).size;
    const usableSequences = skillSequences.filter((s) => s.responses.length >= thresholds.minSequenceLength).length;
    const eligible = evidence.eligibleSkills.includes(skillId);

    const base: Omit<BktSkillArtifactEntry, "params" | "rawFit" | "source" | "shrinkageWeight" | "trainLogLikelihood" | "emIterations" | "converged" | "flags"> = {
      skillId,
      opportunities,
      learners,
      sequences: usableSequences,
    };

    // The global arm never assigns per-skill parameters; every skill reads the
    // pooled fit. Kept in the artifact so all three variants are the same shape.
    if (variant === "global" || !eligible) {
      skills[skillId] = {
        ...base,
        params: globalParams,
        rawFit: null,
        source: "global-fallback",
        shrinkageWeight: 0,
        trainLogLikelihood: null,
        emIterations: 0,
        converged: false,
        flags: variant === "global" ? ["variant_global"] : ["insufficient_evidence"],
      };
      continue;
    }

    const fit = fitBktEm(skillSequences, { iterations: emIterations, tolerance });
    const rawFit = roundParams(fit.params);
    const flags = degeneracyFlags(fit.params);

    // A degenerate fit is not shrunk toward sanity — it is discarded. Shrinking
    // it would quietly blend a broken model into the shipped parameters.
    if (flags.length) {
      skills[skillId] = {
        ...base,
        params: globalParams,
        rawFit,
        source: "global-fallback",
        shrinkageWeight: 0,
        trainLogLikelihood: round(fit.logLikelihood, 6),
        emIterations: fit.iterations,
        converged: fit.converged,
        flags: [...flags, "rejected_degenerate"],
      };
      continue;
    }

    if (variant === "skill-specific") {
      skills[skillId] = {
        ...base,
        params: rawFit,
        rawFit,
        source: "fitted",
        shrinkageWeight: 1,
        trainLogLikelihood: round(fit.logLikelihood, 6),
        emIterations: fit.iterations,
        converged: fit.converged,
        flags,
      };
      continue;
    }

    // Empirical-Bayes style shrinkage: w = n / (n + k). A skill with exactly
    // `k` opportunities sits halfway between its own fit and the global one.
    const w = opportunities / (opportunities + shrinkageK);
    const blend = (a: number, b: number) => w * a + (1 - w) * b;
    const shrunk = applyBounds({
      priorMastery: blend(fit.params.priorMastery, globalParams.priorMastery),
      learn: blend(fit.params.learn, globalParams.learn),
      slip: blend(fit.params.slip, globalParams.slip),
      guess: blend(fit.params.guess, globalParams.guess),
      forget: globalParams.forget,
    });

    skills[skillId] = {
      ...base,
      params: roundParams(shrunk),
      rawFit,
      source: "shrunk",
      shrinkageWeight: round(w, 4),
      trainLogLikelihood: round(fit.logLikelihood, 6),
      emIterations: fit.iterations,
      converged: fit.converged,
      flags,
    };
  }

  return {
    schemaVersion: "bkt-params-v1",
    version: options.version,
    global: globalParams,
    skills,
    provenance: {
      algorithm: `bkt-em-forward-backward-v1 (variant=${variant})`,
      datasetVersion: options.datasetVersion,
      trainedThrough: options.trainedThrough,
      rows: trainRows.length,
      learners: new Set(trainRows.map((r) => String(r.learnerId))).size,
      skills: bySkill.size,
      heldOutLearners: 0,
      thresholds,
      shrinkageK,
      bounds: PARAM_BOUNDS,
      forgetPolicy: FORGET_POLICY,
      emIterations,
      tolerance,
    },
  };
}

/** Resolve the parameters an artifact would serve for a skill. */
export function paramsForSkill(artifact: BktCalibrationArtifact, skillId: string | number): BktSkillParams {
  return artifact.skills[String(skillId)]?.params ?? artifact.global;
}
