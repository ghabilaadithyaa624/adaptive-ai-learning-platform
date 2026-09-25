# Persistence boundaries: runtime validation of stored JSON

Drizzle's `jsonb(...).$type<T>()` is a **compile-time assertion, not a runtime
guarantee**. It tells TypeScript what we hope the column holds and then lets the
rest of the codebase index into it freely. Everything that has ever written to a
JSONB column — an older release, a migration, a hand-run SQL fix, a write that
failed halfway — can leave a shape the current build does not understand, and
the cast makes that byte-for-byte indistinguishable from good data.

This document is the inventory of those boundaries, the decision for each one,
and the contract the parsers in `src/lib/persistence` implement.

## The contract

Every parser returns a `ParseResult<T>` with exactly one of three statuses:

| Status | Meaning | Who fixes it |
| --- | --- | --- |
| `VALID` | Payload matches a supported schema version. Safe to use. | — |
| `INVALID` | Malformed: missing field, wrong type, corrupt nesting, `null` where an object is required. | Data-integrity incident. |
| `UNSUPPORTED_VERSION` | Well-formed, but written by a schema version this build cannot interpret (typically a rollback behind a newer writer). | Deployment: roll forward. |

The `INVALID` / `UNSUPPORTED_VERSION` split is not cosmetic. Corruption and a
version gap need different runbooks, and collapsing them would send a rollback
to the data-recovery page (or worse, the reverse). Correspondingly, a version
field of the *wrong type* is `INVALID` — we could not read a version at all —
while a well-formed unrecognised version is `UNSUPPORTED_VERSION`.

Rules the parsers hold to:

- **No coercion.** `"50"` is not `50`; `0`/`1` is not a boolean; `null` is not
  `{}`. A numeric string in a weight vector is the exact failure that produced
  `NaN` predictions, so it is rejected, not parsed with `Number()`.
- **No partial use.** A payload that fails anywhere is not used anywhere.
- **No silent defaults.** A field is defaulted only when the domain type
  declares it optional and the default is documented at the call site.
- **Legacy payloads keep working.** Rows written before the `schemaVersion`
  field existed are read as v1. Retiring the currently-deployed classifier row
  would be a regression, not a hardening.
- **Failures are structured and log-safe.** `ParseIssue` carries
  `{boundary, code, path, message, observed, version}` and never the payload,
  which can contain learner data.

Failures are reported through `src/lib/persistence/report.ts`: counters
`adaptiq_persisted_payload_reads_total{boundary,status}` and
`adaptiq_persisted_payload_rejections_total{boundary,status,code}`, plus a
`persistence.payload_rejected` log line. A degraded read is therefore visible on
the dashboard rather than inferred later from an unexplained accuracy drop.

### No new dependency

Validation is hand-written in the style of the existing `src/lib/validation.ts`
(explicit, zero-dependency), which is the project's established lightweight
answer to this problem. It is a *separate* module because the two guard
different things: `validation.ts` validates untrusted **request input** and
throws `HttpError(400)`; `persistence/` validates **our own stored state**,
where a failure is an operational fault and a 400 would be a lie.

## Boundary inventory

Every JSONB column in `src/db/schema.ts`, and the decision for each.

### Validated (structure is *interpreted* and drives ML/experiment behaviour)

| Column | Parser | Failure mode |
| --- | --- | --- |
| `ml_models.params` (classifier) | `parseClassifierParams` | Falls back to `HEURISTIC_MODEL`, loudly. |
| `ml_models.metrics` (classifier) | `parseModelMetrics` | Falls back to zeroed metrics; the model still serves. |
| `experiments.variants` | `parseExperimentVariants` | Throws `PersistedDataError`. |
| `experiments.eligibility` | `parseEligibilityRule` | Throws `PersistedDataError`. |
| `experiment_assignments.eligibility_snapshot` | `parseEligibilitySnapshot` | Throws `PersistedDataError`. |

Why these five, and why those different failure behaviours:

- **Classifier params** are the dot product behind every served probability.
  `loadClassifier` previously checked only `params?.weights?.length`, so
  `{weights: ["0.4", null]}` passed, `z` became `NaN`, every learner was clamped
  to `0.99`, and adaptive selection quietly degenerated with nothing logged.
  There *is* a known-good default here (the heuristic model), so the read
  degrades instead of failing — but it counts and logs the rejection.
- **Experiment variants** have no safe default. Serving the platform default
  policy while writing an exposure row labelled with a treatment arm permanently
  contaminates the experiment. Worse, `variantForBucket` accumulates
  `allocationPct`: one persisted `"50"` turns the accumulator into string
  concatenation and mis-assigns learners without ever throwing. This read fails
  loudly.
- **Eligibility rules and snapshots** decide and then *freeze* who is in the
  population. A corrupted snapshot does not crash anything — it silently
  reshapes the reported cohort, which is the worst failure this codebase can
  have: a wrong number that looks right.
- Both eligibility structures also fix a concrete lie the old casts told:
  `createdAfter` / `createdBefore` / `createdAt` are typed `Date` but JSONB
  round-trips them to ISO **strings**. `snapshot.createdAt.getTime()` threw at
  runtime while type-checking cleanly. The parsers revive them explicitly, and
  reject an unparseable instant rather than dropping the constraint.

### Not validated (inert data — deliberate, not overlooked)

| Column(s) | Why not |
| --- | --- |
| `skills.prereq_ids`, `questions.prerequisite_skill_ids`, `recommendations.target_skill_ids`, `path_milestones` ids | Scalar id arrays; consumers already treat them as opaque lists and a bad entry yields no join row, not a wrong computation. |
| `questions.options`, `questions.hints`, `questions.distractor_meta`, `questions.quality_flags` | Authored content, validated on the **write** path by `src/lib/questions/validation.ts`, and rendered rather than computed on. |
| `questions.calibration`, `item_statistics.*` (`flags`, `distractor_analysis`, `calibration`) | Reporting/analytics surfaces recomputed from responses; a malformed value shows as a blank panel, not as a wrong served decision. |
| `mastery_states.history`, `recommendations.factors` | Append-only display trails for charts and explanations. |
| `ml_models.hyperparams`, `model_evaluations.{metrics,detail,hyperparams}` | Provenance records. Read for display and comparison only; never deserialized back into a serving configuration. |
| `tutor_interactions.safety_flags`, `activity_events.*`, `audit_logs.*` | Write-mostly audit trails. |
| `experiments.secondary_metrics` | A string array whose members are re-checked against `SECONDARY_METRIC_KEYS` by `lifecycle.validateExperiment`. |

The line is: **is the structure interpreted as configuration or as evidence for
a decision?** If yes, parse it. If it is only echoed to a UI or an audit reader,
a parser would add failure modes without removing any.

## Scope: parsing vs. domain validation

The parsers check **shape and version** only. Experiment *semantics* —
allocations summing to ≤ 100, exactly one control arm, fingerprint freshness —
stay in `lifecycle.validateExperiment`, which already owns them and reports them
as user-facing issues. Duplicating those rules in the parser would fork the
contract and, concretely, would make a saved draft with two controls unloadable
— so an admin could never open it to fix it.

Two rules do live in the parser because they are structural rather than
semantic: duplicate variant keys (arms are resolved by key, so duplicates make
the served config depend on array order) and feature/weight arity mismatch
(weights indexed against a different feature contract silently score the wrong
feature).

## Versioning

Writers stamp `schemaVersion` (`serializeEligibilitySnapshot`, `saveClassifier`);
readers accept unstamped legacy payloads as v1. That asymmetry is what makes the
*next* shape change detectable instead of guessable, without invalidating what
is already in the database today.

To introduce a new shape: add the new version string to the parser's
`supported` list, branch on the resolved version inside the parser, and only
then change the writer. A build that reads a newer payload before it is deployed
reports `UNSUPPORTED_VERSION` and refuses to guess.

## Tests

`tests/unit/persistence-parsers.test.ts` covers, for each structure: valid
payload, missing field, wrong type, malformed nested object, unknown version,
legacy (unversioned) payload, null column, and a corrupted database value
(non-object, wrong container, empty object from a half-finished write), plus the
error-handling contract of `unwrapOrThrow` / `unwrapOrFallback`.
