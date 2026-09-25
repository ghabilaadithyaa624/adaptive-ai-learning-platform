# Production-Readiness Audit — Adaptive AI Learning Platform

**Date:** 2026-09-24
**Branch:** `arena/01a0d1f6-adaptive-ai-learning-platform`
**Scope:** Full-stack audit across 24 dimensions + all quality gates.

## Verdict: 🟢 Production-ready pending operator setup (all P0/P1/P2 remediated)

The platform is architecturally strong, deterministically sound, and well tested (300/300).
The initial audit found a **P0 credential-exposure defect** plus several **P1/P2 gaps**. As of the
latest update **every P0, P1, and P2 finding has been remediated and verified in this branch**
(see each entry). The remaining open items are all **P3 enhancements**.

The one thing still outside the code's control: the operator must **actually perform the documented
operational setup** before go-live — configure managed Postgres backups/PITR, set the required
production secrets (`METRICS_TOKEN`, and `DATABASE_URL`), and run `npm run db:migrate` as a deploy
step (see `OPERATIONS.md`). CI is committed but must be enabled on the GitHub repo.

### Remediation summary (this branch)

| ID | Finding | Status |
|----|---------|--------|
| P0-1 | Auto-seeded admin with hardcoded password | ✅ Fixed & verified |
| P1-1 | Critical/high runtime dependency CVEs (next/postcss/sharp) | ✅ Fixed & verified |
| P1-2 | No versioned DB migrations | ✅ Fixed |
| P1-3 | No Dockerfile / CI / env template | ✅ Fixed |
| P1-4 | No backup / DR / runbook docs | ✅ Fixed (`OPERATIONS.md`) |
| P1-5 | Learner data not erased on account deletion | ✅ Fixed |
| P2-1 | Lint gate failing (3 errors) | ✅ Fixed |
| P2-2 | No DB foreign keys / non-transactional deletes | ✅ Fixed & verified |
| P2-3 | No Content-Security-Policy | ✅ Fixed & verified |
| P2-4 | Metrics endpoint open when token unset | ✅ Fixed & verified |
| P3-1 | Dev/test-only dependency CVEs | ✅ Fixed (vitest→5) — 1 dev-only chain left (drizzle-kit/esbuild) |
| P3-2 | Spoofable client IP | ✅ Fixed & verified |
| P3-3 | In-memory rate limiter doesn't scale | ✅ Fixed — Redis-backed store (auto-activates on REDIS_URL, in-memory fallback) |
| P3-4 | Modal a11y gaps | ✅ Fixed |

---

## Gate results (evidence)

| Gate | Command | Result |
|------|---------|--------|
| Typecheck | `tsc --noEmit` | ✅ PASS (exit 0) |
| Build | `next build` | ✅ PASS (all routes compiled, incl. `/api/tutor`) |
| Unit + integration + e2e | full `vitest run` (31 files) | ✅ PASS 300/300 |
| Lint | `eslint .` | ✅ PASS (was 3 errors — fixed, P2-1) |
| Dependency audit | `npm audit` | ✅ runtime/build CVEs fixed; vitest chain fixed (P3-1); 4 moderate dev-only remain (drizzle-kit/esbuild, unexposed) |

Lint is still **red** (P2-1). After the P1-1 remediation, all runtime/build dependency CVEs are resolved; the remaining `npm audit` findings are confined to the test toolchain.

> **Update (2026-09-24):** **All P0, P1, P2, and P3 findings have been remediated in this branch** (see each entry), including a real Redis-backed rate-limit store (auto-activates on `REDIS_URL`, in-memory fallback). Also added `docker-compose.yml` for one-command local bring-up (Postgres + auto-migrate + Redis + app). The only open item is a 4-CVE dev-only `drizzle-kit/esbuild` chain (unexposed — esbuild dev server we never run). Verified: typecheck ✅, lint ✅, build ✅, **300/300 tests on vitest 5** ✅, Redis fallback ✅, production `npm audit` clean.

---

## Findings by severity

### P0 — Critical (blocks production; exploitable)

**P0-1 — Auto-seed creates a platform-admin account with a known hardcoded password — ✅ FIXED**
- **Files:** `src/lib/seed.ts` (`ensureSeeded`/`ensureSeededSafe`, `runSeed`, `hashPassword("password123")`), `src/lib/seed-content.ts:228` (`admin@adaptiq.ai`, role `admin`), call sites `src/app/page.tsx:44`, `src/app/login/page.tsx:9`, `src/app/register/page.tsx:9`, `src/app/dashboard/layout.tsx:10`, `src/app/api/auth/route.ts:21`.
- **Problem:** `ensureSeededSafe()` runs on unauthenticated public pages and the auth route. When the `users` table is empty it seeds demo users — **including `admin@adaptiq.ai` (platform admin) and role-scoped staff — all with `password123`**. There is **no environment guard**: the same code path runs in production. On a fresh prod deployment, the first visit to `/login` silently provisions a platform-admin whose credentials are in the public repo.
- **Impact:** Complete platform takeover. Anyone can log in as platform admin (`admin@adaptiq.ai` / `password123`) and read/modify all tenants' data, users, and content. Cross-tenant data breach.
- **Fix (applied):** `src/lib/seed.ts` now gates all seeding behind `seedingAllowed()` — auto-seed runs outside production, but in production it is a no-op unless `ALLOW_DEMO_SEED=true`. `ensureSeeded()` short-circuits before touching the DB, so public page loads no longer trigger seeding in prod. `resolveSeedPassword()` refuses to seed in production without a strong `SEED_PASSWORD` (>= 12 chars) and never falls back to the hardcoded `password123` there. Documented in `.env.example`.
- **Residual recommendation:** move seeding out of request-path pages into an explicit `npm run seed` script, and for real production tenants create the first admin via a one-time bootstrap that forces a strong password.

---

### P1 — Production blocker (must fix before launch; not necessarily a live exploit)

**P1-1 — Critical/high dependency CVEs in runtime & build path — ✅ FIXED**
- **Files:** `package.json` / `package-lock.json`.
- **Problem:** `npm audit` reported `next` **CRITICAL** (middleware/proxy authorization bypass in App Router + Turbopack, plus SSRF/RCE/cache-confusion advisories), `postcss` **HIGH** (build), `sharp` **HIGH** (Next image optimization).
- **Impact:** The Next CVEs can bypass authorization performed in middleware; postcss/sharp affect the build and image pipeline.
- **Fix (applied):** Upgraded `next` 16.2.6 → **16.3.6** (and `eslint-config-next` to match), and `postcss` 8.5.8 → **8.5.28**; `sharp` was transitively patched by the Next bump. Re-verified: typecheck ✅, build ✅, **300/300** tests ✅. `npm audit` now reports **no runtime/build CVEs** — only dev/test-only tooling remains (see P3-1).

**P1-2 — No versioned database migrations — ✅ FIXED**
- **Files:** `drizzle/0000_init.sql` (+ `drizzle/meta/`), `drizzle.config.ts`, `package.json` scripts.
- **Problem:** Schema was applied only via `drizzle-kit push --force`, which is **destructive and unversioned** — no migration history, no forward/rollback path.
- **Fix (applied):** Adopted versioned Drizzle migrations. Added `drizzle.config.ts` (env-driven `DATABASE_URL`, `out: ./drizzle`), generated the initial migration (all tables + the 24 new FK constraints), and added `db:generate` / `db:migrate` / `db:push` scripts. Verified: `db:migrate` applies cleanly to a fresh DB and the test suite (300/300) passes against the migrated schema. `push --force` is now reserved for the disposable test DB. Deploy process documented in `OPERATIONS.md`.

**P1-3 — No deployment, CI, or environment-config artifacts — ✅ FIXED**
- **Files:** `Dockerfile`, `.dockerignore`, `.github/workflows/ci.yml`, `.env.example`, `next.config.ts` (`output: "standalone"`).
- **Problem:** No reproducible image, no CI running the gates, no documented env vars.
- **Fix (applied):** Added a multi-stage, **non-root** `Dockerfile` building the Next.js standalone server (verified it emits `server.js`) with a container `HEALTHCHECK` on `/api/ready`; a `.dockerignore`; a GitHub Actions **CI** pipeline (`quality`: typecheck+lint+build; `test`: Postgres service → migrate → full suite; `security`: `npm audit --omit=dev --audit-level=high`); and a committed `.env.example` documenting every variable. Enable Actions on the repo to activate the gate.

**P1-4 — No backup / disaster-recovery / runbook documentation — ✅ FIXED**
- **Files:** `OPERATIONS.md`.
- **Problem:** No documented backup schedule, restore procedure, RPO/RTO, or incident runbook.
- **Fix (applied):** Added `OPERATIONS.md` — build & release order, migration deploy process, automated backups + PITR with RPO ≤ 5 min / RTO ≤ 60 min targets, `pg_dump`/`pg_restore` procedures, a DR scenario table + restore drill, monitoring/health/audit references, an incident-response checklist, and the data-erasure guarantee.
- **Residual (operator action):** the *procedures* are documented, but the operator must actually enable managed backups/PITR and periodically test restores — this cannot be satisfied in code.

**P1-5 — (FIXED in this audit) Learner data not erased on account deletion**
- **Files:** `src/app/api/users/[id]/route.ts`, `src/app/api/students/[id]/route.ts`.
- **Problem:** The `tutor_interactions` table (added with the AI-tutor feature; holds `studentId`, `skillId`, and learning-context snapshots) was **not** deleted when a user/student account was deleted, unlike every other per-student table. Right-to-erasure violation + orphaned rows.
- **Impact:** Deleted learners left recoverable learning data behind (privacy/GDPR), and orphaned rows accumulate.
- **Fix (applied):** Added `db.delete(tutorInteractions).where(eq(tutorInteractions.studentId, ...))` to both deletion flows; typecheck passes. **Recommended follow-up:** wrap the multi-table deletion in a transaction (see P2-2).

---

### P2 — Important (should fix soon; degrades safety/quality/maintainability)

**P2-1 — Lint gate fails (3 errors) — ✅ FIXED**
- **Files:** `src/components/quiz-runner.tsx`, `src/components/shell.tsx`.
- **Problem:** React-hooks violations (`react-hooks/purity` from `Date.now()` in render; two `set-state-in-effect`) failed `npm run lint`.
- **Fix (applied):** Replaced the reset-state-on-change effects with React's recommended render-time "adjust state when a prop changes" pattern (tracking the previous value), and moved `Date.now()` into an effect. `eslint .` now exits 0.

**P2-2 — No database-level referential integrity + non-transactional cascading deletes — ✅ FIXED**
- **Files:** `src/db/schema.ts`; deletion flows in `src/app/api/{users,students,skills,questions,paths,assessments}/[id]/route.ts`.
- **Problem:** All relationships were bare integer columns — no FK constraints; app-side cascades ran as sequential, non-transactional statements.
- **Fix (applied):** Added **24 foreign keys** with deliberate `onDelete` semantics — `cascade` for owned children (a learner's assessments/items/mastery/paths/recs/tutor interactions/sessions), `set null` for soft links (question author/reviewer, nullable skill refs). `audit_logs` is intentionally left FK-free to preserve forensic history (documented in the schema). Wrapped all six multi-table deletions in `db.transaction(...)`. Verified on a live Postgres: cascade delete removes dependents, `set null` nulls soft links, and orphan inserts are now rejected (`SQLSTATE 23503`); full seed + 300/300 tests pass under the constraints.

**P2-3 — No Content-Security-Policy header — ✅ FIXED**
- **Files:** `src/proxy.ts` (originally added as `src/middleware.ts`; renamed for the Next 16 proxy convention).
- **Problem:** No CSP defense-in-depth against XSS/injection.
- **Fix (applied):** Added a **nonce-based strict CSP** via the edge proxy layer (Next.js's documented App Router approach): a per-request nonce + `'strict-dynamic'` so scripts run WITHOUT `'unsafe-inline'`; `default-src 'self'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, restricted img/font/connect. Verified against a running production server: page returns 200, the CSP header is present, and Next stamps the nonce onto every script tag (nothing blocked). `frame-ancestors` is intentionally left unset so the app remains embeddable in the trusted preview (consistent with the existing X-Frame-Options decision).

**P2-4 — Metrics endpoint open when token unset — ✅ FIXED**
- **File:** `src/app/api/metrics/route.ts`.
- **Problem:** With `METRICS_TOKEN` unset, `/api/metrics` served internal telemetry unauthenticated.
- **Fix (applied):** Fails closed — returns **404 in production** when `METRICS_TOKEN` is unset (open only in non-prod for local dev). Verified: prod server with no token returns 404. Documented as required in `.env.example` and `OPERATIONS.md`.

---

### P3 — Enhancement (nice to have; low risk)

**P3-1 — Dev/test-only dependency CVEs — ✅ FIXED (mostly)** — Upgraded `vitest` + `@vitest/coverage-v8` 2.1.9 → **5.0.1**, clearing the `@vitest/mocker`/`vite`/`esbuild` (critical/high) chain. Verified **300/300** tests still pass on vitest 5. `npm audit` dropped from 9 vulns (2 critical, 1 high, 6 moderate) to **4 moderate**, all in one dev-only chain: `drizzle-kit → @esbuild-kit/esm-loader → esbuild`. That chain can only be resolved by a `drizzle-kit` prerelease and concerns the esbuild dev-server SSRF (GHSA-67mh-4wv8-2f99) — **not exposed** here since we only ever run `drizzle-kit generate`/`migrate`, never an esbuild dev server. Accepted, dev-only; CI's production audit (`--omit=dev`) is clean.

**P3-2 — Client IP is spoofable — ✅ FIXED** — `src/lib/request-context.ts` `clientIp()` now honours a configured `TRUSTED_PROXY_COUNT` and selects the entry at `len - k` from the `X-Forwarded-For` chain — the IP observed by the outermost trusted proxy, which a client cannot spoof. Default (k=0) resolves to the nearest-proxy-observed IP (correct behind a single reverse proxy). Documented in `.env.example`. Verified via unit + full suite (300/300).

**P3-3 — In-memory rate limiter doesn't scale horizontally — ✅ FIXED** — `src/lib/rate-limit.ts` refactored into a pluggable async `RateLimitStore` interface (sliding-window `InMemoryRateLimitStore` default) and a real `RedisRateLimitStore` (`src/lib/rate-limit-redis.ts`, `ioredis`) implementing an **atomic** sliding-window-log via a Lua script so limits hold across all replicas. It **auto-activates when `REDIS_URL` is set** and **degrades to the in-memory fallback** on any Redis error, so an outage can never take the app down. All limits are env-configurable (`RATE_LIMIT_*`); the four call sites now `await`. `docker-compose.yml` ships an active Redis service wired via `REDIS_URL`. Verified: in-memory enforcement, Redis→in-memory fallback (dead server), and the full suite (300/300) all pass; typecheck/lint/build clean.

**P3-4 — Modal a11y gaps — ✅ FIXED** — `src/components/modal.tsx` now sets `role="dialog"`, `aria-modal="true"`, `aria-labelledby`/`aria-describedby` (via `useId`), traps Tab focus within the dialog, moves focus in on open, and restores focus to the trigger on close (WCAG 2.4.3). Backdrop made non-focusable. (Forms were already accessible — `Field` wraps inputs in a `<label>`.)

---

## Dimension-by-dimension summary

| # | Dimension | Verdict | Notes |
|---|-----------|---------|-------|
| 1 | Architecture | 🟢 Good | Clean separation: engine/ml/queries/authz/api layers; deterministic core preserved. |
| 2 | Security (auth) | 🟢 Strong | scrypt (N=16384,r8,p1), `timingSafeEqual`, httpOnly+secure+sameSite=lax cookies, 14d TTL, suspended-account denial, session revocation. |
| 3 | Security (app) | 🟢 Good | P0-1 seed fixed; nonce-based CSP added; metrics fail-closed; CSRF same-origin checks; no raw SQL / no dangerous HTML. |
| 4 | RBAC | 🟢 Good | `authz.ts` capability model + `assert*Access` used across routes. |
| 5 | Tenant isolation | 🟢 Good | `accessibleStudentIds`/institution scoping enforced in queries & authz. |
| 6 | DB integrity | 🟢 Good | 24 FKs with cascade/set-null (P2-2 fixed); transactional deletes; integrity verified. |
| 7 | API correctness | 🟢 Good | Consistent `withAuth`/validation/error envelope; 300 tests cover routes. |
| 8 | Frontend | 🟢 Good | Typed client patterns; lint clean (P2-1 fixed). |
| 9 | Accessibility | 🟢 Good | Labels OK; modal now has dialog semantics + focus trap (P3-4 fixed). |
| 10 | Performance | 🟢 Good | Caching of stable reference data (not student data); pool config; indexes on hot paths. |
| 11 | ML correctness | 🟢 Good | Deterministic BKT/recommender/forecast; pure `buildLearnerState`; covered by tests. |
| 12 | ML evaluation | 🟢 Good | Classifier training/persistence + item statistics; honest, non-overfit design. |
| 13 | Adaptive learning quality | 🟢 Good | Prereq-aware paths, error-profile signals; engine remains source of truth. |
| 14 | Question quality | 🟢 Good | Distractor rationales/misconceptions, Bloom/DOK, status workflow. |
| 15 | Testing | 🟢 Strong | 300/300 across unit/integration/api/auth/db/e2e; deterministic. |
| 16 | Observability | 🟢 Strong | Metrics/counters/histograms, redaction policy, readiness probe. |
| 17 | Error handling | 🟢 Good | Central `handleError`; no stack leakage; audit outcomes on denials. |
| 18 | Deployment | 🟢 Good | Dockerfile (standalone, non-root) + GitHub Actions CI (P1-3 fixed). |
| 19 | Env config | 🟢 Good | `.env.example` documents all vars (P1-3 fixed). |
| 20 | Secrets mgmt | 🟢 Good | No hardcoded prod password (P0-1); metrics token required/fail-closed (P2-4). |
| 21 | Backups | 🟡 Documented | Procedures in OPERATIONS.md (P1-4); operator must enable + test them. |
| 22 | Migrations | 🟢 Good | Versioned drizzle migrations + db:migrate (P1-2 fixed). |
| 23 | Disaster recovery | 🟡 Documented | Runbook + RPO/RTO + drill in OPERATIONS.md (P1-4). |
| 24 | Privacy / PII | 🟢 Good | Redaction drops secrets & masks PII; transactional erasure incl. tutor data (P1-5 fixed). |
| 25 | Audit logging | 🟢 Good | `recordAudit` on mutating/deny paths with actor/resource/ip. |

---

## Remaining work (all P3 enhancements)

All P3 items have been implemented. One low-risk follow-up remains:

1. **P3-1 residual** — 4 moderate dev-only CVEs in `drizzle-kit → @esbuild-kit → esbuild`; clear once drizzle-kit ships a non-beta release that drops `@esbuild-kit`. No production/runtime exposure (the CVE is the esbuild dev server, which we never run).

## Operator pre-launch checklist (not code)

- [ ] Set production secrets: `DATABASE_URL`, `METRICS_TOKEN`; leave `ALLOW_DEMO_SEED` unset.
- [ ] Enable managed Postgres automated backups + PITR; run a test restore.
- [ ] Wire `npm run db:migrate` into the deploy pipeline (before rolling app containers).
- [ ] Enable GitHub Actions so the committed CI pipeline gates merges.
- [ ] Point Prometheus at `/api/metrics` with the token; load `observability/alerts.yml`.

## Confirmed strengths (evidence-backed)
- Typecheck clean; build clean; **300/300** tests green.
- Hardened auth & sessions; RBAC + tenant isolation enforced in code and tests.
- Deterministic, explainable ML/assessment core (no opaque LLM decisions); AI tutor cannot mutate mastery and post-filters leaked answers.
- No raw SQL, no `dangerouslySetInnerHTML`; structured logging with secret-dropping/PII-masking redaction; readiness probe returns 503 on dependency failure.
