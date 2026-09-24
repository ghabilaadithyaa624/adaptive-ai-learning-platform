/**
 * Experiment lifecycle and configuration integrity.
 *
 * The rules here exist because the most common way to ruin an experiment is not
 * a bad statistical test — it is editing the experiment while it runs. Changing
 * an allocation, adding an arm, or tweaking a weight vector mid-flight silently
 * mixes two populations into one readout, and nothing downstream can detect it
 * afterwards.
 *
 * So mutation is gated on status, and the gate is strict in exactly the place
 * it matters: once an experiment is `running`, the things that determine *who
 * sees what* are frozen.
 */
import {
  EXPERIMENT_STATUSES,
  POLICY_VARIANT_IDS,
  PRIMARY_METRIC_KEYS,
  SECONDARY_METRIC_KEYS,
  type Experiment,
  type ExperimentStatus,
  type ExperimentVariant,
  type VersionedPolicyConfig,
} from "./types";

/* ------------------------------------------------------------------ */
/* Config fingerprinting                                               */
/* ------------------------------------------------------------------ */

/**
 * Deterministic digest of a policy configuration.
 *
 * Keys are sorted and numbers are fixed to 6 decimals so that two configs which
 * are semantically identical produce the same fingerprint regardless of key
 * order or float formatting. Written onto every exposure record, which is what
 * makes "did this learner's treatment change mid-run?" answerable from data.
 */
export function fingerprintConfig(config: Omit<VersionedPolicyConfig, "fingerprint">): string {
  const canonical = JSON.stringify({
    policy: config.policy,
    version: config.version,
    weights: sortedNumericRecord(config.weights),
    params: sortedNumericRecord(config.params),
  });
  let h = 2166136261 >>> 0;
  for (let i = 0; i < canonical.length; i += 1) {
    h = (h ^ canonical.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `${config.policy}@${config.version}#${(h >>> 0).toString(36)}`;
}

function sortedNumericRecord(record?: Record<string, number> | Partial<Record<string, number>>) {
  if (!record) return null;
  const entries = Object.entries(record)
    .filter(([, v]) => typeof v === "number" && Number.isFinite(v))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => [k, Number((v as number).toFixed(6))] as const);
  return entries.length ? Object.fromEntries(entries) : null;
}

/** Attach a fingerprint to a bare config. */
export function withFingerprint(config: Omit<VersionedPolicyConfig, "fingerprint">): VersionedPolicyConfig {
  return { ...config, fingerprint: fingerprintConfig(config) };
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

export interface ValidationIssue {
  field: string;
  message: string;
}

export class ExperimentValidationError extends Error {
  constructor(public readonly issues: ValidationIssue[]) {
    super(`experiment validation failed: ${issues.map((i) => `${i.field}: ${i.message}`).join("; ")}`);
    this.name = "ExperimentValidationError";
  }
}

/**
 * Structural validation of an experiment definition.
 *
 * Returns every problem rather than throwing on the first, so an operator
 * fixing a definition sees the whole list instead of discovering issues one
 * round-trip at a time.
 */
export function validateExperiment(
  experiment: Pick<
    Experiment,
    | "key"
    | "variants"
    | "primaryMetric"
    | "secondaryMetrics"
    | "startAt"
    | "endAt"
    | "status"
    | "salt"
  >,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!/^[a-z0-9][a-z0-9-_]{2,63}$/.test(experiment.key)) {
    issues.push({
      field: "key",
      message: "must be 3–64 chars of lowercase letters, digits, hyphen or underscore",
    });
  }

  if (!experiment.salt || experiment.salt.length < 4) {
    issues.push({ field: "salt", message: "must be at least 4 characters" });
  }

  if (!EXPERIMENT_STATUSES.includes(experiment.status)) {
    issues.push({ field: "status", message: `unknown status ${experiment.status}` });
  }

  /* -------- variants -------- */
  if (experiment.variants.length < 2) {
    issues.push({ field: "variants", message: "an experiment needs at least two variants" });
  }

  const keys = new Set<string>();
  for (const v of experiment.variants) {
    if (keys.has(v.key)) issues.push({ field: `variants.${v.key}`, message: "duplicate variant key" });
    keys.add(v.key);

    if (!/^[a-z0-9][a-z0-9-_]{0,31}$/.test(v.key)) {
      issues.push({ field: `variants.${v.key}`, message: "invalid variant key format" });
    }
    if (v.allocationPct < 0 || v.allocationPct > 100) {
      issues.push({ field: `variants.${v.key}.allocationPct`, message: "must be within 0..100" });
    }
    if (!(POLICY_VARIANT_IDS as readonly string[]).includes(v.config.policy)) {
      issues.push({ field: `variants.${v.key}.config.policy`, message: `unknown policy ${v.config.policy}` });
    }
    // A fingerprint that does not match its config means the config was edited
    // without re-fingerprinting — exposures would then be labelled with a
    // configuration that was never served.
    const expected = fingerprintConfig(v.config);
    if (v.config.fingerprint !== expected) {
      issues.push({
        field: `variants.${v.key}.config.fingerprint`,
        message: `stale fingerprint (expected ${expected})`,
      });
    }
  }

  const totalAllocation = experiment.variants.reduce((s, v) => s + v.allocationPct, 0);
  if (totalAllocation > 100 + 1e-9) {
    issues.push({
      field: "variants",
      message: `allocations sum to ${totalAllocation}%, which exceeds 100%`,
    });
  }

  const controls = experiment.variants.filter((v) => v.isControl);
  if (controls.length !== 1) {
    issues.push({
      field: "variants",
      message: `exactly one variant must be the control (found ${controls.length})`,
    });
  }

  /* -------- metrics -------- */
  if (!(PRIMARY_METRIC_KEYS as readonly string[]).includes(experiment.primaryMetric)) {
    issues.push({
      field: "primaryMetric",
      message:
        `must be a learning-outcome metric (${PRIMARY_METRIC_KEYS.join(", ")}); ` +
        "engagement and prediction-quality metrics are secondary by design",
    });
  }
  for (const m of experiment.secondaryMetrics) {
    if (!(SECONDARY_METRIC_KEYS as readonly string[]).includes(m)) {
      issues.push({ field: "secondaryMetrics", message: `unknown secondary metric ${m}` });
    }
  }

  /* -------- window -------- */
  if (experiment.endAt && experiment.endAt <= experiment.startAt) {
    issues.push({ field: "endAt", message: "must be after startAt" });
  }

  return issues;
}

export function assertValidExperiment(
  experiment: Parameters<typeof validateExperiment>[0],
): void {
  const issues = validateExperiment(experiment);
  if (issues.length) throw new ExperimentValidationError(issues);
}

/* ------------------------------------------------------------------ */
/* Status transitions                                                  */
/* ------------------------------------------------------------------ */

/**
 * Legal status transitions.
 *
 * `completed` and `archived` are terminal for *analysis integrity*: restarting
 * a concluded experiment would append a second, differently-conditioned
 * population to the same readout. Re-running a hypothesis means creating a new
 * experiment with a new key, which also gives it a new hash salt and therefore
 * a fresh, uncorrelated bucketing.
 */
export const ALLOWED_TRANSITIONS: Record<ExperimentStatus, ExperimentStatus[]> = {
  draft: ["scheduled", "running", "archived"],
  scheduled: ["running", "draft", "archived"],
  running: ["paused", "completed"],
  paused: ["running", "completed", "archived"],
  completed: ["archived"],
  archived: [],
};

export function canTransition(from: ExperimentStatus, to: ExperimentStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export class ExperimentTransitionError extends Error {
  constructor(from: ExperimentStatus, to: ExperimentStatus) {
    super(
      `illegal experiment transition ${from} → ${to}. Allowed from ${from}: ` +
        `${ALLOWED_TRANSITIONS[from].join(", ") || "(none — terminal)"}`,
    );
    this.name = "ExperimentTransitionError";
  }
}

export function assertTransition(from: ExperimentStatus, to: ExperimentStatus): void {
  if (!canTransition(from, to)) throw new ExperimentTransitionError(from, to);
}

/* ------------------------------------------------------------------ */
/* Mutation guards                                                     */
/* ------------------------------------------------------------------ */

/** Fields that determine who sees what, and are therefore frozen once running. */
export const FROZEN_WHILE_RUNNING = [
  "key",
  "salt",
  "variants",
  "eligibility",
  "primaryMetric",
  "assignmentStrategy",
  "exclusionGroup",
] as const;

export type FrozenField = (typeof FROZEN_WHILE_RUNNING)[number];

/**
 * Check whether a proposed patch is legal for the experiment's current status.
 *
 * Deliberately conservative: it rejects even changes that *look* harmless, like
 * re-ordering variants, because allocation is derived from the variant set and
 * any change to it re-buckets somebody. Widening a date window and adding
 * secondary metrics are the only substantive edits allowed mid-run — neither
 * affects assignment.
 */
export function guardMutation(
  current: Pick<Experiment, "status">,
  patch: Partial<Record<FrozenField | "endAt" | "secondaryMetrics" | "name" | "hypothesis" | "status", unknown>>,
): ValidationIssue[] {
  if (current.status !== "running" && current.status !== "paused") return [];

  const issues: ValidationIssue[] = [];
  for (const field of FROZEN_WHILE_RUNNING) {
    if (patch[field] !== undefined) {
      issues.push({
        field,
        message:
          `cannot be changed while the experiment is ${current.status} — ` +
          "it would re-bucket learners and mix populations in one readout. " +
          "Complete this experiment and start a new one with a new key.",
      });
    }
  }
  return issues;
}

export function assertMutationAllowed(
  current: Pick<Experiment, "status">,
  patch: Parameters<typeof guardMutation>[1],
): void {
  const issues = guardMutation(current, patch);
  if (issues.length) throw new ExperimentValidationError(issues);
}

/* ------------------------------------------------------------------ */
/* Effective status                                                    */
/* ------------------------------------------------------------------ */

/**
 * Status accounting for the scheduled window.
 *
 * Stored status and effective status differ when a `scheduled` experiment's
 * start time passes, or a `running` one's end time does, and no job has yet
 * updated the row. Serving decisions use this rather than the stored value so
 * that an experiment stops on time even if the scheduler is late.
 */
export function effectiveStatus(
  experiment: Pick<Experiment, "status" | "startAt" | "endAt">,
  now: Date,
): ExperimentStatus {
  if (experiment.status === "scheduled" && now >= experiment.startAt) {
    return experiment.endAt && now >= experiment.endAt ? "completed" : "running";
  }
  if (experiment.status === "running" && experiment.endAt && now >= experiment.endAt) {
    return "completed";
  }
  return experiment.status;
}
