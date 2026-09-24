/** Controlled v3 component ablations. Baselines and the adoption rule are untouched. */
import { mean } from "@/lib/utils";
import { CalibratedResponseModel, fitResponseCalibrator, type ResponseTelemetry } from "@/lib/ml/response-calibration";
import type { LearnerState, ResponseModel } from "@/lib/ml/interfaces";
import { aggregateCells, simulateCell, type AggregateMetrics, type CellResult } from "./simulate";
import { heldOutCells, trainCells } from "./protocol";
import { SKILL_BY_ID } from "./world";
import { makeV3Policy, masteryGapOnlyPolicy, v3Policy, type BenchPolicy, type PolicyContext } from "./policies";

function wrap(id: BenchPolicy["id"], label: string, transform: (ctx: PolicyContext) => PolicyContext, base = v3Policy): BenchPolicy {
  return { id, label, select(ctx) { return base.select(transform(ctx)); } };
}
const neutralResponse: ResponseModel = { id: "neutral-response", predict: () => .5 };

function learnerWithTruth(ctx: PolicyContext): LearnerState {
  const skills = new Map([...ctx.learner.skills].map(([id, skill]) => {
    const mastery = ctx.truth.abilityBySkill.get(id) ?? skill.mastery;
    const prereqIds = SKILL_BY_ID.get(id)?.prereqIds ?? [];
    const prereqMastery = prereqIds.map(pid => ({ skillId: pid, name: SKILL_BY_ID.get(pid)?.name ?? String(pid), mastery: ctx.truth.abilityBySkill.get(pid) ?? 0 }));
    return [id, { ...skill, mastery, rawMastery: mastery, prereqMastery, prereqReadiness: prereqMastery.length ? Math.min(...prereqMastery.map(p => p.mastery)) : 1 }];
  }));
  return { ...ctx.learner, ability: mean([...ctx.truth.abilityBySkill.values()]), skills };
}

function oracleResponse(ctx: PolicyContext): ResponseModel {
  return {
    id: "oracle-response",
    predict({ item, skill }) {
      const candidate = ctx.candidates.find(c => c.skillId === skill.skillId && c.item.difficulty === item.difficulty && c.item.bloom === item.bloom);
      return candidate ? ctx.truth.trueProbFor(candidate.questionId) : .5;
    },
  };
}

/** Select the weakest estimated skill, while retaining v3's prerequisite safety and item-level explanation/scoring. */
const masteryGapSkillBase = makeV3Policy({}, "v3 item scoring within mastery-gap skill");
const masteryGapSkillPolicy: BenchPolicy = {
  id: "v3-mastery-gap-skill", label: "F: v3 + mastery-gap skill selection",
  select(ctx) {
    const unseen = ctx.candidates.filter(c => !ctx.seen.has(c.questionId));
    // Retain a prerequisite gate; relax only if no safe skill exists.
    const safePool = unseen.filter(c => (ctx.learner.skills.get(c.skillId)?.prereqReadiness ?? 1) >= .6);
    const pool = safePool.length ? safePool : unseen;
    const minMastery = Math.min(...pool.map(c => ctx.learner.skills.get(c.skillId)?.mastery ?? .3));
    const skillId = [...new Set(pool.filter(c => (ctx.learner.skills.get(c.skillId)?.mastery ?? .3) <= minMastery + 1e-9).map(c => c.skillId))].sort((a,b) => a-b)[0];
    return masteryGapSkillBase.select({ ...ctx, candidates: pool.filter(c => c.skillId === skillId) });
  },
};

export interface AblationRow { id: string; label: string; metrics: AggregateMetrics; cells: CellResult[] }
export interface AblationResult { rows: AblationRow[]; calibration: { version: string; source: string; samples: number }; diagnosis: string[] }

/** Fits synthetic calibration on TRAIN cells only, then evaluates every variant on unchanged held-out cells. */
export function runV3Ablations(): AblationResult {
  const calibrationRows: ResponseTelemetry[] = trainCells().flatMap(cell => simulateCell(v3Policy, cell).trace.map((t, i) => ({
    rawProbability: t.predicted, isCorrect: t.isCorrect, occurredAt: new Date(Date.UTC(2025, 0, 1 + i)).toISOString(),
    learnerId: `${cell.archetype.id}:${cell.seed}`, skillId: t.skillId, difficulty: t.difficulty, bloom: t.bloom, cohort: cell.archetype.id,
  })));
  const calibrator = fitResponseCalibrator(calibrationRows, { version: "synthetic-train-v1", source: "synthetic", heldOutLearners: true });
  const noInfo = makeV3Policy({ weights: { informationGain: 0, uncertaintyReduction: 0 } }, "C: no information gain");
  const noPrereqWeight = makeV3Policy({ weights: { prerequisiteCorrectness: 0, prerequisiteRisk: 0 } }, "D: no prerequisite weighting (gate retained)");
  const noDiversity = makeV3Policy({ weights: { skillCoverage: 0, repeatedExposure: 0 } }, "E: no diversity weights (caps retained)");
  const calibrated = wrap("v3-calibrated-response", "G: calibrated response", ctx => ({ ...ctx, responseModel: new CalibratedResponseModel(ctx.responseModel, calibrator) }));
  const policies: BenchPolicy[] = [
    masteryGapOnlyPolicy,
    v3Policy,
    wrap("v3-no-response", "A: v3 without response model", ctx => ({ ...ctx, responseModel: neutralResponse })),
    wrap("v3-true-mastery", "B: v3 with true mastery", ctx => ({ ...ctx, learner: learnerWithTruth(ctx) })),
    { ...noInfo, id: "v3-no-information" },
    { ...noPrereqWeight, id: "v3-no-prerequisite-weight" },
    { ...noDiversity, id: "v3-no-diversity" },
    masteryGapSkillPolicy,
    calibrated,
    wrap("v3-oracle-response", "H: v3 with oracle response probabilities", ctx => ({ ...ctx, responseModel: oracleResponse(ctx) })),
  ];
  const specs = heldOutCells();
  const rows = policies.map(policy => { const cells = specs.map(c => simulateCell(policy, c)); return { id: policy.id, label: policy.label, metrics: aggregateCells(cells), cells }; });
  const base = rows.find(r => r.id === "v3")!.metrics.retainedGain;
  const ranked = rows.filter(r => r.id !== "mastery-gap-only" && r.id !== "v3").sort((a,b) => b.metrics.retainedGain-a.metrics.retainedGain);
  return {
    rows,
    calibration: { version: calibrator.version, source: calibrator.source, samples: calibrator.samples },
    diagnosis: [
      `Best controlled v3 variant is ${ranked[0].label} (${ranked[0].metrics.retainedGain.toFixed(4)} retained gain vs ${base.toFixed(4)}).`,
      "True-mastery and oracle-response interventions isolate estimation and response-link ceilings; zero-weight ablations retain hard safety gates.",
      "Synthetic calibration is diagnostic only and is not production evidence.",
    ],
  };
}
