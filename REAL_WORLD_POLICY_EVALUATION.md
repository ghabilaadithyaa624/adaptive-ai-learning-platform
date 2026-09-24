# Real-world adaptive-policy evaluation protocol

## Governance gate

This protocol must not be launched against real students until privacy review, appropriate learner/guardian consent, institutional approval, and all applicable educational-data requirements are documented. `createPolicyEvaluationDraft` fails closed unless all four approvals are true.

## Design

- **Unit of randomization:** learner.
- **Assignment:** deterministic and sticky for the experiment lifetime.
- **Tenant boundary:** one institution per experiment; eligibility repeats the institution restriction and attribution rejects cross-tenant observations.
- **Control:** mastery-gap-only baseline.
- **Treatment:** adaptive v3.
- **Optional secondary treatment:** IRT-assisted adaptive policy, currently fail-closed because no production-approved IRT artifact and runtime strategy exists. It cannot be enabled merely by editing the protocol.
- **Window:** explicit `startAt`, `endAt`, and later `finalAnalysisAt` fixed before launch.
- **Concurrent-policy exclusion:** `adaptive-policy-serving` exclusion group.

The framework persists one assignment per learner and records item-level exposure. Outcomes count only at or after first exposure and before `endAt`. Variant/exposure conflicts are dropped and reported. Eligibility characteristics are frozen at assignment.

## Outcomes

Pre-specified primary family:

1. retained mastery gain;
2. time to mastery;
3. questions to mastery;
4. delayed retention.

The unchanged framework directly supplies `masteryGain`, `timeToMastery`, `questionsToMastery`, and `retention`. Because it has no standalone retained-mastery-gain composite, the report presents post-exposure mastery gain together with delayed retention and explicitly states this limitation rather than inventing a new estimand.

Secondary family:

- completion;
- engagement;
- ZPD hit rate;
- prerequisite violations (descriptive safety count);
- recommendation acceptance;
- calibration error.

All outcomes are reported. The unit of analysis is the learner, matching randomization. Time/questions-to-mastery and delayed outcomes explicitly report censoring and coverage; absent values are never replaced with zero.

## Analysis schedule

Outcome reporting is locked until `finalAnalysisAt`. Operational monitoring before then may inspect enrollment, exposure delivery, privacy/safety incidents, and data-pipeline health—but not treatment outcome differences. This prevents repeated peeking from being turned into an undeclared stopping rule.

At final analysis, each primary-family outcome is passed through the existing `buildReadout` implementation. Therefore Welch intervals, seeded bootstrap intervals, effect sizes, resolution, censoring, and all interpretation notes remain unchanged. Multiple views do not create multiple decisions: no readout has a winner, significance flag, recommendation, or verdict.

## Required report sections

`buildPolicyEvaluationReport` emits:

- assigned cohort sizes and exposed cohort sizes;
- exposure counts;
- frozen baseline characteristics by arm;
- all primary outcomes and confidence intervals;
- all secondary outcomes and confidence intervals where supported;
- censoring and metric coverage;
- missingness by arm and outcome;
- prerequisite-safety counts;
- protocol deviations;
- attribution conflicts;
- pre-exposure, post-window, cross-tenant, and unassigned exclusions;
- governance warning and neutral interpretation language.

The report describes evidence. Product adoption remains a separate human governance decision and is intentionally not automated.
