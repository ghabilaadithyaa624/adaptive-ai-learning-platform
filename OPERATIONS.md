# Operations Runbook — Adaptive AI Learning Platform

Operational guide for deploying and running the platform in production: build &
release, database migrations, backups, disaster recovery, monitoring, and
incident response.

---

## 1. Architecture at a glance

- **App:** Next.js (App Router) server, packaged as a standalone Node server
  (`output: "standalone"`) in a minimal non-root container (see `Dockerfile`).
- **Datastore:** PostgreSQL. All application and learner state lives here; it is
  the only stateful component and the sole backup target.
- **Config:** via environment variables (see `.env.example`). No secrets in the
  image or repo.

## 2. Required configuration

See `.env.example` for the full list. Production must set at least:

| Variable | Purpose | Notes |
|----------|---------|-------|
| `DATABASE_URL` | Postgres connection string | required |
| `METRICS_TOKEN` | Bearer token guarding `/api/metrics` | **required in prod** — endpoint fails closed (404) without it |
| `NODE_ENV=production` | Enables prod hardening (HSTS, strict CSP, no auto-seed) | set by the container |
| `REDIS_URL` | Shared rate-limit store across replicas | required for horizontal scale; falls back to in-memory if unreachable |
| `TRUSTED_PROXY_COUNT` | Trusted reverse-proxy hops for client-IP extraction | set to your real hop count behind a CDN/LB |
| `ALLOW_DEMO_SEED` | Leave unset/false in prod | only set `true` for demo/staging environments |
| `SEED_PASSWORD` | Required (≥12 chars) *if* demo seeding is enabled in prod | never a default password |

## 3. Build & release

```bash
docker build -t adaptiq:$(git rev-parse --short HEAD) .
```

CI (`.github/workflows/ci.yml`) gates every push/PR on: **typecheck, lint,
build, migrations, full test suite, and a production `npm audit`**. Do not
deploy an image whose commit did not pass CI.

Release order for a new version:

1. Run database migrations (§4) against production **before** rolling out new
   app containers (migrations are written to be backward-compatible with the
   currently-running version).
2. Roll out the new image. The container `HEALTHCHECK` and the app's
   `/api/ready` probe (returns 503 when the DB is unreachable) gate traffic.
3. Verify `/api/health/live`, `/api/ready`, and `/api/metrics` (with the token).

## 4. Database migrations

Schema changes are **versioned** — never run destructive `push` against prod.

- Generate a migration after editing `src/db/schema.ts`:
  ```bash
  npm run db:generate            # writes ./drizzle/NNNN_*.sql (commit these)
  ```
- Apply pending migrations (idempotent; tracks state in `__drizzle_migrations`):
  ```bash
  DATABASE_URL=... npm run db:migrate
  ```

Run `db:migrate` as a dedicated deploy step (a Kubernetes Job / CI job / release
task), not from every app replica. `drizzle-kit push` is reserved for local dev
and the disposable test database only.

**Foreign keys:** the schema enforces referential integrity with
`ON DELETE CASCADE` (dependent child rows, e.g. a learner's assessments) and
`ON DELETE SET NULL` (soft links, e.g. a question's author). App-side deletions
are additionally wrapped in transactions for atomicity.

## 5. Backups

PostgreSQL is the single source of truth — back it up.

- **Automated:** enable managed automated backups + Point-In-Time Recovery
  (WAL archiving) on the database (RDS/Cloud SQL/managed Postgres) with
  transaction-log retention.
- **Targets:** `RPO ≤ 5 min` (via WAL/PITR), `RTO ≤ 60 min`.
- **Logical dumps** (portable, for major upgrades / off-site copies):
  ```bash
  pg_dump --format=custom --no-owner "$DATABASE_URL" > backup_$(date +%F).dump
  ```
  Schedule daily, retain ≥30 days, store encrypted off-site (separate account/region).
- **Test restores quarterly** — an untested backup is not a backup.

## 6. Disaster recovery

| Scenario | Procedure |
|----------|-----------|
| Data corruption / bad deploy | PITR-restore Postgres to a timestamp just before the incident; redeploy the last good image; re-run any migrations. |
| Accidental data loss | Restore the most recent `pg_dump` into a fresh database and repoint `DATABASE_URL`. |
| Region/instance outage | Promote a read replica or restore the latest backup in a healthy region; repoint app config. |
| Full rebuild | Provision Postgres → `npm run db:migrate` → deploy image → (staging only) optionally seed. |

Restore drill (staging):
```bash
createdb adaptiq_restore
pg_restore --no-owner --dbname adaptiq_restore backup_YYYY-MM-DD.dump
# point a staging app at adaptiq_restore and smoke-test /api/ready + login
```

## 7. Monitoring & alerting

- **Metrics:** Prometheus scrapes `/api/metrics` (Bearer `METRICS_TOKEN`).
  Scrape config and alert rules live in `observability/prometheus.yml` and
  `observability/alerts.yml`.
- **Health:** `/api/health/live` (process up), `/api/ready` (dependencies OK — 503 otherwise).
- **Logs:** structured JSON with correlation ids; secrets are dropped and PII is
  masked by the redaction layer (see `OBSERVABILITY.md`). Never log raw
  passwords, tokens, or unmasked learner PII.
- **Audit trail:** security-relevant actions are recorded in `audit_logs`
  (actor, action, resource, outcome, ip) and are intentionally retained even
  after the referenced accounts are deleted.

## 8. Incident response (quick checklist)

1. Check `/api/ready` and the DB health/metrics dashboards.
2. Inspect structured logs by `requestId` around the first error.
3. If a recent deploy is implicated, roll back to the previous image; if the
   database is implicated, follow §6.
4. Rotate `METRICS_TOKEN` / session material if credentials may be exposed
   (sessions can be revoked per-user via `revokeUserSessions`).
5. Record a post-incident timeline and file follow-up issues.

## 9. Data privacy / erasure

Deleting a user (`DELETE /api/users/:id`) or student
(`DELETE /api/students/:id`) transactionally removes all of that learner's
dependent data — assessments, items, mastery states, paths, recommendations,
activity events, tutor interactions, and sessions — satisfying right-to-erasure.
Audit-log entries are retained by design (identity preserved via denormalized
snapshots, not live foreign keys).
