# Longitudinal misconception evaluation

Tracks what happens to a detected misconception *after* detection: was it
remediated, was the learner ever re-tested, did it come back, and did anything
actually improve.

- `src/lib/ml/misconceptions.ts` — **unchanged** deterministic detector (source of truth)
- `src/lib/ml/misconception-longitudinal.ts` — episode construction + classification
- `src/lib/ml/misconception-metrics.ts` — cohort metrics
- `src/db/schema.ts` — `misconception_episodes`, `misconception_remediations` (+ `drizzle/0002_*.sql`)
- `tests/unit/misconception-longitudinal.test.ts` — 29 synthetic longitudinal tests

The detector still decides *what* a misconception is. This layer only answers
*what happened next*, and only for MEDIUM/HIGH-confidence hypotheses.

---

## 1. The measurement problem

"The learner stopped getting it wrong" is not evidence that a misconception was
fixed. It is equally consistent with:

- never being asked again,
- being asked only items where the misconception's distractor was not an option,
- guessing,
- remembering the fix for ten minutes after the explanation.

So resolution is defined against **opportunities to recur**, not against the
absence of errors.

> **An item counts as an opportunity only when an option encoding that
> misconception was actually present and selectable.**

Without that rule, serving easier items that omit the trap looks identical to
teaching. One of the synthetic tests is exactly this scenario: three subsequent
correct answers on the same skill, none of which offered the distractor →
`insufficient_evidence`, not success.

---

## 2. Episode lifecycle

```
first error ──► detection (2nd distinct item, MEDIUM) ──► remediation exposure
                      │                                        │
                      └──────────── opportunities ─────────────┴──► status
```

**Detection clock.** `detectedAt` is the observation that carried the hypothesis
to MEDIUM — the second distinct item — not the first error. Nobody could act on
the first error, so timing remediation from it would flatter every latency
metric. Both timestamps are kept.

**Tracked per episode:** first detection, first observation, every remediation
exposure (source + whether it named the misconception), every subsequent related
opportunity, recurrences, mastery at detection / latest / change, retention, and
time to resolution.

---

## 3. The four-way classification

Evaluated in this order — recurrence outranks everything, because a relapse
surrounded by clean items is still a relapse.

| Status | Condition |
| --- | --- |
| `recurred` | misconception's distractor selected again after remediation |
| `resolved` | ≥3 clean opportunities, ≥2 correct, ≥2 distinct sessions, spanning ≥7 days, no recurrence |
| `temporarily_suppressed` | clean so far, but short of one or more of those bars (the reason says which) |
| `insufficient_evidence` | no remediation, or no post-remediation opportunity at all |

Thresholds are `DEFAULT_LONGITUDINAL_CONFIG` and are configurable per analysis;
the config used is stored on the episode so a status can always be re-derived.

Two deliberate strictnesses:

- **A wrong answer via a *different* distractor is not progress.** The tracked
  misconception is absent, but there is no evidence of understanding either, so
  `minCorrectOpportunities` requires genuine correctness, not just the absence
  of this specific error.
- **Durability is required.** Three correct answers in the same session, minutes
  after an explanation, is `temporarily_suppressed`. That is the difference
  between learning and echo.

`asOf` replays the timeline at any past instant, so "resolved on day 15, recurred
by day 21" is representable — both statements being true of their moment.

---

## 4. LLM explanations are exposure, never evidence

Enforced in three places, because a comment would not survive a refactor:

1. **Type level** — resolution reads `ResponseObservation[]`; exposures are a
   different type that never reaches the scoring path.
2. **Runtime** — `assertNoExposureEvidence` throws if an exposure-shaped object
   is passed as evidence.
3. **Database** — `misconception_remediations.counts_as_evidence` is `false` with
   a CHECK constraint pinning it there, so a future analyst joining the table
   cannot accidentally treat "the tutor explained it" as "the learner fixed it".

Learner `helpful` ratings are recorded for analysis and are likewise not outcome
evidence. A test delivers 25 explanations to one episode and asserts the status
stays `insufficient_evidence`.

---

## 5. Metrics, and their denominators

Every rate reports what it divided by — most misleading dashboards in this space
come from quietly choosing the flattering denominator.

| Metric | Denominator | Note |
| --- | --- | --- |
| detection precision | labelled detections | `null` when nothing is labelled |
| false **discovery** rate | labelled detections | FP / (TP + FP) |
| false **positive** rate | labelled positives + negatives | `null` until labelled negatives exist |
| recurrence rate | episodes **with ≥1 post-remediation opportunity** | not all detections |
| resolution rate | same evaluable subset | |
| remediation response rate | all episodes | did the system act on what it found? |
| time to resolution | resolved episodes | median and mean |
| downstream mastery gain | episodes with mastery data | split by resolved vs recurred |

**Precision vs. false-positive rate.** Detections alone cannot yield a true FPR:
that needs labelled *negatives* — candidates an expert examined and ruled absent.
The API therefore returns `falseDiscoveryRate` from detections and only computes
`falsePositiveRate` when `labelledNegatives` is supplied. The two are routinely
conflated, and the difference decides whether a precision figure means anything.

Unmeasured values are `null`, never `0` or `1`. `evaluateMisconceptionProgram`
also emits **derived caveats** — they fire only when the data warrants them
(≥25% unevaluable episodes, <30 evaluable, <20% label coverage, no labels at
all, resolved episodes with no post-resolution data), so they stay worth reading.

---

## 6. Data model for real-learner evaluation

`misconception_episodes` is a **derived, recomputable projection** — every row
can be rebuilt from responses + remediations by `buildMisconceptionEpisodes`.
Persisting it buys queryable history and a stable place to hang expert labels,
not a second source of truth. It stores the full opportunity trail and the
config the status was computed under.

Ground-truth columns (`ground_truth_label`, `..._by`, `..._at`, `..._note`) are
the hook for real evaluation. Until an expert fills them in, detection precision
is **unmeasured** — which the metrics layer reports as `null` rather than as a
flattering default.

### What is still needed before precision numbers mean anything

- **Expert labels on a random sample of detections** — not a convenience sample
  of the interesting ones, which biases precision upward.
- **Labelled negatives** — candidates reviewed and ruled absent — or the FPR
  stays `null` by construction.
- **Item metadata coverage**: the opportunity rule depends on authored
  `distractorMeta.misconception` tags. Skills whose items lack them can never
  produce an evaluable episode, and will show up as a high `unevaluableRate`
  rather than as good results.
- **Deliberate re-testing.** Today nothing guarantees a remediated learner is
  ever served the trap again; until selection does that on purpose, most
  episodes will legitimately land in `insufficient_evidence`. That is an honest
  reading of the current data, and it is the single highest-value change for
  making this measurable.
