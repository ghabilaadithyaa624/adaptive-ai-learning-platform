/**
 * Weight tuner for the v3 adaptive policy.
 *
 * Run with `npm run bench:tune`. Deterministic: same input, same output, no
 * wall clock and no `Math.random`.
 *
 * Pre-registration
 * ----------------
 * Everything below was fixed *before* looking at any tuned result, and is
 * restated in `TUNING_PROVENANCE` so the shipped weights carry their own
 * provenance:
 *
 *   Search    Stage A — deterministic coordinate ascent over a fixed multiplier
 *             grid [0.6, 0.8, 1.0, 1.25, 1.6], objectives visited in
 *             `PRIOR_WEIGHTS` key order, benefit weights renormalised to sum 1
 *             after every accepted move (so only *relative* emphasis moves).
 *
 *             Stage B — coordinate ascent over the three *structural* policy
 *             parameters that weights provably cannot reach, on explicit value
 *             grids: the prerequisite gate, the pessimism (lower-confidence
 *             bound) multiplier applied to it, and the per-skill item cap.
 *             These govern which candidates survive the hard gates, so they —
 *             not any weight — decide the breadth/safety trade-off.
 *
 *             Stages alternate for `TUNING_PASSES` passes.
 *
 *   Budget    TRAIN cells are simulated under a **time** budget, not an item
 *             budget. An item-budgeted objective silently rewards a policy for
 *             picking longer questions: the first tuned vector won +11.7%
 *             mastery gain per item and 0% per minute, because it spent 11%
 *             more of the learner's time to get it. Learner time is the scarce
 *             resource, so that is what the search is denominated in.
 *
 *   Data      TRAIN split only — 4 archetypes × 4 seeds × base world. The
 *             held-out archetypes, the held-out seeds and all perturbed worlds
 *             are never evaluated here. That is the whole point: the adoption
 *             decision in `protocol.ts` must be made on data the search could
 *             not have fitted.
 *
 *   Objective U = 0.6·rel(retained mastery gain)
 *               + 0.4·rel(immediate mastery gain)
 *               − 3·Σ_g max(0, relative regression of guarded metric g − 2%)
 *             where `rel(x)` is the relative improvement over the **v2 policy
 *             on the same cells** (common random numbers ⇒ paired), and the
 *             guarded metrics are the ones in `GUARDRAILS`.
 *
 *             The 0.6/0.4 split puts durable learning ahead of immediate
 *             learning without ignoring it; the ×3 penalty multiplier makes any
 *             guardrail breach cost more than a plausible primary gain, so the
 *             search cannot buy learning with regressions.
 *
 * The tuner prints a patch-ready `TUNED_WEIGHTS` block plus a sensitivity
 * table, and writes the full log to `benchmarks/tuning.json`.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  BENEFIT_OBJECTIVES,
  PENALTY_OBJECTIVES,
  type ObjectiveKey,
  type PolicyParams,
  type PolicyWeights,
} from "@/lib/ml/policy/types";
import { PRIOR_PARAMS, PRIOR_WEIGHTS } from "@/lib/ml/policy/weights";

import { EQUAL_TIME_MINUTES_PER_SESSION } from "./harness";
import { makeV3Policy, v2Policy, type BenchPolicy } from "./policies";
import { GUARDRAILS, trainCells } from "./protocol";
import {
  DEFAULT_PROTOCOL,
  aggregateCells,
  simulateCell,
  type AggregateMetrics,
  type CellSpec,
} from "./simulate";

/** TRAIN cells under the equal-time budget the search is denominated in. */
function tuningCells(): CellSpec[] {
  return trainCells().map((cell) => ({
    ...cell,
    protocol: { ...DEFAULT_PROTOCOL, minutesPerSession: EQUAL_TIME_MINUTES_PER_SESSION },
  }));
}

/* ------------------------------------------------------------------ */
/* Pre-registered search configuration                                 */
/* ------------------------------------------------------------------ */

export const TUNING_GRID = [0.6, 0.8, 1, 1.25, 1.6] as const;
export const TUNING_PASSES = 2;

/**
 * Structural parameters searched in stage B, with the grid each one is allowed
 * to take. Weights cannot reach these: they change *which candidates exist*,
 * not how the survivors are ranked.
 */
export type TunableParamKey = "prereqGate" | "prereqPessimismZ" | "maxPerSkill";

export const PARAM_GRIDS: Record<TunableParamKey, number[]> = {
  // How much true prerequisite mastery the policy insists on before unlocking.
  prereqGate: [0.45, 0.5, 0.55, 0.6],
  // How many posterior SDs of pessimism are applied to that gate. 0 = trust the
  // point estimate (v2's behaviour); larger = wait for firmer evidence.
  prereqPessimismZ: [0, 0.5, 0.75, 1, 1.25],
  // Cap on items per skill per session — the other lever on breadth vs depth.
  maxPerSkill: [3, 4, 5],
};

export const TUNABLE_PARAM_KEYS = Object.keys(PARAM_GRIDS) as TunableParamKey[];

/** Weight on the retained (post-delay) learning gain in the search objective. */
const W_RETAINED = 0.6;
/** Weight on the immediate (end-of-session) learning gain. */
const W_IMMEDIATE = 0.4;
/** Multiplier applied to guardrail breaches. */
const GUARDRAIL_PENALTY = 3;
/** Relative regression tolerated before a guardrail starts costing utility. */
const GUARDRAIL_TOLERANCE = 0.02;

const OBJECTIVE_DESCRIPTION =
  `under a ${EQUAL_TIME_MINUTES_PER_SESSION}-minute-per-session time budget (not an item budget): ` +
  `${W_RETAINED}·rel(retained mastery gain) + ${W_IMMEDIATE}·rel(immediate mastery gain) ` +
  `− ${GUARDRAIL_PENALTY}·Σ max(0, relative regression − ${(GUARDRAIL_TOLERANCE * 100).toFixed(0)}% tolerance) over ` +
  `[${GUARDRAILS.map((g) => g.label).join(", ")}]`;

/* ------------------------------------------------------------------ */
/* Utility                                                             */
/* ------------------------------------------------------------------ */

export interface UtilityBreakdown {
  utility: number;
  retainedGain: number;
  masteryGain: number;
  relRetained: number;
  relImmediate: number;
  penalty: number;
  breaches: { key: string; relative: number; cost: number }[];
}

/** Relative improvement of `value` over `baseline`, sign-aware. */
function relative(value: number, baseline: number, higherIsBetter: boolean): number {
  const denom = Math.abs(baseline);
  if (denom < 1e-9) return value === baseline ? 0 : higherIsBetter ? Math.sign(value - baseline) : Math.sign(baseline - value);
  const raw = (value - baseline) / denom;
  return higherIsBetter ? raw : -raw;
}

export function scoreAgainstBaseline(candidate: AggregateMetrics, baseline: AggregateMetrics): UtilityBreakdown {
  const relRetained = relative(candidate.retainedGain, baseline.retainedGain, true);
  const relImmediate = relative(candidate.masteryGain, baseline.masteryGain, true);

  const breaches: { key: string; relative: number; cost: number }[] = [];
  let penalty = 0;
  for (const guard of GUARDRAILS) {
    const rel = relative(
      candidate[guard.key] as number,
      baseline[guard.key] as number,
      guard.higherIsBetter,
    );
    // `rel` is already oriented so that positive = better.
    const regression = Math.max(0, -rel - GUARDRAIL_TOLERANCE);
    if (regression > 0) {
      const cost = GUARDRAIL_PENALTY * regression;
      penalty += cost;
      breaches.push({ key: guard.key, relative: rel, cost });
    }
  }

  return {
    utility: W_RETAINED * relRetained + W_IMMEDIATE * relImmediate - penalty,
    retainedGain: candidate.retainedGain,
    masteryGain: candidate.masteryGain,
    relRetained,
    relImmediate,
    penalty,
    breaches,
  };
}

/* ------------------------------------------------------------------ */
/* Evaluation                                                          */
/* ------------------------------------------------------------------ */

function evaluate(policy: BenchPolicy, cells: CellSpec[]): AggregateMetrics {
  return aggregateCells(cells.map((cell) => simulateCell(policy, cell)));
}

/** Benefit weights renormalised to sum 1; penalties left on their own scale. */
export function normalizeWeights(weights: PolicyWeights): PolicyWeights {
  const total = BENEFIT_OBJECTIVES.reduce((acc, key) => acc + Math.max(0, weights[key]), 0);
  const out = { ...weights };
  if (total > 1e-9) {
    for (const key of BENEFIT_OBJECTIVES) out[key] = round3(Math.max(0, weights[key]) / total);
  }
  for (const key of PENALTY_OBJECTIVES) out[key] = round3(Math.max(0, weights[key]));
  return out;
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/* ------------------------------------------------------------------ */
/* Coordinate ascent                                                   */
/* ------------------------------------------------------------------ */

export interface TuningStep {
  pass: number;
  stage: "weights" | "params";
  knob: string;
  /** Multiplier for weight moves, absolute value for parameter moves. */
  value: number;
  utility: number;
  accepted: boolean;
}

export type TunedParams = Pick<PolicyParams, TunableParamKey>;

export interface TuningOutcome {
  prior: PolicyWeights;
  tuned: PolicyWeights;
  priorParams: TunedParams;
  tunedParams: TunedParams;
  priorUtility: UtilityBreakdown;
  tunedUtility: UtilityBreakdown;
  baseline: AggregateMetrics;
  priorMetrics: AggregateMetrics;
  tunedMetrics: AggregateMetrics;
  steps: TuningStep[];
  sensitivity: { knob: string; down: number; up: number }[];
  paramProfiles: { knob: TunableParamKey; value: number; utility: number }[];
  evaluations: number;
}

export function tune(options: { verbose?: boolean } = {}): TuningOutcome {
  const cells = tuningCells();
  const baseline = evaluate(v2Policy, cells);
  let evaluations = 1;

  const cache = new Map<string, AggregateMetrics>();
  const evalConfig = (weights: PolicyWeights, params: TunedParams): AggregateMetrics => {
    const key = JSON.stringify([weights, params]);
    const hit = cache.get(key);
    if (hit) return hit;
    const metrics = evaluate(makeV3Policy({ weights, params }), cells);
    cache.set(key, metrics);
    evaluations += 1;
    return metrics;
  };
  const utilityOf = (weights: PolicyWeights, params: TunedParams) =>
    scoreAgainstBaseline(evalConfig(weights, params), baseline);

  const prior = normalizeWeights(PRIOR_WEIGHTS);
  // ALWAYS start from the documented theory prior, never from whatever is
  // currently shipped — otherwise the search would chase its own tail and the
  // provenance recorded in `weights.ts` would not be reproducible.
  const priorParams: TunedParams = {
    prereqGate: PRIOR_PARAMS.prereqGate,
    prereqPessimismZ: PRIOR_PARAMS.prereqPessimismZ,
    maxPerSkill: PRIOR_PARAMS.maxPerSkill,
  };
  const priorMetrics = evalConfig(prior, priorParams);
  const priorUtility = scoreAgainstBaseline(priorMetrics, baseline);

  let currentWeights = prior;
  let currentParams = priorParams;
  let currentUtility = priorUtility.utility;
  const steps: TuningStep[] = [];

  const log = (msg: string) => {
    if (options.verbose) process.stdout.write(`${msg}\n`);
  };

  const tunableWeights: ObjectiveKey[] = [...BENEFIT_OBJECTIVES, ...PENALTY_OBJECTIVES];

  for (let pass = 1; pass <= TUNING_PASSES; pass += 1) {
    /* ---------------- Stage A: relative emphasis (weights) ---------------- */
    for (const objective of tunableWeights) {
      let bestWeights = currentWeights;
      let bestUtility = currentUtility;
      let bestMultiplier = 1;

      for (const multiplier of TUNING_GRID) {
        if (multiplier === 1) continue;
        const proposal = normalizeWeights({
          ...currentWeights,
          [objective]: currentWeights[objective] * multiplier,
        });
        const utility = utilityOf(proposal, currentParams).utility;
        steps.push({ pass, stage: "weights", knob: objective, value: multiplier, utility: round4(utility), accepted: false });
        // Strict improvement only — ties keep the incumbent, which keeps the
        // result stable and closer to the theory prior.
        if (utility > bestUtility + 1e-6) {
          bestUtility = utility;
          bestWeights = proposal;
          bestMultiplier = multiplier;
        }
      }

      if (bestMultiplier !== 1) {
        const accepted = steps.find(
          (s) => s.pass === pass && s.stage === "weights" && s.knob === objective && s.value === bestMultiplier,
        );
        if (accepted) accepted.accepted = true;
        currentWeights = bestWeights;
        currentUtility = bestUtility;
      }
      log(`pass ${pass} W ${objective.padEnd(26)} ×${bestMultiplier.toFixed(2)} → U=${currentUtility.toFixed(4)}`);
    }

    /* ---------------- Stage B: structural gate parameters ----------------- */
    for (const knob of TUNABLE_PARAM_KEYS) {
      let bestParams = currentParams;
      let bestUtility = currentUtility;
      let bestValue = currentParams[knob];

      for (const value of PARAM_GRIDS[knob]) {
        if (value === currentParams[knob]) continue;
        const proposal = { ...currentParams, [knob]: value };
        const utility = utilityOf(currentWeights, proposal).utility;
        steps.push({ pass, stage: "params", knob, value, utility: round4(utility), accepted: false });
        if (utility > bestUtility + 1e-6) {
          bestUtility = utility;
          bestParams = proposal;
          bestValue = value;
        }
      }

      if (bestValue !== currentParams[knob]) {
        const accepted = steps.find(
          (s) => s.pass === pass && s.stage === "params" && s.knob === knob && s.value === bestValue,
        );
        if (accepted) accepted.accepted = true;
        currentParams = bestParams;
        currentUtility = bestUtility;
      }
      log(`pass ${pass} P ${knob.padEnd(26)} =${String(bestValue).padStart(5)} → U=${currentUtility.toFixed(4)}`);
    }
  }

  const tunedMetrics = evalConfig(currentWeights, currentParams);
  const tunedUtility = scoreAgainstBaseline(tunedMetrics, baseline);

  // ±25% sensitivity around the final vector: how much utility moves when a
  // single weight is perturbed. A weight the objective barely reacts to is a
  // weight nobody should agonise over.
  const sensitivity = tunableWeights.map((objective) => ({
    knob: objective as string,
    down: round4(
      utilityOf(
        normalizeWeights({ ...currentWeights, [objective]: currentWeights[objective] * 0.75 }),
        currentParams,
      ).utility - tunedUtility.utility,
    ),
    up: round4(
      utilityOf(
        normalizeWeights({ ...currentWeights, [objective]: currentWeights[objective] * 1.25 }),
        currentParams,
      ).utility - tunedUtility.utility,
    ),
  }));

  // Full utility profile of every structural parameter value, so the report can
  // show *why* the chosen gate wins rather than just asserting it.
  const paramProfiles: { knob: TunableParamKey; value: number; utility: number }[] = [];
  for (const knob of TUNABLE_PARAM_KEYS) {
    for (const value of PARAM_GRIDS[knob]) {
      paramProfiles.push({
        knob,
        value,
        utility: round4(utilityOf(currentWeights, { ...currentParams, [knob]: value }).utility),
      });
    }
  }

  return {
    prior,
    tuned: currentWeights,
    priorParams,
    tunedParams: currentParams,
    priorUtility,
    tunedUtility,
    baseline,
    priorMetrics,
    tunedMetrics,
    steps,
    sensitivity,
    paramProfiles,
    evaluations,
  };
}

const round4 = (x: number) => Math.round(x * 10000) / 10000;

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function formatWeightsBlock(weights: PolicyWeights): string {
  const lines = [...BENEFIT_OBJECTIVES, ...PENALTY_OBJECTIVES].map(
    (key) => `  ${key}: ${weights[key]},`,
  );
  return `export const TUNED_WEIGHTS: PolicyWeights = {\n${lines.join("\n")}\n};`;
}

function main(): void {
  const started = Date.now();
  const outcome = tune({ verbose: true });

  const lines: string[] = [];
  lines.push("");
  lines.push("=".repeat(78));
  lines.push("v3 weight + parameter tuning — TRAIN split only");
  lines.push("=".repeat(78));
  lines.push(`objective : ${OBJECTIVE_DESCRIPTION}`);
  lines.push(`cells     : ${tuningCells().length}   evaluations: ${outcome.evaluations}`);
  lines.push("");
  const summarise = (label: string, u: UtilityBreakdown) =>
    `${label} ${u.utility.toFixed(4)}  (retained ${(u.relRetained * 100).toFixed(2)}%, ` +
    `immediate ${(u.relImmediate * 100).toFixed(2)}%, penalty ${u.penalty.toFixed(4)})`;
  lines.push(summarise("prior utility", outcome.priorUtility));
  lines.push(summarise("tuned utility", outcome.tunedUtility));
  for (const b of outcome.tunedUtility.breaches) {
    lines.push(`  ! guardrail ${b.key}: ${(b.relative * 100).toFixed(2)}% (cost ${b.cost.toFixed(4)})`);
  }
  lines.push("");
  lines.push("weight                       prior →  tuned");
  for (const key of [...BENEFIT_OBJECTIVES, ...PENALTY_OBJECTIVES]) {
    const delta = outcome.tuned[key] - outcome.prior[key];
    lines.push(
      `  ${key.padEnd(26)} ${outcome.prior[key].toFixed(3)} → ${outcome.tuned[key].toFixed(3)}  ` +
        `(${delta >= 0 ? "+" : ""}${delta.toFixed(3)})`,
    );
  }
  lines.push("");
  lines.push("parameter                    prior →  tuned");
  for (const key of TUNABLE_PARAM_KEYS) {
    lines.push(`  ${key.padEnd(26)} ${String(outcome.priorParams[key]).padStart(5)} → ${String(outcome.tunedParams[key]).padStart(5)}`);
  }
  lines.push("");
  lines.push("structural parameter utility profile (all other knobs at their tuned value)");
  for (const knob of TUNABLE_PARAM_KEYS) {
    const row = outcome.paramProfiles
      .filter((p) => p.knob === knob)
      .map((p) => `${p.value}: ${p.utility.toFixed(4)}${p.value === outcome.tunedParams[knob] ? "*" : " "}`)
      .join("   ");
    lines.push(`  ${knob.padEnd(26)} ${row}`);
  }
  lines.push("");
  lines.push("weight sensitivity (ΔU when a single weight moves ±25%)");
  for (const s of outcome.sensitivity) {
    lines.push(`  ${s.knob.padEnd(26)} −25%: ${s.down.toFixed(4)}   +25%: ${s.up.toFixed(4)}`);
  }
  lines.push("");
  lines.push("Patch src/lib/ml/policy/weights.ts with:");
  lines.push("");
  lines.push(formatWeightsBlock(outcome.tuned));
  lines.push("");
  for (const key of TUNABLE_PARAM_KEYS) lines.push(`  ${key}: ${outcome.tunedParams[key]},`);
  lines.push(`  priorUtility: ${round4(outcome.priorUtility.utility)},`);
  lines.push(`  tunedUtility: ${round4(outcome.tunedUtility.utility)},`);
  lines.push("");
  process.stdout.write(lines.join("\n"));

  const payload = {
    schema: "adaptive.tuning.v1",
    objective: OBJECTIVE_DESCRIPTION,
    weightGrid: TUNING_GRID,
    paramGrids: PARAM_GRIDS,
    passes: TUNING_PASSES,
    trainCells: tuningCells().length,
    evaluations: outcome.evaluations,
    durationMs: Date.now() - started,
    prior: outcome.prior,
    tuned: outcome.tuned,
    priorParams: outcome.priorParams,
    tunedParams: outcome.tunedParams,
    priorUtility: outcome.priorUtility,
    tunedUtility: outcome.tunedUtility,
    baselineMetrics: outcome.baseline,
    priorMetrics: outcome.priorMetrics,
    tunedMetrics: outcome.tunedMetrics,
    sensitivity: outcome.sensitivity,
    paramProfiles: outcome.paramProfiles,
    steps: outcome.steps,
  };
  const target = join(process.cwd(), "benchmarks", "tuning.json");
  writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  process.stdout.write(`\nwrote ${target}\n`);
}

if (require.main === module) main();
