# Response-model diagnosis and calibration plan

## Executive conclusion

The benchmark identifies a **link-calibration** failure, not proof that the learner-state estimator or production response model should be retuned to the simulator. The synthetic world and serving model use different equations. The new calibration layer therefore leaves the base model intact, is identity by default, records the evidence source, and can only affect serving when an independently evaluated artifact is explicitly attached to the registered classifier.

No real-world improvement is claimed. There is not yet evidence here from held-out real learners that a non-identity calibrator improves production reliability.

## Audit of the current implementation

1. **Mathematical model.** `LogisticResponseModel` wraps a regularised logistic regression. It computes `sigmoid(w·standardize(x))`, clipped to `[.01,.99]`. Features are intercept, global ability, per-skill mastery, authored difficulty, ability-minus-difficulty, Bloom level, assumed/observed log response time, historical skill accuracy, and evidence confidence. The default is a hand-authored heuristic (`heuristic-0.1`, zero training samples); registry training uses gradient descent.
2. **Assumptions.** One global linear log-odds relationship; fixed feature effects; a common scale across skills/cohorts; historical behavior remains relevant; response time is known (or safely imputable); labels and telemetry are representative under the serving policy. Interactions and parameter uncertainty are absent.
3. **Mastery to probability.** Mastery is one positive logistic feature (weight `+0.95` in the heuristic), alongside ability (`+1.15`), skill accuracy (`+.85`) and evidence (`+.30`). Thus mastery is not a BKT observation equation and is partly duplicated by correlated features.
4. **Difficulty/discrimination/guess/slip.** Difficulty contributes directly (`-.85`) and via the ability-difficulty gap (`+.70`). Bloom and time reduce log odds. The production logistic equation does **not** use item discrimination, lower-asymptote guessing, or upper-asymptote slipping. Guess/slip belong to the BKT mastery update, not this response model. The simulator instead uses a 4PL-flavoured IRT response with discrimination, guessing/slipping, prerequisite support, memory, Bloom load, and fatigue. The +.241 synthetic gap is therefore structurally plausible.
5. **Question-bank correspondence.** The bank stores numeric `difficultyValue`, label, discrimination, and a JSON calibration container. Selection currently maps the difficulty **label** to a coarse number, despite the numeric field being available, and does not pass bank discrimination. The logistic feature contract also has no discrimination feature. Therefore correspondence is partial, not complete. Changing that contract requires a versioned model and real-data evaluation; it was not silently changed in this work.
6. **Real-data calibration.** Registry retraining uses assessment responses and reports Brier/ECE/MCE, but there was no separate post-hoc calibration artifact. The zero-sample heuristic is not calibrated on learner responses. A trained logistic model may be empirically fitted, but fitting and calibration are not equivalent.
7. **Temporal leakage.** Classifier registry training already uses a chronological split and training-only standardisation. The new calibration API also supplies chronological splitting. Remaining risk: mastery, accuracy, evidence, and response-time features must be snapshots computed strictly **before** the response; using final aggregates would leak outcomes. Calibration telemetry must log the serving-time raw prediction rather than reconstruct it from later state.
8. **Conditional calibration.** Existing evaluation gives global reliability bins only. It did not report reliability separately by skill, difficulty, Bloom level, cohort, or cold-start status. The new evaluator does.
9. **Cold start.** The response model uses fallback learner/skill states and the same equation. There is no separately trained cold-start mapping. The new reports isolate cold start; insufficient calibration evidence produces identity rather than a fitted mapping. A separate cold-start artifact should require adequate held-out support.
10. **Uncertainty.** Learner mastery uncertainty/confidence is a feature and an objective, but response-probability uncertainty or calibration-artifact parameter uncertainty is not represented. Reports expose sample counts and slices; serving remains a deterministic point estimate. Confidence intervals/bootstrap governance are a recommended promotion requirement, not fabricated in online serving.

## Architecture

`src/lib/ml/response-calibration.ts` adds:

- `predictResponseProbability(model, context)` — stable selector-facing entry point.
- `calibrateResponseProbability(raw, artifact)` — deterministic post-processing.
- `fitResponseCalibrator(rows, metadata)` — deterministic Platt scaling, weakly regularised toward identity, with a minimum evidence threshold.
- `evaluateResponseCalibration(rows, artifact)` — predicted-vs-observed reliability curves, Brier, ECE/MCE, and reliability by difficulty band, skill, cohort, Bloom level, and cold-start status.
- `splitCalibrationTelemetry(...)` — chronological evaluation plus strict held-out learners.
- `CalibratedResponseModel` — composition for any response model.

The registered logistic model can carry an optional calibration artifact. Loading/persistence preserves it; absence is identity. Both v2 and v3 selectors now consume the stable calibrated prediction interface. Artifacts include source (`synthetic`, `offline-historical`, `production`), version, sample count, cutoff, and held-out-learner status. This preserves deterministic serving and auditability.

Platt scaling is intentionally simple and explainable: `p_cal = sigmoid(a logit(p_raw) + b)`. It preserves ranking when `a > 0`. Promotion should reject non-positive slopes. Isotonic regression may be evaluated later for large datasets, but its variance and stepwise behavior need explicit governance.

## Three distinct evidence stages

### 1. Synthetic-world calibration

Purpose: test APIs, diagnose structural mismatch, and regression-test that known overconfidence can be corrected **inside that simulator**. Synthetic artifacts must remain tagged `synthetic`; they must never be promoted to production or described as real-world gains. The simulator’s 4PL-like truth is not learner evidence.

### 2. Offline historical-data calibration

Purpose: estimate whether a mapping generalizes to future real responses. Log immutable serving-time raw probability, model/calibrator versions, pre-response features, item metadata, learner pseudonymous ID, cohort, timestamp, and outcome. Fit on an early chronological window. Tune only on a later validation window. Report once on a untouched future test window and on learners entirely absent from fitting. Account for adaptive-policy selection bias and changes in item exposure.

Historical improvement is offline evidence, not proof of online impact. Report both raw and calibrated results, sample counts, base rates, confidence intervals, and every required slice. Never train on test rows or post-response learner state.

### 3. Real production calibration

Purpose: establish safety and benefit under current traffic. Begin shadow-only: compute calibrated values without changing selection. Check drift, latency, slice reliability, monotonicity, and sample sufficiency. Then use the existing experiment infrastructure for a limited, monitored rollout against identity calibration. Do not rewrite that infrastructure.

## Evidence required before production enablement

A promotion review should require all of the following:

1. immutable provenance and source=`production` (not synthetic), feature/model versions, training cutoff, and reproducible dataset signature;
2. strict pre-response feature construction audit and no learner/time leakage;
3. adequate samples overall and for safety-critical skills, difficulty bands, cohorts, Bloom levels, and cold-start learners;
4. lower held-out chronological and held-out-learner Brier and ECE, with MCE not materially worse; reliability curves and predicted-vs-observed rates included;
5. bootstrap confidence intervals or equivalent uncertainty analysis showing gains are not noise;
6. positive monotonic slope, bounded outputs, deterministic replay, and documented rollback to identity;
7. drift and subgroup review; no material degradation hidden by aggregate improvement;
8. shadow-production validation followed by the existing controlled experiment and monitoring process;
9. explicit approval and versioned registry promotion. Training alone must never auto-enable calibration.

## Telemetry notes

Do not use realized response time to select an item: it is unknown before serving. The current selector imputes expected time, while grading can use observed time; these are different prediction contexts and should be evaluated separately. Log `surface` and the exact raw probability at decision time. If policy changes alter the observed item distribution, evaluate by policy/version and consider propensity-aware analysis rather than treating telemetry as IID.
