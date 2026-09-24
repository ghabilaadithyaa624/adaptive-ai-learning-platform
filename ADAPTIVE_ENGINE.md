# Adaptive Learning Engine — v2

Senior-ML upgrade of the existing engine. The working modules (BKT, classifier,
gap detector, recommender, forecaster, registry) were **kept and wrapped**, not
replaced. The upgrade adds a composite learner model, a stronger, fully
explainable item selector, and clean interfaces so BKT / IRT / Bayesian /
contextual-bandit strategies are swappable.

Everything is **deterministic** (seeded, no wall-clock reads inside the pure
core) and **explainable** (no LLM in any assessment decision).

---

## What was already there (understood first)

| Module | Role |
| --- | --- |
| `ml/knowledge-tracing.ts` | BKT posterior + forgetting decay + P(correct) |
| `ml/classifier.ts` | Logistic-regression P(correct) with 9 features, trainable, metrics |
| `ml/adaptive.ts` | Legacy CAT selector (skill priority + ZPD/info scoring) |
| `ml/gaps.ts` | Wilson-bound gap severity classifier |
| `ml/recommender.ts` | Hybrid skill ranking + prereq-ordered path builder |
| `ml/forecast.ts` | Linear-regression performance forecast |
| `ml/registry.ts` | Model persistence + retraining on live responses |
| `engine.ts` | DB orchestration of the above |

The two key weaknesses found: (1) selection fed the classifier a **fixed**
`masteryBefore = 0.5` instead of the learner's real per-skill mastery; (2) it
reasoned over a thin state (mastery + attempts + staleness) and had no
prerequisite gating, spaced review, uncertainty or exploration.

---

## New architecture (additive)

```
src/lib/ml/
  interfaces.ts        # contracts: KnowledgeTracingModel, ResponseModel,
                       #            ItemSelectionStrategy + all domain types
  learner-state.ts     # buildLearnerState(): the 15-signal composite (pure)
  selection.ts         # AdaptiveSelector v2: 10-criteria scoring + explanation
  explain.ts           # deterministic natural-language explanations
  models/
    bkt.ts             # BKT  → KnowledgeTracingModel (wraps knowledge-tracing.ts)
    irt.ts             # 2PL IRT → KnowledgeTracingModel (theta + Fisher info)
    bayesian.ts        # Beta-Bernoulli → KnowledgeTracingModel (closed-form uncertainty)
    logistic.ts        # classifier → ResponseModel (default P(correct))
    bandit.ts          # deterministic UCB1 exploration bonus
```

### Pluggable interfaces (future-proofing)

- **`KnowledgeTracingModel`** — `prior / observe / decay / predictCorrect`.
  Implemented by **BKT**, **IRT (2PL)** and **Bayesian (Beta-Bernoulli)**. A
  uniform `SkillBelief { mastery, uncertainty, confidence, stats }` keeps model
  internals (Beta counts, IRT `theta`, Fisher information) opaque.
- **`ResponseModel`** — `predict(ctx) → P(correct)`. Implemented by
  `LogisticResponseModel` (wraps the trained classifier) and
  `responseModelFromKnowledge()` (any tracing model). A **contextual bandit** can
  drop in as another `ResponseModel`/exploration source without touching the
  selector.
- **`ItemSelectionStrategy`** — `select(input) → SelectionResult`. The engine
  depends on the interface, so the whole policy is swappable/A-B testable.

---

## The composite learner model (15 signals)

`buildLearnerState()` fuses all requested signals from mastery states + recent
responses + the skill graph (pure function, `now` injected):

| # | Signal | Where |
| --- | --- | --- |
| 1 | Skill mastery | `skill.mastery` (decay-adjusted) |
| 2 | Recent performance | `skill.recentAccuracy`, `learner.recentAccuracy` |
| 3 | Historical performance | `skill.accuracy`, `learner.historicalAccuracy` |
| 4 | Response time | `skill.responseRatio` (observed/expected) |
| 5 | Question difficulty faced | `skill.avgDifficulty` |
| 6 | Bloom level faced | `skill.avgBloom` |
| 7 | Attempt count | `skill.attempts` |
| 8 | Confidence / evidence | `skill.confidence` / `skill.uncertainty` (Beta posterior) |
| 9 | Forgetting / retention | `skill.retention`, `skill.daysSincePractice` |
| 10 | Prerequisite mastery | `skill.prereqReadiness` (bottleneck of prereqs) |
| 11 | Assessment context | `learner.context` (mode, progress, fatigue) |
| 12 | Learning velocity | `skill.velocity` (slope of mastery history) |
| 13 | Error patterns | `skill.errorProfile` (careless / struggling / guessing / slipping) |
| 14 | Hint usage | `skill.hintReliance` / `hasHintData` (only when data exists) |
| 15 | Recent engagement | `learner.engagement` (recency + volume + consistency) |

---

## Next-item selection (10 criteria)

`AdaptiveSelector.select()` scores each candidate with a transparent weighted
blend; every term is surfaced as a `DecisionFactor` and folded into the
explanation.

| # | Criterion | Mechanism |
| --- | --- | --- |
| 1 | Mastery gap | `target − mastery` |
| 2 | Expected learning gain | simulated BKT posterior step: `p·m⁺ + (1−p)·m⁻ − m` |
| 3 | Information gain | Fisher info `4·p·(1−p)` |
| 4 | Appropriate difficulty | distance to an **adaptive ZPD target** (`0.55 + 0.2·confidence`) |
| 5 | Prerequisite constraints | **hard route-away** from gated skills when a ready one exists; soft penalty otherwise (no dead-ends) |
| 6 | Question diversity | penalty for over-asked skills / bloom levels this session |
| 7 | Avoid repeats | hard filter on served question ids |
| 8 | Exploration vs exploitation | deterministic **UCB1** bonus for thin-evidence skills |
| 9 | Spaced review | bonus for mastered-but-decaying skills |
| 10 | Uncertainty | active-learning bonus proportional to `skill.uncertainty` |

Weights live in `DEFAULT_SELECTION_WEIGHTS` (documented, tunable, overridable per
call). Ties break by question id → **fully deterministic**.

### Explanations (no LLM)

Every decision yields a sentence in the required house style, templated from the
numeric factors:

> *"Selected because Probability Foundations mastery is 0.25, target is 0.85,
> prerequisite Fractions, Ratios & Proportion is sufficiently mastered (0.65),
> this item maximises expected mastery gain (a large step forward), also sits
> squarely in the learner's zone of proximal development, and predicted success
> is 70%."*

---

## Integration & backward compatibility

- `engine.ts › computeNextSessionQuestion` now builds the composite learner
  state and calls the v2 selector (with `LogisticResponseModel` + `bktModel`).
  The `SessionQuestion` shape and all DB writes are unchanged; `rationale` now
  carries the richer explanation.
- `engine.ts › gradeItem` now uses the **per-skill** BKT `slip / guess / learn`
  parameters persisted on `mastery_states` (previously ignored) instead of the
  population defaults.
- The legacy `ml/adaptive.ts` selector is retained, exported and tested — nothing
  was removed.
- The **model registry** now records the live policy (`adaptive-selector-v2`,
  its weights, prereq gate and available models) via
  `saveAdaptivePolicySnapshot()`.

---

## Tests & benchmark

- **`npm test`** → 80 unit tests (Vitest):
  `knowledge-tracing`, `models` (BKT/IRT/Bayesian contract + UCB), `learner-state`
  (all 15 signals), `selection` (all 10 criteria + determinism), `explain`,
  `regression` (guards the pre-existing modules), and `benchmark`.
- **`npm run bench`** → deterministic synthetic-learner simulation comparing v2
  vs. the legacy selector across 4 archetypes over a 6-skill prerequisite graph.
  Report: [`benchmarks/RESULTS.md`](benchmarks/RESULTS.md).

### Benchmark headline (v2 vs legacy, same tracer + luck)

| Metric | Legacy | v2 |
| --- | ---: | ---: |
| ZPD hit rate (↑) | 30.2% | **34.4%** |
| Wasted items too easy/hard (↓) | 33.3% | **28.1%** |
| Estimation RMSE (↓) | 0.229 | **0.186** |
| Serving Brier (↓) | 0.313 | **0.298** |
| Repeated items (↓) | 0 | **0** |

v2 wins decisively on difficulty targeting, calibration, ability recovery and
waste, with parity on prerequisite adherence and raw drill-learning (see the
RESULTS.md interpretation for the honest trade-off).
