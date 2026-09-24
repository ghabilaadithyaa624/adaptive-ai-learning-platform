# Offline IRT calibration and CAT-assistance study

## Status

Research-only. The production adaptive default is unchanged. No calibration artifact is loaded by serving unless a future, separately reviewed promotion path explicitly supplies one.

## Method

- Default model: regularized 2PL, `P(Y=1)=logistic(a(θ-b))`.
- Joint alternating optimization with L2 shrinkage and latent-scale anchoring.
- Minimum evidence: 50 item responses and 5 learner responses by default (the synthetic study pre-registers 40/item because of its finite cell design).
- Item uncertainty: approximate standard errors from observed Fisher information.
- Learner uncertainty: `SEM=1/sqrt(total information)` with a unit-normal prior contribution.
- Identification flags: insufficient sample, low information, discrimination at bounds, or guessing at bounds.
- 3PL is requested only explicitly and automatically falls back to 2PL unless there are at least 500 responses, at least 100 low-ability observations, broad truth/equating support, and 3+ answer options. The 2PL remains the default.
- Split: chronological training/test among development learners plus learners held out entirely.
- Provenance: model/version, dataset version, time cutoff, sample thresholds, row/learner counts, regularization and algorithm are immutable artifact fields.

The optional CAT assistant reranks only the top five candidates already admitted and explained by v3. It uses maximum calibrated Fisher information, abstains on poorly identified items, respects an exposure ceiling, and appends its version/information to the existing deterministic decision trace. Existing prerequisite, no-repeat, curriculum, and exposure logic runs first.

## Synthetic held-out comparison

Calibration: `research-2pl-v1`; 4,480 training responses, 70 learners, 22 sufficiently identified items. Held-out-learner ability RMSE was 1.276 theta units, mean SEM 0.687, over 80 responses per evaluation learner. This is weak estimation evidence, not production-grade calibration.

| Metric | Current v3 | IRT-assisted v3 |
|---|---:|---:|
| Learner-state estimation RMSE ↓ | **0.27958** | 0.28167 |
| Standard error of IRT ability ↓ | n/a | 0.68715 (offline held-out learner analysis) |
| Questions required for ability estimate ↓ | n/a | 80 in this protocol; target precision was not reliably reached early |
| Retained mastery gain ↑ | 0.90625 | **0.90957** |
| Prerequisite violations ↓ | **882** | 932 |
| Maximum item exposure share ↓ | 3.125% | 3.125% |
| Skill coverage ↑ | 6.9875 | **7.1500** |
| Eligible skill coverage ↑ | 99.063% | **99.219%** |
| Questions to mastery ↓ | 23.474 | **22.143** |

## Conclusion

The synthetic comparison does **not** support promoting IRT assistance. It shows a tiny retained-gain increase and somewhat faster observed mastery events, but worse learner-state RMSE and prerequisite safety. Ability RMSE/SEM are also too weak for operational CAT. These outcomes are reported together rather than selecting favorable metrics.

Before production use, require a versioned artifact trained on real telemetry, chronological and held-out-learner gains, stable parameter recovery/equating, acceptable item/ability standard errors, sufficient identified coverage within every required skill, no safety regression, exposure review, and shadow evaluation through the existing experiment process. A 3PL additionally requires reliable guessing identification; multiple-choice format alone is not evidence for estimating `c`.
