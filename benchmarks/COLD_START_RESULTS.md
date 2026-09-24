# Cold-start diagnostic benchmark

## Design

A learner with no mastery, assessment, or response records is routed to a bounded diagnostic rather than normal adaptive learning. The diagnostic uses a neutral, maximally uncertain prior—not a claim that every skill has identical mastery—and follows:

`new learner → diagnostic → foundation coverage → broad sampling → mastery + uncertainty → adaptive learning`

Maximum length is 12 items. Early stopping requires at least six responses, at least 75% skill coverage, and sufficient aggregate confidence. A low score alone never triggers stopping or a “weak learner” label. Selection receives item descriptors but no answer keys. Foundations receive first-sample priority, after which adaptive selection combines coverage, expected uncertainty reduction, moderate difficulty, and discrimination.

The held-out benchmark compares random, fixed-blueprint, and adaptive diagnostics over all synthetic archetypes and three unseen seeds. Every strategy starts with no evidence. After diagnosis, each receives the same 12-item downstream weakest-skill learning policy with common random numbers.

## Held-out results

| Diagnostic | Estimation RMSE ↓ | Questions ↓ | Skill coverage ↑ | Uncertainty reduction ↑ | Downstream learning gain ↑ |
|---|---:|---:|---:|---:|---:|
| Random | 0.29356 | 9.233 | 75.0% | **0.59662** | **0.27864** |
| Fixed | **0.29283** | **6.000** | 75.0% | 0.58643 | 0.27387 |
| Adaptive | **0.29283** | **6.000** | 75.0% | 0.58643 | 0.27387 |

## Conclusion

Held-out synthetic evidence supports the bounded diagnostic architecture and shows that fixed/adaptive selection reaches the coverage/confidence stopping rule with fewer questions than random. It **does not support a claim that the current adaptive diagnostic improves estimation or downstream learning over fixed**, and random has slightly higher uncertainty reduction and downstream gain in this experiment. The production route is therefore a principled safe starting strategy, not a proven learning improvement.

Before claiming superiority or changing the default diagnostic strategy, require chronological real-response evaluation, held-out learners, subgroup reliability, completion/dropout burden, and downstream experimental evidence. Synthetic results must not be treated as production validation.
