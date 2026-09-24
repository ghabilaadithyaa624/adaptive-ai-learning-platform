# Experimentation framework

Controlled comparison of adaptive-learning policies on live traffic.

The offline simulator (`SIMULATION.md`) can tell you how policies behave under
an assumed model of learning. It cannot tell you what happens to real learners.
This framework is the other half: deterministic assignment, exposure tracking,
and leakage-resistant metric attribution, so a policy change can be measured
instead of asserted.

> **It does not pick winners.** The readout reports estimates with uncertainty
> intervals and stops. There is no `winner`, `significant`, `pValue` or
> `recommendation` field anywhere in the payload — see §6.

---

## 1. Quick start

```ts
import {
  createExperiment, setExperimentStatus,
  assignLearnerToActiveExperiments, strategyForConfig, recordExposure,
  analyseExperiment, formatReadout,
} from "@/lib/experiments";

// Define
const exp = await createExperiment({
  scope: { institutionId: 7 },
  draft: {
    key: "v3-vs-mastery-gap",
    name: "Is adaptive v3 beating the trivial baseline?",
    hypothesis: "v3 produces more mastery gain than a mastery-gap heuristic.",
    institutionId: 7,
    primaryMetric: "masteryGain",
    secondaryMetrics: ["zpdHitRate", "completion", "calibration"],
    eligibility: { minPriorAttempts: 10 },
    startAt: new Date("2026-03-01"),
    endAt: new Date("2026-05-01"),
    variants: [
      { key: "control",  label: "Mastery-gap", allocationPct: 50, isControl: true,
        config: { policy: "mastery-gap-baseline", version: "1.0.0" } },
      { key: "treatment", label: "Adaptive v3", allocationPct: 50, isControl: false,
        config: { policy: "adaptive-v3", version: "1.0.0" } },
    ],
  },
});
await setExperimentStatus({ scope, experimentId: exp.id, status: "running", now: new Date() });

// Read out
console.log(formatReadout(await analyseExperiment(exp, new Date())));
```

Serving is already wired into `src/lib/engine.ts` — an enrolled learner is
automatically served by their variant's policy and an exposure is recorded
against the item. No call-site changes are needed to run an experiment.

---

## 2. Entities

| Entity | Table | Purpose |
| :--- | :--- | :--- |
| Experiment | `experiments` | Definition: variants, allocation, window, eligibility, metrics, status |
| Assignment | `experiment_assignments` | A learner's binding to one variant, with a frozen eligibility snapshot |
| Exposure | `experiment_exposures` | One moment a learner was actually *served* by a variant |

**Experiment** carries: `key` (stable id, unique per tenant), `variants` with
`allocationPct`, `startAt`/`endAt`, `eligibility`, `primaryMetric`,
`secondaryMetrics`, `status`, `assignmentStrategy`, `salt`, `exclusionGroup`,
and a **versioned policy configuration** per variant.

### Versioned policy configuration

An arm is not identified by its policy alone — two arms can run `adaptive-v3`
with different weights. Each variant carries:

```ts
{ policy: "adaptive-v3", version: "1.2.0",
  weights: { zpdTargeting: 0.25 }, params: { prereqGate: 0.55 },
  fingerprint: "adaptive-v3@1.2.0#k3n1xp" }
```

`fingerprint` is a deterministic digest of the whole config (keys sorted, floats
normalised) and is written onto **every exposure row**. If someone edits a
weight mid-flight, the change shows up in the data rather than silently mixing
into the previous arm's results. `validateExperiment` rejects a definition whose
fingerprint does not match its config.

---

## 3. Policy variants

All six are real serving strategies, not simulator-only constructs.

| Variant | Tier | Behaviour |
| :--- | :--- | :--- |
| `legacy` | legacy | Pre-v2 scorer preserved verbatim, including its mastery-blind difficulty targeting |
| `adaptive-v2` | production | Weighted 10-criteria selector, point-estimate prerequisite gate |
| `adaptive-v3` | production | Multi-objective policy; the only arm that accepts weight/param overrides |
| `random-baseline` | baseline | Uniform over unseen items, seeded |
| `difficulty-baseline` | baseline | Closest difficulty to estimated ability |
| `mastery-gap-baseline` | baseline | Easiest unseen item in the least-mastered skill |

The baselines exist in production for a specific reason: offline simulation
found `mastery-gap-baseline` **out-learning every adaptive policy**
(`SIMULATION.md` §6.1). "Is the adaptive engine better than a trivial
heuristic?" has to be answerable on live traffic, so the heuristic has to be
runnable on live traffic.

Baselines deliberately ignore prerequisites. That is what makes them controls:
it isolates how much benefit comes from prerequisite safety versus everything
else. All six emit a machine-readable `DecisionExplanation` for every selection,
so explainability does not degrade in a control arm.

---

## 4. Deterministic assignment

```
bucket = hash(`${experimentKey}:${salt}:${studentId}`) / 2^32   ∈ [0, 1)
variant = first arm whose cumulative allocation exceeds the bucket
```

Pure function. No counters, no `Math.random`, no wall clock, no database
sequence. Anyone can recompute any historical assignment from the experiment key
and a learner id — `bucketFor()` is exported for exactly that.

Three implementation details that are load-bearing:

- **Avalanche finaliser.** Plain FNV-1a distributes short similar inputs
  (`exp:salt:1`, `exp:salt:2`, …) poorly; consecutive learner ids would land in
  correlated buckets and a 50/50 split would become a split by signup order.
- **`>>> 0` coercion.** JS bitwise operators return *signed* int32. Without the
  coercion every bucket falls in [0, 0.5) and no learner ever reaches the second
  variant. A test asserts the mean bucket is ≈0.5 over 4000 ids.
- **Allocation sorts by variant key, not array order.** Reordering variants in a
  config file must not re-bucket live learners.

### Stability

A learner keeps their variant for the life of the experiment. This is enforced
twice: a persisted assignment row (the journal) and a unique index on
`(experiment_id, student_id)` (the guarantee). Concurrent first-time
assignments use `ON CONFLICT DO NOTHING` + re-read, so the first writer wins and
every other caller adopts that variant rather than its own recomputation.

Stickiness survives **allocation changes** — reweighting traffic mid-flight
never moves someone who is already mid-treatment.

Opt out with `assignmentStrategy: "rolling"`, which recomputes on every call.
Only appropriate for stateless surfaces; it destroys per-learner causal
attribution, so it is explicit rather than a default.

### Order of checks

Tenant and window checks run **before** the sticky short-circuit, so pausing an
experiment actually stops treatment for the existing cohort — the one case where
you most need pause to work. Eligibility runs **after** it, so an enrolled
learner is never ejected for drifting out of the population.

---

## 5. Metrics

**Primary** (learning outcomes only — the framework rejects anything else as a
primary metric, because the platform's objective is learning):

| Metric | Definition |
| :--- | :--- |
| `masteryGain` | Sum of per-item mastery deltas after exposure |
| `timeToMastery` | Minutes of on-task time until a skill first crosses the threshold |
| `retention` | Accuracy on skills re-encountered ≥7 days after their peak |
| `questionsToMastery` | Items served until a skill first crosses the threshold |

**Secondary**: `zpdHitRate`, `recommendationAcceptance`, `completion`,
`informationGain`, `calibration`, `engagement`.

The unit of analysis is the **learner**, not the item, because the learner is
the unit of randomisation. Averaging over items would weight heavy users more
heavily and produce intervals that are too narrow.

### Attribution rules

Each rule prevents a specific, named failure. All are enforced in one pure
function (`attribution.ts`) and every rejection is counted and reported.

| Rule | Guarantee | Failure it prevents |
| :--- | :--- | :--- |
| **R1** | Only observations at/after **first exposure** count | Crediting pre-existing progress to whichever arm a learner later joined |
| **R2** | Observation variant must match the **assignment** variant, else dropped and counted | Silent re-bucketing corrupting both arms |
| **R3** | Observations after `endAt` excluded | A long-running learner accruing outcomes into a concluded readout |
| **R4** | Observations filtered to the experiment's institution | One customer's outcomes leaking into another's readout |
| **R5** | Learners with no qualifying observation are **censored, not zero-filled** | An arm with fewer completers looking worse at learning |

**Exposure gates attribution.** Being assigned is not being treated: a learner
enrolled but never served by the policy contributes no outcome data, or the
experiment measures enrolment rather than treatment. `loadAnalysisDataset` only
produces subjects for learners with *both* an assignment and an exposure.

Eligibility is evaluated once and **frozen** into the assignment row.
Re-deriving it at analysis time would let learners fall out of the population as
their attempt counts grow, biasing the readout toward whoever still qualifies.

---

## 6. Reporting — and why there is no winner

`VariantComparison` contains a point estimate, a Welch interval, a percentile
bootstrap interval, Hedges' *g*, and `resolution`. It contains no verdict of any
kind, and a test asserts the serialised payload contains none of `winner`,
`significant`, `pValue`, `recommendation` or `verdict` — verified against a
tampered payload to confirm the check actually bites.

Three reasons this is the right default for learning experiments:

1. **Peeking.** Learning outcomes accrue over weeks, so readouts get checked
   repeatedly. Any fixed threshold on a repeatedly-viewed interval will
   eventually be crossed by noise alone.
2. **Multiplicity.** Four primary and six secondary metrics across several arms
   means something is nearly always "significant". A verdict per metric would
   industrialise that error.
3. **The metrics disagree on purpose.** A policy can raise mastery gain and
   depress completion. Which trade is acceptable is a product judgement;
   collapsing it into a boolean hides the judgement rather than making it.

What is reported instead:

- **`resolution`** — the smallest difference this sample could distinguish. The
  antidote to reading a null result as proof of equivalence: if resolution is
  ±0.15 and the observed difference is 0.02, the experiment is uninformative,
  not negative.
- **Coverage and censoring** per arm, with a note when coverage drops below 50%.
- **Zero-width intervals flagged** as an artefact, not precision — they occur
  when every value in an arm is identical (usually tiny *n*) and would otherwise
  render as infinite certainty.
- **Attribution diagnostics** promoted into prose: non-zero `conflicts` means
  re-bucketing happened and the numbers should not be trusted yet.
- **Welch vs bootstrap** side by side; disagreement signals skew, which
  time-to-mastery routinely has.

Statistical choices: Welch (not pooled) because arms differ in variance exactly
when the treatment is doing something interesting; Wilson (not Wald) for
proportions because completion rates sit near 0/1 and Wald produces impossible
bounds; Hedges' *g* (not Cohen's *d*) because single-institution cohorts are
small enough for the correction to matter.

---

## 7. Isolation

**Tenant.** Every read is scoped: an institution sees its own experiments plus
platform-wide ones, never another tenant's. Enforced in SQL (`tenantFilter`), in
the assignment function (`tenant-mismatch` outcome, checked *before*
stickiness), and again in attribution (R4). Creating an experiment outside your
own scope throws.

The unique-key constraint uses **two partial indexes** rather than one composite
index, because SQL treats NULLs as distinct — a plain unique index on
`(institution_id, key)` accepts two platform-wide experiments with the same key,
and then key lookup returns an arbitrary one. (Found by testing the migration
against a real Postgres; the original composite index had this bug.)

**Cross-experiment.** Experiments sharing an `exclusionGroup` never enrol the
same learner. Two experiments that both change item selection would otherwise
interact and neither result would be interpretable. Resolution is deterministic:
active experiments are processed in key order, so the same one always wins.

Salts are per-experiment so a learner in the treatment arm of one experiment is
not systematically in the treatment arm of the next.

---

## 8. Lifecycle

```
draft ──▶ scheduled ──▶ running ⇄ paused ──▶ completed ──▶ archived
  └──────────────────────┘           └───────────────────────┘
```

`completed` and `archived` are terminal. Restarting a concluded experiment would
append a second, differently-conditioned population to the same readout —
re-running a hypothesis means a new experiment with a new key, which also gives
it a fresh, uncorrelated bucketing.

**Frozen while running**: `key`, `salt`, `variants`, `eligibility`,
`primaryMetric`, `assignmentStrategy`, `exclusionGroup`. These determine who
sees what; changing any of them re-buckets someone. `guardMutation` rejects such
edits with a message that says so. Widening `endAt`, adding secondary metrics,
and renaming are allowed.

`effectiveStatus()` accounts for the schedule, so an experiment starts and stops
on time even if no scheduler job has updated the row.

---

## 9. Tests

`tests/unit/experiments.test.ts` — 74 tests, no database required, covering
stable assignment, tenant isolation, eligibility, metric attribution, variant
exposure, lifecycle, neutral reporting and statistics. The decision rules are
pure functions specifically so they can be tested this way.

`tests/db/experiments.test.ts` — 15 tests for what only a real database can
prove: the unique index under concurrency, `ON CONFLICT DO NOTHING` semantics,
tenant scoping as SQL, cascade deletes, and persistence round trips. Skips
cleanly without `TEST_DATABASE_URL`.

```bash
npx vitest run tests/unit/experiments.test.ts
TEST_DATABASE_URL=postgres://... npx vitest run tests/db/experiments.test.ts
```

---

## 10. Limitations

- **No sequential testing.** Intervals are nominal and uncorrected for repeated
  viewing. If you need to peek continuously and act on it, this framework's
  readout is not a sufficient basis — add an alpha-spending or always-valid
  procedure first.
- **No variance reduction.** No CUPED or covariate adjustment, so experiments
  need more traffic than they strictly must. Pre-exposure data is available in
  the frozen eligibility snapshot if this is added later.
- **No interference model.** Learners are assumed independent. That is wrong for
  classroom cohorts where learners interact; a cluster-randomised design
  (assigning classes rather than learners) is not yet supported.
- **Engagement uses answered items** as its activity signal, so it measures
  practice days rather than logins.
- **Exposure is per served item.** Surfaces other than item selection are not
  yet instrumented; `surface` exists on the exposure row to support them.
