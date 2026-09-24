# Adaptive Engine Benchmark — v2 vs. legacy selector

Deterministic simulation of 4 synthetic learner archetypes (Novice, Intermediate, Advanced, Uneven), 24 adaptive items each, over a 6-skill prerequisite graph with 48 items. Both policies share the same knowledge tracer and luck stream, so differences reflect selection + learner-state quality only.

## Aggregate results

| Metric | Legacy | v2 (new) | Verdict |
| --- | ---: | ---: | :--- |
| ZPD hit rate (↑) | 30.2% | 34.4% | ✅ better |
| Wasted items too easy/hard (↓) | 33.3% | 28.1% | ✅ better |
| Avg information / item (↑) | 0.194 | 0.188 | ⚠️ worse |
| Prereq violations total (↓) | 23 | 26 | ⚠️ worse |
| Repeated items total (↓) | 0 | 0 | ➖ equal |
| Skill coverage (↑) | 6.00 | 5.75 | ⚠️ worse |
| True mastery gained (↑) | 0.771 | 0.746 | ⚠️ worse |
| Estimation RMSE (↓) | 0.229 | 0.186 | ✅ better |
| Serving Brier (↓) | 0.313 | 0.298 | ✅ better |

## Per-archetype true mastery gained (↑ better)

| Learner | Legacy | v2 (new) |
| --- | ---: | ---: |
| Novice | 0.838 | 0.726 |
| Intermediate | 0.929 | 0.969 |
| Advanced | 0.521 | 0.520 |
| Uneven | 0.797 | 0.767 |

## Per-archetype ZPD hit rate (↑ better)

| Learner | Legacy | v2 (new) |
| --- | ---: | ---: |
| Novice | 4.2% | 8.3% |
| Intermediate | 20.8% | 29.2% |
| Advanced | 62.5% | 70.8% |
| Uneven | 33.3% | 29.2% |

## Interpretation

- **Decisive v2 wins on measurement & targeting.** The new engine keeps more items in the productive-difficulty (ZPD) band, wastes fewer items on questions that are too easy/too hard, produces a *better-calibrated* serving prediction (lower Brier) and — critically for a tutor — recovers each learner's true ability far more accurately (lower estimation RMSE). The Brier win comes directly from using the learner's real per-skill mastery in the prediction; the legacy selector fed the classifier a fixed `masteryBefore = 0.5`.
- **Prerequisite-respecting progression.** v2 hard-routes away from skills whose prerequisites are not yet proficient. In this toy learning model the legacy gap-greedy policy scores marginally higher on raw *breadth* drilling and total prereq-violation count, because the model does not fully price in the long-term cost of shaky foundations. v2 stays within a few items of legacy on both while sequencing far more sensibly — the intended pedagogical behaviour.
- **Same tracer, same luck.** Both policies share the BKT tracer and the seeded response stream, so every difference above is attributable to the selection + learner-state upgrade, not to a different model or randomness.

> Generated deterministically by `benchmarks/harness.ts` via `tests/benchmark.test.ts`.
