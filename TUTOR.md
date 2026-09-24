# AI Tutor Layer

An AI tutor that teaches **on top of the existing learner model** — not a generic
chatbot. Every response is grounded in the deterministic learner state, the
curriculum taxonomy, and the question bank, and is shaped by an explainable
policy before a single token is generated. The LLM is confined to one
replaceable step and can never change the learner model.

---

## 1. Design goals & invariants

| Invariant | How it's enforced |
|---|---|
| The tutor uses the **learner model**, not a blank chat | Stage 1 assembles a read-only `LearnerTutorContext` from `mastery_states`, the 15-signal `buildLearnerState`, paths, milestones, recommendations and assessment state. |
| The **LLM never modifies mastery** | The tutor performs **no** writes to `mastery_states` / `assessment_items` / `assessments`. Its only persistence is `tutor_interactions` + one `activity_events` row. The deterministic engine remains the single source of truth. |
| **Never reveal assessment answers prematurely** | Two independent layers: (a) the **policy** guard redacts answer explanations at the *retrieval boundary* so the key never enters the prompt; (b) a **post-generation scan** blocks an external model that tries to leak the answer anyway. |
| **Explainable pedagogy** | All pedagogical decisions (capability, difficulty register, remediation style, prerequisite fallback, answer-withholding) are made by a **pure, deterministic policy function** — the LLM only renders prose within those guardrails. |
| **Impact is measurable** | Every exchange is stored as a learning event with a mastery snapshot, so tutoring can later be correlated with subsequent mastery change. |

---

## 2. Architecture (the mandated pipeline)

```
                 ┌────────────────────────────────────────────────┐
   Request  ───▶ │ 1. Learner Context   (read-only learner model) │
                 └───────────────┬────────────────────────────────┘
                                 ▼
                 ┌────────────────────────────────────────────────┐
                 │ 3. Tutor Policy (guard) → withholdAnswers?      │  ← runs first for safety
                 └───────────────┬────────────────────────────────┘
                                 ▼
                 ┌────────────────────────────────────────────────┐
                 │ 2. Retrieval / Curriculum  (answers redacted)   │
                 └───────────────┬────────────────────────────────┘
                                 ▼
                 ┌────────────────────────────────────────────────┐
                 │ 3. Tutor Policy (full decision + guardrails)    │
                 └───────────────┬────────────────────────────────┘
                                 ▼
                 ┌────────────────────────────────────────────────┐
                 │ 4. LLM  (prose only; deterministic or external) │
                 └───────────────┬────────────────────────────────┘
                                 ▼
                 ┌────────────────────────────────────────────────┐
                 │    Post-generation answer-safety scan           │
                 └───────────────┬────────────────────────────────┘
                                 ▼
                 ┌────────────────────────────────────────────────┐
                 │    Response  ──▶  Learning Event (persisted)    │
                 └────────────────────────────────────────────────┘
```

> The spec lists the flow as *LLM → Learner Context → Retrieval → Policy →
> Response → Learning Event*. We keep exactly that data flow, with one safety
> refinement: the **answer-withholding decision runs before retrieval** so the
> answer key is never even loaded into the prompt. Everything downstream is
> defense in depth.

### Files (`src/lib/tutor/`)

| File | Stage | Responsibility |
|---|---|---|
| `context.ts` | 1 | `assembleLearnerContext()` — read-only view of the learner model. |
| `retrieval.ts` | 2 | `assembleCurriculumContext()` — skill description, prerequisite chain, representative items (hints + distractor misconceptions), **answer redaction**. |
| `policy.ts` | 3 | `decidePolicy()` + `mustWithholdAnswers()` — pure, deterministic pedagogy. |
| `prompt.ts` | — | Grounded system+user prompt built from context+curriculum+policy. |
| `llm.ts` | 4 | `getTutorLlm()` — pluggable backend (deterministic ↔ OpenAI-compatible). |
| `deterministic.ts` | 4 | Zero-config grounded composer (default backend). |
| `pipeline.ts` | all | `runTutor()` — orchestration, post-gen safety scan, learning-event persistence. |
| `types.ts` | — | Contracts between stages. |

---

## 3. What the tutor knows (Stage 1 — Learner Context)

`LearnerTutorContext` fuses the required signals, all read-only:

- **current skill** — resolved by: explicit request → live pending assessment
  item → active recommendation → weakest practised skill → most foundational
  skill (cold start).
- **mastery estimate** — decayed point estimate + evidence confidence (from
  `buildLearnerState`, the same builder the adaptive engine uses).
- **recent mistakes** — the most recent incorrect responses with speed/recency,
  plus the diagnosed **error profile** (careless / struggling / guessing / …).
- **prerequisites** — each prerequisite skill, its mastery, and whether it's met,
  plus overall prerequisite readiness.
- **current learning path + current milestone** — the active path's next
  incomplete milestone.
- **recommended activity** — the top open recommendation, else the next
  milestone, else a diagnostic (cold start).
- **learner goal** — from the user profile.
- **assessment context** — any in-progress assessment and its pending item.

## 4. Capabilities

| # | Capability | Intent | Notes |
|---|---|---|---|
| 1 | Explain concepts | `explain` | Built from skill description + a non-redacted worked example. |
| 2 | Give hints | `hint` | Uses authored **progressive hints** — safe even mid-assessment. |
| 3 | Ask Socratic questions | `socratic` | 2–3 guiding questions, no answers. |
| 4 | Generate worked examples | `worked_example` | Uses an **analogous** problem while an assessment is live. |
| 5 | Diagnose misconceptions | `diagnose` | Uses the error profile + distractor misconception bank; tentative on thin evidence. |
| 6 | Provide targeted remediation | `remediate` | Style chosen from the error profile; drops to the weakest unmet prerequisite. |
| 7 | Recommend the next activity | `next_activity` | Mirrors / refines the engine's recommendation. |
| 8 | **Adjust explanation difficulty** | `difficulty: auto\|easier\|same\|harder` | Base register (foundational/core/stretch) from mastery + prereq readiness, then the requested shift. |
| 9 | **Avoid revealing answers prematurely** | policy `withholdAnswers` | See §5. |

## 5. Answer safety (capability 9) — two layers

1. **Retrieval redaction (primary).** `mustWithholdAnswers()` returns true when an
   assessment is *in progress* with a *pending* item on the skill in focus.
   Retrieval then strips every answer-revealing `explanation` from the grounding
   material (progressive hints are retained — they're authored to precede the
   answer). The answer key never enters the prompt.
2. **Post-generation scan (defense in depth).** The pending item's correct answer
   is loaded *only for scanning* and the generated text is checked for answer-
   giving phrasing / the verbatim correct option. On a hit the response is
   replaced with the guaranteed-safe deterministic output and flagged
   `withheld_answer_leak_blocked` (persisted on the event).

Both layers are covered by tests, including an injected "leaky" model.

## 6. The LLM adapter (Stage 4)

The pipeline depends only on the `TutorLlm` interface, so the backend is a
config choice:

- **`deterministic`** (default) — a *grounded composer*, not a random chatbot.
  It assembles prose strictly from the upstream context/curriculum/policy, is
  fully deterministic (testable offline), and is always answer-safe. Used
  whenever no external model is configured.
- **`openai`** — any OpenAI-compatible Chat Completions endpoint. It delegates
  only the prose body; structured fields (follow-ups, suggested activity) still
  come from the deterministic composer. **Falls back to the deterministic
  composer on any error/timeout**, so a learner request never hard-fails.

### Environment

| Var | Default | Meaning |
|---|---|---|
| `TUTOR_LLM_PROVIDER` | `deterministic` | `deterministic` or `openai`. |
| `TUTOR_LLM_API_KEY` | — | Required for `openai`; read from env only, never logged. |
| `TUTOR_LLM_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible base URL. |
| `TUTOR_LLM_MODEL` | `gpt-4o-mini` | Model id. |
| `TUTOR_LLM_TIMEOUT_MS` | `12000` | Abort + fall back after this. |

If `openai` is selected without a key, the tutor logs a warning and stays on the
deterministic backend.

## 7. Learning events (impact evaluation)

Every exchange writes a `tutor_interactions` row:

`studentId, skillId, assessmentId, itemId, intent, requestedIntent, difficulty,`
`masteryAtTime, withheldAnswer, provider, model, latencyMs, responseChars,`
`safetyFlags[], helpful, createdAt`

`masteryAtTime` is a **read-only snapshot** of decayed mastery at request time.
Because it is captured per skill with a timestamp, later analysis can correlate
tutoring on a skill with the learner's *subsequent* mastery trajectory (from
`mastery_states.history` / assessment items) — without the tutor ever having
influenced those numbers directly. A lightweight `activity_events` row (type
`tutor`) mirrors the event into the activity feed. Learners can rate an
interaction (`helpful`) via the feedback action for usefulness analysis.

## 8. API

`POST /api/tutor`
- `action=ask` (default): `{ studentId?, intent, difficulty?, message?, skillId?, assessmentId?, itemId? }` → `TutorResponse` (201).
- `action=feedback`: `{ interactionId, helpful }` → `{ ok: true }`.

`GET /api/tutor?studentId=&limit=` → recent interaction history.

**Authorization** reuses the platform's central policy: students are pinned to
themselves; staff may tutor/inspect learners **within their tenant**; cross-tenant
is denied. Assessment-scoped requests additionally check assessment access. The
endpoint is same-origin (CSRF) protected and per-learner rate limited.

## 9. Observability

- Metrics: `adaptiq_tutor_interactions_total{intent,provider}`,
  `adaptiq_tutor_latency_seconds{provider}`,
  `adaptiq_tutor_answers_withheld_total`, `adaptiq_tutor_fallbacks_total`.
- Structured log `tutor.interaction` (opaque ids + enum values only — never the
  learner's prose, question stems, or answers).

## 10. UI

`src/components/tutor-panel.tsx` — a client panel with the seven capability
buttons, a difficulty selector, free-text input, follow-up chips, a "Why this
answer?" disclosure (guardrails + grounding citations + disclaimers), and
thumbs-up/down feedback. It is mounted on:
- the **in-progress assessment page** (where answer-withholding is visibly active), and
- the **learner profile page**.

## 11. Tests

- `tests/unit/tutor-policy.test.ts` — the pure policy: determinism, difficulty
  adjustment, answer-withholding, remediation shaping, cold start.
- `tests/integration/tutor.test.ts` — context assembly, deterministic generation
  for every capability, **learning-event persistence with mastery left
  unchanged**, retrieval redaction, and the leaky-model block.
- `tests/api/tutor.api.test.ts` — auth, tenant isolation, answer-withholding
  during a live assessment, feedback ownership, and history.
