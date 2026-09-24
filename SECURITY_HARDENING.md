# Security Hardening Summary — AdaptiQ Adaptive Learning Platform

**Role:** Senior application security engineer
**Scope:** Harden the existing platform without rewriting working functionality.
**Result:** All 17 target areas addressed. `tsc --noEmit` passes. Automated
authorization-matrix suite: **44/44 pass**. Functional smoke suite: core flows
intact.

---

## 1. Architecture: one centralized authorization layer

All access decisions now flow through a single module instead of scattered,
inconsistent `user.role === "..."` checks.

| File | Responsibility |
|------|----------------|
| `src/lib/authz.ts` | Role predicates (`isStudent/isStaff/isAccountAdmin/isPlatformAdmin`), a **capability map**, `studentScope()`, `accessibleStudentIds()`, and the enforcement asserters `assertStudentAccess`, `assertAssessmentAccess`, `assertInstitutionAccess`, `requireCapability`. |
| `src/lib/api.ts` | `withAuth` / request wrapper: authenticates the session, enforces **same-origin** on mutations (CSRF), captures client IP, and converts thrown `HttpError`s into safe JSON. |
| `src/lib/page-guards.ts` | Server-component guards: `requireStaffPage`, `requireAccountAdminPage`, `requireStudentPageAccess` (→ `notFound()` on cross-tenant), `resolveFocusStudent`, `scopedLearners`, `scopedInstitutions`, `institutionScopeId`. |
| `src/lib/audit.ts` | `recordAudit()` — structured, tamper-evident audit log (success **and** denied outcomes). |
| `src/lib/rate-limit.ts` | Sliding-window rate limiter (swappable for Redis in prod). |
| `src/lib/validation.ts` | Strict input parsing/validation (`reqString`, `reqEmail`, `validatePassword`, `parseId`, `oneOf`, …). |
| `src/lib/http.ts` | Safe error helpers (`unauthorized`, `forbidden`, `conflict`, `tooManyRequests`, `badRequest`) — no internal detail leakage. |

**Capability map** (`authz.ts`) — the single source of truth for "who may do what":

```
manageStudents        → staff
manageContent         → staff        (question bank + skills taxonomy)
manageStaff           → account admin (institution admin | platform admin)
manageInstitutions    → account admin
createInstitution     → platform admin ONLY
trainModels/viewModels→ staff
managePaths           → staff
manageRecommendations → staff
```

---

## 2. Coverage of the 17 required areas

1. **Authentication** — `withAuth`/`requireUser` on every non-public route; invalid/absent session → `401`.
2. **Session management** — opaque 256-bit random tokens (`randomBytes(32)`), server-side `sessions` table, logout invalidates.
3. **Password security** — `scryptSync` with per-user 16-byte salt; verification via `timingSafeEqual` (constant-time). `validatePassword` enforces a minimum policy; weak passwords rejected at register/create.
4. **Cookie security** — `adaptiq_session` cookie is `httpOnly`, `sameSite=lax`, and `secure` in production.
5. **CSRF** — state-changing requests (`POST/PATCH/PUT/DELETE`) are rejected when `Sec-Fetch-Site: cross-site` (verified by test H). `sameSite=lax` is the second layer.
6. **Input validation** — centralized `validation.ts`; all IDs parsed with `parseId`, enums with `oneOf`, strings length-bounded, emails normalized.
7. **Authorization** — capability checks on every route via `requireCapability`; no ad-hoc role string comparisons remain in routes.
8. **RBAC** — roles `student | teacher | trainer | institution | admin` resolved to capabilities in one map.
9. **Institution tenant isolation** — non-platform-admins are pinned to their own `institutionId` on **both reads and writes**; a supplied `institutionId` param cannot broaden scope. `assertInstitutionAccess` guards institution resources.
10. **Student data privacy** — learner listings/details are staff-only and institution-scoped; students can only ever see their own data.
11. **API IDOR protection** — every student-scoped resource calls `assertStudentAccess` / `assertAssessmentAccess`; nested resources (paths, recommendations, milestones, assessment items) are re-checked by owner, not trusted from the URL.
12. **Privilege escalation** — public registration **hard-forces `role = student`** regardless of client input; role changes are platform-admin-only; users cannot elevate themselves.
13. **Admin protection** — `/api/institutions` create is platform-admin-only; admin pages gated server-side, not just hidden.
14. **Staff permissions** — teachers/trainers get content + learner management within their tenant only; cannot create staff or cross tenants.
15. **Audit logging** — `recordAudit` writes actor, role, action, resource, target student, institution, IP, and outcome (success/denied) to `audit_logs`.
16. **Rate limiting** — per-IP limits on register and login, plus a tighter per-email limiter on login to blunt credential stuffing.
17. **Sensitive error handling** — errors return generic messages via `http.ts`; no stack traces / SQL / internal identifiers leaked to clients.

### Critical requirement — public registration
`POST /api/auth {action:"register"}` ignores any client-supplied `role` and always
creates a **student**. Verified for `admin`, `institution`, `teacher`, `trainer`
inputs — all produced `role=student` (test B).

### Answer-key exfiltration (fixed)
- The question bank (with correct answers) is now staff-only at `/api/questions`, `/dashboard/questions`, and `/dashboard/models`.
- A student's **unanswered** assessment items are redacted before leaving the server (`correctIndex = -1`, `explanation = ""`) in both the API and the server-rendered detail page. The correct answer is revealed only *after* the student submits.

---

## 3. Every security-related change

### API routes (all migrated to `withAuth` + `requireCapability` + `assert*` + `recordAudit`)
- `auth/route.ts` — register forces student role; rate limiting on register & login (+ per-email); audit.
- `students/route.ts` — GET staff-only + institution-scoped; POST forces new learner into staff's own institution.
- `students/[id]/route.ts` — `assertStudentAccess` on GET/PATCH/DELETE (IDOR + cross-tenant fix).
- `users/route.ts`, `users/[id]/route.ts` — `manageStaff`; role changes platform-admin-only; tenant-scoped directory.
- `assessments/route.ts`, `assessments/[id]/route.ts`, `assessments/[id]/answer/route.ts` — `assertAssessmentAccess`; student answer-key redaction on served sessions.
- `recommendations/route.ts` + `[id]`, `paths/route.ts` + `[id]`, `milestones/route.ts` + `[id]` — owner/tenant checks on nested resources.
- `ml/route.ts` — `viewModels` (GET) / `trainModels` (POST); students blocked from train/predict/evaluate; predict re-checks student access.
- `questions/route.ts` + `[id]` — `manageContent` (staff-only) — closes answer-bank exfiltration.
- `skills/route.ts` + `[id]` — read open (non-sensitive taxonomy, no answer keys); writes `manageContent`.
- `institutions/route.ts` + `[id]` — GET `manageInstitutions` + tenant scope; POST `createInstitution` (platform-admin-only); DELETE platform-admin-only.

### Server-rendered pages (enforce server-side, not just hidden UI)
- `dashboard/page.tsx`, `analytics`, `students`, `students/[id]`, `gaps`, `recommendations`, `paths`, `assessments`, `assessments/[id]`, `admin` — now use `requireStaffPage` / `resolveFocusStudent` / `scopedLearners` / `scopedInstitutions` / `institutionScopeId`; students pinned to self, staff pinned to their tenant, URL `studentId`/`institutionId` cannot broaden scope.
- `questions/page.tsx`, `models/page.tsx` — staff-only (`requireStaffPage`); learner picker institution-scoped.

### Data layer (`src/lib/queries.ts`)
- Added tenant / allow-list parameters to `getUserDirectory`, `getInstitutionList`, `listAssessments`, `getRecommendations`, `getPaths`, `getStudentOptions`, `getCohortSnapshot`, `getActivity` so scoping is enforced at the query, not just the caller.

### Cross-cutting
- `src/db/schema.ts` — added `audit_logs` and `sessions` tables.
- `src/components/shell.tsx` — Question bank & AI models nav hidden from students (defense in depth; pages still enforce).
- `next.config.ts` — security headers (`X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`, `X-DNS-Prefetch-Control`, HSTS in prod). Frame-blocking headers deliberately omitted so trusted preview embedding keeps working; add a strict frame policy in real deployment.

---

## 4. Testing performed

Ran against a throwaway Postgres with the real seeded dataset (18 users across
multiple institutions, 84 questions, 167 assessments), driving the actual HTTP
routes. Harness kept in `sectest/` (`matrix.mjs`, `smoke.mjs`).

**Authorization matrix — 44/44 pass**, covering:
- Unauthorized requests → `401`.
- Registration privilege escalation (admin/institution/teacher/trainer → forced student).
- Cross-student access (student cannot read another student; cannot list learners).
- Cross-institution access (teacher/institution-admin cannot read or list another tenant's students or assessments).
- Privilege escalation via API (student/teacher cannot create admins; institution admin cannot mint admins; no self-elevation).
- Student ↔ admin boundaries (answer bank, ML training, institutions, user directory all denied to students).
- Answer-key leakage (served session has no `correctIndex`; pending items redacted).
- CSRF (cross-site mutation rejected; same-origin allowed).
- IDOR on nested resources (paths/assessments by id).

**Verification commands**
```
npx tsc --noEmit                      # passes
node sectest/matrix.mjs               # 44 passed, 0 failed
node sectest/smoke.mjs                # core flows intact
```

---

## 5. Known follow-ups (non-security / out of scope)

- **Atomicity (integrity, not a vuln):** the grade → mastery-update → complete
  sequence in `assessments/[id]/answer` is not yet wrapped in a single DB
  transaction. Left untouched to avoid rewriting working grading internals;
  recommend wrapping `gradeItem` in a transaction next.
- **Rate limiter** is in-process; back it with Redis/Upstash for multi-instance
  production (interface already swappable).
- 3 pre-existing ESLint `react-hooks` warnings in `quiz-runner.tsx` /
  `shell.tsx` are unrelated to security and were left as-is.
