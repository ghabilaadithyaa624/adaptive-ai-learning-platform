# Why mastery-gap-only beats adaptive v3

## Scope and integrity

This is a controlled attribution analysis on the unchanged held-out synthetic benchmark. The mastery-gap baseline, oracle, world, metric definitions, and adoption rule were not changed. Every variant receives the same item bank, random draws, session budget, learner archetypes, and worlds. Zero-weight variants retain v3's hard no-repeat, prerequisite, and exposure gates, so a gain cannot be manufactured by removing safety.

These are synthetic-world findings. Variant G's calibrator was fitted only on benchmark **training cells**, is tagged `synthetic`, and is evaluated on unchanged held-out cells. It is not production evidence and must not be enabled for real learners.

## Results

The held-out suite contains all registered archetypes and seeds. Counts such as prerequisite violations are totals across cells; rates and learning measures are aggregate cell means.

| Policy / ablation | Retained gain ↑ | ZPD hit ↑ | Wasted ↓ | Prereq violations ↓ | Eligible coverage ↑ | Questions to mastery ↓ | Retention ratio ↑ | Information ↑ | Minutes to mastery ↓ |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| mastery-gap-only | **1.1352** | 65.04% | 2.58% | 1221 | 65.41% | **16.933** | 1.4981 | 0.2217 | **24.789** |
| v3 | 0.9063 | 24.38% | 19.10% | 882 | 99.06% | 23.474 | 2.4872 | 0.2156 | 48.005 |
| A. v3 without response model | 0.9639 | 28.32% | 15.86% | 842 | 98.91% | 20.188 | 2.3710 | 0.2144 | 40.026 |
| B. v3 with true mastery | 0.9832 | 39.30% | 7.70% | **360** | 98.28% | 20.565 | 2.4275 | 0.2176 | 40.504 |
| C. without information gain / uncertainty reduction | 0.8942 | 22.03% | 15.78% | 928 | 98.59% | 22.353 | **2.5645** | 0.2194 | 43.333 |
| D. without prerequisite weights (gate retained) | 0.8937 | 24.73% | 18.87% | 917 | 98.59% | 23.600 | 2.4485 | 0.2157 | 48.855 |
| E. without diversity/exposure weights (caps retained) | 0.8860 | 25.47% | 19.49% | 940 | 98.91% | 22.056 | 2.3939 | 0.2149 | 46.603 |
| F. mastery-gap skill selection + v3 item scoring | 0.8576 | 22.19% | 21.49% | 1364 | 94.35% | 25.833 | 2.2768 | 0.2124 | 51.014 |
| G. training-only synthetic calibrated probabilities | 1.4449 | 77.58% | 0.35% | 518 | 99.38% | 17.818 | 1.7516 | 0.2159 | 28.142 |
| H. oracle response probabilities | **1.4653** | **90.24%** | **0.12%** | 598 | **99.69%** | 18.778 | 1.6562 | **0.2302** | 32.287 |

Retention ratio can exceed one in this world because delayed retrieval improves memory stability; it is not a bounded probability. No metric was omitted because it was unfavorable.

## Component decomposition

| Pipeline component | Controlled evidence | Attribution |
|---|---|---|
| 1. Mastery estimation | B improves retained gain 0.9063 → 0.9832 and wasted rate 19.10% → 7.70%, but remains below mastery-gap-only. | A real secondary loss and a major safety contributor, not the primary bottleneck. |
| 2. Prerequisite filtering | B sharply reduces violations. D removes soft weighting but retains the gate and gets worse. Mastery-gap-only learns more while violating prerequisites far more often. | Hard filtering preserves safety. Do not weaken it. Estimation error at the gate matters more than the soft prerequisite objective. |
| 3. Skill selection | F forces mastery-gap skill selection while keeping v3 item scoring; it falls to 0.8576. | The baseline's advantage is not explained by weakest-skill allocation alone. |
| 4. Response-probability prediction | A improves despite discarding the model; G and H produce the largest gains by far. | **Primary causal bottleneck: miscalibrated response probabilities.** |
| 5. ZPD targeting | v3 hits the true ZPD only 24.38%; G reaches 77.58% and H 90.24%. | ZPD objective is directionally useful but acts on the wrong probability scale. |
| 6. Information gain | C does not improve retained learning; H attains both the best information and learning. | Information gain is not causing the deficit. Removing it is not principled. |
| 7. Diversity | E gets worse; v3's eligible coverage is much better than mastery-gap-only. | Diversity is buying breadth, not causing the loss. |
| 8. Retention | v3 has the highest unablated retention ratio, while mastery-gap-only has higher absolute retained gain. | Retention scheduling is not the bottleneck; ratios alone cannot compensate for weak initial acquisition. |
| 9. Fatigue | All variants use identical fatigue dynamics and time budgets. V3's assessment-efficiency objective remains in A–H; time-to-mastery collapses under G/H without changing fatigue logic. | Fatigue is a shared world cost, not the identified source. A dedicated fatigue removal would change the world rather than isolate policy attribution. |
| 10. Question exposure | E removes exposure/diversity score terms while retaining hard caps and performs worse. | Exposure control does not explain the gap and should remain for bank safety. |
| 11. Difficulty selection | F retains v3 item-level selection and wastes 21.49%, whereas the simple baseline's fixed easy-first order wastes 2.58%. G/H repair this without changing skill policy. | The proximal failure is difficulty selection driven by over-predicted success probability. |

The multiplicative acquisition decomposition in `benchmarks/attribution.ts` supports the same mechanism: learning depends on productive-band efficiency, prerequisite support, headroom, and outcome. V3 has excellent eligible coverage and safer prerequisites, but its poor true-ZPD placement depresses acquisition on nearly every selected item. The baseline accidentally avoids this by choosing each skill's easiest unseen item; it does not need the broken response link.

## Smallest principled change

The smallest defensible change is **not** a new policy or weaker safety constraint. It is a separately versioned, monotone calibration layer between raw response prediction and v3's ZPD/difficulty objectives. This preserves:

- the base response model and its ranking;
- deterministic serving;
- prerequisite and exposure gates;
- objective-level explanations;
- the benchmark and adoption rule.

The synthetic mapping in G demonstrates mechanism, not deployability. Production activation still requires chronological and held-out-learner evaluation on immutable pre-response telemetry, subgroup reliability, Brier/ECE/MCE improvement, uncertainty intervals, shadow serving, and the existing controlled experiment process described in `RESPONSE_CALIBRATION.md`.

## Honest conclusion

Under the currently served, uncalibrated response link, **mastery-gap-only remains superior to v3 on retained mastery gain and speed to mastery**. It is inferior on prerequisite safety and eligible coverage. A training-only synthetic calibrator and an oracle response model both reverse the learning deficit while retaining v3's safety, strongly isolating response calibration/difficulty targeting as the dominant cause. This does not establish that a real-data calibrator will do so in production.
