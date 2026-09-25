# BKT parameter calibration (offline)

Evidence-based, skill-specific BKT parameter estimation. **Nothing in this
pipeline changes serving.** It fits, evaluates, and recommends; adopting
parameters is a deliberate human edit.

- `src/lib/ml/bkt-calibration.ts` — estimator, splits, evidence gates, artifact
- `src/lib/ml/bkt-evaluation.ts` — replay, metrics, promotion gate
- `benchmarks/bkt-calibrate.ts` — runnable pipeline (`npm run bench:bkt`)
- `tests/unit/bkt-calibration.test.ts` — 36 tests, incl. parameter recovery

---

## 1. Current parameterization (audited, not assumed)

| Parameter | Value | Where it lives |
| --- | --- | --- |
| learn `T` | **0.22** | `knowledge-tracing.ts` `DEFAULT_BKT` |
| slip `S` | **0.10** | `knowledge-tracing.ts` `DEFAULT_BKT` |
| guess `G` | **0.20** | `knowledge-tracing.ts` `DEFAULT_BKT` |
| forget | **0.035 / day** | `applyDecay`, applied *outside* the BKT recursion |
| initial mastery `L0` | **0.3 / 0.4 / 0.5 / 0** | four different values — see below |

These are recorded as code in `CURRENT_SERVING_PARAMS`, with a test asserting
they stay in sync with the real constants, so the comparison baseline cannot
silently drift from what production runs.

### Finding 1 — initial mastery has four values

The prior a learner starts from depends on which door they came through:

| Value | Source | When it applies |
| --- | --- | --- |
| `0.3` | `models/bkt.ts` `DEFAULT_BKT_EXT.priorMastery` | the BKT model's own prior |
| `0.4` | `mastery_states.mastery` / `prior_mastery` column defaults | any newly created state row |
| `0.5` | `engine.ts:544` | first touch of a skill in a diagnostic |
| `0` | `engine.ts:69` `loadSkillFeatures` | no state row exists yet |

The `0` is the most consequential: a skill with no evidence is fed to the
selection policy as *certainly unmastered* rather than *unknown*, which is a
different claim. This is not fixed here — it is a serving change and this task
is explicitly offline-only — but a calibrated `L0` makes the gap measurable.

### Finding 2 — "per-skill" parameters already exist, and are inert

`mastery_states` carries `slip`, `guess`, `learn_rate` columns **per
(student, skill)** row. They are read by `engine.ts:550`, but every writer seeds
them from the global defaults (`seed.ts:388`), so they are global values stored
N times. The schema was ready for this work; the estimation never existed.

### Finding 3 — forgetting is not a BKT parameter here

`forget` is applied as between-session exponential decay on stored mastery, not
as a transition inside the recursion. This pipeline therefore **does not fit
it** (`FORGET_POLICY`): fitting a within-sequence forget transition would
estimate a different quantity from the one the engine applies, and adopting it
would silently change semantics. Estimating the decay rate needs spaced-retention
data (same skill, long gap, no intervening practice) and is a separate study.

---

## 2. Pipeline

```
responses ─► evidence gate ─► split ─► EM fit ─► shrinkage ─► artifact ─► evaluation ─► recommendation
                   │                                                                         │
                   └── insufficient ──► keep current parameters, report what is missing ◄────┘
```

**Estimator.** Expectation-Maximisation with a scaled forward-backward pass over
the two-state BKT chain (absorbing `known`). EM respects the latent-state
structure; gradient descent on the raw likelihood does not. Initialised at the
current serving parameters, so "no signal" converges back to production.

**Splits.** Two independent generalisation tests, because they fail differently:

- *held-out learners* (20%, deterministic FNV hash) — catches memorising the
  training population;
- *chronological* (last 20% of the remaining learners' responses) — catches
  riding a population trend that will not repeat.

**No post-response leakage.** Evaluation replays sequences from their start:
the prediction for response *t* uses only responses 1…*t*−1. A test asserts the
first prediction equals exactly the prior's implied P(correct).

**Minimum evidence** (`DEFAULT_THRESHOLDS`, chosen from the literature *before*
looking at any result):

| Gate | Default | Why |
| --- | --- | --- |
| responses per skill | 200 | common floor for a stable 4-parameter BKT fit |
| distinct learners per skill | 30 | stops one learner defining a skill |
| multi-response sequences per skill | 30 | only transitions carry the learn rate |
| responses per sequence | 2 | structural: one response has no transition |
| total responses | 2000 | below this, do not fit at all |

**Shrinkage.** `w = n / (n + 300)` toward the pooled global fit; a skill with 300
opportunities sits halfway. Both the shrunk value and the `rawFit` are kept in
the artifact for audit.

**Degeneracy rejection.** BKT is only weakly identified (Beck & Chang 2007):
different (L0, T, S, G) tuples fit nearly equally well, and some are degenerate —
slip 0.6 / guess 0.5 predicts responses acceptably while making mastery
meaningless, so the learner never "advances" no matter what they do. Parameters
are bounded (`S ≤ 0.3`, `G ≤ 0.4`, `S + G ≤ 0.9`) and a fit that lands on those
bounds is **discarded, not shrunk** — shrinking a broken fit would launder it
into the shipped parameters.

**Reproducibility.** No `Math.random`, no wall clock, stable tie-breaking on
equal timestamps. Same rows + same options ⇒ byte-identical artifact (tested).
Every artifact carries `schemaVersion`, `version`, dataset fingerprint,
`trainedThrough`, thresholds, bounds, and the algorithm string.

---

## 3. Estimator validation

The pipeline is only worth reading if the estimator works. Generating data from
a *known* BKT process and recovering it:

| Truth (L0, T, S, G) | n = 600 | n = 2 400 | n = 9 600 |
| --- | --- | --- | --- |
| 0.25, 0.15, 0.08, 0.22 | 0.32, 0.19, 0.10, 0.26 | 0.30, 0.15, 0.08, 0.23 | **0.25, 0.16, 0.08, 0.23** |
| 0.10, 0.30, 0.05, 0.15 | 0.05, 0.27, 0.06, 0.20 | 0.04, 0.28, 0.04, 0.19 | **0.07, 0.28, 0.05, 0.16** |
| 0.50, 0.08, 0.15, 0.30 | 0.43, 0.07, 0.16, 0.37 | 0.52, 0.08, 0.15, 0.30 | **0.49, 0.08, 0.15, 0.29** |

Recovery is accurate and tightens with sample size, as it should. **This also
calibrates the thresholds honestly:** at the 200-response minimum, parameter
error is still ~0.05–0.07 — which is exactly why shrinkage is not optional at
that sample size, and why a skill should really have ≳2 000 responses before its
raw fit is trusted on its own.

---

## 4. Evaluation

Three variants, identical estimator/split/metrics, differing only in
eligibility and shrinkage:

1. **current global BKT** — pooled fit, every skill shares it
2. **skill-specific BKT** — per-skill fit where evidence allows
3. **skill-specific + shrinkage** — as above, blended toward the global fit

Measured on both held-out sets: next-response accuracy, Brier, log-loss,
calibration (ECE/MCE + reliability bins), mastery-estimation RMSE, mastery
volatility/stability, temporal stability (Brier SD across chronological blocks),
and a downstream selection proxy (ZPD hit rate, information per item,
premature-mastery rate).

Two honesty constraints worth naming:

- **Mastery RMSE is `null` on real data.** Latent mastery is unobservable; it is
  only scored where simulation ground truth exists. A proxy here would be
  indistinguishable from a measurement.
- **The selection metric is observational, not counterfactual.** Logged responses
  were served by the current policy, so we cannot know what a re-parameterised
  policy *would have picked*. It measures whether a variant's beliefs would place
  already-served items in the productive band — enough to catch systematically
  high/low mastery, not enough to claim a learning-outcome improvement. That
  needs the simulation harness and then a live experiment.

---

## 5. Promotion — never automatic

`assessBktPromotion` returns `autoPromote: false` unconditionally. Primary metric
is **Brier on held-out learners** (a proper scoring rule; threshold accuracy is
insensitive to exactly the probability shifts that matter for selection), with
guarded metrics on log-loss, calibration, accuracy and stability. A candidate is
additionally blocked when it:

- has < 500 held-out responses,
- earned no per-skill parameters (it is the global model in disguise),
- regresses temporal stability (Brier SD > 1.5× baseline), or
- raises the premature-mastery rate by > 1pp.

Adoption path: `npm run bench:bkt` → review
`benchmarks/BKT_CALIBRATION_RESULTS.md` → simulation harness (`npm run bench`) →
shadow/experiment arm (`EXPERIMENTATION.md`) → only then edit the serving
constants.

---

## 6. Current status: **not adoptable — insufficient real evidence**

`npm run bench:bkt` in this environment has no production database, so it ran
against the deterministic synthetic world in `benchmarks/world.ts`
(18 457 responses, 220 learners, 8 skills). Result:

| Variant | Brier (held-out) | Accuracy | ECE | Skills with own params |
| --- | --- | --- | --- | --- |
| current global | **0.24504** | 55.21% | 0.0083 | 0 |
| skill-specific | 0.24539 | 55.15% | 0.0101 | 1 / 8 |
| skill-specific + shrinkage | 0.24534 | 55.15% | 0.0097 | 1 / 8 |

**Recommendation: keep the current parameters.** Neither candidate improved on
the baseline, and 7 of 8 skills produced fits pinned at the slip/guess bounds,
which the degeneracy check rejected.

That result is a statement about the *synthetic corpus*, not about the method:
that world generates responses from an IRT-style ability/memory model with
per-item difficulty spread within each skill, which BKT's single-latent-bit
model cannot represent — so EM pushes the noise parameters to their ceilings.
Since the estimator demonstrably recovers true BKT parameters (§3), the right
reading is "this data cannot justify skill-specific BKT", and the pipeline
correctly refused rather than shipping bound-pinned parameters.

### Minimum evidence required before this is worth re-running

Per skill you intend to parameterise:

- **≥ 200 graded responses** (hard gate) — and realistically **≥ 2 000** for the
  raw fit to be trustworthy without heavy shrinkage (§3)
- **≥ 30 distinct learners**
- **≥ 30 sequences of ≥ 2 responses** on that skill

Across the corpus:

- **≥ 2 000 total graded responses** (hard gate)
- **≥ 500 responses from held-out learners** for the promotion gate to return
  anything other than `insufficient-evidence`
- **multiple practice opportunities per learner per skill** — single-attempt
  data cannot identify the learn rate at all, whatever its volume
- ideally **≥ 2 distinct time blocks** of real traffic, so temporal stability is
  measurable rather than vacuous

Until then the current global parameters stand, which is the correct default:
they are wrong in a known, uniform way, whereas bound-pinned per-skill
parameters are wrong in a way that silently breaks mastery for specific skills.
