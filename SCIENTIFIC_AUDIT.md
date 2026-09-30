# Scientific audit — evidence-driven adaptive learning

Date: 2026-09-29

This report distinguishes implementation from evidence. A documented capability is
not called scientifically validated or operationally verified without the
corresponding data and drill evidence.

## A. Status by evidence level

### Implemented

- Deterministic learner-state construction with mastery, uncertainty, retention,
  prerequisite readiness, error patterns, response time, and engagement signals.
- BKT, logistic response prediction, calibration as a separately versioned
  optional layer, v2/v3 policy selection, deterministic experiment assignment,
  and experiment exposure attribution.
- Runtime parsers for classifier parameters, metrics, experiment variants, and
  eligibility snapshots with explicit invalid and unsupported-version outcomes.
- Immutable decision-time persistence in `adaptive_decisions`, linked one-to-one
  to the served assessment item. It stores pre-response state, raw and served
  probabilities, item metadata, policy/calibration/BKT identity, experiment arm,
  cold-start status, candidate-set metadata, and the typed decision explanation.
- AI tutor separation: tutor interactions are telemetry/read-only snapshots and
  do not mutate mastery ground truth.
- Deterministic misconception episodes with explicit expert-ground-truth hooks.

### Tested in repository

- Extensive unit, integration, API, auth, tenant-isolation, persistence-parser,
  model-fallback, policy, calibration, and simulation test suites are present.
- Fallback metrics and warning deduplication have dedicated unit coverage in the
  repository.
- This checkout could not execute the suite because dependencies are not
  installed (`vitest: not found`, `tsc: not found`). Execution remains required
  in CI or after `npm ci`.

### Experimentally validated (research evidence only)

- Synthetic benchmark comparisons of policies, diagnostics, BKT variants, and
  IRT/CAT are recorded under `benchmarks/`.
- These results are useful for diagnosis and protocol development only. They do
  not establish real-learner retained-learning improvement.

### Production verified

- None of the following are verified by this repository alone: PostgreSQL
  backup/PITR restore drill, Redis production failover, deployment restart,
  alert delivery, connection-exhaustion behavior, or disaster recovery.
- Operations documentation is configuration guidance, not evidence of a completed
  operational drill.

## B. Research-only components

- IRT/CAT and IRT-assisted policy variants.
- Synthetic calibration artifacts and synthetic response-model results.
- Unvalidated calibrated serving variants.
- Skill-specific and shrinkage BKT variants until chronological held-out learner
  evidence demonstrates a robust benefit.
- Adaptive, fixed, and random cold-start strategies until held-out learner
  outcomes justify complexity.
- Misconception remediation effectiveness until expert-labeled precision and
  longitudinal resolution/retention data exist.

## C. Currently production-safe boundaries

- Deterministic question grading and BKT state updates, subject to normal
  database availability and migration completion.
- Existing deterministic v3 serving path with its current heuristic/model
  fallback; v3 superiority is not claimed.
- Tenant-scoped experiment assignment/exposure recording without automatic
  treatment promotion.
- Tutor explanations and hints as assistance only; tutor output is not mastery
  evidence.
- Identity calibration by default when no explicitly approved artifact is
  attached.

The new decision telemetry migration must be applied before relying on real-world
policy analysis; a failed telemetry write prevents serving the item because item
and decision creation are committed together.

## D. Scientifically unproven

- Real-data response-model calibration benefit and subgroup safety.
- Superiority of calibrated adaptive v3 over the mastery-gap baseline.
- Cold-start superiority over a simpler diagnostic.
- Misconception detector precision and remediation causal effect.
- BKT variant superiority.
- IRT/CAT benefit, exposure safety, and retained-learning benefit.
- Any claim of improved delayed retention without a completed controlled study.

## E. What should not be built now

Do not add more models, agents, dashboards, LLM-based labels, or another policy
family. The highest-value work is completing the evidence loop: reliable
decision-time telemetry, real learner data quality checks, chronological/held-out
analysis, and a governed shadow experiment.

## F. Single highest-value next experiment

Run a shadow comparison of the current production response probability and a
candidate calibration artifact using immutable `adaptive_decisions` telemetry,
without changing item selection. Fit only on an early chronological window,
evaluate on a future window and held-out learners, and report Brier, log loss,
ECE, MCE, reliability, calibration slope/intercept, confidence intervals, and
all required slices. Reject the calibrator if held-out Brier/log loss does not
improve, if any protected or operational subgroup materially degrades, or if
sample sufficiency and temporal provenance cannot be demonstrated.
