/**
 * Adaptive policy registry.
 *
 * The serving path depends on this module, never on a concrete selector, so the
 * live policy is a *configuration decision* backed by benchmark evidence rather
 * than a code decision:
 *
 *   ADAPTIVE_POLICY=v2|v3              which selector serves items
 *   ADAPTIVE_POLICY_PRESET=<preset>    documented weight preset for v3
 *   ADAPTIVE_POLICY_WEIGHTS={json}     per-objective weight overrides for v3
 *
 * The default is decided by `benchmarks/RESULTS.md`: v3 ships as the default
 * only while the held-out benchmark verdict is "adopt". If a future change makes
 * v3 lose the held-out comparison, the benchmark test fails and the default must
 * be reverted — the adoption rule is enforced in CI, not in prose.
 */
import type { ItemSelectionStrategy } from "@/lib/ml/interfaces";
import { adaptiveSelector } from "@/lib/ml/selection";
import { MultiObjectivePolicy, multiObjectivePolicy, POLICY_V3_ID, POLICY_V3_VERSION } from "./v3";
import { parsePolicyWeights, presetWeights, POLICY_PRESETS, type PolicyPresetId } from "./weights";
import type { PolicyWeights } from "./types";

export type PolicyId = "v2" | "v3";

/**
 * Default serving policy.
 *
 * Evidence: held-out simulation benchmark (8 archetypes × unseen seeds × 5
 * perturbed worlds) — see `benchmarks/RESULTS.md`, section "Adoption decision".
 */
export const DEFAULT_POLICY_ID: PolicyId = "v3";

export function resolvePolicyId(raw = process.env.ADAPTIVE_POLICY): PolicyId {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "v2" || value === "legacy-v2") return "v2";
  if (value === "v3" || value === "multi-objective") return "v3";
  return DEFAULT_POLICY_ID;
}

function configuredWeights(): Partial<PolicyWeights> | undefined {
  const preset = (process.env.ADAPTIVE_POLICY_PRESET ?? "").trim() as PolicyPresetId | "";
  const base = preset && preset in POLICY_PRESETS ? presetWeights(preset) : undefined;
  const overrides = parsePolicyWeights(process.env.ADAPTIVE_POLICY_WEIGHTS);
  if (!base && !overrides) return undefined;
  return { ...(base ?? {}), ...(overrides ?? {}) };
}

/** Resolve the strategy that should serve items right now. */
export function getSelectionStrategy(id: PolicyId = resolvePolicyId()): ItemSelectionStrategy {
  if (id === "v2") return adaptiveSelector;
  const weights = configuredWeights();
  return weights ? new MultiObjectivePolicy({ weights }) : multiObjectivePolicy;
}

/** Registry metadata (surfaced in the model registry + admin UI). */
export function describePolicies() {
  return {
    active: resolvePolicyId(),
    default: DEFAULT_POLICY_ID,
    policies: [
      { id: "v2" as const, strategyId: adaptiveSelector.id, version: "2.0.0", label: "Weighted 10-criteria selector" },
      { id: "v3" as const, strategyId: POLICY_V3_ID, version: POLICY_V3_VERSION, label: "Multi-objective policy" },
    ],
    presets: Object.values(POLICY_PRESETS).map((p) => ({ id: p.id, label: p.label, description: p.description })),
  };
}

export * from "./types";
export * from "./weights";
export * from "./objectives";
export { MultiObjectivePolicy, multiObjectivePolicy, selectNextItemV3, POLICY_V3_ID, POLICY_V3_VERSION } from "./v3";
export { buildDecisionExplanation, decisionFromFactors, narrateDecision } from "./explain";
