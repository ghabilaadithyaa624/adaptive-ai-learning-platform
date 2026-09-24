# Production-Readiness Audit — Adaptive AI Learning Platform

**Date:** 2026-09-24
**Branch:** `arena/01a0d1f6-adaptive-ai-learning-platform`
**Scope:** Full-stack audit across 24 dimensions + all quality gates.

## Verdict: ❌ NOT production-ready

The platform is architecturally strong, deterministically sound, and well tested (300/300),
but it ships with a **P0 credential-exposure defect** (auto-seeded platform-admin account with a
hardcoded password, triggered by an unauthenticated page load) plus several **P1 operational gaps**
(no versioned migrations, no CI/CD, no deployment/backup story, critical dependency CVEs). These
must be resolved before any production deployment.

One regression I introduced with the AI-tutor feature (learner data not erased on account deletion)
was found during this audit and **fixed in place** — see P1-5.

---

## Gate results (evidence)

| Gate | Command | Result |
|------|---------|--------|
| Typecheck | `tsc --noEmit` | ✅ PASS (exit 0) |
| Build | `next build` | ✅ PASS (all routes compiled, incl. `/api/tutor`) |
| Unit + integration + e2e | full `vitest run` (31 files) | ✅ PASS 300/300 |
| Lint | `eslint .` | ❌ FAIL (exit 1) — 3 errors |
| Dependency audit | `npm audit` | ❌ 12 vulns (3 critical, 3 high, 6 moderate) |

Lint and dependency-audit gates are **red**. A CI pipeline running these today would block the merge.

---

## Findings by severity

### P0 — Critical (blocks production; exploitable)

**P0-1 — Auto-seed creates a platform-admin account with a known hardcoded password**
- **Files:** `src/lib/seed.ts` (`ensureSeeded`/`ensureSeededSafe`, `runSeed`, `hashPassword("password123")`), `src/lib/seed-content.ts:228` (`admin@adaptiq.ai`, role `admin`), call sites `src/app/page.tsx:44`, `src/app/login/page.tsx:9`, `src/app/register/page.tsx:9`, `src/app/dashboard/layout.tsx:10`, `src/app/api/auth/route.ts:21`.
- **Problem:** `ensureSeededSafe()` runs on unauthenticated public pages and the auth route. When the `users` table is empty it seeds demo users — **including `admin@adaptiq.ai` (platform admin) and role-scoped staff — all with `password123`**. There is **no environment guard**: the same code path runs in production. On a fresh prod deployment, the first visit to `/login` silently provisions a platform-admin whose credentials are in the public repo.
- **Impact:** Complete platform takeover. Anyone can log in as platform admin (`admin@adaptiq.ai` / `password123`) and read/modify all tenants' data, users, and content. Cross-tenant data breach.
- **Fix:** (1) Gate all auto-seeding behind an explicit opt-in that is off in production, e.g. `if (process.env.NODE_ENV === "production" && process.env.ALLOW_DEMO_SEED !== "true") return;` inside `runSeed`, and move seeding out of request-path pages into an explicit `npm run seed` script. (2) Never ship privileged accounts with static passwords — require the first admin to be created via a one-time bootstrap that forces a strong password (or read it from a secret at seed time). (3) Add a test asserting seeding is a no-op in production mode.

---

### P1 — Production blocker (must fix before launch; not necessarily a live exploit)

**P1-1 — Critical/high dependency CVEs in runtime & build path**
- **Files:** `package.json` / `package-lock.json`.
- **Problem:** `npm audit` reports `next` **CRITICAL** (middleware/proxy authorization bypass in App Router + Turbopack), `postcss` **HIGH** (build), `sharp` **HIGH** (Next image optimization). (Remaining vitest/vite/esbuild/@esbuild-kit CVEs are dev/test-only → see P3-1.)
- **Impact:** The Next CVE can bypass authorization checks performed in middleware; postcss/sharp affect the build and image pipeline.
- **Fix:** Upgrade `next` to a patched release (requires bumping beyond the currently pinned range), then `npm audit fix`; re-run all gates. Confirm no middleware auth logic relies on the vulnerable behavior.

**P1-2 — No versioned database migrations**
- **Files:** no `drizzle/` migration dir; `package.json` scripts (no `db:generate`/`db:migrate`); `tests/setup/global.ts` uses `drizzle-kit push --force`.
- **Problem:** Schema is applied only via `drizzle-kit push --force`, which is **destructive and unversioned**. There is no migration history, no forward/rollback path, no way to evolve a production DB safely.
- **Impact:** Any schema change risks data loss; no reproducible prod schema; no rollback. Blocks safe operation.
- **Fix:** Adopt versioned drizzle migrations (`drizzle-kit generate` → checked-in SQL, `drizzle-kit migrate` on deploy). Reserve `push --force` for tests only.

**P1-3 — No deployment, CI, or environment-config artifacts**
- **Files:** none present — no `Dockerfile`, no `docker-compose.yml`, no `.github/workflows/`, no `.env.example` (only `observability/prometheus.yml` + `alerts.yml` exist).
- **Problem:** No reproducible build/runtime image, no CI running the gates (which would already be catching lint + audit failures), no documented required env vars.
- **Impact:** No automated quality enforcement; error-prone manual deploys; onboarding/ops friction.
- **Fix:** Add a `Dockerfile` (multi-stage, non-root), a CI workflow running typecheck/lint/test/build/`npm audit`, and a committed `.env.example` documenting `DATABASE_URL`, `METRICS_TOKEN`, `LOG_LEVEL`, `DB_POOL_*` (and any LLM/tutor provider vars).

**P1-4 — No backup / disaster-recovery / runbook documentation**
- **Files:** docs absent (only `OBSERVABILITY.md`, `TUTOR.md`).
- **Problem:** No documented backup schedule, restore procedure, RPO/RTO, or incident runbook for the Postgres store that holds all learner data.
- **Impact:** Data loss is unrecoverable in practice; on-call has no playbook.
- **Fix:** Document automated Postgres backups (PITR), a tested restore procedure, and an ops runbook (readiness probe `/api/ready` already returns 503 on dependency failure — reference it).

**P1-5 — (FIXED in this audit) Learner data not erased on account deletion**
- **Files:** `src/app/api/users/[id]/route.ts`, `src/app/api/students/[id]/route.ts`.
- **Problem:** The `tutor_interactions` table (added with the AI-tutor feature; holds `studentId`, `skillId`, and learning-context snapshots) was **not** deleted when a user/student account was deleted, unlike every other per-student table. Right-to-erasure violation + orphaned rows.
- **Impact:** Deleted learners left recoverable learning data behind (privacy/GDPR), and orphaned rows accumulate.
- **Fix (applied):** Added `db.delete(tutorInteractions).where(eq(tutorInteractions.studentId, ...))` to both deletion flows; typecheck passes. **Recommended follow-up:** wrap the multi-table deletion in a transaction (see P2-2).

---

### P2 — Important (should fix soon; degrades safety/quality/maintainability)

**P2-1 — Lint gate fails (3 errors)**
- **Files:** `src/components/quiz-runner.tsx:63` (`react-hooks/purity`), `:64` (`react-hooks/set-state-in-effect`), `src/components/shell.tsx:40` (`set-state-in-effect`).
- **Problem:** Pre-existing React-hooks violations fail `npm run lint` (exit 1).
- **Impact:** Red CI gate; the set-state-in-effect patterns can cause extra renders / subtle state bugs.
- **Fix:** Refactor the effects to derive state during render or guard the state updates; re-run `eslint .` to green.

**P2-2 — No database-level referential integrity + non-transactional cascading deletes**
- **Files:** `src/db/schema.ts` (0 `references()`, 0 `onDelete`); deletion flows in `src/app/api/{users,students,skills,questions,paths}/[id]/route.ts`.
- **Problem:** All relationships are bare integer columns — no FK constraints. Referential integrity depends entirely on hand-written app-side cascades, which run as **sequential, non-transactional** statements. A mid-sequence failure leaves partial/orphaned data, and nothing prevents inserting rows that reference non-existent parents.
- **Impact:** Orphaned rows, silent integrity drift, partial deletes on error.
- **Fix:** Add drizzle `.references(() => parent.id, { onDelete: "cascade" | "set null" })` to child columns (backed by a migration — see P1-2), and wrap each multi-table deletion in `db.transaction(...)`.

**P2-3 — No Content-Security-Policy header**
- **File:** `next.config.ts` (sets `X-Content-Type-Options`, `Referrer-Policy`, HSTS in prod, `Permissions-Policy`; no CSP).
- **Problem:** No CSP defense-in-depth against XSS/injection. (Mitigated somewhat: React escaping in use, `0` `dangerouslySetInnerHTML`, `0` `sql.raw` in `src/`.)
- **Impact:** Larger blast radius if any XSS sink is introduced later.
- **Fix:** Add a strict CSP (`default-src 'self'`, explicit script/style/connect sources; nonce for any inline). Note `X-Frame-Options` is intentionally omitted — keep only if framing is a product requirement, otherwise add `frame-ancestors`.

**P2-4 — Metrics endpoint open when token unset**
- **File:** `src/app/api/metrics/route.ts` (Bearer `METRICS_TOKEN`, but no token ⇒ open).
- **Problem:** If `METRICS_TOKEN` is not configured, `/api/metrics` serves internal telemetry unauthenticated.
- **Impact:** Information disclosure of operational metrics in a misconfigured deploy.
- **Fix:** Fail closed — return 503/404 when `METRICS_TOKEN` is unset in production, and document it as required in `.env.example`.

---

### P3 — Enhancement (nice to have; low risk)

**P3-1 — Dev/test-only dependency CVEs** — `vitest`/`@vitest/mocker` (critical), `vite`/`esbuild`/`@esbuild-kit`/`drizzle-kit` (high/moderate). Not in the production runtime; still resolve by upgrading test tooling to keep the audit gate green.

**P3-2 — Client IP is spoofable** — `src/lib/request-context.ts` `clientIp()` trusts the first `x-forwarded-for` hop with no trusted-proxy allowlist. Because IP keys the login/register rate limiter (`src/lib/rate-limit.ts`), an attacker can rotate the header to evade throttling. Fix: derive client IP from a configured trusted-proxy depth.

**P3-3 — In-memory rate limiter doesn't scale horizontally** — `src/lib/rate-limit.ts` keeps counters in process memory; with >1 instance limits are per-instance. Fix: back with a shared store (Redis) for multi-instance deployments.

**P3-4 — Modal a11y gaps** — `src/components/modal.tsx` has Escape-to-close and an aria-labelled backdrop but no `role="dialog"`/`aria-modal`, no focus trap, no initial focus. Fix: add dialog semantics and focus management. (Forms are otherwise accessible — `Field` in `src/components/ui.tsx` wraps inputs in a `<label>`, giving implicit association.)

---

## Dimension-by-dimension summary

| # | Dimension | Verdict | Notes |
|---|-----------|---------|-------|
| 1 | Architecture | 🟢 Good | Clean separation: engine/ml/queries/authz/api layers; deterministic core preserved. |
| 2 | Security (auth) | 🟢 Strong | scrypt (N=16384,r8,p1), `timingSafeEqual`, httpOnly+secure+sameSite=lax cookies, 14d TTL, suspended-account denial, session revocation. |
| 3 | Security (app) | 🟡 Mixed | **P0-1** seed; CSRF same-origin checks present; no raw SQL / no dangerous HTML; no CSP (P2-3); metrics open if unset (P2-4). |
| 4 | RBAC | 🟢 Good | `authz.ts` capability model + `assert*Access` used across routes. |
| 5 | Tenant isolation | 🟢 Good | `accessibleStudentIds`/institution scoping enforced in queries & authz. |
| 6 | DB integrity | 🔴 Weak | **P2-2** no FKs, non-transactional cascades. |
| 7 | API correctness | 🟢 Good | Consistent `withAuth`/validation/error envelope; 300 tests cover routes. |
| 8 | Frontend | 🟢 Good | Typed client patterns; **P2-1** lint errors. |
| 9 | Accessibility | 🟡 Partial | Labels OK; modal semantics/focus gaps (P3-4). |
| 10 | Performance | 🟢 Good | Caching of stable reference data (not student data); pool config; indexes on hot paths. |
| 11 | ML correctness | 🟢 Good | Deterministic BKT/recommender/forecast; pure `buildLearnerState`; covered by tests. |
| 12 | ML evaluation | 🟢 Good | Classifier training/persistence + item statistics; honest, non-overfit design. |
| 13 | Adaptive learning quality | 🟢 Good | Prereq-aware paths, error-profile signals; engine remains source of truth. |
| 14 | Question quality | 🟢 Good | Distractor rationales/misconceptions, Bloom/DOK, status workflow. |
| 15 | Testing | 🟢 Strong | 300/300 across unit/integration/api/auth/db/e2e; deterministic. |
| 16 | Observability | 🟢 Strong | Metrics/counters/histograms, redaction policy, readiness probe. |
| 17 | Error handling | 🟢 Good | Central `handleError`; no stack leakage; audit outcomes on denials. |
| 18 | Deployment | 🔴 Missing | **P1-3** no Dockerfile/CI. |
| 19 | Env config | 🟡 Partial | **P1-3** no `.env.example`; vars read directly. |
| 20 | Secrets mgmt | 🔴 Weak | **P0-1** hardcoded seed password; **P2-4** metrics token optional. |
| 21 | Backups | 🔴 Missing | **P1-4**. |
| 22 | Migrations | 🔴 Missing | **P1-2**. |
| 23 | Disaster recovery | 🔴 Missing | **P1-4** no runbook/RPO/RTO. |
| 24 | Privacy / PII | 🟡 Good-ish | Redaction drops secrets & masks PII (`src/lib/observability/redact.ts`); erasure gap **P1-5 fixed**. |
| 25 | Audit logging | 🟢 Good | `recordAudit` on mutating/deny paths with actor/resource/ip. |

---

## Recommended remediation order

1. **P0-1** — disable prod auto-seed & remove hardcoded admin password. *(blocks launch)*
2. **P1-1** — upgrade Next + patch CVEs.
3. **P1-2 / P2-2** — versioned migrations + FK constraints + transactional deletes.
4. **P1-3 / P1-4** — Dockerfile, CI running gates, `.env.example`, backup/DR docs.
5. **P2-1 / P2-3 / P2-4** — fix lint, add CSP, fail-closed metrics.
6. **P3** — dev-dep CVEs, trusted-proxy IP, shared rate limiter, modal a11y.

## Confirmed strengths (evidence-backed)
- Typecheck clean; build clean; **300/300** tests green.
- Hardened auth & sessions; RBAC + tenant isolation enforced in code and tests.
- Deterministic, explainable ML/assessment core (no opaque LLM decisions); AI tutor cannot mutate mastery and post-filters leaked answers.
- No raw SQL, no `dangerouslySetInnerHTML`; structured logging with secret-dropping/PII-masking redaction; readiness probe returns 503 on dependency failure.
