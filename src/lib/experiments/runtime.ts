/**
 * Runtime bridge: experiment variant → serving strategy.
 *
 * This is the only place that translates an experiment's *declared* policy
 * configuration into the object that actually chooses a question. Keeping the
 * mapping in one function means an arm can never silently be served by a
 * different policy than the one recorded on its exposures — the fingerprint
 * written to the exposure row and the strategy used to pick the item come from
 * the same call.
 */
import type { ItemSelectionStrategy } from "@/lib/ml/interfaces";
import { adaptiveSelector } from "@/lib/ml/selection";
import { MultiObjectivePolicy, multiObjectivePolicy } from "@/lib/ml/policy/v3";
import { legacySelectionPolicy } from "@/lib/ml/policy/legacy";
import {
  difficultyBaselinePolicy,
  masteryGapBaselinePolicy,
  randomBaselinePolicy,
} from "@/lib/ml/policy/baselines";
import type { PolicyWeights } from "@/lib/ml/policy/types";
import { POLICY_VARIANT_IDS, type PolicyVariantId, type VersionedPolicyConfig } from "./types";

/** Human-facing catalogue of the arms an experiment may use. */
export const POLICY_VARIANT_CATALOGUE: Record<
  PolicyVariantId,
  { label: string; description: string; tier: "production" | "legacy" | "baseline" }
> = {
  legacy: {
    label: "Legacy selector",
    description:
      "Pre-v2 scorer preserved verbatim, including its mastery-blind difficulty targeting. " +
      "Faithful to the historical production behaviour.",
    tier: "legacy",
  },
  "adaptive-v2": {
    label: "Adaptive v2",
    description: "Weighted 10-criteria selector with a point-estimate prerequisite gate.",
    tier: "production",
  },
  "adaptive-v3": {
    label: "Adaptive v3",
    description:
      "Multi-objective policy: lexicographic hard gates, then a weighted combination of nine " +
      "objectives minus two penalties. Accepts per-experiment weight and parameter overrides.",
    tier: "production",
  },
  "random-baseline": {
    label: "Random baseline",
    description: "Uniformly random over unseen items. Seeded, so replays are exact.",
    tier: "baseline",
  },
  "difficulty-baseline": {
    label: "Difficulty baseline",
    description: "Closest item difficulty to overall estimated ability. Ignores skill choice.",
    tier: "baseline",
  },
  "mastery-gap-baseline": {
    label: "Mastery-gap baseline",
    description:
      "Easiest unseen item in the least-mastered skill. Offline simulation found this " +
      "out-learning every adaptive policy, so it is the control that matters most.",
    tier: "baseline",
  },
};

/**
 * Resolve the strategy for a variant's configuration.
 *
 * Only `adaptive-v3` consumes weight/param overrides; for every other policy
 * they are inert by construction rather than by convention, because those
 * policies have no weights to override. `validateVariantConfig` surfaces that
 * as a warning so an operator does not believe they tuned something they did
 * not.
 */
export function strategyForConfig(config: VersionedPolicyConfig): ItemSelectionStrategy {
  switch (config.policy) {
    case "legacy":
      return legacySelectionPolicy;
    case "adaptive-v2":
      return adaptiveSelector;
    case "adaptive-v3": {
      const hasOverrides =
        (config.weights && Object.keys(config.weights).length > 0) ||
        (config.params && Object.keys(config.params).length > 0);
      if (!hasOverrides) return multiObjectivePolicy;
      return new MultiObjectivePolicy({
        weights: config.weights as Partial<PolicyWeights> | undefined,
        params: config.params,
      });
    }
    case "random-baseline":
      return randomBaselinePolicy;
    case "difficulty-baseline":
      return difficultyBaselinePolicy;
    case "mastery-gap-baseline":
      return masteryGapBaselinePolicy;
    default: {
      // Exhaustiveness: adding a variant id without handling it fails to compile.
      const never: never = config.policy;
      throw new Error(`unhandled policy variant ${String(never)}`);
    }
  }
}

/** Non-fatal configuration warnings, surfaced when an experiment is defined. */
export function validateVariantConfig(config: VersionedPolicyConfig): string[] {
  const warnings: string[] = [];
  if (!(POLICY_VARIANT_IDS as readonly string[]).includes(config.policy)) {
    warnings.push(`unknown policy "${config.policy}"`);
    return warnings;
  }
  const overrides =
    Object.keys(config.weights ?? {}).length + Object.keys(config.params ?? {}).length;
  if (config.policy !== "adaptive-v3" && overrides > 0) {
    warnings.push(
      `policy "${config.policy}" ignores weight/param overrides (${overrides} supplied); ` +
        "only adaptive-v3 is configurable",
    );
  }
  return warnings;
}
