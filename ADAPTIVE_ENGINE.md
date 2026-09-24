# Adaptive Learning Engine — v3

Senior-ML upgrade of the existing engine. The working modules (BKT, classifier,
gap detector, recommender, forecaster, registry) were **kept and wrapped**, not
replaced. The upgrade adds a composite learner model, a stronger, fully
explainable item selector, and clean interfaces so BKT / IRT / Bayesian /
contextual-bandit strategies are swappable.

Everything is **deterministic** (seeded, no wall-clock reads inside the pure
core) and **explainable** (no LLM in any assessment decision).

**v3** replaces the single weighted blend with an explicit multi-objective
policy: lexicographic hard gates, then a convex combination of nine documented
learning objectives minus two penalties, with weights derived from theory and
refined against a held-out simulation benchmark. The serving default is v3 on
the strength of that benchmark and nothing else — see
[`benchmarks/RESULTS.md`](benchmarks/RESULTS.md) §2, and §"Was v3 actually
better?" below for the parts that did *not* go v3's way.

> **Read this first.** v3 beats v2 and legacy, but the simulation environment
> also shows that **all three lose to a trivial heuristic baseline**, and
> localises the cause to the response model rather than the policy. See
> [`SIMULATION.md`](SIMULATION.md) §6 and `RESULTS.md` §2b before treating the
> adoption decision as a success story.

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

## Next-item selection — v2 (10 criteria)

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

v2 is still shipped, still tested, and selectable at runtime (`ADAPTIVE_POLICY=v2`).

---

## Next-item selection — v3 (multi-objective policy)

`src/lib/ml/policy/` — `MultiObjectivePolicy` implements the same
`ItemSelectionStrategy` interface, so it is a drop-in for v2.

### Why v2 needed replacing

The v2 benchmark showed a genuine paradox: v2 beat legacy on *measurement*
(estimation RMSE 0.229 → 0.186, ZPD 30.2% → 34.4%) while **losing** on simulated
learning (0.771 → 0.746) and prerequisite safety (23 → 26 violations).
Decomposing the gain gap (`benchmarks/attribution.ts`) found two causes:

1. **The prerequisite gate ran on a point estimate.** BKT's learning transition
   moves mastery up fast on thin evidence, so for weak learners the estimate
   runs *ahead* of true ability — v2 unlocked downstream skills the learner was
   not ready for, then scored poorly on them. The measured estimate-minus-truth
   bias at selection time was **+0.10 for novices** and negative for advanced
   learners, exactly the wrong way round.
2. **One weighted sum cannot express a constraint.** Prerequisite safety was a
   soft term competing with eight others, so enough small bonuses could always
   outvote it.

Both diagnoses were correct, and v3 fixes both. A later and deeper cause was
then found by the simulation environment, and it is the one that now matters
most — see below.

### The bigger reason v2's measurement gains did not become learning gains

The simulation environment (`SIMULATION.md`) isolated a defect neither of the
above explains. Item selection runs through a chain:

```
tracer → mastery estimate → RESPONSE MODEL → P(correct) → chosen difficulty
```

Handing the response model a learner whose mastery **equals true latent
ability** — i.e. perfect knowledge tracing — it *still* over-predicts success by
**+0.24** (RMSE 0.277 over 800 archetype × item pairs), and the bias grows with
item difficulty. So a policy that asks for an item at P(correct) = 0.75 is handed
one the learner will pass far less often, and the harder it aims at the
productive band the further past it it overshoots.

That is why improving the tracer (link 1) produced no learning: the chain was
broken at link 2. The defect is invisible to RMSE, Brier and ECE because it is
not the tracer's error. Its practical consequences are stark — on the held-out
split a six-line heuristic that ignores the response model entirely
(`mastery-gap-only`: easiest unseen item in the least-mastered skill) delivers
**1.135** retained gain against v3's **0.906**, out of an oracle-achievable
**1.370**.

**Implication for roadmap:** the highest-value next change is recalibrating the
response model against production telemetry, not further weight tuning — the
tuner has already extracted most of what the current objective set can give.
The measured bias is relative to the synthetic world, so it must be re-measured
on real data before anything is refit. See `benchmarks/RESULTS.md` §2b.

### Structure: gates first, then a scored trade-off

```
G1  no-repeat          hard filter on served question ids
G2  prerequisite LCB   worst prereq's  mastery − z·σ  ≥ gate
G3  exposure cap       per-skill / per-Bloom / consecutive-run caps
                       ↓  (each gate records how many it filtered, and
                           relaxes — flagged — only if the pool would empty)
score = Σ wₖ·objectiveₖ  −  Σ pⱼ·penaltyⱼ
```

Gating on a **lower confidence bound** rather than a point estimate is the
single highest-value change in v3: in tuning, `prereqPessimismZ = 0` (which *is*
v2's behaviour) scored −0.608 against +0.125 for `z = 1.25`.

### The nine objectives and two penalties

| Objective | Measures | Anchored in |
| --- | --- | --- |
| `expectedMasteryGain` | headroom `(T−m)/T` × ZPD efficiency × prereq support | mastery learning (Bloom 1968) |
| `zpdTargeting` | Gaussian proximity to a confidence-adaptive success target | Vygotsky; Wilson et al. 2019 (85% rule) |
| `prerequisiteCorrectness` | conservative readiness of the weakest prerequisite | learning hierarchies (Gagné 1968) |
| `informationGain` | Fisher information `4p(1−p)`, scaled by discrimination | CAT item selection (Lord 1980) |
| `uncertaintyReduction` | expected posterior-variance reduction for the skill | Bayesian optimal design (Lindley 1956) |
| `retention` | value at risk of being forgotten by the review horizon | spacing effect (Cepeda et al. 2006) |
| `difficultyAppropriateness` | fit in *item-parameter* space, independent of the classifier | desirable difficulties (Bjork 1994) |
| `skillCoverage` | diminishing-returns novelty + downstream unblocking | content balancing (Kingsbury & Zara 1989) |
| `assessmentEfficiency` | expected time cost against budget, weighted by fatigue | CAT efficiency (Weiss & Kingsbury 1984) |
| `repeatedExposure` *(penalty)* | near-repeats by skill / Bloom / bank exposure | exposure control (Sympson & Hetter 1985) |
| `prerequisiteRisk` *(penalty)* | charged only when a gate had to be relaxed | fail-safe sequencing |

Each returns `{ raw, normalized, detail }`; benefit weights are renormalised to
sum to 1, so the composite score stays on an interpretable 0..1 scale and only
*relative* emphasis is configurable.

### Where the weights come from

No weight is asserted. Two stages, both recorded in
`src/lib/ml/policy/weights.ts`:

1. **`PRIOR_WEIGHTS`** — theory-anchored, each with a cited rationale in
   `OBJECTIVE_METADATA`.
2. **`TUNED_WEIGHTS` / `TUNED_PARAMS`** — deterministic coordinate ascent
   (`npm run bench:tune`) over a fixed grid, maximising a **pre-registered**
   objective on the TRAIN split only, under a **time** budget rather than an
   item budget. `TUNING_PROVENANCE` records the method, objective, split, grids
   and the utility achieved; `benchmarks/tuning.json` records every step.

Deployments override weights without a deploy: `ADAPTIVE_POLICY`,
`ADAPTIVE_POLICY_PRESET` (`balanced`, `learning-first`, `measurement-first`,
`retention-first`, `theory-prior`) or `ADAPTIVE_POLICY_WEIGHTS` JSON.

### Machine-readable explanations

Every selected item carries a `DecisionExplanation` (`schema`, `policyId`,
`configFingerprint`, per-objective `raw`/`normalized`/`weight`/`contribution`,
every gate with how many candidates it filtered and whether it was relaxed,
`topDrivers`, and a counterfactual naming the runner-up and what decided against
it). The contributions sum exactly to the reported score, so a served decision
can be audited line by line. It is returned on `SessionQuestion.decision` and
attached to the `question.selected` event.

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

- `engine.ts › computeNextSessionQuestion` builds the composite learner state and
  calls `getSelectionStrategy()` — v3 by default, v2 if configured — with
  `LogisticResponseModel` + `bktModel`. All DB writes are unchanged;
  `SessionQuestion` gains `decision` (the auditable record) alongside the
  existing `rationale`.
- `engine.ts › gradeItem` now uses the **per-skill** BKT `slip / guess / learn`
  parameters persisted on `mastery_states` (previously ignored) instead of the
  population defaults.
- The legacy `ml/adaptive.ts` selector is retained, exported and tested — nothing
  was removed.
- The **model registry** records the live policy via
  `saveAdaptivePolicySnapshot()`: which policy is active, its config
  fingerprint, normalised weights, gate parameters and the tuning provenance —
  enough to reproduce any served decision from the registry alone.

---

## Tests & benchmark

- **`npm test`** → 239 unit tests (Vitest), including `policy-v3` (gates,
  explainability, targeting, configuration) and `selection` (all 10 v2
  criteria). The legacy selector and every pre-existing module are still guarded
  by `regression.test.ts` — nothing was removed.
- **`npm run bench`** → regenerates [`benchmarks/RESULTS.md`](benchmarks/RESULTS.md)
  and `benchmarks/results.json`, and **fails if the shipped serving default
  disagrees with the adoption verdict** computed from held-out evidence.
- **`npm run bench:tune`** → re-runs the weight/parameter search and prints a
  patch-ready block for `weights.ts`.

The benchmark simulates 8 skills (depth-4 prerequisite DAG), 80 items, **8
learner archetypes** (novice, intermediate, advanced, uneven, rapid forgetter,
slow, high-variance, cold start) and 6 world variants, with common random
numbers so two policies get identical luck on the same (learner, item) pair.

Splits are strict: the tuner sees **only** 4 archetypes × 4 seeds. The verdict is
computed on 8 archetypes × 8 unseen seeds — half of them learner types the tuner
never saw — plus a robustness sweep over 5 worlds whose learning, forgetting and
prerequisite dynamics deliberately contradict the policy's own defaults.

### Was v3 actually better?

Held-out, v3 vs v2 (primary metric: retained mastery gain after a 14-day delay):

| Metric | Legacy | v2 | v3 |
| --- | ---: | ---: | ---: |
| Retained mastery gain (↑) | 0.776 | 0.861 | **0.906** |
| True mastery gain (↑) | 0.248 | 0.400 | **0.455** |
| Mastery gain per **minute** (↑) | 0.0044 | 0.0070 | **0.0074** |
| ZPD hit rate (↑) | 7.5% | 18.0% | **24.4%** |
| Prerequisite violation rate (↓) | 48.3% | 52.2% | **34.5%** |
| Estimation RMSE (↓) | 0.329 | 0.355 | **0.280** |
| Serving Brier (↓) | 0.372 | 0.348 | **0.342** |
| Calibration error, ECE (↓) | 0.392 | 0.341 | **0.324** |
| Skills reaching mastery (↑) | 9 | 13 | **19** |
| Repeated items (↓) | 0 | 0 | **0** |
| Minutes on task (↓) | **56.6** | 57.6 | 61.8 |
| Raw skill coverage (↑) | **8.00** | 7.91 | 6.99 |

All pre-registered adoption criteria pass: **+5.27%** on the primary metric,
bootstrap 95% CI lower bound 0.0211 > 0, sign test **55W/25L, p=0.0011**, no
guardrail breach, and the advantage holds in **100%** of the five perturbed
worlds (+2.5% to +13.6%).

**What did not go v3's way**, stated plainly because the numbers are only worth
anything if the losses are reported too:

- **It loses to a trivial baseline.** This is the headline caveat and it is
  covered above: `mastery-gap-only` reaches 1.135 retained gain to v3's 0.906.
  v3 is the best of the three *shippable* policies and the right serving
  default among them; it is not a good policy in absolute terms.
- **It spends more time on task** (61.8 min vs v2's 57.6) under the item budget,
  because it picks harder and therefore longer items. The equal-time control
  neutralises this and v3 still wins, but by a much smaller margin (0.7929 vs
  0.7895, ~+0.4%) — most of the item-budget advantage is bought with time.
- **Raw skill coverage falls** (7.91 → 6.99 distinct skills). Nearly all of the
  shortfall is prerequisite-ineligible skills v3 correctly declined (76 of them,
  vs 5 eligible ones it missed). The guardrail was switched to eligible coverage
  *after* seeing this, which is disclosed in RESULTS.md §1.1.
- **It neglects 5 prerequisite-eligible skills** (v2 neglects 6, legacy 0). Four
  of the five are the `underconfident` archetype, which is chronically
  under-estimated and so never promoted to the deepest skills — a real
  behavioural defect described in `SIMULATION.md` §6.3.
- **Its estimation advantage is a v3-vs-v2 artefact of gating, not better
  tracing.** All three share the same tracer; v3's lower RMSE comes from
  distrusting it (`prereqPessimismZ = 1.25`), not from improving it.
- **Wasted items and information per item are marginally worse** (15.7% → 19.1%;
  0.2158 → 0.2156). v3 pushes into the productive band and overshoots more often
  than v2, which plays it safe in the merely-not-wasteful middle. Given §2b.2,
  much of that overshoot is the response model's bias rather than v3's intent.
- **Retention ratio dips** (2.619 → 2.487): v3 concentrates effort, so slightly
  more of its gain is fresh rather than consolidated.
- **Time was nearly the wrong denominator.** An earlier tuned vector won +11.7%
  gain per item while spending 10.9% more of the learner's time — a statistical
  tie per minute. The item-budgeted objective had quietly rewarded picking
  longer questions. Re-denominating the tuning objective in minutes fixed it,
  and the equal-time control is now a permanent section of the report.
- **The simulator is not a classroom.** The world's acquisition rule is an
  assumption, and it shares a functional family with v3's own
  `expectedMasteryGain` objective. This evidence supports shipping v3 as the
  default; it does not prove a learning gain for real students. The metric
  plumbing for that trial is the same one used here.

One defect found along the way is worth recording: the first version of the
benchmark reported ~0.5 estimation RMSE and near-identical policies. The cause
was a sign bug in the simulator's hash-based RNG (`h ^= h >>> 16` leaves a
*signed* int32), which made every luck draw land in (−0.5, 0.5) and every
simulated learner answer ~70–97% correct regardless of ability. It is fixed and
the RNG is now χ²-tested for uniformity.
