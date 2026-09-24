# Item Bank Architecture & Psychometrics

The question bank is a governed, psychometrically-instrumented item pool — not a
flat list of MCQs. It preserves the original question fields and extends them with
rich metadata, an editorial workflow, quality analytics computed from observed
responses, and an IRT-ready calibration model.

## Design principles

1. **Additive, non-breaking.** Every new column has a default; existing rows,
   queries, the adaptive engine and all prior tests keep working.
2. **Only trusted content reaches learners.** The engine serves an item only when
   it is `isActive` **and** in a servable status (`published` or `monitored`).
3. **AI is never auto-trusted.** AI-generated items enter as `draft` and must pass
   validation *and* human review — with separation of duties — before publication.
4. **Honest analytics.** Quality/discrimination/calibration are computed from real
   responses using rest-score ability (no part-whole inflation) and are marked
   provisional below a minimum sample.
5. **Future IRT without a rewrite.** Psychometric parameters live in a versioned
   `calibration` JSON container discriminated by `model` (`ctt` → `rasch-approx`
   → `1pl`/`2pl`/`3pl`). Swapping in a full estimator changes code, not schema.

## Item metadata (extended `questions` table)

| Field | Purpose |
|---|---|
| `skillId`, `subskill` | skill + finer-grained topic |
| `prerequisiteSkillIds` | item-level prerequisites (independent of taxonomy edges) |
| `difficultyLabel`, `difficultyValue` | authored band + numeric 0..1 difficulty (refined by calibration) |
| `bloomLevel` | Bloom's taxonomy (type of cognition) |
| `cognitiveComplexity` | Webb's Depth of Knowledge (depth of cognition) |
| `estimatedSeconds` | expected response time |
| `explanation`, `hints` | worked explanation + progressive hints |
| `distractorMeta` | per-distractor misconception/rationale |
| `authorId`, `source`, `version` | provenance (`human`/`ai`/`imported`) + revision |
| `status`, `reviewedById`, `reviewedAt`, `reviewNotes`, `publishedAt`, `retiredAt` | editorial workflow |
| `qualityScore`, `exposureCount`, `successRate`, `discrimination` | latest analytics rollup |
| `calibration` | IRT-ready parameter container (see below) |
| `qualityFlags`, `lastAnalyzedAt` | latest quality flags + analysis timestamp |

`item_statistics` is an append-only history table — every analytics run snapshots
facility, discrimination, distractor analysis, flags and the calibration container,
so item drift and re-calibrations are auditable over time.

## Editorial workflow

```
Draft → Review → Validated → Published → Monitored → Retired
```

State machine: `src/lib/questions/workflow.ts` (`canTransition`, `transitionPatch`).
Guards enforced server-side by `POST /api/questions/[id]/transition`:

- Promotion to **validated**/**published** requires validation to pass (zero errors).
- **Validated** requires content-review capability.
- **Published** requires a recorded human review.
- **AI separation of duties:** an AI item cannot be reviewed *and* published by the
  same person, and its author cannot publish it.
- Editing the content (stem/options/key/skill) of a published item bumps `version`,
  clears its calibration, and returns it to **review** for re-validation.

Anything can be **retired**; retired items can be revived to **draft**.

## Validation

`src/lib/questions/validation.ts` (`validateQuestion`) returns blocking `errors`
and advisory `warnings`. Checks:

- **Option count** — 2–8 non-empty options; warns outside the ideal 3–5; blocks duplicates.
- **Correct answer** — index in range and points to a non-empty option.
- **Difficulty** — valid band; numeric value in [0,1]; warns when value ↔ band disagree.
- **Bloom / cognitive complexity** — must be from the canonical vocabularies.
- **Skill relationships** — skill exists; prerequisites exist, are not self-referential,
  and are checked for cycles in the skill graph.
- **Duplicates** — exact (normalised) stem duplicates block; near-duplicates
  (token-set Jaccard ≥ 0.85) within a skill warn.
- **Distractor metadata** — indices in range; warns if metadata describes the key.

## Quality analytics (from observed responses)

`src/lib/ml/item-analysis.ts` (`analyzeItem`) computes, per item:

- **Facility** (p-value / difficulty index) and **success rate**.
- **Discrimination** — corrected point-biserial against learner rest-score ability,
  plus an upper/lower 27% index.
- **Distractor analysis** — per-option selection rate, mean ability of choosers,
  option discrimination, and whether each distractor *functions* (draws lower-ability
  learners). Detects `possible_miskey`.
- **Quality flags** — `too_easy`, `too_hard`, `low_discrimination`,
  `negative_discrimination`, `nonfunctional_distractor`, `insufficient_sample`, …
- **Quality score** (0..1) — explainable weighted blend of discrimination, facility
  band, distractor functioning, sample adequacy and calibration consistency.
- **KR-20** reliability helper for item sets.

`src/lib/questions/analytics.ts` (`computeAndPersistItemStatistics`) runs this over
the live response log, writes an `item_statistics` snapshot, and updates the rollup
on each `questions` row. Triggered by `POST /api/questions/analytics` and during seed.

## IRT-ready calibration

`CalibrationParams` (`src/lib/questions/constants.ts`):

```ts
{ model: "none"|"ctt"|"rasch-approx"|"1pl"|"2pl"|"3pl",
  a, b, c, seB, sampleSize, method, calibratedAt }
```

`calibrationFromAnalysis` seeds this with a **Rasch (1PL) difficulty approximation**
(`b = logit(1 − facility)`) plus a provisional discrimination. A future MML/EM 2PL/3PL
estimator can populate `a`/`b`/`c` and bump `model` — no schema migration required.

## API surface

| Route | Purpose |
|---|---|
| `GET /api/questions` | list the bank (with metadata, analytics, author/reviewer) |
| `POST /api/questions` | create — validates, forces `draft`, records author/source |
| `PATCH /api/questions/[id]` | edit — re-validates; content edits re-queue published items |
| `DELETE /api/questions/[id]` | delete item + its stats + responses |
| `POST /api/questions/[id]/transition` | guarded workflow transition |
| `GET/POST /api/questions/analytics` | bank quality summary / recompute analytics |

Validation failures return HTTP **422** with structured `errors` and `warnings`.

## Tests

- `tests/item-analysis.test.ts` — hand-computed facility, point-biserial, distractor
  functioning, mis-key detection, quality score, Rasch b, KR-20.
- `tests/question-validation.test.ts` — every validation rule + duplicate/cycle helpers.
- `tests/question-workflow.test.ts` — legal/illegal transitions and the AI trust guards.

Run with `npm test`.
