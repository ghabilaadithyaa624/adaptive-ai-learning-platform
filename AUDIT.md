# Adaptive AI Learning Platform — Repository Audit

**Auditors' remit:** senior staff engineer · AI/ML architect · security engineer · SaaS platform architect
**Scope:** full read-only audit of the codebase at commit `7afcadf` (branch `arena/01a0d1f6-...`). No code was changed.
**Stack observed:** Next.js `16.2.6` (App Router, React `19.2.6`), TypeScript `5.9.3` (strict), Drizzle ORM `0.45.2` + `pg` on PostgreSQL, Tailwind v4. ~11.5k LOC of app code. **No test/validation/security/observability libraries are installed** (no zod, jest/vitest, next-auth/jose, bcrypt/argon2, sentry/pino, rate-limiter).

> **Headline:** This is an impressively complete-looking *functional prototype* with a genuinely thoughtful ML layer (BKT, CAT-style item selection, logistic-regression classifier, hybrid recommender, linear forecasting). But it is **not production-ready and has multiple P0 security defects that make it unsafe to deploy as multi-tenant SaaS today** — most critically **self-service admin registration (privilege escalation)**, **no tenant isolation (cross-tenant data exposure / IDOR)**, and **assessment answer-key leakage**.

---

## Subsystem classification (the 25 areas)

| # | Subsystem | Classification | One-line justification |
|---|-----------|----------------|------------------------|
| 1 | Project architecture | **Functional prototype** | Clean single Next.js app, good layering (`db`→`queries`/`engine`/`ml`→`api`→`components`), but monolithic, no service boundaries, runtime seeding. |
| 2 | Frontend architecture | **Functional prototype** | Server Components + focused client islands, shared `ui.tsx`; no design system tokens, no state lib, some prop-drilling. |
| 3 | Next.js App Router structure | **Functional prototype** | Correct route groups & dynamic `[id]` routes, `force-dynamic` everywhere, but **no edge auth gating** (`src/proxy.ts` only attaches CSP); authentication/authorization are enforced in the route + RSC layers (`lib/api`, `lib/authz`, `lib/page-guards`). |
| 4 | API architecture | **Partially implemented** | Consistent `withUser`/`ok`/`fail` pattern, but authz is ad-hoc per-route, inconsistent, and tenant-blind. |
| 5 | PostgreSQL/Drizzle schema | **Weak implementation** | No foreign keys, no cascade, no `references()`, sparse indexes, unbounded JSONB, **no migrations directory**. |
| 6 | Authentication | **Security risk** | Custom scrypt sessions are okay in shape, but cookie lacks `secure`, no rate limiting, no session hygiene. |
| 7 | Authorization / RBAC | **Security risk** | Role checks are inconsistent; several read routes/pages have **no authorization at all** (IDOR). |
| 8 | Multi-tenancy | **Security risk / Missing** | `institutionId` exists but is **never enforced** — every tenant can read/modify every other tenant's data. |
| 9 | Assessment engine | **Functional prototype** | Adaptive session lifecycle works end-to-end, but **answer key leaks** and grading/session logic has integrity gaps. |
| 10 | Adaptive question selection | **Functional prototype** | Reasonable CAT-style priority + Fisher-information scoring (`adaptive.ts`), heuristic, not psychometrically calibrated. |
| 11 | Knowledge tracing | **Functional prototype** | Real BKT with forgetting decay (`knowledge-tracing.ts`), but global static parameters, no per-skill fitting. |
| 12 | Knowledge-gap detection | **Functional prototype** | Wilson lower bound + decay + prereq escalation (`gaps.ts`); solid heuristic, thresholds are hand-tuned. |
| 13 | Recommendation engine | **Functional prototype** | Transparent weighted hybrid with factor decomposition (`recommender.ts`); "hybrid-v2" is a linear score, not ML. |
| 14 | Performance forecasting | **Weak implementation** | OLS on ≤ N assessment scores (`forecast.ts`); tiny-sample linear extrapolation, overstated confidence. |
| 15 | ML model registry | **Partially implemented** | Persists classifier/tracer to `ml_models`, but training runs **synchronously in the request**, no versioning/rollback/lineage. |
| 16 | Data generation / seeding | **Functional prototype** | Rich deterministic seed (`seed.ts`/`seed-content.ts`), but **runs at runtime on first request** and ships weak default passwords. |
| 17 | Analytics | **Weak implementation** | `getCohortSnapshot` loads whole tables into Node and aggregates in JS — correct but non-scalable, tenant-blind. |
| 18 | Error handling | **Weak implementation** | `withUser` leaks `error.message` to clients as 500s; no structured errors, no error boundaries. |
| 19 | Validation | **Weak implementation** | Manual `String()/Number()` coercion only; no schema validation, no payload size limits. |
| 20 | Security | **Security risk** | See D — privilege escalation, IDOR, tenant bypass, answer leakage, no rate limiting, info leak. |
| 21 | Testing | **Missing** | Zero test files, no test runner, no CI. |
| 22 | Observability | **Missing** | Only `/api/health`; no logging, metrics, tracing, or alerting. |
| 23 | Performance | **Weak implementation** | Full-table scans + in-memory joins/filtering, synchronous model training, no caching, N+1 patterns. |
| 24 | Deployment readiness | **Weak implementation** | No Dockerfile/CI/`.env.example`/migrations; hardcoded DB creds in `drizzle.config.json`; runtime seeding. |
| 25 | Code quality | **Functional prototype** | Readable, typed, consistent; but dead code, duplicated constants, magic numbers, and untested. |

---

## A. Current architecture diagram

```
                                   ┌───────────────────────────────────────────┐
                                   │                Browser (SPA-ish)            │
                                   │  Server Components render + Client islands  │
                                   │  (quiz-runner, *-client.tsx, action-button) │
                                   └───────────────┬─────────────────────────────┘
                                                   │ fetch() JSON (same-origin, cookie auth)
                                                   ▼
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│                              Next.js 16 App Router (single process)                          │
│                                                                                            │
│  app/(marketing) page.tsx · login · register                                               │
│  app/dashboard/**  (Server Components → call src/lib/queries directly, requireUser())       │
│                                                                                            │
│  app/api/**  Route Handlers (runtime=nodejs, force-dynamic)                                 │
│   ├─ auth/            login/register/logout  ── lib/auth (scrypt + sessions table)          │
│   ├─ students, users, institutions, skills, questions (CRUD)                                │
│   ├─ assessments/[id]/answer  ── lib/engine (adaptive select + BKT grade)                   │
│   ├─ recommendations, paths, milestones                                                     │
│   ├─ ml/  (train | predict | evaluate) ── lib/ml/registry                                   │
│   └─ health/  ── lib/seed.ensureSeededSafe()   ← RUNTIME SEEDING TRIGGER                    │
│                                                                                            │
│  ┌──────────────────────── lib/ (domain core) ────────────────────────────────┐           │
│  │  auth.ts   api.ts(withUser/ok/fail)   queries.ts (733 LOC read models)       │           │
│  │  engine.ts (session lifecycle, grading)                                      │           │
│  │  ml/  knowledge-tracing(BKT) · adaptive(CAT) · classifier(logreg) ·          │           │
│  │       gaps(Wilson) · recommender(hybrid) · forecast(OLS) · registry          │           │
│  │  seed.ts / seed-content.ts   utils.ts                                        │           │
│  └──────────────────────────────────┬──────────────────────────────────────────┘           │
└─────────────────────────────────────┼──────────────────────────────────────────────────────┘
                                       ▼  Drizzle ORM (node-postgres Pool, global singleton)
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│  PostgreSQL — 13 tables, NO foreign keys, NO cascade, sparse indexes                         │
│  institutions · users · sessions · subjects · skills · questions ·                          │
│  assessments · assessment_items · mastery_states · learning_paths ·                         │
│  path_milestones · recommendations · ml_models · activity_events                            │
└──────────────────────────────────────────────────────────────────────────────────────────┘

Trust/tenant boundaries: authentication boundary = getCurrentUser() cookie lookup.
TENANT boundary (institutionId): effectively ABSENT — not enforced in any query.
```

**Key architectural observations**
- Dashboard pages call `lib/queries` **directly** (server-side) — good — while client islands hit `/api/*`. Two data paths to keep consistent.
- **Runtime seeding**: `ensureSeededSafe()` is invoked from `dashboard/layout.tsx`, `api/auth`, and `api/health`. The DB is populated on first request via a per-process global promise (`globalForSeed.__adaptiqSeedPromise`). This conflates bootstrap with request handling and is unsafe across multiple serverless instances / horizontal scaling.
- ML "training" (`trainAndPersistClassifier`) runs **inside the request thread** and inside the seed path (full table scan + 1400-epoch gradient descent).

---

## B. Current feature inventory

**Implemented & working (prototype-grade):**
- Email/password auth with server sessions (`lib/auth.ts`, `api/auth/route.ts`); login/register/logout UI (`auth-form.tsx`).
- Role model: `student | teacher | trainer | institution | admin` (5 roles).
- Institution/tenant records + admin CRUD (`api/institutions`, `admin-client.tsx`).
- Learner directory, learner detail, learner CRUD (`students` routes/pages, `learner-admin.tsx`).
- Skill/subject catalog with prerequisites (`skills`, `subjects`, `skills-client.tsx`).
- Question bank CRUD with difficulty/Bloom metadata and per-item p-correct stats (`questions` routes, `questions-client.tsx`).
- Adaptive assessment lifecycle: start → serve next item → answer/grade → complete/abandon (`engine.ts`, `assessments/**`, `quiz-runner.tsx`).
- Bayesian Knowledge Tracing with forgetting decay + per-response mastery updates & history (`knowledge-tracing.ts`, `mastery_states`).
- CAT-style adaptive item selection with rationale/explainability (`adaptive.ts`).
- Difficulty/correctness logistic-regression classifier with train/eval metrics (AUC, logloss, Brier, precision/recall) (`classifier.ts`).
- Knowledge-gap detection with severity tiers and drivers (`gaps.ts`, `gaps/page.tsx`).
- Hybrid recommendation engine with factor decomposition + review/spaced-repetition (`recommender.ts`, `recommendations/**`).
- Personalized learning-path generation with topological prereq ordering & milestones (`buildLearningPath`, `paths/**`, `milestones/**`).
- Performance forecasting with projection band + trend/risk labels (`forecast.ts`, `analytics/page.tsx`).
- ML model registry with retrain/predict/evaluate actions and metrics display (`registry.ts`, `ml/route.ts`, `models-client.tsx`).
- Cohort analytics snapshot & activity feed (`getCohortSnapshot`, `getActivity`).
- Deterministic demo seed: institutions, students, staff, skills, questions, simulated response history, trained model (`seed.ts`).
- Health endpoint with table counts (`api/health`).

**Partially present / stubbed:**
- Multi-tenant scoping (`scopeStudentIdsFor` helper exists in `queries.ts` but is **never called** — dead code).
- Recommendation accept/dismiss lifecycle (`status` transitions exist; limited enforcement).

**Absent:** password reset, email verification, invitations/onboarding flow, audit log, notifications, exports, admin impersonation controls, background jobs, rate limiting, API docs, tests.

---

## C. Critical bugs

| ID | Severity | Location | Bug |
|----|----------|----------|-----|
| C1 | **P0** | `api/assessments/[id]/route.ts` `GET` → `queries.getAssessment` | **Answer key leakage.** The returned `items[]` include `correctIndex` (and `explanation`) for **all** items, including the *pending, unanswered* item. A student can read the correct answer for the current question directly from the network response before answering → assessment integrity broken. |
| C2 | **P0** | `dashboard/students/[id]/page.tsx` + `api/students/[id]/route.ts` `GET` → `getStudentDetail` | **IDOR.** No ownership/tenant check on read. Any authenticated user (including a `student`) can open `/dashboard/students/<any id>` or `GET /api/students/<any id>` and see another learner's full profile, mastery, forecasts and activity. |
| C3 | **P1** | `engine.ts` `computeNextSessionQuestion` | Pending items are **persisted before being answered**. If the client abandons mid-item, orphan rows linger; `answer` route only cleans null rows on explicit `complete/abandon`. Combined with C1, a student can repeatedly `GET` to enumerate/preview queued items. |
| C4 | **P1** | `engine.ts` `gradeItem` + `api/.../answer` | **Race / double-submit.** Item lock relies on `studentAnswer !== null` read-then-write with no transaction or row lock. Concurrent requests can double-count attempts/mastery. All multi-step writes (item update → mastery upsert → activity → assessment complete) are **not wrapped in a DB transaction**, so partial failures corrupt state. |
| C5 | **P1** | `engine.ts` `computeNextSessionQuestion` | Fallback target skills = `skills.limit(4)` with no ordering → nondeterministic/empty quizzes when a student has no `targetSkillIds`. `itemTarget` can exceed available questions → session can never "complete" (infinite "next"/null churn). |
| C6 | **P2** | `forecast.ts` + `answer` route | Forecast in `gradeItem` includes the just-completed score, but the `answer` route **recomputes** forecast from prior completed scores **excluding** the new one (ordering/`orderBy` differs), so `predictedNext`/`forecastLabel` can disagree between the grade result and the persisted assessment row. |
| C7 | **P2** | `queries.listStudents` | `masteryTrend` computed from `history` slices with an inconsistent fallback (`earlier` empty → subtracts `recent` mean from itself → 0), silently hiding real trends for new learners. |
| C8 | **P2** | `api/students/route.ts` POST | Cold-start seeds mastery states from `prereqIds.length === 0` skills, else `skills.slice(0,4)` — nondeterministic ordering, may seed unrelated skills; `subjectName: "Onboarding"` hardcoded in ranking so recommender factors are wrong at onboarding. |
| C9 | **P3** | `engine.ts` `countRows` / `studentName` | Unused/oddly-generic helpers (`countRows` ignores its arg via `void table`) — dead/confusing code. |

---

## D. Security vulnerabilities

| ID | Severity | Location | Vulnerability & impact |
|----|----------|----------|------------------------|
| D1 | **P0 — critical** | `api/auth/route.ts` (register) | **Privilege escalation / broken access control.** Registration accepts a client-supplied `role` and allows `"admin"` and `"institution"`. **Anyone can self-register as a platform admin** and gain full control. |
| D2 | **P0 — critical** | everywhere (`institutionId` never filtered) | **No tenant isolation.** `listStudents`, `getUserDirectory`, `getCohortSnapshot`, `getStudentDetail`, `listAssessments`, `getRecommendations`, `getPaths`, all `[id]` routes ignore the caller's `institutionId`. A teacher/admin of tenant A reads and mutates tenant B's students, users, questions, models. Complete cross-tenant breach. |
| D3 | **P0** | `api/assessments/[id]` GET (C1) | Answer-key disclosure (assessment/exam integrity). |
| D4 | **P0** | `dashboard/students/[id]` + `api/students/[id]` GET (C2) | IDOR — horizontal privilege escalation to any learner's PII/analytics. |
| D5 | **P1** | `seed.ts` | **Weak, shared default credentials.** All seeded users (including admins/institution admins) get `password123`; created learners default to `password123` (`api/students`, `api/users`). If seed runs in any shared/prod-like env, admin accounts are trivially guessable. |
| D6 | **P1** | `lib/auth.ts` `createSession` | Session cookie sets `httpOnly`+`sameSite=lax` but **no `secure` flag** and no `__Host-` prefix → token sendable over plain HTTP / susceptible to MITM. No session rotation on login, no absolute lifetime cap, no server-side revocation on password change, and **expired sessions are never swept**. |
| D7 | **P1** | `api/auth` login | **No rate limiting / lockout / captcha** on login or register → credential stuffing & brute force. `verifyPassword` is constant-time (good) but the endpoint isn't throttled. |
| D8 | **P1** | `api/*` mutations | **No CSRF defense beyond SameSite=Lax.** State-changing POST/PATCH/DELETE rely solely on the cookie; no CSRF token / origin check. Lax blocks most cross-site POSTs but not all vectors (e.g., top-level form navigations, method quirks). |
| D9 | **P1** | `users/[id]` PATCH | A `teacher`/`trainer` is only blocked from editing *others* by `user.id !== targetId`, but `institution` role can edit **any** user across tenants (no tenant scope). Role changes are admin-gated (good) but everything else is not tenant-scoped. |
| D10 | **P2** | `lib/api.ts` `withUser` | **Server error message leakage**: raw `error.message` returned to client with HTTP 500 (DB errors, constraint text, internals disclosed). |
| D11 | **P2** | `lib/auth.ts` `hashPassword` | scrypt with **default cost parameters** and no application pepper; format `salt:hash`. Acceptable primitive, but not tuned (`N/r/p`), and no upgrade-on-login path. |
| D12 | **P2** | validation (all routes) | No payload validation/size limits; unbounded arrays (`options`, `targetSkillIds`, JSONB `history`) accepted from clients → memory/DoS and data-quality risk. `toIdList`/`toNumber` are permissive. |
| D13 | **P2** | `drizzle.config.json` | **Hardcoded DB credentials** (`postgres:postgres@127.0.0.1`) committed to the repo. |
| D14 | **P3** | `api/health` | Health endpoint is unauthenticated and returns table counts + seed error strings (minor info disclosure) and can **trigger seeding**. |
| D15 | **P3** | `api/questions` GET | Question bank incl. `correctIndex` is readable by any authenticated role (no student block on GET) — content exfiltration of the entire item bank. |

---

## E. Data-model problems

Schema: `src/db/schema.ts`.

1. **No referential integrity (P1).** Every relationship is a bare `integer` (`institutionId`, `studentId`, `skillId`, `subjectId`, `assessmentId`, `questionId`, `pathId`, ...). No `.references()`, no FKs, no `ON DELETE CASCADE`. Deletion is hand-rolled in `students/[id]` and `users/[id]` DELETE — easy to leave orphans (e.g., `recommendations.skillId`, `activity_events.skillId`, `path_milestones` when a skill is deleted).
2. **No migrations (P1).** `drizzle-kit` is a dep but there is **no `drizzle/` migrations dir and no `db:push`/`generate` scripts** in `package.json`. Schema is materialized only via runtime seeding assumptions → no reproducible, versioned schema; risky prod deploys.
3. **Tenant column present but unindexed & unenforced (P1).** `users.institutionId` has no index and is not part of any composite query. There is no institution scoping column on `skills`, `questions`, `subjects`, `assessments`, etc. — the model **cannot** enforce tenant isolation as designed (question bank & skills are global across all tenants).
4. **Sparse indexing (P2).** Indexes exist on `questions.skillId`, `assessment_items.assessmentId`, `recommendations.studentId`, `path_milestones.pathId`, and unique indexes on emails/tokens/slugs/mastery pair. Missing on high-traffic filters: `assessments.studentId`, `assessments.status`, `mastery_states.studentId` (only composite unique), `activity_events.studentId/createdAt`, `users.institutionId`, `learning_paths.studentId`.
5. **Unbounded JSONB (P2).** `mastery_states.history` and `recommendations.factors`/`ml_models.params`/`metrics` grow unbounded except for app-side `slice(-40)`; no DB constraint. Storing time series in JSONB blocks efficient analytics.
6. **`sessions` never garbage-collected (P2).** No TTL job; table grows forever; no index on `expiresAt`.
7. **Float mastery/`real` columns (P3).** `real` for probabilities is fine but mixing `real` ability/score with app-side rounding causes the C6 forecast drift; consider `numeric` for money/analytics-grade values.
8. **`email` unique globally (P3).** Prevents the same person existing in two institutions — a real multi-tenant modeling limitation.
9. **Enums as free-text (P3).** `role`, `status`, `mode`, `severity`, `kind` are `text` with app-side allowlists; drift-prone. Use PG enums or check constraints.

---

## F. ML / AI limitations

Files: `src/lib/ml/*`, `engine.ts`.

1. **BKT parameters are global constants (P2).** `DEFAULT_BKT` (`slip .1, guess .2, learn .22, forget .035`) applied to every student/skill. No per-skill or per-item parameter fitting (no EM/MLE), so tracing is uncalibrated. `mastery_states` stores per-row `slip/guess/learn` columns but they are **never used** — `posterior()` always uses defaults.
2. **Classifier trains synchronously in-request (P1 perf/ML-ops).** `trainAndPersistClassifier` scans **all** `assessment_items` + joins, runs 1400 epochs of full-batch gradient descent on the request thread (also inside `runSeed`). No batching, no async job, no incremental training. Blocks the caller and won't scale.
3. **Forecasting is OLS on ≤ a handful of points (P1 quality).** `forecastPerformance` fits a straight line to completed-assessment scores; with `n<3` it returns `insufficient-data`, otherwise linear extrapolation with a 1.96·residual band that **overstates confidence** on 3–5 points. No seasonality, no per-skill forecast, no uncertainty from model class.
4. **"Hybrid-v2" recommender is a fixed linear weighting (P2).** `RECOMMENDER_WEIGHTS` are hand-set; there is **no collaborative filtering, no embeddings, no learning-to-rank** despite "hybrid" naming. Fine as a heuristic, but marketed above its actual sophistication.
5. **Feature/label leakage risk mitigated but fragile (P2).** `registry.ts` builds features "causally" (running stats before each item) — good intent — but `ability` uses `masteryBefore` history mean and `evidence` caps are heuristic; there's **no train/validation split by student** (leakage across a student's own items) and metrics are computed on a random 20% row split (`trainClassifier`), inflating AUC.
6. **No model governance (P1 for prod).** `ml_models` stores one row per model name via upsert → **no version history, no rollback, no lineage, no A/B, no shadow eval, no drift monitoring, no approval gate.** `evaluate` action computes a naive calibration gap only.
7. **Cold-start is ad-hoc (P2).** `api/students` POST seeds priors from `ability - difficulty*0.25`; recommender then runs with `subjectName:"Onboarding"` and `daysSincePractice:30` placeholders → misleading first recommendations.
8. **Adaptive selection is heuristic, not IRT (P3).** `adaptive.ts` targets a 0.75 success band and Fisher info `p(1-p)` — reasonable CAT approximation, but item difficulty comes from a coarse label→value map (`easy .3 … expert .9`), not estimated item parameters; no exposure control beyond a per-skill coverage penalty.
9. **No content/PII safety layer (P3).** No moderation/guardrails on authored questions or any LLM usage (there is currently no generative-AI integration at all despite the "AI" branding).

---

## G. Testing gaps

- **Zero automated tests** of any kind (no `*.test.ts`, no jest/vitest/playwright config, no `test` script). **Classification: Missing.**
- No CI workflow (`.github/` absent), so `lint`/`typecheck` aren't enforced.
- Highest-risk untested logic that needs coverage first:
  - Pure ML units (deterministic, easy to test): `posterior`/`applyDecay`/`predictCorrect` (BKT), `trainClassifier`/`predictProbability`, `wilsonLowerBound`/`classifyGap`, `scoreSkill`/`buildLearningPath` (topological ordering & prereq inclusion), `forecastPerformance` (edge cases n<3, flat, declining).
  - Authorization matrix: every route × role × (own/other tenant) — currently the biggest correctness/security gap.
  - Assessment engine integration: start→serve→grade→complete, double-submit (C4), item exhaustion (C5), abandon cleanup.
  - Auth: register role allowlist (D1), password verify timing, session expiry.
- No fixtures/factories, no test DB harness, no seed isolation for tests (seed is a runtime global).

---

## H. Performance problems

1. **Whole-table loads + in-JS aggregation (P1).** `getCohortSnapshot` (`queries.ts`) selects **all** rows from `masteryStates`, `assessments`, `recommendations`, `learningPaths`, `institutions` and aggregates in Node. `listStudents` loads all mastery rows for the id set then filters per student in JS (`masteryRows.filter(...)` inside a `.map`), an O(students × states) pattern. These will collapse at a few thousand learners.
2. **N+1 / repeated queries (P2).** `engine.loadSkillFeatures` re-queries `masteryStates` and question counts on every call, and is invoked multiple times per grade/serve. `getStudentDetail` fans out to 5+ query builders, several of which re-run overlapping selects.
3. **Synchronous model training on the request path (P1).** See F2 — blocks the HTTP worker and the first-request seed.
4. **`force-dynamic` everywhere + no caching (P2).** All dashboard pages and APIs are dynamic; no `revalidate`, no `unstable_cache`, no HTTP caching, no memoization of read models. Every page load recomputes cohort analytics from scratch.
5. **`computeNextSessionQuestion` loads the full candidate set each item (P2).** Selects all active questions for target skills + joins subjects on every "next", plus a separate `loadSkillFeatures` scan.
6. **No pagination (P2).** `listStudents`, `getUserDirectory`, question bank, recommendations (`limit 120`), assessments (`limit 60/80`) use fixed caps or none; large tenants overflow.
7. **Connection pool defaults (P3).** `db/index.ts` uses a default `pg` Pool with no `max`, timeouts, or SSL config — risky under serverless concurrency.

---

## I. Production-readiness gaps

- **Deployment (P1):** no `Dockerfile`, no CI/CD, no `.env.example`, **no DB migrations**, hardcoded credentials in `drizzle.config.json`, and **schema/data created via runtime seeding** rather than a migrate+seed pipeline. `next.config.ts` is empty (no security headers, no image/domain config, no `output`).
- **Config/secrets (P1):** only `DATABASE_URL` is read; no secret for session signing, no per-env config, no validation of required env at boot (other than the DB URL throw).
- **Observability (P1):** no structured logging, no request IDs, no metrics (RED/USE), no tracing, no error reporting (Sentry), no uptime/SLO. `/api/health` is shallow (counts only, unauthenticated, can seed).
- **Security headers / hardening (P1):** no CSP, HSTS, `X-Frame-Options`, `Referrer-Policy`, no `secure`/`__Host-` cookies, no rate limiting/WAF.
- **Data lifecycle (P2):** no backups/retention policy, no session GC, no soft-delete/audit trail, no GDPR/FERPA data-subject flows (this is edtech — FERPA/COPPA/GDPR obligations apply).
- **Resilience (P2):** no transactions around multi-write flows (C4), no idempotency keys, no graceful shutdown / pool drain, no queue for training.
- **Docs (P3):** no README/runbook/API reference/architecture docs.

---

## J. Technical debt

- **Dead / unused code:** `queries.scopeStudentIdsFor` (the intended tenant helper) is never used; `auth.canManageCohort` is never used; `engine.countRows`/`studentName` are unused/odd; `void staffRows/questionRows` in seed.
- **Duplicated constants:** `DIFFICULTY_VALUE` and `BLOOM_VALUE` maps are redefined in `engine.ts`, `registry.ts`, `ml/route.ts`, `seed.ts` (drift risk). `AVATAR_COLORS` duplicated in `auth` route and `seed`.
- **Two data-access paths:** Server Components import `lib/queries` directly while client islands call `/api/*` — authorization logic must be duplicated and kept in sync (and currently isn't — pages skip the checks the APIs sometimes have).
- **Ad-hoc authz:** role checks copy-pasted per route with subtle inconsistencies (some routes block students, some don't; none check tenant). No central policy/guard.
- **Magic numbers everywhere:** thresholds (`0.85`, `0.6`, `0.55`, weights, epochs, `45`) scattered without named config.
- **Manual coercion instead of a schema:** `toNumber/toIdList/String(...)` repeated in every handler.
- **Runtime seeding coupling:** business bootstrap tangled into `layout.tsx`/`health`/`auth`.
- **Type looseness at boundaries:** `body as Record<string, unknown>`, `params as Partial<ClassifierModel>` casts bypass validation.

---

## K. Recommended target architecture

**Goal:** a secure, observable, horizontally-scalable multi-tenant edtech SaaS with a governed ML layer. Evolve the current monolith rather than rewrite.

1. **Central auth & policy layer**
   - Add `middleware.ts` to gate all `/dashboard` and `/api` (except public) routes; attach the authenticated principal + `institutionId` to the request.
   - Replace per-route ad-hoc checks with a single **policy module** (`lib/authz.ts`) exposing `assertCan(user, action, resource)` and a **tenant-scoped query layer** (every read/write filters by `institutionId`). Wire the existing-but-unused `scopeStudentIdsFor` concept into a real `withTenant(user)` DB helper.
   - Harden sessions: `secure` + `__Host-` cookie, rotation on login, absolute + idle expiry, revoke-on-password-change, scheduled expiry sweep. Consider signed JWT access + opaque refresh, or keep DB sessions with an index on `expiresAt`.
   - Server-issued roles only (never trust client `role`); invite-based admin creation; per-IP + per-account rate limiting on auth; add CSRF tokens/origin checks for mutations.

2. **Data model & migrations**
   - Adopt Drizzle migrations (`drizzle-kit generate`/`migrate`, checked-in `drizzle/`), remove runtime seeding from request paths (move to a `db:seed` script + idempotent bootstrap job).
   - Add real FKs + `ON DELETE` policies; add `institutionId` to tenant-owned tables (skills/questions can be global "library" + tenant overrides); add missing indexes; enum/check constraints for status/role/mode; move `mastery_states.history` to a `mastery_events` table for analytics.

3. **Validation & error contract**
   - Introduce **zod** schemas per route (body/query/params) + shared error envelope; strip internal messages (log server-side, return safe codes). Enforce payload size limits.

4. **ML platform**
   - Move training to a **background job/queue** (e.g., a cron route or worker) writing versioned rows to `ml_models` with lineage, metrics, and a `status` (candidate/active/archived) + rollback. Split eval by student to prevent leakage; add calibration & drift monitoring.
   - Fit BKT parameters per skill (EM) and actually use the per-row `slip/guess/learn`. Estimate item parameters (2PL/IRT) offline; feed into `adaptive.ts`. Keep the transparent recommender but add learning-to-rank later. Add a serving-time model cache.

5. **Analytics & performance**
   - Push aggregation into SQL (materialized views / `GROUP BY`) for cohort snapshot and per-student rollups; add pagination + cursor APIs; cache read models (`unstable_cache`/Redis) with tenant-aware keys; wrap multi-write flows in transactions with row locks (fixes C4).

6. **Observability & ops**
   - Structured logging (pino) with request IDs, OpenTelemetry traces, RED metrics, Sentry error reporting; deep `/api/health` (DB, migrations, model freshness) that does **not** seed; security headers + CSP in `next.config.ts`.
   - Dockerfile + CI (lint, typecheck, test, migrate check) + `.env.example` + secrets via env manager.

7. **Testing pyramid**
   - Unit-test all `lib/ml/*` (pure) and the authz matrix; integration-test the assessment engine against a disposable Postgres (testcontainers); a few Playwright E2E flows (login, take quiz, tenant isolation).

8. **Compliance (edtech):** FERPA/COPPA/GDPR — audit log, data export/delete, consent, PII minimization, region pinning (`institutions.region` already exists).

---

## L. Prioritized roadmap

### P0 — Critical / security / data-integrity (do before any real deployment)
1. **D1** Remove client-controlled `role` from registration; force `student` on self-signup; admin/institution creation only via authenticated admin invite. *(api/auth)*
2. **D2** Enforce tenant isolation: add `institutionId` scoping to every read/write (queries + `[id]` routes + dashboard pages); introduce `withTenant`/policy layer. *(queries.ts, all routes/pages)*
3. **C2/D4** Fix IDOR on learner detail: authorize `getStudentDetail`/`GET /api/students/[id]` by ownership+tenant.
4. **C1/D3** Stop leaking `correctIndex`/`explanation` for unanswered items in `GET /api/assessments/[id]`; only reveal after grading. *(queries.getAssessment / engine)*
5. **D5** Remove shared `password123` defaults; require strong passwords; never seed real-usable admin creds outside demo mode.
6. **C4** Wrap the grade/mastery/complete flow in a transaction with row locking; make item submission idempotent.

### P1 — Required for production
7. **Migrations & bootstrap:** add Drizzle migrations, `db:migrate`/`db:seed` scripts, remove runtime seeding from `layout.tsx`/`auth`/`health`. *(seed.ts, package.json, drizzle/)*
8. **Referential integrity & indexes:** FKs + cascade, tenant/`studentId`/`status`/`expiresAt` indexes. *(schema.ts)*
9. **Session hardening + rate limiting + CSRF:** `secure`/`__Host-` cookie, rotation/expiry sweep, login throttling, CSRF/origin checks. *(auth.ts, request-context.ts, proxy.ts)*
10. **Validation & error contract:** zod on every route; stop returning raw `error.message`. *(api.ts, all routes)*
11. **Async, governed ML training:** move `trainAndPersistClassifier` off the request path; versioned model registry with rollback + leakage-safe eval. *(registry.ts)*
12. **Observability:** structured logging, error reporting, deep non-seeding health, security headers. *(next.config.ts, lib)*
13. **C5/C3** Deterministic target-skill selection + session-exhaustion handling + orphan-item cleanup. *(engine.ts)*
14. **Deployment:** Dockerfile, CI (lint/typecheck/test/migrate), `.env.example`, remove hardcoded creds from `drizzle.config.json`. *(D13)*

### P2 — Important quality improvements
15. Push analytics aggregation into SQL + add pagination + cache read models (fix H1/H2/H4/H6).
16. Authz matrix + engine integration tests; wire CI to enforce (`lint`/`typecheck`/`test`).
17. Calibrate BKT per skill (use stored `slip/guess/learn`); reconcile forecast drift (C6); improve cold-start (C8).
18. Centralize duplicated constants/config; remove dead code (`scopeStudentIdsFor`, `canManageCohort`, `countRows`); unify server/API data access.
19. Restrict question-bank `correctIndex` exposure by role (D15); tighten `/api/health` (D14).
20. Session/data lifecycle jobs (session GC, JSONB→events table), enum/check constraints.

### P3 — Advanced features
21. IRT/2PL item calibration feeding CAT; exposure control; learning-to-rank recommender; embeddings/collaborative filtering.
22. Drift monitoring, A/B & shadow model serving, model approval workflow.
23. Optional generative-AI features (question generation, tutoring) **with** moderation/guardrails and evals.
24. FERPA/COPPA/GDPR compliance suite: audit log, data export/delete, consent, region pinning.
25. Notifications, invitations/onboarding, password reset/email verification, exports, admin impersonation with audit.

---

### Bottom line
The **domain modeling and ML thinking are strong for a prototype** — BKT, CAT-style selection, gap analysis, hybrid recommendations, and forecasting are all really present and explainable, not fake. The blockers are **not** the algorithms; they are **security (privilege escalation, tenant isolation, IDOR, answer leakage), data-model integrity (no FKs/migrations), and operational maturity (no tests/observability/CI, in-request training/seeding).** Address the P0 set first — none of them are large changes, and each is currently exploitable — then the P1 platform work to make it a deployable multi-tenant SaaS.
