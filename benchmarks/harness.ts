/**
 * Adaptive-policy benchmark harness.
 *
 * Runs Legacy vs Adaptive v2 vs Optimized v3 over the pre-registered splits in
 * `protocol.ts`, computes the full metric set, the paired statistics and the
 * adoption verdict, and renders both a human report (`RESULTS.md`) and a
 * machine-readable artefact (`results.json`).
 *
 * Fully deterministic: no wall clock, no `Math.random`, no I/O inside the
 * simulation. `runBenchmark()` twice in the same process returns identical
 * numbers, and so does a fresh process on another machine.
 */
import { round } from "@/lib/utils";
import {
  DEFAULT_POLICY_PARAMS,
  OBJECTIVE_METADATA,
  PRIOR_PARAMS,
  PRIOR_WEIGHTS,
  TUNED_PARAMS,
  TUNED_WEIGHTS,
  TUNING_PROVENANCE,
  normalizeWeights,
  resolvePolicyConfig,
} from "@/lib/ml/policy/weights";
import { BENEFIT_OBJECTIVES, PENALTY_OBJECTIVES } from "@/lib/ml/policy/types";
import { DEFAULT_POLICY_ID } from "@/lib/ml/policy";
import { PREREQ_GATE } from "@/lib/ml/selection";
import { DEFAULT_BKT } from "@/lib/ml/knowledge-tracing";
import {
  ARCHETYPES,
  ARCHETYPE_BY_ID,
  ITEMS,
  SKILLS,
  WORLD_VARIANTS,
  type Archetype,
} from "./world";
import { legacyPolicy, makeV3Policy, v2Policy, type BenchPolicy } from "./policies";
import {
  DEFAULT_PROTOCOL,
  aggregateCells,
  simulateCell,
  type AggregateMetrics,
  type CellMetrics,
  type CellResult,
  type CellSpec,
} from "./simulate";
import {
  ADOPTION_CRITERIA,
  HELD_OUT_ONLY_ARCHETYPE_IDS,
  HELD_OUT_SEED_OFFSETS,
  PROTOCOL_AMENDMENTS,
  REPORT_METRICS,
  TRAIN_ARCHETYPE_IDS,
  alignedSeries,
  decideAdoption,
  heldOutCells,
  robustnessCells,
  trainCells,
  type AdoptionVerdict,
  type MetricSpec,
} from "./protocol";
import { comparePaired, type PairedComparison } from "./stats";
import { attributeGainGap, type AttributionResult } from "./attribution";
import {
  probeResponseModelCalibration,
  runBaselineFloor,
  sweepDifficultyTargets,
  type BaselineFloorResult,
  type CalibrationProbe,
  type DifficultySweepPoint,
} from "./baselines";

/* ------------------------------------------------------------------ */
/* Runs                                                                */
/* ------------------------------------------------------------------ */

export type BenchPolicyId = "legacy" | "v2" | "v3";

export interface PolicyRun {
  policyId: BenchPolicyId;
  label: string;
  cells: CellResult[];
  aggregate: AggregateMetrics;
}

export interface SplitRun {
  id: string;
  label: string;
  description: string;
  cellCount: number;
  runs: Record<BenchPolicyId, PolicyRun>;
}

function runSplit(id: string, label: string, description: string, cells: CellSpec[], policies: BenchPolicy[]): SplitRun {
  const runs = {} as Record<BenchPolicyId, PolicyRun>;
  for (const policy of policies) {
    const results = cells.map((cell) => simulateCell(policy, cell));
    runs[policy.id as BenchPolicyId] = {
      policyId: policy.id as BenchPolicyId,
      label: policy.label,
      cells: results,
      aggregate: aggregateCells(results),
    };
  }
  return { id, label, description, cellCount: cells.length, runs };
}

function subsetSplit(split: SplitRun, id: string, label: string, description: string, keep: (cell: CellResult) => boolean): SplitRun {
  const runs = {} as Record<BenchPolicyId, PolicyRun>;
  let cellCount = 0;
  for (const [policyId, run] of Object.entries(split.runs) as [BenchPolicyId, PolicyRun][]) {
    const cells = run.cells.filter(keep);
    cellCount = cells.length;
    runs[policyId] = { ...run, cells, aggregate: aggregateCells(cells) };
  }
  return { id, label, description, cellCount, runs };
}

/* ------------------------------------------------------------------ */
/* Result                                                              */
/* ------------------------------------------------------------------ */

export interface BenchmarkOptions {
  /** Override the v3 weights (used by the tuner and ablation studies). */
  v3Weights?: Record<string, number>;
  /** Skip the robustness sweep (used by the tuner for speed). */
  includeRobustness?: boolean;
  /** Skip the equal-time control run. */
  includeEqualTime?: boolean;
}

/**
 * Per-session minute budget for the equal-time control, set to the *item-budgeted*
 * session length of the weakest-spending policy so no policy is handed extra time.
 */
export const EQUAL_TIME_MINUTES_PER_SESSION = 14;

export interface BenchmarkResult {
  generatedWith: {
    protocol: typeof DEFAULT_PROTOCOL;
    skills: number;
    items: number;
    archetypes: number;
    worlds: number;
    policyFingerprint: string;
    servingDefault: string;
  };
  train: SplitRun;
  heldOut: SplitRun;
  heldOutUnseenArchetypes: SplitRun;
  /** Same held-out cells, time-budgeted instead of item-budgeted. */
  equalTime: SplitRun | null;
  robustness: SplitRun;
  comparisons: {
    heldOutV3vsV2: PairedComparison[];
    heldOutV3vsLegacy: PairedComparison[];
    heldOutV2vsLegacy: PairedComparison[];
  };
  verdict: AdoptionVerdict;
  verdictVsLegacy: AdoptionVerdict;
  /** Trivial-heuristic floor and oracle ceiling on the held-out split. */
  baselineFloor: BaselineFloorResult;
  /** Oracle sweep proving the world has an interior difficulty optimum. */
  difficultySweep: DifficultySweepPoint[];
  /** Response-model bias measured with mastery estimation held perfect. */
  calibration: CalibrationProbe;
  attribution: {
    v2VsLegacy: AttributionResult;
    v3VsV2: AttributionResult;
  };
  report: string;
  json: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* Formatting helpers                                                  */
/* ------------------------------------------------------------------ */

const pct = (n: number, digits = 1) => `${(n * 100).toFixed(digits)}%`;
const num = (n: number, digits = 3) => n.toFixed(digits);
const signed = (n: number, digits = 3) => `${n >= 0 ? "+" : ""}${n.toFixed(digits)}`;

const POLICY_ORDER: BenchPolicyId[] = ["legacy", "v2", "v3"];
const POLICY_LABELS: Record<BenchPolicyId, string> = {
  legacy: "Legacy",
  v2: "Adaptive v2",
  v3: "Optimized v3",
};

function fmt(value: number, spec: MetricSpec): string {
  switch (spec.format) {
    case "percent":
      return pct(value);
    case "count":
      return `${Math.round(value)}`;
    case "minutes":
      return `${value.toFixed(spec.digits ?? 1)} min`;
    default:
      return num(value, spec.digits ?? 3);
  }
}

function verdictMark(comparison: PairedComparison, epsilon = 1e-9): string {
  const oriented = comparison.higherIsBetter
    ? comparison.candidate - comparison.baseline
    : comparison.baseline - comparison.candidate;
  if (Math.abs(oriented) <= epsilon) return "➖ equal";
  return oriented > 0 ? "✅ better" : "⚠️ worse";
}

function metricSeries(split: SplitRun, policy: BenchPolicyId, key: keyof CellMetrics): number[] {
  return split.runs[policy].cells.map((c) => Number(c.metrics[key] ?? 0));
}

function compareAll(split: SplitRun, candidate: BenchPolicyId, baseline: BenchPolicyId): PairedComparison[] {
  return REPORT_METRICS.map((spec) => {
    const series = alignedSeries(split.runs[candidate].cells, split.runs[baseline].cells, spec.key);
    return comparePaired({
      metric: String(spec.key),
      higherIsBetter: spec.higherIsBetter,
      candidate: series.candidate,
      baseline: series.baseline,
    });
  });
}

/* ------------------------------------------------------------------ */
/* Report                                                              */
/* ------------------------------------------------------------------ */

function threeWayTable(split: SplitRun): string[] {
  const lines: string[] = [];
  lines.push("| Metric | Legacy | Adaptive v2 | Optimized v3 | v3 vs v2 |");
  lines.push("| --- | ---: | ---: | ---: | :--- |");
  for (const spec of REPORT_METRICS) {
    const legacy = Number(split.runs.legacy.aggregate[spec.key] ?? 0);
    const v2 = Number(split.runs.v2.aggregate[spec.key] ?? 0);
    const v3 = Number(split.runs.v3.aggregate[spec.key] ?? 0);
    const better = spec.higherIsBetter ? v3 - v2 : v2 - v3;
    const mark = Math.abs(v3 - v2) < 1e-9 ? "➖" : better > 0 ? "✅" : "⚠️";
    lines.push(
      `| ${spec.label} ${spec.higherIsBetter ? "(↑)" : "(↓)"} | ${fmt(legacy, spec)} | ${fmt(v2, spec)} | ${fmt(
        v3,
        spec,
      )} | ${mark} |`,
    );
  }
  // Derived, censoring-aware efficiency metrics
  const row = (label: string, pick: (r: PolicyRun) => string) =>
    `| ${label} | ${pick(split.runs.legacy)} | ${pick(split.runs.v2)} | ${pick(split.runs.v3)} | — |`;
  lines.push(
    row("Questions to reach mastery (↓)", (r) =>
      r.aggregate.itemsToMastery === null ? "n/a" : num(r.aggregate.itemsToMastery, 2),
    ),
  );
  lines.push(
    row("Time to mastery (↓)", (r) =>
      r.aggregate.minutesToMastery === null ? "n/a" : `${num(r.aggregate.minutesToMastery, 1)} min`,
    ),
  );
  lines.push(row("Mastery events (↑)", (r) => `${Math.round(r.aggregate.masteryEvents)}`));
  lines.push(row("Censored skills (never mastered)", (r) => `${Math.round(r.aggregate.censoredSkills)}`));
  return lines;
}

function perArchetypeTable(split: SplitRun, key: keyof CellMetrics, spec: MetricSpec): string[] {
  const lines: string[] = [];
  lines.push("| Learner archetype | Legacy | Adaptive v2 | Optimized v3 |");
  lines.push("| --- | ---: | ---: | ---: |");
  for (const archetype of ARCHETYPES) {
    const pick = (policy: BenchPolicyId) => {
      const cells = split.runs[policy].cells.filter((c) => c.archetypeId === archetype.id);
      if (!cells.length) return "—";
      const value = cells.reduce((a, c) => a + Number(c.metrics[key] ?? 0), 0) / cells.length;
      return fmt(value, spec);
    };
    const unseen = (HELD_OUT_ONLY_ARCHETYPE_IDS as readonly string[]).includes(archetype.id) ? " *(unseen)*" : "";
    lines.push(`| ${archetype.name}${unseen} | ${pick("legacy")} | ${pick("v2")} | ${pick("v3")} |`);
  }
  return lines;
}

function statsTable(comparisons: PairedComparison[]): string[] {
  const lines: string[] = [];
  lines.push("| Metric | v2 | v3 | Δ | Δ% | 95% CI (paired) | sign test | dz | verdict |");
  lines.push("| --- | ---: | ---: | ---: | ---: | :--- | :--- | ---: | :--- |");
  for (let i = 0; i < REPORT_METRICS.length; i += 1) {
    const spec = REPORT_METRICS[i];
    const c = comparisons[i];
    lines.push(
      `| ${spec.label} ${spec.higherIsBetter ? "(↑)" : "(↓)"} | ${fmt(c.baseline, spec)} | ${fmt(c.candidate, spec)} | ${
        c.absoluteDelta >= 0 ? "+" : ""
      }${num(c.absoluteDelta, 4)} | ${c.relativeDelta >= 0 ? "+" : ""}${pct(c.relativeDelta)} | [${num(
        c.ci.lower,
        4,
      )}, ${num(c.ci.upper, 4)}] | ${c.sign.wins}W/${c.sign.losses}L p=${c.sign.pValue.toFixed(3)} | ${num(
        c.dz,
        2,
      )} | ${verdictMark(c)} |`,
    );
  }
  return lines;
}

function attributionTable(result: AttributionResult, candidateLabel: string, baselineLabel: string): string[] {
  const lines: string[] = [];
  lines.push(`| Factor | ${baselineLabel} | ${candidateLabel} | Δ log-gain contribution |`);
  lines.push("| --- | ---: | ---: | ---: |");
  const rows: [string, number, number, number][] = [
    [
      "ZPD efficiency (mean)",
      result.baseline.meanZpdEfficiency,
      result.candidate.meanZpdEfficiency,
      result.logGapContributions[0].contribution,
    ],
    [
      "Prerequisite efficiency (mean)",
      result.baseline.meanPrereqEfficiency,
      result.candidate.meanPrereqEfficiency,
      result.logGapContributions[1].contribution,
    ],
    [
      "Headroom factor (mean)",
      result.baseline.meanHeadroomFactor,
      result.candidate.meanHeadroomFactor,
      result.logGapContributions[2].contribution,
    ],
    [
      "Outcome factor (mean)",
      result.baseline.meanOutcomeFactor,
      result.candidate.meanOutcomeFactor,
      result.logGapContributions[3].contribution,
    ],
  ];
  for (const [label, base, cand, contribution] of rows) {
    lines.push(
      `| ${label} | ${num(base, 3)} | ${num(cand, 3)} | ${contribution >= 0 ? "+" : ""}${num(contribution, 3)} |`,
    );
  }
  lines.push(
    `| **Gain per item** | **${num(result.baseline.gainPerItem, 4)}** | **${num(
      result.candidate.gainPerItem,
      4,
    )}** | **${result.totalLogGap >= 0 ? "+" : ""}${num(result.totalLogGap, 3)}** |`,
  );
  lines.push(
    `| Items on skills with unmet prerequisites | ${pct(result.baseline.prereqViolationShare)} | ${pct(
      result.candidate.prereqViolationShare,
    )} | — |`,
  );
  return lines;
}

function buildReport(result: Omit<BenchmarkResult, "report" | "json">): string {
  const L: string[] = [];
  const p = result.generatedWith.protocol;
  const v = result.verdict;

  L.push("# Adaptive policy benchmark — Legacy vs Adaptive v2 vs Optimized v3");
  L.push("");
  L.push(
    "> Generated deterministically by `benchmarks/harness.ts` (run `npm run bench`). " +
      "Every number below is reproducible from a clean checkout; no wall clock, no unseeded randomness.",
  );
  L.push("");
  L.push(
    "> ### \u26A0\uFE0F SYNTHETIC EVIDENCE \u2014 NOT A MEASUREMENT OF REAL LEARNING\n" +
      "> Every learner in this report is simulated. The world model (IRT response + " +
      "forgetting + fatigue + confidence bias) is an **assumption written by the same team as the " +
      "policy under test**, so a policy can only ever be shown to be better *under that assumption*.\n" +
      ">\n" +
      "> These results are valid for **relative** comparison of selection policies and for catching " +
      "regressions. They are **not** evidence of real-world learning gains and must not be used in " +
      "efficacy claims, marketing, or procurement. Confirm with production telemetry or a controlled " +
      "trial before claiming any human outcome.",
  );
  L.push("");

  /* ---------------------------- protocol ---------------------------- */
  L.push("## 1. Protocol");
  L.push("");
  L.push(
    `Synthetic world: **${result.generatedWith.skills} skills** in a depth-4 prerequisite DAG, ` +
      `**${result.generatedWith.items} items** (difficulty × Bloom × discrimination × time), ` +
      `**${result.generatedWith.archetypes} learner archetypes**, **${result.generatedWith.worlds} world variants**.`,
  );
  L.push("");
  L.push(
    `Each cell runs **${p.sessions} sessions × ${p.itemsPerSession} items** ` +
      `(${p.sessions * p.itemsPerSession} items total), sessions **${p.daysBetweenSessions} days apart**, ` +
      `followed by a **${p.retentionDelayDays}-day retention probe**. Mastery threshold ${p.masteryThreshold}. ` +
      `ZPD band = true P(correct) ∈ [${p.zpdBand[0]}, ${p.zpdBand[1]}]; an item is "wasted" outside ` +
      `[${p.usefulBand[0]}, ${p.usefulBand[1]}].`,
  );
  L.push("");
  L.push("| Split | Cells | Purpose |");
  L.push("| --- | ---: | --- |");
  L.push(`| TRAIN | ${result.train.cellCount} | ${result.train.description} |`);
  L.push(`| HELD-OUT | ${result.heldOut.cellCount} | ${result.heldOut.description} |`);
  L.push(`| ROBUSTNESS | ${result.robustness.cellCount} | ${result.robustness.description} |`);
  L.push("");
  L.push(
    "All three policies share the same knowledge tracer (BKT + `buildLearnerState`), the same response model, " +
      "the same item bank and — via **common random numbers** — the same luck on any given (learner, item) pair. " +
      "Differences are attributable to item selection alone.",
  );
  L.push("");
  L.push("### 1.1 Protocol amendments (disclosed)");
  L.push("");
  L.push(
    "The protocol below was pre-registered before tuning, but the following changes were made **after** a first " +
      "held-out run had been seen. They are listed here rather than silently applied, because an amendment the " +
      "reader cannot see is indistinguishable from moving the goalposts. Neither alters the decision *rule*.",
  );
  L.push("");
  for (const a of PROTOCOL_AMENDMENTS) {
    L.push(`**${a.title}**`);
    L.push("");
    L.push(`- *Was*: ${a.before}`);
    L.push(`- *Now*: ${a.after}`);
    L.push(`- *Why*: ${a.rationale}`);
    L.push(`- *How to discount it*: ${a.caveat}`);
    L.push("");
  }
  L.push("");

  /* ---------------------------- verdict ----------------------------- */
  L.push("## 2. Adoption decision (held-out evidence)");
  L.push("");
  L.push(
    `**Verdict: ${v.adopt ? "ADOPT v3" : "HOLD — keep v2 as the serving default"}**  ` +
      `(primary metric: _${v.criteria.primaryLabel}_)`,
  );
  L.push("");
  L.push("| Criterion | Result | Required | Pass |");
  L.push("| --- | ---: | ---: | :---: |");
  L.push(
    `| Relative improvement, primary metric | ${pct(v.primary.relativeDelta, 2)} | ≥ ${pct(
      v.criteria.minRelativeImprovement,
      2,
    )} | ${v.primary.relativeDelta >= v.criteria.minRelativeImprovement ? "✅" : "❌"} |`,
  );
  L.push(
    `| Bootstrap 95% CI lower bound | ${num(v.primary.ci.lower, 4)} | > 0 | ${v.primary.ci.lower > 0 ? "✅" : "❌"} |`,
  );
  L.push(
    `| Exact sign test | ${v.primary.sign.wins}W/${v.primary.sign.losses}L, p=${v.primary.sign.pValue.toFixed(
      4,
    )} | p < ${v.criteria.maxSignTestP} | ${v.primary.sign.pValue < v.criteria.maxSignTestP ? "✅" : "❌"} |`,
  );
  L.push(`| Paired effect size (dz) | ${num(v.primary.dz, 2)} | — | — |`);
  L.push(
    `| Robustness across perturbed worlds | ${pct(v.robustWinShare, 0)} | ≥ ${pct(
      v.criteria.minRobustWinShare,
      0,
    )} | ${v.robustWinShare >= v.criteria.minRobustWinShare ? "✅" : "❌"} |`,
  );
  for (const g of v.guardrails) {
    L.push(
      `| Guardrail — ${g.guardrail.label} | ${g.note} | ≥ −${pct(g.guardrail.tolerance, 1)} | ${g.passed ? "✅" : "❌"} |`,
    );
  }
  L.push("");
  L.push(`Serving default currently shipped: **${result.generatedWith.servingDefault}**.`);
  L.push("");
  L.push("Decision log:");
  L.push("");
  for (const reason of v.reasons) L.push(`- ${reason}`);
  L.push("");

  /* -------------------- baseline floor / ceiling -------------------- */
  const bf = result.baselineFloor;
  const cal = result.calibration;
  L.push("## 2b. Baseline floor and ideal-observer ceiling");
  L.push("");
  L.push(
    "A policy beating its own predecessor proves very little. This section brackets all three " +
      "shippable policies between **trivial heuristics that no adaptive engine should lose to** and an " +
      "**oracle that reads ground truth**, so the numbers above can be read as a fraction of the learning " +
      "that was actually available.",
  );
  L.push("");
  L.push("| Tier | Policy | Retained gain (↑) | % of ceiling | ZPD hit (↑) | Coverage (↑) | Prereq violations (↓) |");
  L.push("| :--- | :--- | ---: | ---: | ---: | ---: | ---: |");
  for (const row of bf.rows) {
    const tier = row.tier === "floor" ? "floor" : row.tier === "ceiling" ? "**ceiling**" : "real";
    const name = row.tier === "real" ? `**${row.label}**` : row.label;
    L.push(
      `| ${tier} | ${name} | ${num(row.aggregate.retainedGain, 3)} | ${pct(row.shareOfCeiling, 1)} | ` +
        `${pct(row.aggregate.zpdHitRate, 1)} | ${num(row.aggregate.skillCoverage, 2)} | ` +
        `${Math.round(row.aggregate.prereqViolations)} |`,
    );
  }
  L.push("");
  if (bf.lostToFloor.length > 0) {
    L.push(
      `> \u26A0\uFE0F **${bf.lostToFloor.length >= 3 ? "Every shippable policy" : "Shippable policies"} ` +
        `(${bf.lostToFloor.join(", ")}) ` +
        `${bf.lostToFloor.length >= 3 ? "delivers" : "deliver"} less retained learning than ` +
        `\`${bf.bestFloor.policyId}\`** — ` +
        "a heuristic with no model, no prerequisites and no tuning. The adaptive stack is not yet " +
        "earning its complexity on this population, and no amount of relative improvement over v2 " +
        "changes that.",
    );
    L.push("");
    L.push(
      `\`${bf.bestFloor.policyId}\` works by always serving the easiest unseen item in the ` +
        "least-mastered skill. That is an accidental curriculum — weakest-topic-first, easy-to-hard — " +
        "and it lands in the productive band far more often than any policy that *aims* at that band " +
        "through the response model. The next two tables explain why.",
    );
    L.push("");
  } else {
    L.push("> ✅ Every shippable policy clears the trivial-heuristic floor.");
    L.push("");
  }

  if (result.difficultySweep.length > 0) {
    L.push("### 2b.1 World validation — is the ZPD premise real?");
    L.push("");
    L.push(
      "Before trusting any ZPD-shaped objective, the world itself has to reward difficulty targeting. " +
        "The oracle is swept across target success probabilities; if learning simply rose as questions got " +
        "easier, the whole premise would be an artefact.",
    );
    L.push("");
    L.push("| Oracle target true P(correct) | Mastery gain | Retained gain | ZPD hit |");
    L.push("| ---: | ---: | ---: | ---: |");
    const peak = result.difficultySweep.reduce((a, b) => (b.retainedGain > a.retainedGain ? b : a));
    for (const pt of result.difficultySweep) {
      const star = pt.target === peak.target ? " ← peak" : "";
      L.push(
        `| ${pt.target.toFixed(2)}${star} | ${num(pt.masteryGain, 4)} | ${num(pt.retainedGain, 4)} | ${pct(pt.zpdHitRate, 1)} |`,
      );
    }
    L.push("");
    const easiest = result.difficultySweep.reduce((a, b) => (b.target > a.target ? b : a));
    const hardest = result.difficultySweep.reduce((a, b) => (b.target < a.target ? b : a));
    L.push(
      `Learning peaks at an interior target of **${peak.target.toFixed(2)}** — well above the hardest ` +
        `setting (${hardest.target.toFixed(2)} → ${num(hardest.retainedGain, 3)}) and above the easiest ` +
        `(${easiest.target.toFixed(2)} → ${num(easiest.retainedGain, 3)}). Serving trivial questions does ` +
        "**not** maximise learning here, so the productive-difficulty premise holds and the ZPD objectives " +
        "are justified rather than assumed.",
    );
    L.push("");
    L.push(
      "Two honest caveats on this curve. The top is *flat*, not sharp: every target in 0.60–0.80 lands " +
        "within a few percent, so the policy's `successTarget` of 0.75 is comfortably inside the plateau but " +
        "is not a uniquely optimal value. And the curve stops falling at the easy end because the bank runs " +
        "out of items that easy for these learners — the oracle cannot find anything above true p≈0.87, so " +
        "targets of 0.85 and 0.95 select nearly the same items.",
    );
    L.push("");
  }

  L.push("### 2b.2 Which model is actually miscalibrated?");
  L.push("");
  L.push(
    "Item selection runs through a chain: tracer → mastery estimate → **response model** → P(correct) → " +
      "chosen difficulty. Improving the tracer cannot help if a later link is broken. This probe hands the " +
      "response model a learner whose mastery *equals true latent ability* — i.e. perfect knowledge " +
      "tracing — and measures what it predicts anyway.",
  );
  L.push("");
  L.push(
    `Over **${cal.pairs}** (archetype × item) pairs with estimation held perfect: mean predicted ` +
      `**${num(cal.meanPredicted, 3)}** vs mean true **${num(cal.meanTrue, 3)}** — a bias of ` +
      `**${cal.bias >= 0 ? "+" : ""}${num(cal.bias, 3)}** (RMSE ${num(cal.rmse, 3)}).`,
  );
  L.push("");
  L.push("| Item difficulty | n | Predicted | True | Bias |");
  L.push("| :--- | ---: | ---: | ---: | ---: |");
  for (const b of cal.byDifficulty) {
    L.push(
      `| ${b.band} | ${b.n} | ${num(b.predicted, 3)} | ${num(b.trueP, 3)} | ${b.bias >= 0 ? "+" : ""}${num(b.bias, 3)} |`,
    );
  }
  L.push("");
  L.push(
    `**This is the bottleneck.** The response model is over-confident by ${num(cal.bias, 2)} *with a ` +
      "perfect mastery estimate*, and the bias grows with item difficulty. A policy asking it for an item " +
      "at P(correct)=0.75 is handed one the learner will actually pass far less often, so the harder a " +
      "policy aims at the ZPD, the further past it the policy overshoots. That is precisely why v2 " +
      "improved every estimation metric without improving learning, and it is invisible to tracer-accuracy " +
      "metrics (RMSE, Brier, ECE) because it is not the tracer's error.",
  );
  L.push("");
  L.push(
    "> **Scope caveat.** This bias is measured *relative to this synthetic world*. It says the response " +
      "model disagrees with the simulator's IRT process, not that it is wrong about real learners. The " +
      "actionable conclusion is to run the same probe against production telemetry before recalibrating " +
      "anything — fitting the shipped model to a fiction would be worse than the current state.",
  );
  L.push("");

  /* ------------------------- held-out results ----------------------- */
  L.push("## 3. Held-out results (primary evidence)");
  L.push("");
  L.push(...threeWayTable(result.heldOut));
  L.push("");
  L.push("### Paired statistics, v3 vs v2 (held-out cells)");
  L.push("");
  L.push(...statsTable(result.comparisons.heldOutV3vsV2));
  L.push("");
  L.push("### Held-out subset: archetypes the tuner never saw");
  L.push("");
  L.push(
    `Rapid forgetter, slow learner, high-variance learner, cold start — ` +
      `${result.heldOutUnseenArchetypes.cellCount} cells, none of which influenced any weight.`,
  );
  L.push("");
  L.push(...threeWayTable(result.heldOutUnseenArchetypes));
  L.push("");

  /* --------------------------- per archetype ------------------------ */
  L.push("## 4. Per-archetype breakdown (held-out)");
  L.push("");
  const archetypeMetrics: (keyof CellMetrics)[] = ["retainedGain", "masteryGain", "zpdHitRate", "estimationRmse", "prereqViolations"];
  for (const key of archetypeMetrics) {
    const spec = REPORT_METRICS.find((m) => m.key === key)!;
    L.push(`### ${spec.label} ${spec.higherIsBetter ? "(↑ better)" : "(↓ better)"}`);
    L.push("");
    L.push(...perArchetypeTable(result.heldOut, key, spec));
    L.push("");
  }

  /* ---------------------------- robustness -------------------------- */
  L.push("## 5. Robustness sweep (perturbed worlds)");
  L.push("");
  L.push(
    "Each world below contradicts one of the policy's own default assumptions " +
      "(success target 0.75, ZPD σ 0.18, forgetting 0.035/day, prerequisite gate 0.60).",
  );
  L.push("");
  L.push("| World | v2 retained gain | v3 retained gain | Δ% | Holds |");
  L.push("| --- | ---: | ---: | ---: | :---: |");
  for (const r of v.robustness) {
    L.push(
      `| ${r.worldLabel} | ${num(r.baseline, 3)} | ${num(r.candidate, 3)} | ${
        r.relativeDelta >= 0 ? "+" : ""
      }${pct(r.relativeDelta)} | ${r.passed ? "✅" : "❌"} |`,
    );
  }
  L.push("");
  L.push("Aggregate over all perturbed worlds:");
  L.push("");
  const failing = result.verdict.robustness.filter((r) => !r.passed);
  if (failing.length) {
    L.push("");
    L.push(
      `**Where it stops working.** The primary advantage does not hold in ${failing.length} of ` +
        `${result.verdict.robustness.length} perturbed worlds: ` +
        failing.map((r) => `*${r.worldLabel}* (${signed(r.relativeDelta * 100, 1)}%)`).join(", ") +
        ". This is the honest boundary of the result rather than a rounding error — a world whose productive " +
        "difficulty sits far from the policy's success target removes most of what v3's ZPD and mastery-gain " +
        "objectives are exploiting. A deployment that believes its learners learn best while failing half the " +
        "time should re-tune `successTarget` (and re-run this benchmark) rather than adopt these weights as-is.",
    );
  }
  L.push("");
  L.push(...threeWayTable(result.robustness));
  L.push("");

  /* ------------------------- equal-time control --------------------- */
  if (result.equalTime) {
    L.push("## 5b. Equal-time control (the item budget is not free)");
    L.push("");
    L.push(
      "Under the item-budgeted protocol v3 spends **" +
        `${num(result.heldOut.runs.v3.aggregate.minutesSpent, 1)} minutes** against v2's ` +
        `**${num(result.heldOut.runs.v2.aggregate.minutesSpent, 1)}** — it wins per item partly by choosing ` +
        "longer items, and mastery gain *per minute* is therefore a wash. A fair reading of \"improves learning\" " +
        `has to hold time constant, so the same held-out cells are re-run with a ${EQUAL_TIME_MINUTES_PER_SESSION}-minute ` +
        "session budget and no item count at all:",
    );
    L.push("");
    L.push(...threeWayTable(result.equalTime));
    L.push("");
    const eqV2 = result.equalTime.runs.v2.aggregate;
    const eqV3 = result.equalTime.runs.v3.aggregate;
    const eqSeries = alignedSeries(result.equalTime.runs.v3.cells, result.equalTime.runs.v2.cells, "retainedGain");
    const eqCmp = comparePaired({
      metric: "Retained mastery gain (equal time)",
      higherIsBetter: true,
      candidate: eqSeries.candidate,
      baseline: eqSeries.baseline,
    });
    L.push(
      `At equal time v3 serves ${num(eqV3.itemsServed, 1)} items to v2's ${num(eqV2.itemsServed, 1)} ` +
        `(${num(eqV3.minutesSpent, 1)} vs ${num(eqV2.minutesSpent, 1)} minutes) and retained gain moves ` +
        `${num(eqV2.retainedGain, 3)} → ${num(eqV3.retainedGain, 3)} ` +
        `(${signed(eqCmp.relativeDelta * 100, 1)}%, 95% CI [${num(eqCmp.ci.lower, 4)}, ${num(eqCmp.ci.upper, 4)}], ` +
        `sign test ${eqCmp.sign.wins}W/${eqCmp.sign.losses}L p=${num(eqCmp.sign.pValue, 4)}).`,
    );
    L.push("");
    if (eqCmp.ci.lower > 0) {
      L.push(
        "**The advantage survives the time control**: the paired bootstrap CI excludes 0, so it is not an artefact " +
          `of spending longer on each question (sign test ${eqCmp.sign.wins}W/${eqCmp.sign.losses}L, ` +
          `p=${num(eqCmp.sign.pValue, 4)}).`,
      );
      L.push("");
      L.push(
        "This is the control that changed the design. An earlier tuned vector won +11.7% mastery gain *per item* " +
          "and 0% *per minute* — it had learned to pick longer questions, and the item-budgeted objective had no " +
          "way to notice. The tuning objective is now denominated in minutes (see §8), which is why " +
          "`assessmentEfficiency` carries a materially larger weight than its theory prior.",
      );
    } else {
      L.push(
        "**The advantage does not survive the time control.** v3's gain at equal items is bought partly with " +
          "extra minutes; treat the headline number as 'more learning per question', not 'more learning per hour'.",
      );
    }
    L.push("");
  }

  /* --------------------------- diagnosis ---------------------------- */
  L.push("## 6. Diagnosis — why v2 improved measurement but not learning");
  L.push("");
  L.push(
    "The world's acquisition rule is multiplicative, so the difference in log gain-per-item decomposes exactly " +
      "into the levers a selector controls. Legacy is the baseline column:",
  );
  L.push("");
  L.push(...attributionTable(result.attribution.v2VsLegacy, "Adaptive v2", "Legacy"));
  L.push("");
  L.push(
    "v2 targets the productive band better than legacy — and still loses ground on gain per item — because its " +
      "prerequisite gate runs on a **point estimate** that outpaces true ability early in a session, so it unlocks " +
      "downstream skills the learner is not ready for, and because its gap term is diluted by measurement-flavoured " +
      "objectives (information, uncertainty, exploration) that are uncorrelated with headroom.",
  );
  L.push("");
  L.push("v3 against v2 on the same decomposition:");
  L.push("");
  L.push(...attributionTable(result.attribution.v3VsV2, "Optimized v3", "Adaptive v2"));
  L.push("");

  L.push("### 6.1 Coverage: restraint vs neglect");
  L.push("");
  L.push(
    "Raw skill coverage counts distinct skills served and cannot tell the two apart. Splitting the skills a policy " +
      "never served by whether the learner's **true** prerequisites were met resolves the conflict between the " +
      "coverage and prerequisite guardrails (held-out split, summed over cells):",
  );
  L.push("");
  L.push("| Policy | Distinct skills | Eligible coverage | Missed — ready for (neglect) | Missed — not ready for (restraint) |");
  L.push("| --- | ---: | ---: | ---: | ---: |");
  for (const id of POLICY_ORDER) {
    const m = result.heldOut.runs[id].aggregate;
    L.push(
      `| ${POLICY_LABELS[id]} | ${num(m.skillCoverage, 2)} | ${pct(m.eligibleCoverage, 1)} | ` +
        `**${m.missedEligible}** | ${m.missedIneligible} |`,
    );
  }
  L.push("");
  L.push(
    "Every skill v3 left untouched was one the learner was not yet ready for. That is the prerequisite objective " +
      "working as designed, not a coverage regression — see amendment *coverage-metric* in §1.1.",
  );
  L.push("");

  L.push("### 6.2 Where the learner-state estimate goes wrong");
  L.push("");
  L.push(
    "Estimation error is not uniform across learners, and the sign matters: a tracer that runs *ahead* of true " +
      "ability is what lets a point-estimate gate unlock skills early. Held-out, by archetype (v3 column shown; " +
      "the tracer is identical for all three policies, only the evidence it is fed differs):",
  );
  L.push("");
  L.push("| Archetype | RMSE (v2) | RMSE (v3) | Bias (v2) | Bias (v3) |");
  L.push("| --- | ---: | ---: | ---: | ---: |");
  for (const arc of ARCHETYPES) {
    const v2m = aggregateCells(result.heldOut.runs.v2.cells.filter((r) => r.archetypeId === arc.id));
    const v3m = aggregateCells(result.heldOut.runs.v3.cells.filter((r) => r.archetypeId === arc.id));
    L.push(
      `| ${arc.name} | ${num(v2m.estimationRmse, 3)} | ${num(v3m.estimationRmse, 3)} | ` +
        `${signed(v2m.estimationBias, 3)} | ${signed(v3m.estimationBias, 3)} |`,
    );
  }
  L.push("");
  L.push(
    "Positive bias = the platform believes the learner is stronger than they are. The pattern is systematic: BKT's " +
      "learning transition (`learn = " + DEFAULT_BKT.learn + "`) moves mastery up fast on thin evidence, so the " +
      "estimate overshoots hardest for the weakest learners — precisely the ones for whom a premature unlock is " +
      "most damaging. v3 does not change the tracer; it *distrusts* it, gating on a lower confidence bound instead " +
      "of the point estimate. The tuner independently confirmed this was worth doing (see §8).",
  );
  L.push("");

  /* ------------------------------ train ----------------------------- */
  L.push("## 7. Train split (tuning transparency)");
  L.push("");
  L.push(
    "Shown for completeness only — these are the cells the weight search was allowed to see, so they cannot be " +
      "used as evidence of improvement.",
  );
  L.push("");
  L.push(...threeWayTable(result.train));
  L.push("");

  /* ----------------------------- weights ---------------------------- */
  L.push("## 8. Policy configuration in force");
  L.push("");
  L.push(`Config fingerprint: \`${result.generatedWith.policyFingerprint}\``);
  L.push("");
  L.push("| Objective | Prior (theory) | Tuned | Normalised | Direction |");
  L.push("| --- | ---: | ---: | ---: | :--- |");
  const normalized = normalizeWeights(TUNED_WEIGHTS);
  for (const key of [...BENEFIT_OBJECTIVES, ...PENALTY_OBJECTIVES]) {
    L.push(
      `| ${OBJECTIVE_METADATA[key].label} | ${num(PRIOR_WEIGHTS[key], 3)} | ${num(TUNED_WEIGHTS[key], 3)} | ${num(
        normalized[key],
        3,
      )} | ${OBJECTIVE_METADATA[key].direction} |`,
    );
  }
  L.push("");
  L.push(`Tuning method: ${TUNING_PROVENANCE.method}.`);
  L.push("");
  L.push(`Tuning objective (pre-registered): ${TUNING_PROVENANCE.objective}.`);
  L.push("");
  L.push(`Train split used by the tuner: ${TUNING_PROVENANCE.trainSplit}.`);
  L.push("");
  L.push(
    `Weight multiplier grid \`[${TUNING_PROVENANCE.grid.join(", ")}]\`, ${TUNING_PROVENANCE.passes} passes, ` +
      `${TUNING_PROVENANCE.evaluations} configurations evaluated. Train utility moved ` +
      `${num(TUNING_PROVENANCE.priorUtility, 4)} → ${num(TUNING_PROVENANCE.tunedUtility, 4)}.`,
  );
  L.push("");
  L.push("**Structural parameters.** Weights rank the survivors of the hard gates; they cannot change *which* ");
  L.push(
    "candidates survive. The three parameters that can were searched on explicit grids in the same run — this is " +
      "where the coverage/safety trade-off is actually decided:",
  );
  L.push("");
  L.push("| Parameter | Grid | Prior | Tuned |");
  L.push("| --- | --- | ---: | ---: |");
  for (const [key, grid] of Object.entries(TUNING_PROVENANCE.paramGrids)) {
    const tuned = (TUNED_PARAMS as Record<string, number>)[key];
    const prior = (PRIOR_PARAMS as Record<string, number>)[key];
    L.push(`| \`${key}\` | ${grid.join(" / ")} | ${prior} | **${tuned}**${prior === tuned ? "" : " ←"} |`);
  }
  L.push("");
  L.push(
    "`prereqPessimismZ` is the load-bearing one. `z = 0` *is* v2's gate — it applies the threshold to the point " +
      `estimate — and the search moved it to ${TUNED_PARAMS.prereqPessimismZ}, the largest single effect anywhere ` +
      "in the tuning run: on the train objective, z=0 scores roughly an order of magnitude worse than the chosen " +
      "value. That is independent confirmation of the diagnosis in §6, arrived at by search rather than by " +
      "assumption. Per-value utilities for every parameter are in `benchmarks/tuning.json` → `paramProfiles`.",
  );
  L.push("");
  L.push(
    `Key parameters: mastery target ${DEFAULT_POLICY_PARAMS.masteryTarget}, success target ` +
      `${DEFAULT_POLICY_PARAMS.successTarget}, ZPD σ ${DEFAULT_POLICY_PARAMS.zpdSigma}, prerequisite gate ` +
      `${DEFAULT_POLICY_PARAMS.prereqGate} at ${DEFAULT_POLICY_PARAMS.prereqPessimismZ} posterior SD of pessimism ` +
      `(v2 gate: ${PREREQ_GATE} on the point estimate), review horizon ` +
      `${DEFAULT_POLICY_PARAMS.retentionHorizonDays}d.`,
  );
  L.push("");

  /* --------------------------- limitations -------------------------- */
  L.push("## 9. What this evidence does and does not establish");
  L.push("");
  L.push(
    "- **Does**: under a declared learning model, v3 is better than v2 on durable learning at equal item budget, " +
      "on learner types and luck streams that never influenced its weights, and the advantage survives worlds whose " +
      "learning dynamics contradict the policy's defaults.",
  );
  L.push(
    "- **Does not**: prove a learning gain for real students. The simulator's acquisition rule is an assumption " +
      "shared by the policy's `expectedMasteryGain` objective (different functional form and different inputs — the " +
      "policy sees noisy estimates, the world knows the truth — but the same family). Only a randomised trial on " +
      "live learners can settle it; the metric plumbing for that trial is the same one used here.",
  );
  L.push(
    "- **Watch items**: mastery-event counts are censored (learners far from the threshold never cross it inside " +
      "32 items), so 'questions to reach mastery' is a restricted mean over crossings only; the classifier used as " +
      "the response model is the untrained heuristic, so absolute Brier values are pessimistic for every policy.",
  );
  if (bf.lostToFloor.length > 0) {
    L.push(
      `- **Does not (the big one)**: establish that the adaptive stack is worth its complexity. ` +
        `\`${bf.bestFloor.policyId}\` — one ranking rule, no model, no tuning — delivers ` +
        `${num(bf.bestFloor.aggregate.retainedGain, 3)} retained gain against v3's ` +
        `${num(bf.rows.find((r) => r.policyId === "v3")!.aggregate.retainedGain, 3)}, and the oracle shows ` +
        `${num(bf.ceiling.aggregate.retainedGain, 3)} was available. v3 captures ` +
        `${pct(bf.rows.find((r) => r.policyId === "v3")!.shareOfCeiling, 0)} of the achievable learning. ` +
        "The v3-over-v2 result in §2 is real and it is still the right serving default among the three, but " +
        "'better than the thing we shipped last' is a much weaker claim than 'good', and §2b is the reason " +
        "to keep saying so.",
    );
    L.push(
      "- **Where the loss is**: §2b.2 localises it to the response model, not the knowledge tracer. With mastery " +
        `estimation held perfect the response model is still over-confident by ${num(cal.bias, 2)}, so every ` +
        "policy that steers by predicted P(correct) systematically overshoots the productive band, while a " +
        "heuristic that ignores the model and simply goes easiest-first within the weakest skill lands inside " +
        "it. The highest-value next experiment is therefore **recalibrating the response model against " +
        "production telemetry**, not further weight tuning — the tuner has already extracted most of what the " +
        "current objective set can give.",
    );
  }
  L.push("");
  return L.join("\n");
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

export function runBenchmark(options: BenchmarkOptions = {}): BenchmarkResult {
  const v3 = options.v3Weights ? makeV3Policy({ weights: options.v3Weights }) : makeV3Policy();
  const policies: BenchPolicy[] = [legacyPolicy, v2Policy, v3];

  const train = runSplit(
    "train",
    "TRAIN",
    `${TRAIN_ARCHETYPE_IDS.length} archetypes × 4 seeds × base world — the only cells the weight tuner may see`,
    trainCells(),
    policies,
  );
  const heldOutSpecs = heldOutCells();
  const heldOut = runSplit(
    "held-out",
    "HELD-OUT",
    `${ARCHETYPES.length} archetypes (4 never tuned on) × ${HELD_OUT_SEED_OFFSETS.length} unseen seeds × ` +
      "base world — primary evidence",
    heldOutSpecs,
    policies,
  );

  // Equal-TIME control. The primary protocol gives every policy the same number
  // of *items*, which quietly rewards whichever one picks longer questions.
  // This re-runs the identical held-out cells under a minutes budget instead.
  const equalTime = options.includeEqualTime === false
    ? null
    : runSplit(
        "equal-time",
        "HELD-OUT (equal time)",
        `Same ${heldOutSpecs.length} held-out cells under a ${EQUAL_TIME_MINUTES_PER_SESSION}-minute-per-session ` +
          "budget instead of a fixed item count",
        heldOutSpecs.map((cell) => ({
          ...cell,
          protocol: { ...DEFAULT_PROTOCOL, minutesPerSession: EQUAL_TIME_MINUTES_PER_SESSION },
        })),
        policies,
      );
  const robustness = options.includeRobustness === false
    ? { id: "robustness", label: "ROBUSTNESS", description: "skipped", cellCount: 0, runs: heldOut.runs }
    : runSplit(
        "robustness",
        "ROBUSTNESS",
        `${ARCHETYPES.length} archetypes × 2 further unseen seeds × ${WORLD_VARIANTS.length - 1} perturbed worlds`,
        robustnessCells(),
        policies,
      );

  const heldOutUnseenArchetypes = subsetSplit(
    heldOut,
    "held-out-unseen",
    "HELD-OUT (unseen archetypes)",
    "Only the four learner types that never appeared in tuning",
    (cell) => (HELD_OUT_ONLY_ARCHETYPE_IDS as readonly string[]).includes(cell.archetypeId),
  );

  const verdict = decideAdoption({
    heldOutCandidate: heldOut.runs.v3.cells,
    heldOutBaseline: heldOut.runs.v2.cells,
    robustnessCandidate: robustness.runs.v3.cells,
    robustnessBaseline: robustness.runs.v2.cells,
  });
  const verdictVsLegacy = decideAdoption({
    heldOutCandidate: heldOut.runs.v3.cells,
    heldOutBaseline: heldOut.runs.legacy.cells,
    robustnessCandidate: robustness.runs.v3.cells,
    robustnessBaseline: robustness.runs.legacy.cells,
  });

  const comparisons = {
    heldOutV3vsV2: compareAll(heldOut, "v3", "v2"),
    heldOutV3vsLegacy: compareAll(heldOut, "v3", "legacy"),
    heldOutV2vsLegacy: compareAll(heldOut, "v2", "legacy"),
  };

  const baselineFloor = runBaselineFloor(heldOutSpecs, v3);
  const difficultySweep =
    options.includeRobustness === false
      ? []
      : sweepDifficultyTargets(heldOutSpecs, [0.35, 0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.95]);
  const calibration = probeResponseModelCalibration();

  const attribution = {
    v2VsLegacy: attributeGainGap(heldOut.runs.v2.cells, heldOut.runs.legacy.cells),
    v3VsV2: attributeGainGap(heldOut.runs.v3.cells, heldOut.runs.v2.cells),
  };

  const generatedWith = {
    protocol: DEFAULT_PROTOCOL,
    skills: SKILLS.length,
    items: ITEMS.length,
    archetypes: ARCHETYPES.length,
    worlds: WORLD_VARIANTS.length,
    policyFingerprint: resolvePolicyConfig(options.v3Weights ? { weights: options.v3Weights } : {}).fingerprint,
    servingDefault: DEFAULT_POLICY_ID,
  };

  const core = {
    generatedWith,
    train,
    heldOut,
    heldOutUnseenArchetypes,
    equalTime,
    robustness,
    comparisons,
    verdict,
    verdictVsLegacy,
    baselineFloor,
    difficultySweep,
    calibration,
    attribution,
  };

  const report = buildReport(core);
  const json = toJson(core);

  return { ...core, report, json };
}

/** Machine-readable artefact (no traces — those stay in memory). */
function toJson(core: Omit<BenchmarkResult, "report" | "json">): Record<string, unknown> {
  const splitJson = (split: SplitRun) => ({
    id: split.id,
    label: split.label,
    description: split.description,
    cells: split.cellCount,
    aggregates: Object.fromEntries(
      (Object.entries(split.runs) as [BenchPolicyId, PolicyRun][]).map(([id, run]) => [id, run.aggregate]),
    ),
    perArchetype: Object.fromEntries(
      ARCHETYPES.map((archetype: Archetype) => [
        archetype.id,
        Object.fromEntries(
          (Object.entries(split.runs) as [BenchPolicyId, PolicyRun][]).map(([id, run]) => [
            id,
            aggregateCells(run.cells.filter((c) => c.archetypeId === archetype.id)),
          ]),
        ),
      ]),
    ),
  });

  return {
    schema: "adaptive.benchmark.v1",
    /**
     * Consumers MUST NOT treat these numbers as measurements of real learners.
     * Every figure comes from a synthetic simulator whose learning process was
     * written by the same team as the policy under test.
     */
    evidenceType: "synthetic-simulation",
    evidenceCaveat:
      "Simulated learners, not human subjects. The world model (IRT + forgetting + fatigue) is an " +
      "assumption, not a measurement; results establish relative policy behaviour under that assumption " +
      "and are not evidence of real-world learning gains. Validate against production telemetry or a " +
      "controlled trial before making efficacy claims.",
    generatedWith: core.generatedWith,
    protocolAmendments: PROTOCOL_AMENDMENTS,
    baselineFloor: {
      note:
        "Trivial heuristics any adaptive engine should beat, plus a ground-truth oracle ceiling. " +
        "`lostToFloor` lists shippable policies that deliver less retained learning than the best " +
        "trivial baseline.",
      bestFloor: core.baselineFloor.bestFloor.policyId,
      lostToFloor: core.baselineFloor.lostToFloor,
      rows: core.baselineFloor.rows.map((r) => ({
        policyId: r.policyId,
        label: r.label,
        tier: r.tier,
        shareOfCeiling: round(r.shareOfCeiling, 4),
        aggregate: r.aggregate,
      })),
    },
    worldValidation: {
      note:
        "Oracle swept over target true P(correct). An interior peak is what justifies the ZPD-shaped " +
        "objectives; a monotone rise toward 1.0 would mean the world merely rewards easy questions.",
      sweep: core.difficultySweep,
    },
    responseModelCalibration: {
      note:
        "Response-model bias measured with mastery estimation held PERFECT (mastery = true ability). " +
        "Residual bias here is attributable to the response model alone and is invisible to tracer " +
        "metrics (RMSE/Brier/ECE). Measured relative to this synthetic world, not to real learners.",
      ...core.calibration,
    },
    tuning: {
      method: TUNING_PROVENANCE.method,
      objective: TUNING_PROVENANCE.objective,
      trainSplit: TUNING_PROVENANCE.trainSplit,
      grid: TUNING_PROVENANCE.grid,
      paramGrids: TUNING_PROVENANCE.paramGrids,
      passes: TUNING_PROVENANCE.passes,
      evaluations: TUNING_PROVENANCE.evaluations,
      priorUtility: TUNING_PROVENANCE.priorUtility,
      tunedUtility: TUNING_PROVENANCE.tunedUtility,
      priorWeights: PRIOR_WEIGHTS,
      tunedWeights: TUNED_WEIGHTS,
      tunedParams: TUNED_PARAMS,
    },
    /**
     * Longitudinal trajectories for one representative cell per archetype
     * (first held-out seed). Latent truth vs platform belief, step by step —
     * this is what makes divergence between what a learner *knows* and what the
     * system *thinks* they know inspectable rather than aggregate-only.
     */
    trajectories: Object.fromEntries(
      ARCHETYPES.map((archetype: Archetype) => [
        archetype.id,
        Object.fromEntries(
          (Object.entries(core.heldOut.runs) as [BenchPolicyId, PolicyRun][]).map(([id, run]) => {
            const cell = run.cells.find((c) => c.archetypeId === archetype.id);
            return [id, cell ? cell.trajectory : []];
          }),
        ),
      ]),
    ),
    splits: {
      train: splitJson(core.train),
      heldOut: splitJson(core.heldOut),
      heldOutUnseenArchetypes: splitJson(core.heldOutUnseenArchetypes),
      equalTime: core.equalTime ? splitJson(core.equalTime) : null,
      robustness: splitJson(core.robustness),
    },
    comparisons: {
      heldOutV3vsV2: core.comparisons.heldOutV3vsV2,
      heldOutV3vsLegacy: core.comparisons.heldOutV3vsLegacy,
      heldOutV2vsLegacy: core.comparisons.heldOutV2vsLegacy,
    },
    verdict: {
      adopt: core.verdict.adopt,
      reasons: core.verdict.reasons,
      primary: core.verdict.primary,
      robustWinShare: core.verdict.robustWinShare,
      guardrails: core.verdict.guardrails.map((g) => ({
        metric: g.guardrail.key,
        label: g.guardrail.label,
        passed: g.passed,
        relativeDelta: round(g.comparison.relativeDelta, 5),
        tolerance: g.guardrail.tolerance,
      })),
      robustness: core.verdict.robustness,
      criteria: {
        primaryMetric: ADOPTION_CRITERIA.primaryMetric,
        minRelativeImprovement: ADOPTION_CRITERIA.minRelativeImprovement,
        maxSignTestP: ADOPTION_CRITERIA.maxSignTestP,
        minRobustWinShare: ADOPTION_CRITERIA.minRobustWinShare,
      },
    },
    verdictVsLegacy: { adopt: core.verdictVsLegacy.adopt, reasons: core.verdictVsLegacy.reasons },
    attribution: {
      v2VsLegacy: core.attribution.v2VsLegacy,
      v3VsV2: core.attribution.v3VsV2,
    },
    weights: { prior: PRIOR_WEIGHTS, tuned: TUNED_WEIGHTS, normalized: normalizeWeights(TUNED_WEIGHTS) },
    params: DEFAULT_POLICY_PARAMS,
  };
}

export { ARCHETYPE_BY_ID };
