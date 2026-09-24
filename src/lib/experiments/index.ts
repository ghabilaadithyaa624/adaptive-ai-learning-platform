/**
 * Experimentation framework — public API.
 *
 * Controlled comparison of adaptive-learning policies, designed around four
 * properties. Each is enforced in code rather than documented as a practice:
 *
 *  1. **Deterministic assignment.** `bucketFor(key, salt, studentId)` is a pure
 *     function; anyone can recompute any historical assignment. See
 *     `assignment.ts`.
 *
 *  2. **Stable membership.** A learner keeps their variant for the life of the
 *     experiment, guaranteed by a persisted record plus a unique index, unless
 *     the experiment explicitly opts into `assignmentStrategy: "rolling"`.
 *
 *  3. **No automated winner.** The readout types have no `winner`,
 *     `significant` or `recommendation` field. Estimates and uncertainty
 *     intervals only. See the docstring in `analysis.ts` for why.
 *
 *  4. **Leakage resistance.** Attribution rules R1–R5 in `attribution.ts` gate
 *     every observation on exposure, variant agreement, window and tenant, and
 *     report what they rejected.
 *
 * ## Usage
 *
 * ```ts
 * // 1. Define
 * const exp = await createExperiment({
 *   scope: { institutionId: 7 },
 *   draft: {
 *     key: "v3-vs-mastery-gap",
 *     name: "Is adaptive v3 beating the trivial baseline?",
 *     institutionId: 7,
 *     primaryMetric: "masteryGain",
 *     secondaryMetrics: ["zpdHitRate", "completion"],
 *     startAt: new Date(),
 *     variants: [
 *       { key: "control", label: "Mastery-gap", allocationPct: 50, isControl: true,
 *         config: { policy: "mastery-gap-baseline", version: "1.0.0" } },
 *       { key: "v3", label: "Adaptive v3", allocationPct: 50, isControl: false,
 *         config: { policy: "adaptive-v3", version: "1.0.0" } },
 *     ],
 *   },
 * });
 *
 * // 2. Serve (in the item-selection path)
 * const decisions = await assignLearnerToActiveExperiments({ scope, studentId, now });
 * const assigned = decisions.find((d) => d.outcome === "assigned");
 * const strategy = assigned ? strategyForConfig(assigned.config!) : defaultStrategy;
 * // ... choose the item, then:
 * await recordExposure({ ...,  entityId: assessmentItemId, occurredAt: now });
 *
 * // 3. Read out
 * const readout = await analyseExperiment(exp, new Date());
 * console.log(formatReadout(readout));  // no winner is declared, by design
 * ```
 */
export * from "./types";
export * from "./assignment";
export * from "./attribution";
export * from "./analysis";
export * from "./real-world-evaluation";
export * from "./lifecycle";
export * from "./runtime";
export * from "./stats";
export {
  activeExperimentsFor,
  assignLearner,
  assignLearnerToActiveExperiments,
  buildLearnerSnapshot,
  createExperiment,
  getExperimentByKey,
  listExperiments,
  loadAnalysisDataset,
  recordExposure,
  setExperimentStatus,
  type AnalysisDataset,
  type TenantScope,
} from "./service";

import { attributeMetrics } from "./attribution";
import { buildReadout, type ExperimentReadout } from "./analysis";
import { loadAnalysisDataset } from "./service";
import type { Experiment } from "./types";

/**
 * End-to-end readout for one experiment: load, attribute, summarise.
 *
 * Deterministic — the same database state always produces the same numbers,
 * including bootstrap bounds.
 */
export async function analyseExperiment(
  experiment: Experiment,
  now: Date,
): Promise<ExperimentReadout> {
  const dataset = await loadAnalysisDataset(experiment);
  const attribution = attributeMetrics({
    experiment,
    subjects: dataset.subjects,
    items: dataset.items,
    assessments: dataset.assessments,
    recommendations: dataset.recommendations,
    activity: dataset.activity,
    now,
  });
  return buildReadout({
    experiment,
    attribution,
    exposureByVariant: dataset.exposureByVariant,
    generatedAt: now,
  });
}
