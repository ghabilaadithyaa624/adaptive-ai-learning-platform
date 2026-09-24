# ML Model Registry & Evaluation

This document describes how models on the platform are trained, evaluated, versioned
and compared. The goal is **honest, reproducible, leakage-free** evaluation — we never
report a metric the data cannot support, and never claim a new model is "better"
without held-out evidence.

## Design principles

1. **No temporal leakage.** Behaviour here is time-dependent (mastery grows, difficulty
   is calibrated over time). Features are built *causally* — only information available
   *before* the prediction event contributes — and data is split *chronologically*, never
   randomly. Standardisation statistics are learned on the training partition only.
2. **Undefined metrics are `null`, not fabricated.** ROC-AUC requires both classes,
   PR-AUC requires ≥1 positive, MAPE is excluded when any actual is ≈0. Each such metric
   carries an `*Applicable` flag.
3. **Reproducibility.** Every trained model stores its model version, dataset version,
   feature version, hyperparameters, sample count, and training + evaluation timestamps.
4. **Evidence-gated comparison.** A candidate is only promoted over a baseline when it
   was evaluated on enough held-out samples, improves the primary metric beyond a noise
   threshold, and does not regress any guarded metric.

## Metric coverage by model family

### Classification / prediction (`evaluateClassification`)
Accuracy, precision, recall, F1, specificity, ROC-AUC, PR-AUC (average precision),
log loss, Brier score, calibration error (ECE + MCE + reliability bins) and the full
confusion matrix.

### Forecasting / regression (`evaluateForecast`)
MAE, RMSE, MAPE (only when no actual ≈ 0 — otherwise `null`), sMAPE, bias, and
prediction-interval coverage (PICP) against a nominal coverage level.

### Recommendation (`rankingMetricsAtK`, `evaluateRecommendationOutcomes`)
Precision@K, Recall@K, NDCG@K (graded gains supported), plus acceptance rate,
completion rate, dismissal rate and post-recommendation learning gain (`null` when no
before/after mastery is available).

### Knowledge tracing (`evaluateKnowledgeTracing`)
Next-step predictive accuracy + calibration (via the classification report), and mastery
estimation stability: volatility, oscillation, monotonicity and a composite stability
score. Temporal validation is enforced by the chronological split utilities.

## Temporal splitting (`src/lib/ml/splits.ts`)

- `chronologicalSplit` — orders by time then slices into train / validation / test so the
  test set is always the most-recent block. Guarantees `max(train time) <= min(test time)`.
- `expandingWindowFolds` — forward-chaining cross-validation: each fold trains on a growing
  past prefix and tests on the next future block.
- `isLeakageFree` — assertion used in tests to prove a split does not leak the future.

## Comparison & regression detection (`src/lib/ml/model-compare.ts`)

- `METRIC_DIRECTIONS` — declares, per metric, whether higher or lower is better.
- `compareMetrics` — per-metric verdict (improved / regressed / unchanged / incomparable),
  respecting direction and a noise tolerance.
- `decidePromotion` — the gate. Returns `promote` + a verdict of `improved`, `regressed`,
  `mixed`, `unchanged` or `insufficient-evidence`. It **abstains** rather than over-claims
  when samples are too few or the primary metric is missing on either side, and blocks
  promotion when any guarded metric regresses.

## Persistence

- `ml_models` — latest snapshot per model (upserted by name): version, `dataset_version`,
  `feature_version`, `params`, `hyperparams`, `metrics`, `samples`, `trained_at`,
  `evaluated_at`.
- `model_evaluations` — immutable append-only history. Every retrain writes a row with the
  held-out metrics, the confusion matrix / reliability bins / promotion decision (`detail`),
  hyperparameters and versions — this is what powers regression detection across retrains.

## Flow: retraining the difficulty classifier

`trainAndPersistClassifier` (`src/lib/ml/registry.ts`):
1. Pull every logged response ordered by `created_at`.
2. Build features causally (running per-learner/skill stats from prior responses only).
3. Compute a deterministic `datasetSignature` (count + time span + checksum).
4. `chronologicalSplit` into 70 / 15 / 15 train / validation / test.
5. Train logistic regression on the training rows; standardise on train stats only.
6. Evaluate on the held-out **test** block with the full metric library.
7. Compare against the previous evaluation and record a `model_evaluations` row.
8. Upsert the model snapshot with full provenance.

## API (`/api/ml`)

- `POST { action: "train" }` → retrains and returns the model, its provenance, and an
  evidence-gated `comparison` (verdict, reasons, per-metric deltas, regression alerts).
- `POST { action: "evaluate" }` → comprehensive held-out report on live serving
  predictions: full metrics, confusion matrix, reliability bins, a most-recent temporal
  holdout slice, and recent evaluation history.
- `POST { action: "predict" }` → what-if scoring for a learner × item pair.
- `GET` → the model registry + total training samples.

## Tests

- `tests/evaluation.test.ts` — hand-computed expected values for every metric family.
- `tests/splits.test.ts` — chronological ordering, split boundaries, leakage-freedom.
- `tests/model-compare.test.ts` — direction handling, regression detection, promotion gates.

Run with `npm test`.
