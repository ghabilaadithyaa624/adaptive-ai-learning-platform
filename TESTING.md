# Testing Architecture

A layered, deterministic test suite for the adaptive learning platform. It
covers pure algorithms, the database, the API surface, authentication,
authorization, multi-tenant isolation, the adaptive engine, knowledge tracing,
recommendations, ML training/evaluation, and full end-to-end journeys.

```
tests/
├── unit/            Pure logic — no I/O. Always run, fully deterministic.
├── db/              Schema, constraints, defaults, jsonb round-trips.
├── auth/            Authentication · authorization (RBAC) · multi-tenant isolation.
├── api/             Route handlers invoked in-process (real DB, mocked cookies).
├── integration/     Cross-module flows: adaptive engine, knowledge tracing,
│                    ML training/evaluation, learning-path progression.
├── e2e/             Full learner journey across many endpoints.
├── helpers/         db-url, db reset, deterministic fixtures, request/session/
│                    cookie helpers.
└── setup/           env normalization (per worker) + schema push (global).
```

## The 12 required test types → where they live

| # | Type | File(s) |
|---|------|---------|
| 1 | Unit | `tests/unit/*` (models, evaluation, selection, item-analysis, recommender, knowledge-tracing primitives, …) |
| 2 | Integration | `tests/integration/*` |
| 3 | API | `tests/api/*` |
| 4 | Database | `tests/db/schema.test.ts` |
| 5 | Authentication | `tests/auth/authentication.test.ts` |
| 6 | Authorization | `tests/auth/authorization.test.ts` |
| 7 | Multi-tenant isolation | `tests/auth/tenant-isolation.test.ts` |
| 8 | Adaptive engine | `tests/integration/adaptive-engine.test.ts`, `tests/api/assessments.api.test.ts` |
| 9 | Knowledge tracing | `tests/integration/knowledge-tracing.test.ts`, `tests/unit/knowledge-tracing.test.ts` |
| 10 | Recommendation | `tests/api/recommendations.api.test.ts`, `tests/unit/recommender.test.ts` |
| 11 | ML evaluation | `tests/integration/ml-training.test.ts`, `tests/api/ml.api.test.ts`, `tests/unit/{evaluation,regression,model-compare}.test.ts` |
| 12 | End-to-end | `tests/e2e/learner-journey.test.ts` |

### Critical scenarios covered

student registration · login/logout · unauthorized API access · cross-student
access · cross-institution access · assessment creation · adaptive question
selection · answer submission · mastery update · assessment completion ·
recommendation generation · learning-path progression · model training · model
evaluation.

## Determinism

- **No dependence on the app's random seed.** The DB suites use
  `tests/helpers/fixtures.ts`, a fully-specified world (no `Math.random`, no
  seeded PRNG). The application seed (`ensureSeeded`) is neutralized in the
  suites that touch auth routes.
- **Fixed timezone** (`TZ=UTC`) so date formatting is stable.
- **Serial DB access** (`fileParallelism: false`) — each DB suite truncates and
  reseeds a clean baseline, so IDs and outcomes are reproducible run-to-run.
- **Model training is deterministic** — see the "identical data yields identical
  weights" assertion in `tests/integration/ml-training.test.ts`.

Business logic was **not** modified to make tests pass; a couple of tests
encode genuine model semantics (e.g. Bayesian Knowledge Tracing's learn-
transition can raise mastery from a zero base even on a wrong answer, so
"wrong lowers mastery" is asserted from an established base).

## Synthetic learner profiles (`tests/helpers/fixtures.ts`)

| Profile | Learner | Characteristics |
|---------|---------|-----------------|
| ADVANCED | alice | high mastery across all skills, recent practice |
| STRUGGLING | bob | low mastery on foundations, some evidence |
| STALE | carol | high mastery, not practiced for weeks (forgetting) |
| COLD-START | dave | no mastery evidence at all |
| SUSPENDED | erin | account suspended (auth edge case) |

Two tenants (Northwind Academy / Eastvale College) plus platform admin,
institution admin, and per-tenant teachers exercise the isolation model. The
skill graph is a prerequisite chain: arithmetic → fractions → linear → quadratics,
with published, draft and retired questions to verify the servable-item gate.

## Running

```bash
npm test              # everything (DB suites auto-skip if no database)
npm run test:unit
npm run test:integration
npm run test:api
npm run test:db
npm run test:auth
npm run test:e2e
npm run test:all
npm run test:coverage
npm run test:watch
```

### Database-backed suites

The `db`, `auth`, `api`, `integration` and `e2e` suites need a Postgres. Point
them at one via `TEST_DATABASE_URL` (preferred) or `DATABASE_URL`:

```bash
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/app_test npm test
```

On startup the global setup pushes the current Drizzle schema into that database
(`drizzle-kit push`, idempotent; set `TEST_PUSH_SCHEMA=0` to skip). **When no
database URL is configured these suites skip themselves** (with a clear warning)
so `npm test` stays green in any environment — exactly how CI runs the unit
layer without a service container, and the full suite with one.
